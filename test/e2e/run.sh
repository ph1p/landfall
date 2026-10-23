#!/usr/bin/env bash
# End-to-end test against a throwaway "server" container (sshd + dockerd).
# Exercises setup → traefik → static/dockerfile/image deploys → rollback → env → rm.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/srv-e2e.XXXXXX")
NAME=srv-e2e
SSH_PORT=${SSH_PORT:-2222}
HTTPS_PORT=${HTTPS_PORT:-18443}

cleanup() {
  [ -z "${UI_PID:-}" ] || kill "$UI_PID" 2>/dev/null || true
  [ "${KEEP:-}" = 1 ] && { echo "kept container $NAME and $WORK"; return; }
  docker rm -f "$NAME" "$NAME-fresh" >/dev/null 2>&1 || true
  [ -z "${FRESH_PORT:-}" ] || ssh-keygen -R "[127.0.0.1]:$FRESH_PORT" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

pass() { printf '\033[32mPASS\033[0m %s\n' "$*"; }
die() { printf '\033[31mFAIL\033[0m %s\n' "$*"; exit 1; }
# Not grep -q: it stops reading at the first match, and under pipefail the writer's SIGPIPE fails the check.
has() { grep "$@" >/dev/null; }
lf() { node "$ROOT/dist/cli.mjs" "$@"; }
get() { curl -sk --max-time 10 --resolve "$1:$HTTPS_PORT:127.0.0.1" "https://$1:$HTTPS_PORT${2:-/}"; }
code() { curl -sk -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$1:$HTTPS_PORT:127.0.0.1" "${@:2}" "https://$1:$HTTPS_PORT/"; }
expect() { # expect <host> <path> <needle>
  for _ in $(seq 1 20); do get "$1" "$2" | has "$3" && { pass "https://$1$2 contains '$3'"; return; }; sleep 1; done
  echo "got: $(get "$1" "$2" | head -c 300)"; die "https://$1$2 does not contain '$3'"
}

ssh-keygen -q -t ed25519 -N "" -f "$WORK/key"
export SRV_CONFIG_DIR="$WORK/cfg" SRV_SSH_CONFIG="$WORK/ssh_config"
printf 'Host *\n  UserKnownHostsFile %s/known_hosts\n' "$WORK" > "$SRV_SSH_CONFIG"

docker build -q -t srv-e2e "$ROOT/test/e2e" >/dev/null
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --privileged --name "$NAME" -p "$SSH_PORT:22" -p "$HTTPS_PORT:443" \
  -e AUTHORIZED_KEY="$(cat "$WORK/key.pub")" srv-e2e >/dev/null
for _ in $(seq 1 30); do docker exec "$NAME" docker info >/dev/null 2>&1 && break; sleep 1; done

echo "== setup"
lf setup box --host 127.0.0.1 --port "$SSH_PORT" --key "$WORK/key" --email test@example.com --staging --no-firewall -y
[ "$(ssh -F "$SRV_SSH_CONFIG" -o BatchMode=yes box "id -un")" = deploy ] || die "ssh box not deploy"; pass "ssh box logs in as deploy"
{ lf setup box --no-firewall -y 2>&1 | has "already bootstrapped"; } || die "setup re-run skips bootstrap"; pass "setup re-run skips bootstrap"
{ ! lf setup box --no-firewall --check 2>&1 | grep -E '→|!'; } || die "check shows nothing to do"; pass "check shows nothing to do"
docker exec "$NAME" gpasswd -d deploy docker >/dev/null
{ lf setup box --no-firewall --check 2>&1 | has "exists, add docker group"; } || die "check finds partial user"; pass "check finds partial user"
lf setup box --no-firewall -y >/dev/null 2>&1
{ docker exec "$NAME" id -nG deploy | has -w docker; } || die "setup repairs partial user"; pass "setup repairs partial user"
{ docker exec "$NAME" docker inspect traefik | has acme-staging; } || die "staging remembered"; pass "staging remembered"
# Docker without compose (distro packages often ship it separately): setup notices and installs it.
docker exec "$NAME" mv /usr/local/libexec/docker/cli-plugins/docker-compose /root/docker-compose.off
{ lf setup box --no-firewall --check 2>&1 | has "install compose"; } || die "check finds missing compose"; pass "check finds missing compose"
lf setup box --no-firewall -y >/dev/null 2>&1
{ docker exec "$NAME" docker compose version >/dev/null 2>&1; } || die "setup installs compose"; pass "setup installs compose"
lf undo -s box -y >/dev/null 2>&1
{ ! docker exec "$NAME" test -e /usr/local/lib/docker/cli-plugins/docker-compose; } || die "undo removes the installed compose"; pass "undo removes the installed compose"
docker exec "$NAME" mv /root/docker-compose.off /usr/local/libexec/docker/cli-plugins/docker-compose
{ lf traefik status | has 'Up'; } || die "traefik running"; pass "traefik running"

# The user's own Host block whose key file is gone: server add points it at the key that works.
printf 'Host ownbox\n  HostName 127.0.0.1\n  Port %s\n  User root\n  IdentityFile %s/gone\n' "$SSH_PORT" "$WORK" >> "$SRV_SSH_CONFIG"
lf server add ownbox -i "$WORK/key" >"$WORK/own.log" 2>&1 || { cat "$WORK/own.log"; die "server add own alias"; }
{ has -x "  IdentityFile $WORK/key" "$SRV_SSH_CONFIG" && ! has "$WORK/gone" "$SRV_SSH_CONFIG" && [ -e "$SRV_SSH_CONFIG.srv-bak" ]; } \
  || { cat "$SRV_SSH_CONFIG"; die "own Host block gets the key"; }
[ "$(ssh -F "$SRV_SSH_CONFIG" -o BatchMode=yes ownbox id -un)" = root ] || die "ssh ownbox with the added key"
{ lf server config ownbox | has "your own"; } || die "server config shows the Host block"
pass "server add fixes the key of an own Host block, server config shows it"
lf server rm ownbox -y >/dev/null

[ "${STOP_AFTER_SETUP:-}" = 1 ] && exit 0
echo "== static"
mkdir -p "$WORK/site/dist" && cd "$WORK/site"
echo '<h1>v1</h1>' > dist/index.html
lf deploy -d site.test -y
expect site.test / v1
{ grep -q '"site.test"' srv.json; } || die "srv.json written"; pass "srv.json written"
sleep 1; echo '<h1>v2</h1>' > dist/index.html
lf deploy -y
expect site.test / v2
{ [ "$(curl -sk -o /dev/null -w '%{http_code}' --resolve site.test:$HTTPS_PORT:127.0.0.1 https://site.test:$HTTPS_PORT/nope)" = 404 ]; } || die "unknown path 404s"; pass "unknown path 404s"
lf rollback -y
expect site.test / v1
{ lf ls | has site; } || die "sites list shows site"; pass "sites list shows site"

echo "== spa"
mkdir -p "$WORK/spa/build" && cd "$WORK/spa"
echo '<div id=app>spa</div>' > build/index.html
lf deploy -d spa.test --spa -y
expect spa.test /deep/link spa

echo "== dockerfile"
mkdir -p "$WORK/app" && cd "$WORK/app"
cat > Dockerfile <<'EOF'
FROM busybox:1.37
EXPOSE 8000
CMD sh -c 'mkdir -p /www && echo "app $GREETING" > /www/index.html && httpd -f -p 8000 -h /www'
EOF
lf deploy -d app.test -e GREETING=hello -y
expect app.test / "app hello"
lf env GREETING=world -y
expect app.test / "app world"

echo "== image"
cd "$WORK"
lf deploy --no-save -n who --image traefik/whoami:v1.11 --port 80 -d who.test -y
expect who.test / "Hostname"
{ lf sites info who | has whoami; } || die "sites info"; pass "sites info"
{ lf logs who -n 5 >/dev/null; } || die "logs"; pass "logs"

echo "== password, domains, free address"
lf auth who -u bob -p secretpw1 >/dev/null
for _ in $(seq 1 20); do [ "$(code who.test)" = 401 ] && break; sleep 1; done
[ "$(code who.test)" = 401 ] || die "auth asks for a login"; pass "auth asks for a login"
[ "$(code who.test -u bob:secretpw1)" = 200 ] || die "auth lets bob in"; pass "auth lets bob in"
lf auth who --off -y >/dev/null
for _ in $(seq 1 20); do [ "$(code who.test)" = 200 ] && break; sleep 1; done
[ "$(code who.test)" = 200 ] || die "auth --off"; pass "auth --off makes it public again"
lf domains who --add who2.test >/dev/null 2>&1
expect who2.test / "Hostname"
{ lf domains who --json | has '"who2.test"'; } || die "domains lists the new one"; pass "domains --add"
mkdir -p "$WORK/free" && cd "$WORK/free" && echo '<h1>free</h1>' > index.html
lf deploy -y >/dev/null
free=$(node --input-type=module -e 'console.log(JSON.parse((await import("node:fs")).readFileSync("srv.json", "utf8")).domains[0])')
[[ "$free" == free.127-0-0-1.sslip.io ]] || die "no domain gives an sslip.io address (got $free)"
expect "$free" / free
pass "deploy without a domain uses $free"
{ grep -q '"path": ".*'"$(basename "$WORK")"'/free"' "$SRV_CONFIG_DIR/projects.json"; } || die "project remembered"; pass "project remembered"
cd "$WORK"

echo "== main domain"
lf server domain box box.test >/dev/null 2>&1 || die "server domain"
lf server domain box --add other.test >/dev/null 2>&1 || die "server domain --add"
{ lf server config box --json | tr -d ' \n' | has '"domains":\["box.test","other.test"\]'; } || die "main domains remembered"; pass "main domains remembered, first is primary"
lf server domain box --primary other.test >/dev/null 2>&1 && lf server domain box --primary box.test >/dev/null 2>&1
{ lf server domain box --json | has '"primary": true'; } || die "server domain --json"
lf server domain box --rm other.test >/dev/null 2>&1 && die "server domain --rm without -y"
lf server domain box --rm other.test -y >/dev/null 2>&1
{ lf server config box --json | tr -d ' \n' | has '"domains":\["box.test"\]'; } || die "server domain --rm"; pass "server domain --add/--primary/--rm"
mkdir -p "$WORK/main" && cd "$WORK/main" && echo '<h1>main</h1>' > index.html
lf deploy -y >/dev/null
expect main.box.test / main
pass "deploy with a main domain serves <site>.<domain>"
lf domains main --add extra >/dev/null 2>&1
{ lf domains main --json | has '"extra.box.test"'; } || die "domains --add extra"; pass "domains --add extra means extra.box.test"
lf traefik setup --dashboard traefik --dashboard-password dashpw1 >/dev/null 2>&1 || die "traefik dashboard"
for _ in $(seq 1 20); do [ "$(code traefik.box.test)" = 401 ] && break; sleep 1; done
[ "$(code traefik.box.test)" = 401 ] || die "dashboard at traefik.<domain> asks for a login"
[ "$(code traefik.box.test -u admin:dashpw1)" != 401 ] || die "dashboard lets admin in"
pass "traefik dashboard at traefik.box.test"
lf traefik setup >/dev/null 2>&1
{ docker exec "$NAME" grep -q traefik.box.test /opt/srv/traefik/docker-compose.yml; } || die "dashboard kept on re-run"; pass "traefik setup keeps the dashboard"
lf traefik setup --dashboard off >/dev/null 2>&1
{ ! docker exec "$NAME" grep -q traefik.box.test /opt/srv/traefik/docker-compose.yml; } || die "dashboard off"; pass "--dashboard off removes it"
lf sites rm main -y >/dev/null
lf server domain box --clear -y >/dev/null
cd "$WORK"

echo "== os and updates"
{ lf info --json | has '"id": "alpine"'; } || die "server info detects the os"; pass "server info detects alpine"
out=$(lf updates --no-refresh --json) || die "updates"
{ echo "$out" | has '"mgr": "apk"' && echo "$out" | has '"name": "traefik"'; } || { echo "$out" | head -40; die "updates lists packages and images"; }
pass "updates lists apk packages and images"

echo "== traefik host network"
lf traefik setup --host-network --image traefik:v3.6 >/dev/null 2>&1 || die "traefik setup --host-network"
{ lf updates -s box --no-refresh 2>&1 | has "newer version traefik:v3."; } || die "updates names the newer traefik tag"; pass "updates names the newer traefik tag"
{ [ "$(docker exec "$NAME" docker inspect -f '{{.HostConfig.NetworkMode}}' traefik)" = host ]; } || die "traefik on host network"; pass "traefik on host network"
expect who.test / "Hostname"
{ grep -q '"hostNetwork": true' "$SRV_CONFIG_DIR/config.json"; } || die "host network remembered"; pass "host network remembered"
{ ! lf setup box --no-firewall --check 2>&1 | grep -E '→|!'; } || die "check accepts own host-network traefik"; pass "check accepts own host-network traefik"
out=$(lf traefik status 2>&1); { echo "$out" | has 'network host'; } || { echo "$out"; die "status shows host network"; }; pass "status shows host network"
lf traefik setup --no-host-network >/dev/null 2>&1 || die "traefik back to published ports"
expect who.test / "Hostname"
pass "traefik back to published ports"

echo "== remove"
lf sites rm who -y
lf ls | has who && die "who still listed" || pass "site removed"

echo "== firewall"
# deploy has no sudo here, so these go through root's key login.
ufw_added() { docker exec "$NAME" ufw show added; }
{ lf firewall -s box 2>&1 | has "firewall on box: off"; } || die "firewall status"; pass "firewall status shows off"
lf firewall allow 5432 --from 10.0.0.0/8 -s box >/dev/null
{ ufw_added | has -x "ufw allow from 10.0.0.0/8 to any port 5432"; } || die "firewall allow"; pass "firewall allow --from"
lf firewall enable -s box >/dev/null 2>&1 || lf firewall enable -s box --force >/dev/null
[ "$(docker exec "$NAME" ufw status | head -1)" = "Status: active" ] || die "firewall enable"; pass "firewall enable keeps ssh"
out=$(lf firewall deny 22 -s box 2>&1) && die "deny ssh refused"
{ grep -q "blocks ssh port 22" <<<"$out"; } || die "deny ssh refused: $out"; pass "deny ssh refused"
lf firewall update 1 --action deny -s box >/dev/null
{ ufw_added | head -2 | has -x "ufw deny from 10.0.0.0/8 to any port 5432"; } || die "firewall update"; pass "firewall update moves a deny first"
{ lf firewall -s box --json | has '"action": "deny"'; } || die "firewall --json"; pass "firewall status --json"
lf firewall rm "deny from 10.0.0.0/8 to any port 5432" -s box -y >/dev/null
{ ! ufw_added | has 5432; } || die "firewall rm"; pass "firewall rm"
lf firewall disable -s box -y >/dev/null
[ "$(docker exec "$NAME" ufw status | head -1)" = "Status: inactive" ] || die "firewall disable"; pass "firewall disable"
ssh -F "$SRV_SSH_CONFIG" -o BatchMode=yes box true || die "ssh after firewall"; pass "ssh still works"

echo "== history and undo"
out=$(lf history -s box -n 100 2>&1)
for want in "created user deploy" "installed traefik" "deploy site release" "ufw allow from 10.0.0.0/8"; do
  { grep -q "$want" <<<"$out"; } || { echo "$out"; die "history shows: $want"; }
done; pass "history shows setup, traefik, deploys and firewall"
lf firewall allow 7000 -s box >/dev/null
lf undo -s box -y >/dev/null 2>&1 || die "undo firewall allow"
{ ! ufw_added | has 7000; } || die "undo removes the rule"; pass "undo removes a firewall rule"
{ lf history -s box 2>&1 | has "undone"; } || die "history marks undone"; pass "history marks the step undone"
cd "$WORK/site"
echo '<h1>v3</h1>' > dist/index.html
lf deploy -y >/dev/null 2>&1
expect site.test / v3
lf undo -y >/dev/null 2>&1 || die "undo redeploy"
expect site.test / v1
pass "undo of a redeploy brings the previous release back"
mkdir -p "$WORK/und/dist" && cd "$WORK/und" && echo '<h1>und</h1>' > dist/index.html
lf deploy -d und.test -y >/dev/null 2>&1
expect und.test / und
lf undo -y >/dev/null 2>&1 || die "undo new site"
{ ! lf ls | has und && ! docker exec "$NAME" test -e /opt/srv/sites/und; } || die "undo removes a new site"; pass "undo removes a new site"
cd "$WORK/app"
lf env GREETING=undo -y >/dev/null 2>&1
expect app.test / "app undo"
lf undo -y >/dev/null 2>&1 || die "undo env"
expect app.test / "app world"
pass "undo of env restores .env"
# Backups are pruned to the newest 10 per file, and the one undo needs survives.
docker exec "$NAME" sh -c 'cd /opt/srv/sites/app && for i in $(seq 1 12); do cp -p .env ..env.srv-old-$i; done'
lf env GREETING=prune -y >/dev/null 2>&1
expect app.test / "app prune"
n=$(docker exec "$NAME" sh -c 'ls -A /opt/srv/sites/app | grep -c "^\.\.env\.srv-"')
[ "$n" -le 10 ] || die "backups pruned (have $n)"
lf undo -y >/dev/null 2>&1 || die "undo env after pruning"
expect app.test / "app world"
pass "old backups are pruned, undo still works"
# A new site in a dir that already held files: undo removes only what landfall wrote.
docker exec "$NAME" sh -c 'mkdir -p /opt/srv/sites/pre && echo mine > /opt/srv/sites/pre/notes.txt && chown -R deploy /opt/srv/sites/pre'
mkdir -p "$WORK/pre/dist" && cd "$WORK/pre" && echo '<h1>pre</h1>' > dist/index.html
lf deploy -d pre.test -y >/dev/null 2>&1
expect pre.test / pre
lf undo -y >/dev/null 2>&1 || die "undo site in existing dir"
docker exec "$NAME" sh -c 'd=/opt/srv/sites/pre; [ "$(cat $d/notes.txt)" = mine ] && [ ! -e $d/site.json ] && [ ! -e $d/releases ] && [ ! -e $d/current ]' \
  || die "undo keeps foreign files"
pass "undo of a site in an existing dir keeps what was there"
docker exec "$NAME" rm -rf /opt/srv/sites/pre
cd "$WORK/app"
lf traefik setup --no-staging >/dev/null 2>&1
{ ! docker exec "$NAME" docker inspect traefik | has acme-staging; } || die "traefik left staging"
lf undo -y >/dev/null 2>&1 || die "undo traefik setup"
{ docker exec "$NAME" docker inspect traefik | has acme-staging; } || die "undo restores traefik config"; pass "undo restores the traefik config"
# No TTY and no -y: shows what it would do, then cancels.
out=$(lf undo 1 -s box </dev/null 2>&1) && die "undo without -y cancels"
{ grep -q "later runs build on it" <<<"$out" && grep -q "created user deploy" <<<"$out"; } || { echo "$out"; die "undo preview"; }
pass "undo previews and needs a yes"
cd "$WORK/app"
lf start -y >/dev/null 2>&1
{ ! lf history -s box -n 1 --json | has '"undo"'; } || die "start on a running site is not reversible"
lf stop -y >/dev/null 2>&1 && lf undo -y >/dev/null 2>&1 || die "undo stop"
expect app.test / "app world"
pass "start/stop only journal an undo when they changed something"
lf firewall enable -s box >/dev/null 2>&1 || lf firewall enable -s box --force >/dev/null
ref=$(lf history -s box -n 100 --json | node --input-type=module -e 'const runs = JSON.parse((await import("node:fs")).readFileSync(0, "utf8"));
for (const r of runs) { const i = r.steps.findIndex((s) => /^ufw allow 22\/tcp/.test(s.what) && !s.undone); if (i >= 0) { console.log(`${r.n}.${i + 1}`); break; } }')
[ -n "$ref" ] || die "find the ssh rule step"
out=$(lf undo "$ref" -s box -y 2>&1) && die "undo refuses to drop the ssh rule"
{ grep -q "lock you out" <<<"$out" && ufw_added | has "22/tcp"; } || { echo "$out"; die "undo ssh guard"; }
pass "undo refuses to remove the ssh rule while ufw is on"

echo "== web dashboard"
UI_PORT=${UI_PORT:-4799}
# node itself, not the lf function: $! of a backgrounded function is a subshell that kill leaves node behind.
node "$ROOT/dist/cli.mjs" ui --port "$UI_PORT" --no-open >"$WORK/ui.log" 2>&1 &
UI_PID=$!
for _ in $(seq 1 30); do [ -s "$SRV_CONFIG_DIR/ui-token" ] && curl -s "http://127.0.0.1:$UI_PORT/" >/dev/null && break; sleep 0.2; done
UI="http://127.0.0.1:$UI_PORT"
JAR="$WORK/cookies"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$UI/api/state")" = 401 ] || die "ui needs the login link"
curl -s -c "$JAR" -o /dev/null "$UI/login?t=$(cat "$SRV_CONFIG_DIR/ui-token")"
[ "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -H 'Host: evil.test' "$UI/api/state")" = 403 ] || die "ui refuses a foreign Host"
{ curl -s -b "$JAR" "$UI/" | has "<title>landfall</title>"; } || die "ui serves the page"
{ curl -s -b "$JAR" "$UI/api/state" | has '"name":"box"'; } || die "ui lists servers"
{ curl -s -b "$JAR" "$UI/api/servers/box" | has '"ready":true'; } || die "ui reads a server"
job=$(curl -s -b "$JAR" -H 'content-type: application/json' -d '{"argv":["ls","-s","box"],"server":"box"}' "$UI/api/jobs" | node --input-type=module -e 'console.log(JSON.parse((await import("node:fs")).readFileSync(0, "utf8")).id)')
{ curl -s -N --max-time 30 -b "$JAR" "$UI/api/jobs/$job/events" | has '"code":0'; } || die "ui runs a job and streams it"
{ curl -s -b "$JAR" "$UI/api/jobs/$job" | has 'app'; } || die "ui job output"
{ curl -s -b "$JAR" "$UI/api/servers/box/facts" | has '"pkg":"apk"'; } || die "ui reads facts"
{ curl -s -b "$JAR" "$UI/api/fs?path=$WORK/free" | has '"kind":"static"'; } || die "ui browses folders"
mkdir -p "$WORK/up" && echo '<h1>up</h1>' > "$WORK/up/index.html"
up=$(curl -s -b "$JAR" -F "file=@$WORK/up/index.html" -F "path=up/index.html" "$UI/api/upload")
{ echo "$up" | has '"kind":"static"'; } || { echo "$up"; die "ui takes an upload"; }
upath=$(echo "$up" | node --input-type=module -e 'console.log(JSON.parse((await import("node:fs")).readFileSync(0, "utf8")).path)')
job=$(curl -s -b "$JAR" -H 'content-type: application/json' -d '{"argv":["deploy","-y","-s","box","-n","up","-d","up.test","--no-save"],"server":"box","cwd":"'"$upath"'"}' "$UI/api/jobs" | node --input-type=module -e 'console.log(JSON.parse((await import("node:fs")).readFileSync(0, "utf8")).id)')
{ curl -s -N --max-time 60 -b "$JAR" "$UI/api/jobs/$job/events" | has '"code":0'; } || die "ui deploys an upload"
expect up.test / up
kill "$UI_PID"; wait "$UI_PID" 2>/dev/null || true
pass "web dashboard: login, host check, servers, jobs"

echo "== undo everything"
lf undo --all -s box -y >"$WORK/undo.log" 2>&1 || { cat "$WORK/undo.log"; die "undo --all"; }
docker exec "$NAME" sh -c '! id deploy 2>/dev/null && [ ! -e /opt/srv/sites ] && [ ! -e /etc/ssh/sshd_config.d/00-srv.conf ]' \
  || die "undo --all removes user, layout and hardening"
{ ! docker exec "$NAME" docker network inspect web >/dev/null 2>&1 && [ -z "$(docker exec "$NAME" docker ps -aq)" ]; } \
  || die "undo --all removes containers and network"
# The deploy user is gone now, so look at the journal directly.
{ docker exec "$NAME" grep -q "$(printf '\tundo\t')" /opt/srv/journal.log; } || die "journal kept"
pass "undo --all leaves the server as it was, journal kept"

echo "== fresh server with password"
FRESH_PORT=${FRESH_PORT:-2223}
docker rm -f "$NAME-fresh" >/dev/null 2>&1 || true
docker run -d --privileged --name "$NAME-fresh" -p "$FRESH_PORT:22" -e ROOT_PASSWORD=hunter2 srv-e2e >/dev/null
for _ in $(seq 1 30); do docker exec "$NAME-fresh" docker info >/dev/null 2>&1 && break; sleep 1; done
# Things setup must not break: a password user and a service on port 80.
docker exec "$NAME-fresh" sh -c 'adduser -D alice && echo alice:pw | chpasswd' >/dev/null 2>&1
docker exec -d "$NAME-fresh" nc -lk -p 80
printf '#!/bin/sh\necho hunter2\n' > "$WORK/askpass" && chmod +x "$WORK/askpass"
mkdir -p "$WORK/home"
# server add: password from stdin, ssh config that does not exist yet, then an existing key file without .pub.
NEWCFG="$WORK/new/ssh_config"
# Without an ssh config file, ssh uses the real ~/.ssh/known_hosts: drop this throwaway port's key before and after.
forget_fresh() { ssh-keygen -R "[127.0.0.1]:$FRESH_PORT" >/dev/null 2>&1 || true; }
forget_fresh
echo hunter2 | HOME="$WORK/home2" SRV_SSH_CONFIG="$NEWCFG" node "$ROOT/dist/cli.mjs" server add plain --host 127.0.0.1 --port "$FRESH_PORT" --password-stdin >/dev/null 2>&1 \
  || die "server add with password"
[ "$(ssh -F "$NEWCFG" -o BatchMode=yes plain "id -un")" = root ] || die "ssh plain"; pass "server add installs a key with the password and creates the ssh config"
rm "$WORK/home2/.ssh/srv_plain.pub"
HOME="$WORK/home2" SRV_SSH_CONFIG="$NEWCFG" node "$ROOT/dist/cli.mjs" server add keyed --host 127.0.0.1 --port "$FRESH_PORT" -i "$WORK/home2/.ssh/srv_plain" </dev/null >/dev/null 2>&1 \
  || die "server add with a key file"
{ [ "$(ssh -F "$NEWCFG" -o BatchMode=yes keyed "id -un")" = root ] && grep -q "srv_plain$" "$NEWCFG"; } || die "ssh keyed"; pass "server add logs in with a given key file"
lf server rm plain -y >/dev/null 2>&1; lf server rm keyed -y >/dev/null 2>&1; forget_fresh
# Same steps as the dashboard: install the key with the password, then check and apply with the key only.
# HOME keeps the generated ~/.ssh/srv_fresh out of the real home; askpass types the password.
FRESH=(setup fresh --host 127.0.0.1 --port "$FRESH_PORT")
HOME="$WORK/home" SSH_ASKPASS="$WORK/askpass" SSH_ASKPASS_REQUIRE=force \
  node "$ROOT/dist/cli.mjs" "${FRESH[@]}" --key-only -y </dev/null >/dev/null 2>&1 || die "setup --key-only"
docker exec "$NAME-fresh" test ! -e /opt/srv || die "--key-only changed nothing else"; pass "--key-only installs only the key"
{ HOME="$WORK/home" node "$ROOT/dist/cli.mjs" "${FRESH[@]}" --check </dev/null 2>&1 | has "key login works"; } \
  || die "check uses the installed key"; pass "check uses the installed key"
HOME="$WORK/home" node "$ROOT/dist/cli.mjs" "${FRESH[@]}" --no-firewall -y </dev/null 2>"$WORK/fresh.log" \
  || { cat "$WORK/fresh.log"; die "fresh setup"; }
cat "$WORK/fresh.log"
{ grep -q "skipping traefik: port 80 is in use by nc" "$WORK/fresh.log"; } || die "traefik skipped on busy port 80"; pass "traefik skipped on busy port 80"
{ ! docker exec "$NAME-fresh" docker inspect traefik >/dev/null 2>&1 && docker exec "$NAME-fresh" netstat -ltnp | has ':80 .*nc'; } || die "port 80 service untouched"; pass "port 80 service untouched"
{ docker exec "$NAME-fresh" sshd -T | grep -x >/dev/null 'passwordauthentication yes'; } || die "hardening skipped for alice"; pass "hardening skipped for password user alice"
HOME="$WORK/home" node "$ROOT/dist/cli.mjs" setup fresh --no-traefik --no-firewall --force -y </dev/null >/dev/null 2>&1 || die "setup --force"
[ -f "$WORK/home/.ssh/srv_fresh" ] || die "key generated"; pass "key generated"
# Host block holds an absolute key path: HOME differs from the passwd home here.
[ "$(ssh -F "$SRV_SSH_CONFIG" -o BatchMode=yes fresh "id -un")" = deploy ] || die "ssh fresh as deploy"; pass "ssh fresh logs in as deploy"
{ docker exec "$NAME-fresh" sshd -T | grep -x >/dev/null 'passwordauthentication no'; } || die "password auth disabled"; pass "password auth disabled"

echo; pass "all e2e checks"
