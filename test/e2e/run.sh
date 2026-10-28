#!/usr/bin/env bash
# End-to-end test against a throwaway "server" container (sshd + dockerd).
# Exercises setup → traefik → static/dockerfile/image/compose deploys → rollback → env → adopt → rm.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/landfall-e2e.XXXXXX")
NAME=landfall-e2e
SSH_PORT=${SSH_PORT:-2222}
HTTPS_PORT=${HTTPS_PORT:-18443}

cleanup() {
  [ -z "${UI_PID:-}" ] || kill "$UI_PID" 2>/dev/null || true
  [ -z "${TUNNEL_PID:-}" ] || kill "$TUNNEL_PID" 2>/dev/null || true
  [ "${KEEP:-}" = 1 ] && { echo "kept container $NAME and $WORK"; return; }
  docker rm -fv "$NAME" "$NAME-fresh" "$NAME-deb" "$NAME-fedora" "$NAME-rocky" >/dev/null 2>&1 || true
  [ -z "${FRESH_PORT:-}" ] || ssh-keygen -R "[127.0.0.1]:$FRESH_PORT" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

pass() { printf '\033[32mPASS\033[0m %s\n' "$*"; }
die() { printf '\033[31mFAIL\033[0m %s\n' "$*"; exit 1; }

# E2E_ONLY="volumes ui" runs setup, then only these sections and the ones whose sites they use.
SECTIONS="static spa dockerfile secrets environments node image compose volumes domains main updates stats traffic prune
  system security traefik remove firewall undo ui undo-all legacy uninstall fresh debian dnf"
needs() {
  case $1 in
    environments) echo secrets ;;
    updates | traffic | prune) echo dockerfile ;;
    domains | traefik | remove) echo image ;;
    # main's traefik setup is the later run that keeps undo from reverting setup's traefik.
    undo) echo static dockerfile main firewall ;;
    ui) echo dockerfile image domains ;;
  esac
}
ONLY=" "
for s in ${E2E_ONLY//,/ }; do
  [ "$s" = setup ] || [[ " $(echo $SECTIONS) " == *" $s "* ]] || die "E2E_ONLY: no section $s (setup $(echo $SECTIONS))"
  ONLY+="$s $(needs "$s") "
done
want() { [ -z "${E2E_ONLY:-}" ] || [[ "$ONLY" == *" $1 "* ]]; }
# Not grep -q: it stops reading at the first match, and under pipefail the writer's SIGPIPE fails the check.
has() { grep "$@" >/dev/null; }
lf() { node "$ROOT/dist/cli.mjs" "$@"; }
srv() { docker exec "$NAME" "$@"; }
ufw_added() { docker exec "$NAME" ufw show added; }
get() { curl -sk --max-time 10 --resolve "$1:$HTTPS_PORT:127.0.0.1" "https://$1:$HTTPS_PORT${2:-/}"; }
# code <host> [/path] [curl args...]
code() {
  local host=$1 path=/; shift
  [[ ${1-} == /* ]] && { path=$1; shift; }
  curl -sk -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$host:$HTTPS_PORT:127.0.0.1" "$@" "https://$host:$HTTPS_PORT$path"
}
# Traefik answers only hosts it has a certificate for, and Let's Encrypt cannot issue one for
# *.test: give it a self-signed one, the way users drop their own certs into dynamic/.
trust_test_hosts() {
  docker exec "$NAME" sh -c 'd=/opt/landfall/traefik/dynamic && cp /e2e/cert.pem /e2e/key.pem $d/ &&
    printf "tls:\n  certificates:\n    - certFile: /etc/traefik/dynamic/cert.pem\n      keyFile: /etc/traefik/dynamic/key.pem\n" > $d/e2e.yml'
}
expect() { # expect <host> <path> <needle>
  for _ in $(seq 1 20); do get "$1" "$2" | has "$3" && { pass "https://$1$2 contains '$3'"; return; }; sleep 1; done
  echo "got: $(get "$1" "$2" | head -c 300)"; die "https://$1$2 does not contain '$3'"
}

ssh-keygen -q -t ed25519 -N "" -f "$WORK/key"
export LANDFALL_CONFIG_DIR="$WORK/cfg" LANDFALL_SSH_CONFIG="$WORK/ssh_config"
printf 'Host *\n  UserKnownHostsFile %s/known_hosts\n' "$WORK" > "$LANDFALL_SSH_CONFIG"

docker build -q -t landfall-e2e "$ROOT/test/e2e" >/dev/null
docker rm -fv "$NAME" >/dev/null 2>&1 || true
docker run -d --privileged --name "$NAME" -p "$SSH_PORT:22" -p "$HTTPS_PORT:443" \
  -e AUTHORIZED_KEY="$(cat "$WORK/key.pub")" landfall-e2e >/dev/null
for _ in $(seq 1 30); do docker exec "$NAME" docker info >/dev/null 2>&1 && break; sleep 1; done

echo "== setup"
lf setup box --host 127.0.0.1 --port "$SSH_PORT" --key "$WORK/key" --email test@example.com --staging --no-firewall -y
trust_test_hosts
{ docker exec "$NAME" grep -q "sniStrict: true" /opt/landfall/traefik/dynamic/landfall.yml; } || die "strict tls written"; pass "strict tls written"
[ "$(ssh -F "$LANDFALL_SSH_CONFIG" -o BatchMode=yes box "id -un")" = deploy ] || die "ssh box not deploy"; pass "ssh box logs in as deploy"
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
printf 'Host ownbox\n  HostName 127.0.0.1\n  Port %s\n  User root\n  IdentityFile %s/gone\n' "$SSH_PORT" "$WORK" >> "$LANDFALL_SSH_CONFIG"
lf server add ownbox -i "$WORK/key" >"$WORK/own.log" 2>&1 || { cat "$WORK/own.log"; die "server add own alias"; }
{ has -x "  IdentityFile $WORK/key" "$LANDFALL_SSH_CONFIG" && ! has "$WORK/gone" "$LANDFALL_SSH_CONFIG" && [ -e "$LANDFALL_SSH_CONFIG.landfall-bak" ]; } \
  || { cat "$LANDFALL_SSH_CONFIG"; die "own Host block gets the key"; }
[ "$(ssh -F "$LANDFALL_SSH_CONFIG" -o BatchMode=yes ownbox id -un)" = root ] || die "ssh ownbox with the added key"
{ lf server config ownbox | has "your own"; } || die "server config shows the Host block"
pass "server add fixes the key of an own Host block, server config shows it"
lf server rm ownbox -y >/dev/null

[ "${STOP_AFTER_SETUP:-}" = 1 ] && exit 0
if want static; then echo "== static"
mkdir -p "$WORK/site/dist" && cd "$WORK/site"
echo '<h1>v1</h1>' > dist/index.html
echo old > dist/old.txt
echo secret > dist/notes.txt && echo dist/notes.txt > .landfallignore
echo draft > dist/draft.html && echo draft.html > dist/.gitignore
out=$(lf deploy -d site.test -y 2>&1) || { echo "$out"; die "deploy static site"; }
has "upload: 4 files" <<<"$out" || { echo "$out"; die "first deploy says what it uploads"; }
expect site.test / v1
[ "$(code site.test /notes.txt)" = 404 ] && [ "$(code site.test /draft.html)" = 200 ] || die ".landfallignore leaves files out, .gitignore only with --gitignore"
pass ".landfallignore leaves files out, .gitignore only with --gitignore"
{ grep -q '"site.test"' .landfall.json; } || die ".landfall.json written"; pass ".landfall.json written"
echo '<h1>v2</h1>' > dist/index.html   # same second as v1 on purpose: release ids must not collide
rm dist/old.txt
out=$(lf deploy --gitignore -y 2>&1) || { echo "$out"; die "redeploy static site"; }
has "only what changed" <<<"$out" || die "redeploy sends only changes"; pass "redeploy sends only changes"
expect site.test / v2
[ "$(code site.test /draft.html)" = 404 ] && [ "$(code site.test /notes.txt)" = 404 ] && grep -q '"gitignore": true' .landfall.json || die "--gitignore with rsync, saved"
pass "--gitignore leaves out what .gitignore ignores, also with rsync, and is saved"
[ "$(code site.test /nope)" = 404 ] || die "unknown path 404s"; pass "unknown path 404s"
[ "$(code site.test /old.txt)" = 404 ] || die "a file deleted locally is gone after redeploy"; pass "a file deleted locally is gone after redeploy"
lf rollback -y
expect site.test / v1
[ "$(code site.test /old.txt)" = 200 ] || die "the older release keeps its files"; pass "the older release keeps its files"
lf release rm -y >/dev/null || die "release rm"
expect site.test / v1
[ "$(docker exec "$NAME" ls /opt/landfall/sites/site/releases | wc -l)" -eq 1 ] || die "release rm keeps only the live release"
{ ! lf rollback -y >/dev/null 2>&1; } || die "rollback to a removed release"
pass "release rm deletes all but the live release"
# A host no site serves has no certificate: the handshake fails, no 404 and no wrong certificate.
[ "$(code nope.invalid)" = 000 ] || die "unknown host answered"; pass "unknown host fails the handshake"
{ lf ls | has site; } || die "sites list shows site"; pass "sites list shows site"
out=$(lf deploy -d 'site.test`)' -y 2>&1) && die "deploy accepts a bad domain"
echo "$out" | has uploading && die "deploy uploads before checking the domain"
lf deploy --keep abc -y >/dev/null 2>&1 && die "deploy accepts --keep abc"
pass "deploy rejects bad input"
fi

if want spa; then echo "== spa"
mkdir -p "$WORK/spa/build" && cd "$WORK/spa"
echo '<div id=app>spa</div>' > build/index.html
lf deploy -d spa.test --spa -y
expect spa.test /deep/link spa
fi

if want dockerfile; then echo "== dockerfile"
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
lf env 2>/dev/null | grep -qx 'GREETING=•••••••• (5)' || die "lf env hides values"
lf env --reveal | grep -qx 'GREETING=world' || die "lf env --reveal"
[ "$(lf env --keys)" = GREETING ] || die "lf env --keys"
lf env --pull "$WORK/pulled.env" -y >/dev/null && grep -qx 'GREETING=world' "$WORK/pulled.env" || die "lf env --pull"
pass "lf env hides, reveals, lists and pulls"
# A release that does not come up: the site is put back at once, .env too, and the release goes.
cp Dockerfile "$WORK/Dockerfile.ok"
printf 'HEALTHCHECK --interval=1s --retries=1 CMD false\n' >> Dockerfile
{ ! lf deploy -e GREETING=broken -y >"$WORK/broken.log" 2>&1; } || die "a release that does not start fails the deploy"
{ has "is back as it was" "$WORK/broken.log"; } || { cat "$WORK/broken.log"; die "failed start puts the site back"; }
expect app.test / "app world"
lf env --reveal | grep -qx 'GREETING=world' || die ".env put back"
[ "$(docker exec "$NAME" ls /opt/landfall/sites/app/releases | wc -l)" -eq 1 ] || die "failed release removed"
{ lf history 2>&1 | has "undid: deploy app release"; } || die "the rolled back deploy is marked undone"
pass "a release that does not start goes back to the one before, with its .env"
cp "$WORK/Dockerfile.ok" Dockerfile
docker exec "$NAME" mkdir /opt/landfall/sites/.app.deploying
{ ! lf deploy -y >"$WORK/locked.log" 2>&1 && has "another deploy or change of app is running" "$WORK/locked.log"; } || { cat "$WORK/locked.log"; die "deploy lock"; }
docker exec "$NAME" rmdir /opt/landfall/sites/.app.deploying
pass "one deploy of a site at a time"
lf deploy --build-local -y >"$WORK/local.log" 2>&1 || { cat "$WORK/local.log"; die "deploy --build-local"; }
{ has "built here, sent" "$WORK/local.log" && ! grep -q "building app$" "$WORK/local.log"; } || { cat "$WORK/local.log"; die "--build-local builds here"; }
expect app.test / "app world"
pass "--build-local builds the image here and sends it"
fi

if want secrets; then echo "== secrets"
# A file under /run/secrets, read once at start: changing it must restart the service.
mkdir -p "$WORK/vault" && cd "$WORK/vault"
cat > Dockerfile <<'EOF'
FROM busybox:1.37
EXPOSE 8000
CMD sh -c 'mkdir -p /www && echo "token $(cat /run/secrets/TOKEN 2>/dev/null || echo none)" > /www/index.html && httpd -f -p 8000 -h /www'
EOF
lf deploy -d vault.test -y >/dev/null 2>&1 || die "vault deploy"
expect vault.test / "token none"
lf secret TOKEN=s3cret -y >/dev/null 2>&1 || die "lf secret"
expect vault.test / "token s3cret"
lf secret TOKEN=rotated -y >/dev/null 2>&1 || die "lf secret rotates"
expect vault.test / "token rotated"
lf secret | grep -q '^TOKEN' || die "lf secret lists"
lf secret --json | grep -q rotated && die "lf secret --json shows a value"
lf undo -y >/dev/null 2>&1 || die "undo secret"
expect vault.test / "token s3cret"
lf deploy -y >/dev/null 2>&1 || die "vault redeploy"
expect vault.test / "token s3cret"
lf secret -u TOKEN -y >/dev/null 2>&1 || die "lf secret -u"
expect vault.test / "token none"
pass "lf secret mounts, rotates, undoes and survives a redeploy"
fi

if want environments; then echo "== environments"
# The same folder deployed again as its own site, with its own secrets.
lf deploy -E staging -d vault-staging.test -y >/dev/null 2>&1 || die "deploy -E staging"
expect vault-staging.test / "token none"
LANDFALL_ENV=staging lf secret TOKEN=stg -y >/dev/null 2>&1 || die "lf secret in an environment"
expect vault-staging.test / "token stg"
expect vault.test / "token none"
grep -q '"vault-staging.test"' .landfall.json && grep -q '"environments"' .landfall.json || die "environment saved in .landfall.json"
lf deploy -y >/dev/null 2>&1 || die "vault redeploy keeps environments"
grep -q '"environments"' .landfall.json || die "a deploy without -E keeps environments"
lf sites rm vault-staging -y >/dev/null 2>&1 || die "sites rm vault-staging"
{ ! lf ls | has vault-staging; } || die "staging removed"
expect vault.test / "token none"
pass "environments deploy and manage their own site"
# compose.staging.yaml layers on compose.yaml for -E staging only, as docker compose -f a -f b would.
mkdir -p "$WORK/layers" && cd "$WORK/layers"
printf 'services:\n  web:\n    image: busybox:1.37\n    environment: { MODE: base }\n    command: sh -c "mkdir -p /www && echo mode $$MODE > /www/index.html && httpd -f -p 8000 -h /www"\n    x-landfall: { port: 8000 }\n' > compose.yaml
printf 'services:\n  web:\n    environment: { MODE: staging }\n' > compose.staging.yaml
lf deploy -d layers.test -y >/dev/null 2>&1 || die "deploy layers"
lf deploy -E staging -d layers-staging.test -y >/dev/null 2>&1 || die "deploy layers -E staging"
expect layers.test / "mode base"
expect layers-staging.test / "mode staging"
docker exec "$NAME" sh -c 'cd /opt/landfall/sites/layers-staging/current && docker compose config' | has "MODE: staging" || die "the release's compose.yaml holds the merge"
lf sites rm layers -y >/dev/null 2>&1; lf sites rm layers-staging -y >/dev/null 2>&1
pass "compose.<env>.yaml layers on compose.yaml"
fi

if want node; then echo "== node"
# No Dockerfile: landfall writes one; the build runs on the server, the app gets PORT and HOST.
mkdir -p "$WORK/node" && cd "$WORK/node"
echo '{"name":"node-app","scripts":{"build":"echo built > built.txt"}}' > package.json
echo 'require("http").createServer((q, r) => r.end(`node ${process.env.PORT} ${require("fs").readFileSync("built.txt", "utf8").trim()} v1`)).listen(process.env.PORT, process.env.HOST)' > server.js
out=$(lf deploy -d node.test --start "node server.js" --port 4000 -y 2>&1) || { echo "$out"; die "node deploy"; }
expect node.test / "node 4000 built v1"
{ grep '"start": "node server.js"' .landfall.json >/dev/null; } || die "start saved"; pass "start command saved"
sed -i.bak 's/v1/v2/' server.js && rm server.js.bak
lf deploy -y >/dev/null
expect node.test / "node 4000 built v2"
lf init >/dev/null
{ grep '^CMD node server.js$' Dockerfile >/dev/null && grep 'init: true' compose.yaml >/dev/null; } || die "init writes the Dockerfile"; pass "init writes the Dockerfile"
fi

if want image; then echo "== image"
cd "$WORK"
lf deploy --no-save -n who --image traefik/whoami:v1.11 --port 80 -d who.test -y
expect who.test / "Hostname"
{ lf sites info who | has who-app-1; } || die "sites info"; pass "sites info"
{ lf logs who -n 5 >/dev/null; } || die "logs"; pass "logs"
fi

if want compose; then echo "== compose"
# lf init writes the files; the same compose.yaml runs locally and on the server.
mkdir -p "$WORK/stack" && cd "$WORK/stack"
stack_app() { printf 'FROM busybox:1.37\nEXPOSE 8000\nCMD sh -c "mkdir -p /www && echo stack %s > /www/index.html && httpd -f -p 8000 -h /www"\n' "$1" > Dockerfile; }
stack_app v1
lf init --postgres >/dev/null || die "init"
{ has "127.0.0.1:8000:8000" compose.override.yaml && has "x-landfall" compose.yaml; } || die "init writes compose files"
cp compose.yaml "$WORK/c1" && cp compose.override.yaml "$WORK/o1"
{ lf init 2>&1 | has "nothing to change"; } && cmp -s compose.yaml "$WORK/c1" && cmp -s compose.override.yaml "$WORK/o1" || die "init again changes nothing"
pass "init writes compose.yaml and compose.override.yaml, a second init changes nothing"
# compose.yaml requires POSTGRES_PASSWORD: -e on the first deploy must satisfy it.
lf deploy -d stack.test -e POSTGRES_PASSWORD=pw1 -y >"$WORK/stack.log" 2>&1 || { cat "$WORK/stack.log"; die "deploy compose site"; }
expect stack.test / "stack v1"
[ -z "$(srv docker port stack-db-1)" ] && [ -z "$(srv docker port stack-app-1)" ] || die "compose.override.yaml ports stay local"
{ ! srv docker inspect -f '{{json .NetworkSettings.Networks}}' stack-db-1 | has '"web"'; } || die "db stays off the proxy network"
pass "only the routed service is on Traefik's network, nothing is published"
psql() { srv docker exec stack-db-1 psql -U app -tAc "$1"; }
for _ in $(seq 1 30); do psql "select 1" >/dev/null 2>&1 && break; sleep 1; done
psql "create table t (x int); insert into t values (42)" >/dev/null
stack_app v2
lf deploy -y >/dev/null 2>&1 || die "redeploy compose site"
expect stack.test / "stack v2"
lf rollback -y >/dev/null 2>&1 || die "rollback compose site"
expect stack.test / "stack v1"
[ "$(psql "select x from t")" = 42 ] || die "data survives deploys and rollbacks"; pass "data survives deploys and rollbacks"
{ lf logs stack db -n 20 | has -i postgres; } || die "logs of one service"; pass "logs of one service"
lf restart stack db -y >/dev/null 2>&1 || die "restart one service"
lf sites rm stack -y >/dev/null 2>&1
{ srv docker volume ls -q | has -x stack_db; } || die "rm keeps the volume"
# The local .env is not sent unless asked, and then only what the project asks for.
printf 'POSTGRES_PASSWORD=pw1\nLOCAL_ONLY=x\n' > .env
{ ! lf deploy -y >"$WORK/local.log" 2>&1 && has -- "--local-env" "$WORK/local.log"; } || { cat "$WORK/local.log"; die "deploy without the local .env"; }
lf deploy --local-env -y >"$WORK/local.log" 2>&1 || { cat "$WORK/local.log"; die "deploy again with --local-env"; }
{ lf env stack --keys | has -x POSTGRES_PASSWORD && ! lf env stack --keys | has LOCAL_ONLY; } || die "--local-env takes only what is asked for"
rm .env; pass "deploy --local-env takes what the project asks for from the local .env, nothing else"
for _ in $(seq 1 30); do psql "select 1" >/dev/null 2>&1 && break; sleep 1; done
[ "$(psql "select x from t")" = 42 ] || die "a site deployed again finds its data"
lf sites rm stack --volumes -y >"$WORK/rmv.log" 2>&1 || { cat "$WORK/rmv.log"; die "sites rm --volumes"; }
{ ! srv docker volume ls -q | has -x stack_db; } || die "rm --volumes deletes it"
pass "sites rm keeps volumes, --volumes deletes them"
fi

if want volumes; then echo "== volumes"
mkdir -p "$WORK/vols/seed/sub" && cd "$WORK/vols"
printf 'services:\n  app:\n    image: busybox:1.37\n    command: sleep 3600\n    volumes: [data:/data]\nvolumes:\n  data:\n' > compose.yaml
lf deploy -n vols --no-domain -y >"$WORK/vols.log" 2>&1 || { cat "$WORK/vols.log"; die "deploy vols"; }
vol() { srv docker run --rm -v vols_data:/v busybox:1.37 sh -c "cd /v && $1"; }
vol 'echo old > old && chown -R 1000:1000 /v'
{ lf volumes vols | has 'app:/data'; } || die "volumes lists the mount"; pass "volumes lists the mount"
echo new > seed/new && echo x > seed/sub/x
lf volume push vols data seed -y >"$WORK/push.log" 2>&1 || { cat "$WORK/push.log"; die "volume push"; }
[ "$(vol 'find . -type f | sort | tr "\n" " "')" = "./new ./sub/x " ] || die "push replaces the contents"
[ "$(vol 'stat -c %u sub/x')" = 1000 ] || die "pushed files get the volume root's owner"
[ "$(srv docker inspect -f '{{.State.Running}}' vols-app-1)" = true ] || die "push starts the service again"
pass "volume push replaces the contents, owned like the volume, service running"
lf undo -s box -y >/dev/null 2>&1 || die "undo push"
[ "$(vol 'cat old')" = old ] && [ -z "$(vol 'ls new 2>/dev/null || true')" ] || die "undo restores the volume"; pass "undo restores the volume"
lf volume backup vols >/dev/null 2>&1 || die "volume backup"
lf volume pull vols data --into "$WORK/vols/out" >/dev/null 2>&1 && [ "$(cat "$WORK/vols/out/old")" = old ] || die "volume pull --into"
vol 'rm old'
lf volume restore vols data -y >/dev/null 2>&1 && [ "$(vol 'cat old')" = old ] || die "volume restore"
pass "volume backup, pull and restore"
lf volume add app:/cache --as cache >/dev/null 2>&1 && has 'cache:/cache' < compose.yaml || die "volume add writes compose.yaml"
lf deploy -n vols --no-domain -y >/dev/null 2>&1 && { lf volumes vols | has 'app:/cache'; } || die "volume add mounts it"
lf volume rm cache --data -y >/dev/null 2>&1 && ! has cache < compose.yaml && srv docker volume ls -q | has -x vols_cache || die "volume rm --data keeps a mounted volume"
lf deploy -n vols --no-domain -y >/dev/null 2>&1 && lf volume rm vols cache --data -y >/dev/null 2>&1 && ! { srv docker volume ls -q | has -x vols_cache; } || die "volume rm --data deletes an unused one"
lf undo -s box -y >/dev/null 2>&1 && { lf volumes vols | has unused; } || die "undo brings the deleted volume back"
pass "volume add and rm edit compose.yaml, --data deletes an unused volume, undo brings it back"
lf volume backup vols --schedule hourly --keep 2 >"$WORK/sched.log" 2>&1 || { cat "$WORK/sched.log"; die "volume backup --schedule"; }
{ lf volumes vols | has 'hourly, keep 2'; } && srv sh -c 'crontab -u deploy -l | grep -q "backups/backup.sh .*# landfall backup vols: hourly, keep 2"' || die "the schedule is a crontab line"
srv sh -c 'cd /opt/landfall/sites/vols/backups && for i in 1 2 3; do touch data-20200101-00000$i.tar.gz; done && sh backup.sh' || die "backup.sh runs by hand"
[ "$(srv sh -c 'ls /opt/landfall/sites/vols/backups | grep -c "^data-[0-9]*-[0-9]*\.tar\.gz$"')" = 2 ] && srv test ! -e /opt/landfall/sites/vols/backups/data-20200101-000002.tar.gz || die "backup.sh keeps the newest 2"
lf undo -s box -y >/dev/null 2>&1 && { lf volumes vols | has 'scheduled backups: none'; } || die "undo stops the schedule"
lf volume backup vols --schedule daily >/dev/null 2>&1 || die "volume backup --schedule daily"
pass "scheduled backups: a crontab line, backup.sh keeps the newest, undo stops it"
lf sites rm vols -y >/dev/null 2>&1
srv sh -c 'ls /opt/landfall/sites/vols/backups/data-*.tar.gz' >/dev/null && ! srv test -e /opt/landfall/sites/vols/site.json || die "rm keeps backups"
! srv sh -c 'crontab -u deploy -l 2>/dev/null | grep -q "landfall backup vols:"' || die "rm stops scheduled backups"
lf deploy -n vols --no-domain -y >/dev/null 2>&1 && { lf volumes vols | has 'newest'; } || die "a site deployed again finds its backups"
lf sites rm vols --volumes -y >/dev/null 2>&1 && ! srv test -e /opt/landfall/sites/vols || die "rm --volumes deletes the backups"
pass "sites rm keeps backups with the volumes, --volumes deletes both"
# A folder left out of the upload, named like an empty volume, fills it with --fill-volumes; one with data stays.
mkdir -p "$WORK/fill/data" && cd "$WORK/fill" && echo one > data/hi && echo /data/ > .landfallignore
printf 'services:\n  app:\n    image: busybox:1.37\n    command: sleep 3600\n    volumes: [data:/data]\nvolumes:\n  data:\n' > compose.yaml
lf deploy -n fill --no-domain -y >"$WORK/fill.log" 2>&1 && has -- "--fill-volumes" "$WORK/fill.log" || { cat "$WORK/fill.log"; die "deploy says how to fill"; }
fill() { srv docker run --rm -v fill_data:/v busybox:1.37 cat /v/hi 2>/dev/null || true; }
[ -z "$(fill)" ] || die "no fill without --fill-volumes"
lf deploy -n fill --no-domain --fill-volumes -y >"$WORK/fill.log" 2>&1 && [ "$(fill)" = one ] || { cat "$WORK/fill.log"; die "deploy --fill-volumes"; }
echo two > data/hi
lf deploy -n fill --no-domain --fill-volumes -y >/dev/null 2>&1 && [ "$(fill)" = one ] || die "--fill-volumes leaves a volume with data alone"
lf sites rm fill --volumes -y >/dev/null 2>&1
pass "deploy --fill-volumes fills an empty volume from its left-out folder, only while empty"
# Volumes live in the site's folder; one Docker keeps elsewhere (deployed before that) moves in, data and all.
mkdir -p "$WORK/vdir" && cd "$WORK/vdir"
printf 'services:\n  app:\n    image: busybox:1.37\n    command: sleep 3600\n    volumes: [data:/data]\nvolumes:\n  data:\n' > compose.yaml
vd=/opt/landfall/sites/vdir/volumes/data
srv sh -c 'docker volume create vdir_data >/dev/null && docker run --rm -v vdir_data:/v busybox:1.37 sh -c "echo old > /v/hi"' || die "an old volume"
lf deploy -n vdir --no-domain -y >"$WORK/vdir.log" 2>&1 && has "moving volume data" "$WORK/vdir.log" || { cat "$WORK/vdir.log"; die "deploy moves the volume into the folder"; }
[ "$(srv cat $vd/hi)" = old ] && [ "$(srv docker volume inspect -f '{{index .Options "device"}}' vdir_data)" = $vd ] || die "the volume lives in the site's folder"
srv docker exec vdir-app-1 sh -c 'echo new > /data/hi' && [ "$(srv cat $vd/hi)" = new ] || die "the container writes into the folder"
lf deploy -n vdir --no-domain -y >"$WORK/vdir.log" 2>&1 && ! has "moving volume" "$WORK/vdir.log" && [ "$(srv cat $vd/hi)" = new ] || { cat "$WORK/vdir.log"; die "a redeploy keeps it"; }
lf volumes vdir | has "/opt/landfall/sites/vdir/volumes" || die "lf volumes names the folder"
lf rollback vdir -y >/dev/null 2>&1 && lf undo -s box -y >/dev/null 2>&1 && [ "$(srv docker exec vdir-app-1 cat /data/hi)" = new ] || die "rollback and undo keep the folder's volume"
lf sites rm vdir -y >/dev/null 2>&1 && [ "$(srv cat $vd/hi)" = new ] && ! srv test -e /opt/landfall/sites/vdir/site.json || die "sites rm keeps the folder's volume"
lf deploy -n vdir --no-domain -y >/dev/null 2>&1 && [ "$(srv docker exec vdir-app-1 cat /data/hi)" = new ] || die "a site deployed again finds its volume"
lf sites rm vdir --volumes -y >/dev/null 2>&1 && ! srv test -e /opt/landfall/sites/vdir && ! { srv docker volume ls -q | has -x vdir_data; } || die "sites rm --volumes deletes the folder"
pass "volumes live in the site's folder: an older one moves in, rollback, undo and rm keep it"
# A port published on the server is refused before anything changes.
mkdir -p "$WORK/leaky" && cd "$WORK/leaky"
printf 'services:\n  db:\n    image: busybox:1.37\n    command: sleep 3600\n    ports: ["5433:5432"]\n  web:\n    image: traefik/whoami:v1.11\n    x-landfall: { port: 80 }\n' > compose.yaml
out=$(lf deploy -d leaky.test --no-save -y 2>&1) && die "deploy publishes a port"
{ has "publishes 5433:5432" <<<"$out" && ! srv test -e /opt/landfall/sites/leaky; } || { echo "$out"; die "published port refused"; }
pass "a published port is refused before any change"
# A Compose project started by hand behind landfall's Traefik, adopted.
srv sh -c 'mkdir -p /srv/ext2 && cd /srv/ext2 && cat > compose.yaml <<"EOF"
services:
  web:
    image: traefik/whoami:v1.11
    networks: [web]
    labels:
      - traefik.enable=true
      - traefik.docker.network=web
      - traefik.http.routers.ext2.rule=Host(`ext2.test`)
      - traefik.http.routers.ext2.entrypoints=websecure
      - traefik.http.routers.ext2.tls=true
networks:
  web:
    external: true
EOF
docker compose up -d >/dev/null 2>&1'
expect ext2.test / Hostname
{ lf ls | has "lf adopt"; } || die "ls offers adopt"
lf adopt ext2 -y >/dev/null 2>&1 || die "adopt"
{ lf ls | has -E 'ext2.*Up' && lf sites info ext2 | has /srv/ext2; } || die "adopted site listed"
lf restart ext2 -y >/dev/null 2>&1 || die "restart adopted"
expect ext2.test / Hostname
lf deploy -n ext2 --no-save -y >/dev/null 2>&1 && die "deploy over an adopted site"
lf sites rm ext2 -y >/dev/null 2>&1 || die "forget adopted"
{ srv test -f /srv/ext2/compose.yaml && ! srv test -e /opt/landfall/sites/ext2; } || die "rm forgets, keeps its folder"
pass "adopt makes a hand-run project a site; rm forgets it and keeps its folder"
# A plain compose.yaml (no x-landfall): the HTTP ports it publishes or exposes are routed, the rest stays inside.
mkdir -p "$WORK/auto" && cd "$WORK/auto"
cat > compose.yaml <<'EOF'
services:
  web:
    image: traefik/whoami:v1.11
    ports: ["8080:80"]
  api:
    image: traefik/whoami:v1.11
    command: ["--port", "9000", "--name", "api"]
    expose: ["9000"]
  db:
    image: busybox:1.37
    command: sleep 3600
    ports: ["5432:5432"]
EOF
cp compose.yaml "$WORK/auto.orig"
out=$(lf deploy -d auto.test -y 2>&1) || { echo "$out"; die "deploy plain compose"; }
{ has "web:80" <<<"$out" && has "api.auto.test" <<<"$out" && ! has "db:5432" <<<"$out"; } || { echo "$out"; die "deploy prints the route plan"; }
expect auto.test / Hostname
expect api.auto.test / "Name: api"
{ [ -z "$(srv docker port auto-web-1)" ] && [ -z "$(srv docker port auto-db-1)" ] && cmp -s compose.yaml "$WORK/auto.orig"; } \
  || die "published ports stay local, compose.yaml untouched"
pass "a plain compose.yaml is routed: main port on the domain, others on subdomains, nothing published"
# Leaving landfall: the release runs with plain docker compose.
srv sh -c 'cd /opt/landfall/sites/auto/current && docker compose up -d --force-recreate >/dev/null 2>&1' || die "docker compose up in current"
expect api.auto.test / "Name: api"
pass "docker compose up -d in current runs the site without landfall"
lf sites rm auto -y >/dev/null 2>&1
# A private port: never routed, reached with lf tunnel <site> <name>.
mkdir -p "$WORK/priv" && cd "$WORK/priv"
cat > compose.yaml <<'EOF'
services:
  web:
    image: busybox:1.37
    command: sh -c 'mkdir -p /a /b && echo site > /a/index.html && mkdir -p /b/admin && echo admin > /b/admin/index.html && httpd -p 80 -h /a && httpd -f -p 9000 -h /b'
    x-landfall: { port: 80, private: { admin: { port: 9000, path: /admin/ } } }
  ops:
    image: busybox:1.37
    command: sh -c 'mkdir -p /c && echo ops > /c/index.html && httpd -f -p 9100 -h /c'
    x-landfall: { private: { ops: 9100 } }
EOF
out=$(lf deploy -d priv.test --no-save -y 2>&1) || { echo "$out"; die "deploy private port"; }
has "lf tunnel <site> admin" <<<"$out" || { echo "$out"; die "deploy lists the private port"; }
expect priv.test / site
node "$ROOT/dist/cli.mjs" tunnel priv admin -l 18099 >"$WORK/tunnel.log" 2>&1 &
TUNNEL_PID=$!
for _ in $(seq 1 30); do curl -s http://127.0.0.1:18099/admin/ | has admin && break; sleep 0.5; done
got=$(curl -s http://127.0.0.1:18099/admin/ || true); kill $TUNNEL_PID 2>/dev/null || true; wait $TUNNEL_PID 2>/dev/null || true
[ "$got" = admin ] || { cat "$WORK/tunnel.log"; die "lf tunnel <site> <private name>"; }
has "localhost:18099/admin/" "$WORK/tunnel.log" || { cat "$WORK/tunnel.log"; die "lf tunnel prints the private port's path"; }
pass "a private port is not routed, lf tunnel priv admin opens it at its path"
# A service reached only privately: its name opens its private port, though its image exposes none.
node "$ROOT/dist/cli.mjs" tunnel priv ops -l 18098 >"$WORK/tunnel.log" 2>&1 &
TUNNEL_PID=$!
for _ in $(seq 1 30); do curl -s http://127.0.0.1:18098/ | has ops && break; sleep 0.5; done
got=$(curl -s http://127.0.0.1:18098/ || true); kill $TUNNEL_PID 2>/dev/null || true; wait $TUNNEL_PID 2>/dev/null || true
[ "$got" = ops ] || { cat "$WORK/tunnel.log"; die "lf tunnel <site> <private service>"; }
pass "lf tunnel priv ops opens the private port of a service with no routed one"
# A site the server does not have: a landfall error naming its sites, never a raw cd error.
out=$(lf logs prvi -n 5 2>&1) && die "logs of a missing site fails"
{ has "no site prvi" <<<"$out" && has "did you mean priv? lf logs priv -n 5" <<<"$out" && ! has "No such file" <<<"$out"; } || { echo "$out"; die "logs of a missing site"; }
out=$(lf tunnel prvi admin 2>&1) && die "tunnel to a missing site fails"
has "no site prvi" <<<"$out" || { echo "$out"; die "tunnel to a missing site"; }
pass "a missing site names the server's sites and the close one"
lf sites rm priv -y >/dev/null 2>&1
cd "$WORK"
fi

if want domains; then echo "== password, domains, free address"
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
# A compose project of the user's own, routed by the same Traefik.
docker exec "$NAME" docker run -d --name ext-web-1 --label com.docker.compose.project=ext --label com.docker.compose.project.working_dir=/root/ext \
  --label 'traefik.http.routers.ext.rule=Host(`ext.test`)' busybox:1.37 sleep 3600 >/dev/null
out=$(lf ls 2>&1); { has "not deployed by landfall" <<<"$out" && has "ext.test" <<<"$out" && has "/root/ext" <<<"$out"; } || { echo "$out"; die "ls shows other containers"; }
{ lf ls --json --others | has '"ext.test"'; } || die "ls --json --others"
out=$(lf domains who --add ext.test 2>&1); { has "also routed to ext" <<<"$out"; } || { echo "$out"; die "taken by another container warns"; }
lf domains who --rm ext.test -y >/dev/null 2>&1
docker exec "$NAME" docker rm -f ext-web-1 >/dev/null
pass "sites list shows containers landfall did not deploy, their domains warn"
mkdir -p "$WORK/free" && cd "$WORK/free" && echo '<h1>free</h1>' > index.html
lf deploy -y >/dev/null
free=$(node --input-type=module -e 'console.log(JSON.parse((await import("node:fs")).readFileSync(".landfall.json", "utf8")).domains[0])')
[[ "$free" == free.127-0-0-1.sslip.io ]] || die "no domain gives an sslip.io address (got $free)"
expect "$free" / free
pass "deploy without a domain uses $free"
{ grep -q '"path": ".*'"$(basename "$WORK")"'/free"' "$LANDFALL_CONFIG_DIR/projects.json"; } || die "project remembered"; pass "project remembered"
cd "$WORK"
fi

if want main; then echo "== main domain"
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
lf domains main --add @ -y >/dev/null 2>&1 || die "domains --add @"
expect box.test / main
pass "domains --add @ serves the main domain"
mkdir -p "$WORK/apex" && cd "$WORK/apex" && echo '<h1>apex</h1>' > index.html
lf deploy -d @ -y >/dev/null 2>&1 || die "deploy -d @ takes the main domain"
expect box.test / apex
{ ! lf domains main --json | has '"box.test"' && lf domains main --json | has '"main.box.test"'; } || die "main hands box.test over"
pass "deploy -d @ moves the main domain, the old site keeps its others"
lf domains apex --rm @ -y >/dev/null 2>&1 || die "domains --rm the only domain"
lf deploy -y >/dev/null 2>&1 || die "redeploy a site with no domain"
{ [ "$(code box.test)" = 404 ] && [ -n "$(docker exec "$NAME" docker ps -q --filter label=landfall.site=apex)" ] && ! lf domains apex --json | has '"box.test"'; } \
  || die "site without domains stays up, unrouted"; pass "domains --rm takes the main domain off a site, redeploys keep it unrouted"
lf domains apex --add apex2.test >/dev/null 2>&1 && lf domains main --add @ -y >/dev/null 2>&1 || die "move back"
expect box.test / main
{ ! grep -q '"box.test"' .landfall.json; } || die "move updates the old site's .landfall.json"
# A checkout that still lists it (a teammate's, an old commit) must not take it back.
sed -i.bak 's/"apex2.test"/"apex2.test", "box.test"/' .landfall.json
out=$(lf deploy -y 2>&1) && die "redeploy from .landfall.json takes the domain back"
{ has "deploy with -d" <<<"$out"; } || { echo "$out"; die "redeploy hint"; }; pass ".landfall.json domains never move"
lf sites rm apex -y >/dev/null
cd "$WORK/main"
lf domains main --add extra >/dev/null 2>&1
{ lf domains main --json | has '"extra.box.test"'; } || die "domains --add extra"; pass "domains --add extra means extra.box.test"
lf traefik setup --dashboard traefik --dashboard-password dashpw1 >/dev/null 2>&1 || die "traefik dashboard"
for _ in $(seq 1 20); do [ "$(code traefik.box.test)" = 401 ] && break; sleep 1; done
[ "$(code traefik.box.test)" = 401 ] || die "dashboard at traefik.<domain> asks for a login"
[ "$(code traefik.box.test -u admin:dashpw1)" != 401 ] || die "dashboard lets admin in"
pass "traefik dashboard at traefik.box.test"
lf traefik setup >/dev/null 2>&1
{ docker exec "$NAME" grep -q traefik.box.test /opt/landfall/traefik/docker-compose.yml; } || die "dashboard kept on re-run"; pass "traefik setup keeps the dashboard"
lf traefik setup --dashboard off >/dev/null 2>&1
{ ! docker exec "$NAME" grep -q traefik.box.test /opt/landfall/traefik/docker-compose.yml; } || die "dashboard off"; pass "--dashboard off removes it"
lf sites rm main -y >/dev/null
lf server domain box --clear -y >/dev/null
cd "$WORK"
fi

if want updates; then echo "== os and updates"
{ lf info --json | has '"id": "alpine"'; } || die "server info detects the os"; pass "server info detects alpine"
out=$(lf updates --no-refresh --json) || die "updates"
{ echo "$out" | has '"mgr": "apk"' && echo "$out" | has '"name": "traefik"'; } || { echo "$out" | head -40; die "updates lists packages and images"; }
pass "updates lists apk packages and images"
{ echo "$out" | has 'built on the server: redeploy to rebuild'; } || { echo "$out" | head -60; die "updates marks images built on the server"; }
pass "updates marks images built on the server"
fi

if want stats; then echo "== stats"
out=$(lf stats --json) || die "stats"
{ echo "$out" | has '"docker": true' && echo "$out" | has '"name": "traefik"' && echo "$out" | has '"cpus": '; } || { echo "$out" | head -60; die "stats lists host and containers"; }
pass "stats lists host and containers"
{ lf stats 2>&1 | has Containers; } || die "stats prints"; pass "stats prints"
out=$(lf disk --json) || die "disk"
{ echo "$out" | has '"type": "Images"' && echo "$out" | has '"logs"'; } || { echo "$out" | head -60; die "disk sums up docker"; }
pass "disk sums up docker"
fi

if want traffic; then echo "== traffic, certs, check"
{ docker exec "$NAME" docker inspect traefik | has 'accesslog.format=json'; } || die "traefik logs json"; pass "traefik writes a json access log"
get app.test /nope >/dev/null; get app.test / >/dev/null
out=$(lf traffic --since 1h --json) || die "traffic"
{ echo "$out" | node -e 'const t = JSON.parse(require("fs").readFileSync(0, "utf8")); const a = t.sites.find((s) => s.site === "app"); process.exit(t.format === "json" && a && a.requests >= 2 && a.classes["4xx"] >= 1 ? 0 : 1)'; } || { echo "$out" | head -60; die "traffic counts app's requests"; }
pass "traffic counts app's requests"
{ lf traffic app --since 1h 2>&1 | has /nope; } || die "traffic app lists the failing path"; pass "traffic app lists the failing path"
out=$(lf certs --json) || die "certs"
{ echo "$out" | node -e 'const r = JSON.parse(require("fs").readFileSync(0, "utf8")); process.exit(r.domains.some((d) => d.domain === "app.test" && d.cert?.path?.endsWith("cert.pem") && d.cert.days > 0) ? 0 : 1)'; } || { echo "$out" | head -60; die "certs finds the file certificate"; }
pass "certs finds app.test's certificate"
out=$(lf check app.test --resolve "127.0.0.1:$HTTPS_PORT" --json) && die "check fails on a self-signed certificate"
{ echo "$out" | has '"status": 200' && echo "$out" | has '"valid": false'; } || { echo "$out"; die "check reads status and certificate"; }
pass "check: status 200, self-signed certificate fails"
fi

if want prune; then echo "== prune"
junk=$(printf 'FROM scratch\nLABEL junk=%s\n' "$RANDOM" | docker exec -i "$NAME" docker build -q - 2>/dev/null | tail -n1)
[ -n "$junk" ] || die "build a dangling image"
out=$(lf prune --dry-run --json) || die "prune --dry-run"
{ echo "$out" | node -e 'const p = JSON.parse(require("fs").readFileSync(0, "utf8")); const id = process.argv[1]; process.exit(p.images.some((i) => i.id === id && !i.keep) && p.images.some((i) => i.keep === "used") && !p.images.some((i) => !i.keep && i.tags.some((t) => /^app-/.test(t))) ? 0 : 1)' "$junk"; } \
  || { echo "$out" | tail -60; die "prune plan: dangling goes, used and built images stay"; }
pass "prune plan: dangling goes, used and built images stay"
lf prune -y >/dev/null 2>&1 || die "prune"
{ ! docker exec "$NAME" docker image inspect "$junk" >/dev/null 2>&1; } || die "prune removes the dangling image"
{ docker exec "$NAME" docker image ls --format '{{.Repository}}' | grep -q '^app-'; } || die "prune keeps built images"
{ lf history 2>&1 | has "pruned"; } || die "prune is journaled"
pass "prune removes unused images, keeps built images, journals it"
fi

if want system; then echo "== system"
# deploy has no sudo here: root's keys and daemon.json come through root's key login.
out=$(lf system -s box --json) || die "system --json"
{ echo "$out" | has '"init": "openrc"' && echo "$out" | has '"mine": true' && echo "$out" | has '"driver": "json-file"'; } || { echo "$out" | head -60; die "system lists init, keys, docker logs"; }
pass "system lists init, keys and docker logs"
ssh-keygen -q -t ed25519 -N "" -C e2e-extra -f "$WORK/extra" </dev/null
lf keys add "$WORK/extra.pub" --user root -s box >/dev/null 2>&1 || die "keys add"
{ docker exec "$NAME" grep -q e2e-extra /root/.ssh/authorized_keys; } || die "keys add writes the key"; pass "keys add"
lf keys rm e2e-extra -s box -y >/dev/null 2>&1 || die "keys rm"
{ ! docker exec "$NAME" grep -q e2e-extra /root/.ssh/authorized_keys; } || die "keys rm drops the key"
lf undo -s box -y >/dev/null 2>&1 || die "undo keys rm"
{ docker exec "$NAME" grep -q e2e-extra /root/.ssh/authorized_keys; } || die "undo puts the key back"; pass "keys rm, undo puts it back"
out=$(lf keys rm "$(ssh-keygen -lf "$WORK/key.pub" | awk '{print $2}')" --user root -s box -y 2>&1) && die "keys rm own key refused"
{ grep -q "this machine logs in with" <<<"$out"; } || die "keys rm own key refused: $out"; pass "keys rm refuses this machine's key"
old=$(docker exec "$NAME" hostname)
lf hostname e2e-box -s box >/dev/null 2>&1 || die "hostname"
[ "$(docker exec "$NAME" hostname)" = e2e-box ] || die "hostname changes the name"
lf undo -s box -y >/dev/null 2>&1 || die "undo hostname"
[ "$(docker exec "$NAME" hostname)" = "$old" ] || die "undo restores the host name"; pass "hostname, undo restores it"
lf log-limit 10m --files 2 -s box >/dev/null 2>&1 || die "log-limit"
{ docker exec "$NAME" grep -q '"max-size": *"10m"' /etc/docker/daemon.json; } || die "log-limit writes daemon.json"
{ lf system -s box --json | has '"maxSize": "10m"'; } || die "system shows the limit"
lf undo -s box -y >/dev/null 2>&1 || die "undo log-limit"
{ ! docker exec "$NAME" grep -qs max-size /etc/docker/daemon.json; } || die "undo restores daemon.json"; pass "log-limit, undo restores daemon.json"
fi

if want security; then echo "== security"
# A user who logs in with a password only, and sshd taking passwords again.
docker exec "$NAME" sh -c 'rm -f /etc/ssh/sshd_config.d/00-landfall.conf && adduser -D alice && echo alice:e2e-pw | chpasswd'
out=$(lf security -s box --json) || die "security --json"
{ echo "$out" | has '"passwordLogin": true' && echo "$out" | has '"id": "password-login"' && echo "$out" | has '"--generate"'; } \
  || { echo "$out"; die "security finds password login and offers a key for alice"; }
{ lf security -s box 2>&1 | has "SSH accepts passwords"; } || die "security prints the advice"; pass "security finds password login, offers a key for alice"
out=$(lf harden ssh -s box 2>&1) && die "harden ssh refuses to lock alice out"
{ grep -q "alice" <<<"$out"; } || die "harden ssh names alice: $out"; pass "harden ssh refuses to lock alice out"
{ lf setup box --no-firewall --check 2>&1 | has "alice would lose"; } || die "setup --check sees alice too"; pass "setup --check sees alice too"
mkdir -p "$WORK/home"
HOME="$WORK/home" lf keys add --generate -u alice -s box </dev/null >"$WORK/gen.log" 2>&1 || { cat "$WORK/gen.log"; die "keys add --generate"; }
[ -f "$WORK/home/.ssh/box_alice" ] || die "keys add --generate writes ~/.ssh/box_alice"
[ "$(ssh -F "$LANDFALL_SSH_CONFIG" -o BatchMode=yes -o IdentitiesOnly=yes -i "$WORK/home/.ssh/box_alice" -p "$SSH_PORT" alice@127.0.0.1 id -un)" = alice ] \
  || die "alice logs in with the new key"; pass "keys add --generate: alice logs in with the new key"
{ ! lf setup box --no-firewall --check 2>&1 | has "would lose"; } || die "setup --check: alice has a key now"; pass "setup --check agrees: alice has a key"
lf harden ssh -s box -y >"$WORK/harden.log" 2>&1 || { cat "$WORK/harden.log"; die "harden ssh"; }
{ lf security -s box --json | has '"passwordLogin": false'; } || die "harden ssh turns passwords off"
{ ! lf security -s box --json | has '"password-login"'; } || die "no password advice after harden"; pass "harden ssh: keys only"
lf undo -s box -y >/dev/null 2>&1 || die "undo harden"
{ lf security -s box --json | has '"passwordLogin": true'; } || die "undo turns passwords back on"; pass "undo harden turns passwords back on"
lf harden ssh -s box -y >/dev/null 2>&1 || die "harden ssh again"
lf harden fail2ban -s box >"$WORK/f2b.log" 2>&1 || { cat "$WORK/f2b.log"; die "harden fail2ban"; }
{ docker exec "$NAME" fail2ban-client ping | has pong && lf security -s box --json | has '"fail2ban": "running"'; } \
  || die "harden fail2ban runs it"; pass "harden fail2ban installs and starts it"
lf undo -s box -y >/dev/null 2>&1 || die "undo fail2ban"
{ ! docker exec "$NAME" fail2ban-client ping >/dev/null 2>&1; } || die "undo stops fail2ban"; pass "undo stops fail2ban"
{ lf security -s box --json | has '"id": "auto-updates"'; } || die "security finds no apk updates"
lf harden updates -s box >"$WORK/upd.log" 2>&1 || { cat "$WORK/upd.log"; die "harden updates on alpine"; }
{ lf security -s box --json | has '"autoUpdates": true' && docker exec "$NAME" pidof crond >/dev/null; } || die "harden updates: cron job and crond"
pass "harden updates on alpine: daily apk upgrade, crond running"
lf undo -s box -y >/dev/null 2>&1 || die "undo apk updates"
{ lf security -s box --json | has '"autoUpdates": false' && ! docker exec "$NAME" test -e /etc/periodic/daily/landfall-upgrade; } \
  || die "undo apk updates"; pass "undo removes the apk upgrade job"
fi

if want traefik; then echo "== traefik host network"
lf traefik setup --host-network --image traefik:v3.6 >/dev/null 2>&1 || die "traefik setup --host-network"
{ lf updates -s box --no-refresh 2>&1 | has "newer version traefik:v3."; } || die "updates names the newer traefik tag"; pass "updates names the newer traefik tag"
{ [ "$(docker exec "$NAME" docker inspect -f '{{.HostConfig.NetworkMode}}' traefik)" = host ]; } || die "traefik on host network"; pass "traefik on host network"
expect who.test / "Hostname"
{ grep -q '"hostNetwork": true' "$LANDFALL_CONFIG_DIR/config.json"; } || die "host network remembered"; pass "host network remembered"
{ ! lf setup box --no-firewall --check 2>&1 | grep -E '→|!'; } || die "check accepts own host-network traefik"; pass "check accepts own host-network traefik"
out=$(lf traefik status 2>&1); { echo "$out" | has 'network host'; } || { echo "$out"; die "status shows host network"; }; pass "status shows host network"
lf traefik setup --no-host-network >/dev/null 2>&1 || die "traefik back to published ports"
expect who.test / "Hostname"
pass "traefik back to published ports"
lf traefik rm -y >/dev/null 2>&1 || die "traefik rm"
docker exec "$NAME" sh -c '! docker inspect traefik >/dev/null 2>&1 && [ ! -e /opt/landfall/traefik/docker-compose.yml ] && [ -d /opt/landfall/traefik/letsencrypt ]' \
  || die "traefik rm stops traefik, certificates stay"; pass "traefik rm stops traefik, certificates stay"
lf undo -y >/dev/null 2>&1 || die "undo traefik rm"
expect who.test / "Hostname"
pass "undo puts the removed traefik back"
fi

if want remove; then echo "== remove"
lf sites rm who -y
lf ls | has who && die "who still listed" || pass "site removed"
fi

if want firewall; then echo "== firewall"
# deploy has no sudo here, so these go through root's key login.
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
ssh -F "$LANDFALL_SSH_CONFIG" -o BatchMode=yes box true || die "ssh after firewall"; pass "ssh still works"
fi

if want undo; then echo "== history and undo"
out=$(lf history -s box -n 200 2>&1)
for want in "created user deploy" "installed traefik" "deploy site release" "ufw allow from 10.0.0.0/8"; do
  { grep -q "$want" <<<"$out"; } || { echo "$out"; die "history shows: $want"; }
done; pass "history shows setup, traefik, deploys and firewall"
lf firewall allow 7000 -s box >/dev/null
lf undo -s box -y >/dev/null 2>&1 || die "undo firewall allow"
{ ! ufw_added | has 7000; } || die "undo removes the rule"; pass "undo removes a firewall rule"
{ lf history -s box 2>&1 | has "undone"; } || die "history marks undone"; pass "history marks the step undone"
cd "$WORK/site"
echo '<h1>v3</h1>' > dist/index.html
# A server without rsync still takes the redeploy, whole, and says how to get it.
srv mv /usr/bin/rsync /usr/bin/rsync.off
rc=0; out=$(lf deploy -y 2>&1) || rc=$?
srv mv /usr/bin/rsync.off /usr/bin/rsync
[ $rc = 0 ] || { echo "$out"; die "redeploy to a server without rsync"; }
has "has no rsync" <<<"$out" || { echo "$out"; die "redeploy names the missing rsync"; }
expect site.test / v3
pass "redeploy without rsync on the server uploads everything"
lf undo -y >/dev/null 2>&1 || die "undo redeploy"
expect site.test / v1
pass "undo of a redeploy brings the previous release back"
mkdir -p "$WORK/und/dist" && cd "$WORK/und" && echo '<h1>und</h1>' > dist/index.html
lf deploy -d und.test -y >"$WORK/und.log" 2>&1 || { cat "$WORK/und.log"; die "deploy und"; }
expect und.test / und
lf undo -y >/dev/null 2>&1 || die "undo new site"
{ ! lf ls | has und && ! docker exec "$NAME" test -e /opt/landfall/sites/und; } || die "undo removes a new site"; pass "undo removes a new site"
cd "$WORK/app"
lf env GREETING=undo -y >/dev/null 2>&1
expect app.test / "app undo"
lf undo -y >/dev/null 2>&1 || die "undo env"
expect app.test / "app world"
pass "undo of env restores .env"
# Backups are pruned to the newest 10 per file, and the one undo needs survives.
docker exec "$NAME" sh -c 'cd /opt/landfall/sites/app && for i in $(seq 1 12); do cp -p .env ..env.landfall-old-$i; done'
lf env GREETING=prune -y >/dev/null 2>&1
expect app.test / "app prune"
n=$(docker exec "$NAME" sh -c 'ls -A /opt/landfall/sites/app | grep -c "^\.\.env\.landfall-"')
[ "$n" -le 10 ] || die "backups pruned (have $n)"
lf undo -y >/dev/null 2>&1 || die "undo env after pruning"
expect app.test / "app world"
pass "old backups are pruned, undo still works"
# A new site in a dir that already held files: undo removes only what landfall wrote.
docker exec "$NAME" sh -c 'mkdir -p /opt/landfall/sites/pre && echo mine > /opt/landfall/sites/pre/notes.txt && chown -R deploy /opt/landfall/sites/pre'
mkdir -p "$WORK/pre/dist" && cd "$WORK/pre" && echo '<h1>pre</h1>' > dist/index.html
lf deploy -d pre.test -y >/dev/null 2>&1
expect pre.test / pre
lf undo -y >/dev/null 2>&1 || die "undo site in existing dir"
docker exec "$NAME" sh -c 'd=/opt/landfall/sites/pre; [ "$(cat $d/notes.txt)" = mine ] && [ ! -e $d/site.json ] && [ ! -e $d/releases ] && [ ! -e $d/current ]' \
  || die "undo keeps foreign files"
pass "undo of a site in an existing dir keeps what was there"
docker exec "$NAME" rm -rf /opt/landfall/sites/pre
cd "$WORK/app"
lf traefik setup --no-staging >/dev/null 2>&1
{ ! docker exec "$NAME" docker inspect traefik | has acme-staging; } || die "traefik left staging"
lf undo -y >/dev/null 2>&1 || die "undo traefik setup"
{ docker exec "$NAME" docker inspect traefik | has acme-staging; } || die "undo restores traefik config"; pass "undo restores the traefik config"
out=$(lf undo 1 -s box </dev/null 2>&1) && die "undo refuses when later runs changed the same things"
{ grep -q "later runs changed the same things" <<<"$out"; } || { echo "$out"; die "undo names the clashing runs"; }
pass "undo refuses when later runs changed the same things"
# No TTY and no -y: shows what it would do, then cancels.
out=$(lf undo 1 -s box --force </dev/null 2>&1) && die "undo without -y cancels"
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
fi

if want ui; then echo "== web dashboard"
UI_PORT=${UI_PORT:-4799}
# node itself, not the lf function: $! of a backgrounded function is a subshell that kill leaves node behind.
node "$ROOT/dist/cli.mjs" ui --port "$UI_PORT" --no-open >"$WORK/ui.log" 2>&1 &
UI_PID=$!
for _ in $(seq 1 30); do [ -s "$LANDFALL_CONFIG_DIR/ui-token" ] && curl -s "http://127.0.0.1:$UI_PORT/" >/dev/null && break; sleep 0.2; done
UI="http://127.0.0.1:$UI_PORT"
JAR="$WORK/cookies"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$UI/api/state")" = 401 ] || die "ui needs the login link"
curl -s -c "$JAR" -o /dev/null "$UI/login?t=$(cat "$LANDFALL_CONFIG_DIR/ui-token")"
[ "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -H 'Host: evil.test' "$UI/api/state")" = 403 ] || die "ui refuses a foreign Host"
{ curl -s -b "$JAR" "$UI/" | has "<title>landfall</title>"; } || die "ui serves the page"
{ curl -s -b "$JAR" "$UI/api/state" | has '"name":"box"'; } || die "ui lists servers"
{ curl -s -b "$JAR" "$UI/api/servers/box" | has '"ready":true'; } || die "ui reads a server"
job=$(curl -s -b "$JAR" -H 'content-type: application/json' -d '{"argv":["ls","-s","box"],"server":"box"}' "$UI/api/jobs" | node --input-type=module -e 'console.log(JSON.parse((await import("node:fs")).readFileSync(0, "utf8")).id)')
{ curl -s -N --max-time 30 -b "$JAR" "$UI/api/jobs/$job/events" | has '"code":0'; } || die "ui runs a job and streams it"
{ curl -s -b "$JAR" "$UI/api/jobs/$job" | has 'app'; } || die "ui job output"
{ curl -s -b "$JAR" "$UI/api/servers/box/facts" | has '"pkg":"apk"'; } || die "ui reads facts"
{ curl -s -b "$JAR" "$UI/api/servers/box/stats" | has '"containers":'; } || die "ui reads stats"
{ curl -s -b "$JAR" "$UI/api/servers/box/traffic?since=1h" | has '"format":"json"'; } || die "ui reads traffic"
{ curl -s -b "$JAR" "$UI/api/servers/box/certs" | has '"domains":'; } || die "ui reads certs"
{ curl -s -b "$JAR" "$UI/api/fs?path=$WORK/free" | has '"kind":"static"'; } || die "ui browses folders"
mkdir -p "$WORK/up" && echo '<h1>up</h1>' > "$WORK/up/index.html"
up=$(curl -s -b "$JAR" -F "file=@$WORK/up/index.html" -F "path=up/index.html" "$UI/api/upload")
{ echo "$up" | has '"kind":"static"'; } || { echo "$up"; die "ui takes an upload"; }
upath=$(echo "$up" | node --input-type=module -e 'console.log(JSON.parse((await import("node:fs")).readFileSync(0, "utf8")).path)')
job=$(curl -s -b "$JAR" -H 'content-type: application/json' -d '{"argv":["deploy","-y","-s","box","-n","up","-d","up.test","--no-save"],"server":"box","cwd":"'"$upath"'"}' "$UI/api/jobs" | node --input-type=module -e 'console.log(JSON.parse((await import("node:fs")).readFileSync(0, "utf8")).id)')
{ curl -s -N --max-time 60 -b "$JAR" "$UI/api/jobs/$job/events" | has '"code":0'; } || die "ui deploys an upload"
expect up.test / up
vj=$(curl -s -b "$JAR" "$UI/api/servers/box/volumes?site=up")
{ has -F '"volumes":[]' <<<"$vj" && has -F '"backups":[]' <<<"$vj"; } || { echo "$vj"; die "ui reads a site's volumes"; }
# A security fix button: the advice's argv, run as a job.
json() { node --input-type=module -e "const i = JSON.parse((await import('node:fs')).readFileSync(0, 'utf8')); console.log($1)"; }
argv=$(curl -s -b "$JAR" "$UI/api/servers/box/system" | json 'JSON.stringify(i.advice.find((a) => a.id === "fail2ban").fix.argv)')
job=$(curl -s -b "$JAR" -H 'content-type: application/json' -d '{"argv":'"$argv"',"server":"box"}' "$UI/api/jobs" | json i.id)
{ curl -s -N --max-time 120 -b "$JAR" "$UI/api/jobs/$job/events" | has '"code":0'; } || die "ui runs a security fix: $argv"
{ curl -s -b "$JAR" "$UI/api/servers/box/system" | json '!i.advice.some((a) => a.id === "fail2ban") && i.fail2ban' | has -x running; } \
  || die "ui fix starts fail2ban"; pass "ui security fix button starts fail2ban"
kill "$UI_PID"; wait "$UI_PID" 2>/dev/null || true
pass "web dashboard: login, host check, servers, jobs"
fi

if want undo-all; then echo "== undo everything"
lf undo --all -s box -y >"$WORK/undo.log" 2>&1 || { cat "$WORK/undo.log"; die "undo --all"; }
docker exec "$NAME" sh -c '! id deploy 2>/dev/null && [ ! -e /opt/landfall/sites ] && [ ! -e /etc/ssh/sshd_config.d/00-landfall.conf ]' \
  || die "undo --all removes user, layout and hardening"
{ ! docker exec "$NAME" docker network inspect web >/dev/null 2>&1 && [ -z "$(docker exec "$NAME" docker ps -aq)" ]; } \
  || die "undo --all removes containers and network"
# The deploy user is gone now, so look at the journal directly.
{ docker exec "$NAME" grep -q "$(printf '\tundo\t')" /opt/landfall/journal.log; } || die "journal kept"
pass "undo --all leaves the server as it was, journal kept"
fi

if want legacy; then echo "== site from before Compose sites"
lf setup box --host 127.0.0.1 --port "$SSH_PORT" --key "$WORK/key" --email test@example.com --staging --no-firewall -y >/dev/null 2>&1 || die "setup again"
trust_test_hosts
# A site as the landfall before Compose sites wrote it: one container from sites/<name>/docker-compose.yml.
docker exec "$NAME" sh -c 'set -e; d=/opt/landfall/sites/mig; mkdir -p $d/releases && cd $d && touch .env
  printf "%s\n" "{\"name\":\"mig\",\"kind\":\"image\",\"domains\":[\"mig.test\"],\"port\":80,\"current\":\"20250101000000\",\"releases\":[{\"id\":\"20250101000000\",\"at\":\"2025-01-01T00:00:00.000Z\",\"image\":\"traefik/whoami:v1.11\"}],\"createdAt\":\"2025-01-01T00:00:00.000Z\",\"updatedAt\":\"2025-01-01T00:00:00.000Z\"}" > site.json
  cat > docker-compose.yml <<"EOF"
# managed by landfall — do not edit, changes are overwritten on deploy
name: landfall-mig
services:
  app:
    image: "traefik/whoami:v1.11"
    env_file:
      - .env
    container_name: landfall-mig
    restart: unless-stopped
    networks:
      - web
    labels:
      - "traefik.enable=true"
      - "traefik.docker.network=web"
      - "traefik.http.routers.landfall-mig.rule=Host(`mig.test`)"
      - "traefik.http.routers.landfall-mig.entrypoints=websecure"
      - "traefik.http.routers.landfall-mig.tls.certresolver=le"
      - "traefik.http.services.landfall-mig.loadbalancer.server.port=80"
      - "landfall.managed=true"
      - "landfall.site=mig"
networks:
  web:
    external: true
EOF
  chown -R deploy $d && docker compose up -d >/dev/null 2>&1' || die "make old site"
expect mig.test / Hostname
# Deploying an old site makes it a Compose site: same domain, its old container gone.
mkdir -p "$WORK/mig" && cd "$WORK/mig"
lf deploy -n mig --image traefik/whoami:v1.11 --port 80 --no-save -y >"$WORK/mig2.log" 2>&1 || { cat "$WORK/mig2.log"; die "deploy takes over an old site"; }
expect mig.test / Hostname
{ docker exec "$NAME" grep -q '"v": 2' /opt/landfall/sites/mig/site.json && ! docker exec "$NAME" docker inspect landfall-mig >/dev/null 2>&1 \
  && ! docker exec "$NAME" test -e /opt/landfall/sites/mig/docker-compose.yml; } || die "old site taken over"
pass "deploy moves an old site to a Compose project"
cd "$WORK"
fi

if want uninstall; then echo "== uninstall"
lf server uninstall box --volumes -y >"$WORK/uninstall.log" 2>&1 || { cat "$WORK/uninstall.log"; die "server uninstall"; }
{ [ -z "$(docker exec "$NAME" docker ps -aq)" ] && docker exec "$NAME" test ! -e /opt/landfall; } || die "uninstall removes sites, traefik and /opt/landfall"
{ ! has '"box"' "$LANDFALL_CONFIG_DIR/config.json" && ! has "landfall:box" "$LANDFALL_SSH_CONFIG"; } || die "uninstall forgets box"
pass "server uninstall removes sites, traefik and /opt/landfall, forgets the server"
fi

if want fresh; then echo "== fresh server with password"
FRESH_PORT=${FRESH_PORT:-2223}
docker rm -fv "$NAME-fresh" >/dev/null 2>&1 || true
docker run -d --privileged --name "$NAME-fresh" -p "$FRESH_PORT:22" -e ROOT_PASSWORD=hunter2 landfall-e2e >/dev/null
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
echo hunter2 | HOME="$WORK/home2" LANDFALL_SSH_CONFIG="$NEWCFG" node "$ROOT/dist/cli.mjs" server add plain --host 127.0.0.1 --port "$FRESH_PORT" --password-stdin >/dev/null 2>&1 \
  || die "server add with password"
[ "$(ssh -F "$NEWCFG" -o BatchMode=yes plain "id -un")" = root ] || die "ssh plain"; pass "server add installs a key with the password and creates the ssh config"
rm "$WORK/home2/.ssh/landfall_plain.pub"
HOME="$WORK/home2" LANDFALL_SSH_CONFIG="$NEWCFG" node "$ROOT/dist/cli.mjs" server add keyed --host 127.0.0.1 --port "$FRESH_PORT" -i "$WORK/home2/.ssh/landfall_plain" </dev/null >/dev/null 2>&1 \
  || die "server add with a key file"
{ [ "$(ssh -F "$NEWCFG" -o BatchMode=yes keyed "id -un")" = root ] && grep -q "landfall_plain$" "$NEWCFG"; } || die "ssh keyed"; pass "server add logs in with a given key file"
lf server rm plain -y >/dev/null 2>&1; lf server rm keyed -y >/dev/null 2>&1; forget_fresh
# Same steps as the dashboard: install the key with the password, then check and apply with the key only.
# HOME keeps the generated ~/.ssh/landfall_fresh out of the real home; askpass types the password.
FRESH=(setup fresh --host 127.0.0.1 --port "$FRESH_PORT")
HOME="$WORK/home" SSH_ASKPASS="$WORK/askpass" SSH_ASKPASS_REQUIRE=force \
  node "$ROOT/dist/cli.mjs" "${FRESH[@]}" --key-only -y </dev/null >/dev/null 2>&1 || die "setup --key-only"
docker exec "$NAME-fresh" test ! -e /opt/landfall || die "--key-only changed nothing else"; pass "--key-only installs only the key"
{ HOME="$WORK/home" node "$ROOT/dist/cli.mjs" "${FRESH[@]}" --check </dev/null 2>&1 | has "key login works"; } \
  || die "check uses the installed key"; pass "check uses the installed key"
HOME="$WORK/home" node "$ROOT/dist/cli.mjs" "${FRESH[@]}" --no-firewall -y </dev/null 2>"$WORK/fresh.log" \
  || { cat "$WORK/fresh.log"; die "fresh setup"; }
cat "$WORK/fresh.log"
{ grep -q "skipping traefik: port 80 is in use by nc" "$WORK/fresh.log"; } || die "traefik skipped on busy port 80"; pass "traefik skipped on busy port 80"
{ ! docker exec "$NAME-fresh" docker inspect traefik >/dev/null 2>&1 && docker exec "$NAME-fresh" netstat -ltnp | has ':80 .*nc'; } || die "port 80 service untouched"; pass "port 80 service untouched"
{ docker exec "$NAME-fresh" sshd -T | grep -x >/dev/null 'passwordauthentication yes'; } || die "hardening skipped for alice"; pass "hardening skipped for password user alice"
HOME="$WORK/home" node "$ROOT/dist/cli.mjs" setup fresh --no-traefik --no-firewall --force -y </dev/null >/dev/null 2>&1 || die "setup --force"
[ -f "$WORK/home/.ssh/landfall_fresh" ] || die "key generated"; pass "key generated"
# Host block holds an absolute key path: HOME differs from the passwd home here.
[ "$(ssh -F "$LANDFALL_SSH_CONFIG" -o BatchMode=yes fresh "id -un")" = deploy ] || die "ssh fresh as deploy"; pass "ssh fresh logs in as deploy"
{ docker exec "$NAME-fresh" sshd -T | grep -x >/dev/null 'passwordauthentication no'; } || die "password auth disabled"; pass "password auth disabled"
HOME="$WORK/home" node "$ROOT/dist/cli.mjs" server uninstall fresh -y </dev/null >"$WORK/fresh-un.log" 2>&1 || { cat "$WORK/fresh-un.log"; die "uninstall fresh"; }
docker exec "$NAME-fresh" sh -c '! id deploy 2>/dev/null && [ ! -e /opt/landfall ] && [ ! -e /etc/ssh/sshd_config.d/00-landfall.conf ]' || die "uninstall reverts setup"
{ docker exec "$NAME-fresh" sshd -T | grep -x >/dev/null 'passwordauthentication yes'; } || die "uninstall turns password auth back on"
pass "server uninstall reverts setup: deploy user, ssh hardening"
docker exec "$NAME-fresh" pkill nc || true
mkdir -p "$WORK/freshsite" && echo "fresh site" > "$WORK/freshsite/index.html"
(cd "$WORK/freshsite" && echo hunter2 | HOME="$WORK/home" node "$ROOT/dist/cli.mjs" deploy -s fresh --host 127.0.0.1 --ssh-port "$FRESH_PORT" \
  --password-stdin -d fresh.test --no-save -y >"$WORK/fresh-deploy.log" 2>&1) || { cat "$WORK/fresh-deploy.log"; die "deploy sets up a new server"; }
docker exec "$NAME-fresh" sh -c 'id deploy >/dev/null && docker inspect traefik >/dev/null && [ -f /opt/landfall/sites/freshsite/site.json ]' \
  || { cat "$WORK/fresh-deploy.log"; die "deploy --host: setup, traefik, site"; }
pass "deploy --host sets up a new server with the password, then deploys"
fi

if want debian; then echo "== debian: automatic updates"
# apt's unattended-upgrades and no init system, which the Alpine box cannot show. No 20auto-upgrades: they start off.
DEB_PORT=${DEB_PORT:-2224}
docker build -q -t landfall-e2e-debian "$ROOT/test/e2e/debian" >/dev/null
docker rm -fv "$NAME-deb" >/dev/null 2>&1 || true
docker run -d --name "$NAME-deb" -p "$DEB_PORT:22" -e AUTHORIZED_KEY="$(cat "$WORK/key.pub")" landfall-e2e-debian >/dev/null
for _ in $(seq 1 30); do ssh-keyscan -p "$DEB_PORT" 127.0.0.1 >/dev/null 2>&1 && break; sleep 1; done
lf server add deb --host 127.0.0.1 --port "$DEB_PORT" -i "$WORK/key" </dev/null >"$WORK/deb.log" 2>&1 || { cat "$WORK/deb.log"; die "server add deb"; }
{ lf security -s deb --json | has '"id": "auto-updates"'; } || die "security finds no automatic updates"; pass "security finds no automatic updates on debian"
out=$(lf services restart ssh -s deb -y 2>&1) && die "services without systemd"
{ grep -q "no systemd or OpenRC" <<<"$out"; } || die "services without systemd: $out"; pass "services refuse without systemd or OpenRC"
lf harden updates -s deb >"$WORK/deb.log" 2>&1 || { cat "$WORK/deb.log"; die "harden updates"; }
{ lf security -s deb --json | has '"autoUpdates": true'; } || die "harden updates turns them on"; pass "harden updates turns on unattended-upgrades"
lf undo -s deb -y >/dev/null 2>&1 || die "undo updates"
{ lf security -s deb --json | has '"autoUpdates": false'; } || die "undo turns them off"; pass "undo turns automatic updates off"
fi

if want dnf; then echo "== dnf: automatic updates"
# systemd as PID 1. Fedora's dnf5 has one timer and automatic.conf; Rocky 9's dnf 4 has an installing timer.
port=2225
for base in fedora:42 rockylinux:9; do
  n=${base%%:*}; n=${n%linux}
  docker build -q --build-arg BASE=$base -t "landfall-e2e-rpm:$n" "$ROOT/test/e2e/rpm" >/dev/null
  docker rm -fv "$NAME-$n" >/dev/null 2>&1 || true
  docker run -d --name "$NAME-$n" --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw -p "$port:22" \
    -e AUTHORIZED_KEY="$(cat "$WORK/key.pub")" "landfall-e2e-rpm:$n" >/dev/null
  for _ in $(seq 1 60); do ssh-keyscan -p "$port" 127.0.0.1 >/dev/null 2>&1 && break; sleep 1; done
  lf server add "$n" --host 127.0.0.1 --port "$port" -i "$WORK/key" </dev/null >"$WORK/$n.log" 2>&1 || { cat "$WORK/$n.log"; die "server add $n"; }
  { lf security -s "$n" --json | has '"id": "auto-updates"'; } || die "$n: security finds no automatic updates"
  lf harden updates -s "$n" >"$WORK/$n.log" 2>&1 || { cat "$WORK/$n.log"; die "$n: harden updates"; }
  { lf security -s "$n" --json | has '"autoUpdates": true'; } || die "$n: harden updates turns them on"
  lf undo -s "$n" -y >/dev/null 2>&1 || die "$n: undo updates"
  { lf security -s "$n" --json | has '"autoUpdates": false'; } || die "$n: undo turns them off"
  pass "$n: harden updates turns on dnf-automatic, undo turns it off"
  docker rm -fv "$NAME-$n" >/dev/null; port=$((port + 1))
done
fi

echo; pass "e2e checks${E2E_ONLY:+: $E2E_ONLY}"
