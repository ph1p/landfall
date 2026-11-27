import { DOMAIN, type Server } from "../lib/config";
import { covers } from "../lib/domain-match";
import { fail } from "../lib/fail";
import { shq } from "../lib/quote";
import { runScript } from "../ssh/ssh";
import { effectiveSsh } from "../ssh/sshconfig";
import { USER_NAME, usersLogin } from "./users";
import { PRELUDE, ROOT, SITES, TENANTS, TRAEFIK_DIR } from "../ssh/templates";

export const PORTS = { min: 20000, max: 20999 } as const;
const STATE_FILE = `${TENANTS}/state.json`;
const LOCK = `${TENANTS}/.lock`;
const DROPIN = "/etc/systemd/system/user@.service.d/landfall-delegate.conf";
const APPARMOR = "/etc/apparmor.d/landfall-rootlesskit";
const COMPOSE = `${TRAEFIK_DIR}/docker-compose.yml`;
const COMPOSE_BEFORE = `${TENANTS}/traefik-compose.before.yml`;
const PORT_DRIVER = "builtin";

export interface Limits {
  memory?: string;
  cpu?: string;
  tasks?: string;
}

/** tenants/<user>.json: what the tenant's own login reads too. */
export interface TenantFile {
  user: string;
  uid: number;
  port: number;
  domains: string[];
  portDriver: string;
  active: boolean;
  trustedIP?: string;
  created?: string;
  limits?: Limits;
}

export interface TenantRow extends TenantFile {
  /** Its rootless Docker answers. */
  running: boolean;
  sites?: number;
  containers?: number;
  /** Bytes its processes use now (its user slice). */
  memory?: number;
  /** Bytes under its root, with --sizes. */
  disk?: number;
}

/** tenants/state.json: the server as it was before the first tenant; `lf tenant off` puts it back. */
export interface TenantsState {
  enabled: string;
  // false while the first tenant add is still changing the server, or when it stopped halfway.
  complete?: boolean;
  rootMode: string;
  modes: Record<string, string>;
  traefikHostNetwork: boolean;
  delegateDropIn: boolean;
  apparmorProfile: boolean;
  packages: string[];
  ufw: string[];
  composeWritten?: string;
}

export interface TenantsView {
  on: boolean;
  state?: TenantsState;
  tenants: TenantRow[];
  /** ufw is active. */
  ufw: boolean;
  /** Raw file contents by user: a change is only written over what was read. */
  raw: Record<string, string>;
}

export function checkTenantName(user: string) {
  if (!USER_NAME.test(user)) fail(`not a tenant name: ${user} (lower case letters, digits, _ and -, up to 32)`);
  if (user === "root" || user === "state") fail(`${user} cannot be a tenant`);
}

export function checkDomain(d: string): string {
  const x = d.trim().toLowerCase();
  if (!DOMAIN.test(x.replace(/^\*\./, ""))) fail(`not a domain: ${d} (like example.com or *.example.com)`);
  return x;
}

/** Whether two domain patterns can match the same name. */
export function overlaps(a: string, b: string): boolean {
  return covers(a, b) || covers(b, a);
}

/** The first free port of the tenant range. */
export function nextPort(used: Iterable<number>): number {
  const taken = new Set(used);
  for (let p: number = PORTS.min; p <= PORTS.max; p++) if (!taken.has(p)) return p;
  return fail(`no free tenant port left (${PORTS.min}-${PORTS.max})`);
}

const sniRule = (d: string) => (d.startsWith("*.") ? `HostSNIRegexp(\`^[a-z0-9-]+\\.${d.slice(2).replaceAll(".", "\\.")}$\`)` : `HostSNI(\`${d}\`)`);

/** The central Traefik's route to a tenant: TLS passes through untouched, the client address in a PROXY header. */
export function routeYaml(user: string, port: number, domains: string[]): string {
  const id = `tenant-${user}`;
  return `# managed by landfall — rewritten by \`lf tenant domains\`
# domains: ${domains.join(" ")}
tcp:
  routers:
    ${id}:
      entryPoints: [websecure]
      rule: ${JSON.stringify(domains.map(sniRule).join(" || "))}
      service: ${id}
      tls:
        passthrough: true
  services:
    ${id}:
      loadBalancer:
        serversTransport: ${id}-pp
        servers:
          - address: "127.0.0.1:${port}"
  serversTransports:
    ${id}-pp:
      proxyProtocol:
        version: 2
`;
}

export const tenantJson = (t: TenantFile) => JSON.stringify(t, null, 2) + "\n";

const REC = "\x1e";

const READ = String.raw`
printf '\036 ufw\n'; LC_ALL=C ufw status 2>/dev/null | head -1 || true
[ -d ${TENANTS} ] || exit 0
for f in ${TENANTS}/*.json; do
  [ -e "$f" ] || continue
  n=$(basename "$f" .json); r=0; st=- ct=- mem=- dk=-
  if [ "$n" != state ]; then
    u=$(id -u "$n" 2>/dev/null || true)
    if [ -n "$u" ] && [ -S /run/user/$u/docker.sock ]; then
      r=1; ct=$(timeout 10 sudo -u "$n" DOCKER_HOST=unix:///run/user/$u/docker.sock docker ps -q 2>/dev/null | wc -l || echo -)
    fi
    st=$(find ${TENANTS}/"$n"/sites -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)
    [ -z "$u" ] || mem=$(cat /sys/fs/cgroup/user.slice/user-$u.slice/memory.current 2>/dev/null || echo -)
    [ "$LF_SIZES" != 1 ] || dk=$(timeout 30 du -sxk ${TENANTS}/"$n" 2>/dev/null | cut -f1 || echo -)
  fi
  printf '\036%s %s %s %s %s %s\n' "$n" "$r" "$st" "$ct" "$mem" "$dk"; cat "$f"; echo
done
`;

/** Runs as root: tenant work touches users, systemd and other users' files. */
export const asRoot = (admin: Server, script: string, env?: Record<string, string>) =>
  runScript(admin, script, { sudo: effectiveSsh(admin).user !== "root", env, capture: false });

export function parseTenants(out: string): TenantsView {
  const v: TenantsView = { on: false, tenants: [], ufw: false, raw: {} };
  for (const part of out.split(REC).slice(1)) {
    const nl = part.indexOf("\n");
    const [name, flag, ...use] = part.slice(0, nl).split(" ");
    const body = part.slice(nl + 1).trim();
    if (flag === "ufw") {
      v.ufw = body.startsWith("Status: active");
      continue;
    }
    let j: any;
    try {
      j = JSON.parse(body);
    } catch {
      continue;
    }
    if (name === "state") {
      v.on = true;
      v.state = j;
      v.raw.state = body;
    } else if (Number.isInteger(j.uid) && Number.isInteger(j.port)) {
      v.raw[name] = body;
      const n = (x?: string) => (x && /^\d+$/.test(x) ? Number(x) : undefined);
      const [sites, containers, memory, disk] = use.map(n);
      v.tenants.push({
        ...j,
        user: name,
        domains: Array.isArray(j.domains) ? j.domains : [],
        active: j.active !== false,
        running: flag === "1",
        ...(sites !== undefined && { sites }),
        ...(containers !== undefined && { containers }),
        ...(memory !== undefined && { memory }),
        ...(disk !== undefined && { disk: disk * 1024 }),
      });
    }
  }
  v.tenants.sort((a, b) => a.user.localeCompare(b.user));
  return v;
}

export async function readTenants(admin: Server, sizes = false): Promise<TenantsView> {
  const { stdout } = await runScript(admin, READ, { sudo: effectiveSsh(admin).user !== "root", capture: true, env: { LF_SIZES: sizes ? "1" : "0" } });
  return parseTenants(stdout);
}

/** lf tenant ls --json: what the web UI's Tenants section reads. */
export async function tenantsView(s: Server, sizes = false): Promise<Omit<TenantsView, "raw">> {
  const { raw: _raw, ...v } = await readTenants(await usersLogin(s), sizes);
  return v;
}

// Shared by scripts and undo shells: an undo runs with nothing but the PRELUDE.
const FN = String.raw`
as_user() { _u=$1; shift; _i=$(id -u "$_u"); runuser -u "$_u" -- env HOME="$(home_of "$_u")" XDG_RUNTIME_DIR=/run/user/$_i DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$_i/bus DOCKER_HOST=unix:///run/user/$_i/docker.sock "$@"; }
user_up() { systemctl start "user@$(id -u "$1").service"; for _ in $(seq 30); do [ -S "/run/user/$(id -u "$1")/bus" ] && return 0; sleep 1; done; return 1; }
t_off() {
  _r=${TRAEFIK_DIR}/dynamic/tenant-$1.yml
  [ ! -f "$_r" ] || mv -f "$_r" "${TENANTS}/$1.route.disabled"
  if id "$1" >/dev/null 2>&1; then
    _h=$(home_of "$1")
    as_user "$1" systemctl --user disable --now docker >/dev/null 2>&1 || true
    loginctl disable-linger "$1" || true
    usermod -L "$1"
    [ ! -e "$_h/.ssh/authorized_keys" ] || runuser -u "$1" -- mv -fT "$_h/.ssh/authorized_keys" "$_h/.ssh/authorized_keys.landfall-disabled"
    if crontab -l -u "$1" >"${TENANTS}/$1.crontab.disabled" 2>/dev/null; then crontab -r -u "$1"; else rm -f "${TENANTS}/$1.crontab.disabled"; fi
    loginctl terminate-user "$1" 2>/dev/null || true
    systemctl stop "user@$(id -u "$1").service" 2>/dev/null || true
  fi
  [ ! -f "${TENANTS}/$1.json" ] || sed -i 's/"active": true/"active": false/' "${TENANTS}/$1.json"
}
t_on() {
  _h=$(home_of "$1")
  usermod -U "$1" 2>/dev/null || true
  [ ! -e "$_h/.ssh/authorized_keys.landfall-disabled" ] || runuser -u "$1" -- mv -fT "$_h/.ssh/authorized_keys.landfall-disabled" "$_h/.ssh/authorized_keys"
  [ ! -s "${TENANTS}/$1.crontab.disabled" ] || crontab -u "$1" "${TENANTS}/$1.crontab.disabled"
  rm -f "${TENANTS}/$1.crontab.disabled"
  loginctl enable-linger "$1"
  user_up "$1"
  as_user "$1" systemctl --user enable --now docker
  [ ! -f "${TENANTS}/$1.route.disabled" ] || mv -f "${TENANTS}/$1.route.disabled" "${TRAEFIK_DIR}/dynamic/tenant-$1.yml"
  sed -i 's/"active": false/"active": true/' "${TENANTS}/$1.json"
}
`;

const offShell = (user: string) => `${FN}\nt_off ${shq(user)}`;
const onShell = (user: string) => `${FN}\nt_on ${shq(user)}`;

const LOCKED = String.raw`
install -d -o root -g root -m 0751 ${TENANTS}
exec 9>>${LOCK}
command -v flock >/dev/null 2>&1 || { log "flock is missing (util-linux)"; exit 1; }
flock -w 60 9 || { log "another lf tenant command is running"; exit 1; }
`;
const locked = (body: string) => [PRELUDE, FN, LOCKED, body].join("\n");

// What was read must still be there: two admins must not write over each other.
const UNCHANGED = String.raw`
same() { if [ -f "$1" ]; then [ "$(cat "$1")" = "$2" ]; else [ -z "$2" ]; fi; }
same ${TENANTS}/"$U".json "$WAS" || { log "tenant $U changed meanwhile; run the command again"; exit 1; }
`;

const COLLISIONS = String.raw`
bt=$(printf '\140')
for d in $DOMAINS; do
  for f in ${TENANTS}/*.json; do
    [ -e "$f" ] || continue
    case "$f" in ${TENANTS}/"$U".json|${TENANTS}/state.json) continue ;; esac
    grep -qF "\"$d\"" "$f" && { log "$d belongs to tenant $(basename "$f" .json)"; exit 1; }
  done
  h=$(printf '%s' "$d" | sed 's/^[*]//; s/[.]/[.]/g')
  case "$d" in \*.*) re="$bt[^$bt.]+$h$bt" ;; *) re="$bt$h$bt" ;; esac
  [ -d ${SITES} ] && grep -rqsE "$re" ${SITES} && { log "$d reaches a domain of a site of the admin under ${SITES}"; exit 1; }
done
true
`;

const SERVERWIDE = String.raw`
[ -d /run/systemd/system ] || { log "tenants need systemd"; exit 1; }
[ "$(stat -fc %T /sys/fs/cgroup)" = cgroup2fs ] || { log "tenants need cgroup v2"; exit 1; }
command -v runuser >/dev/null 2>&1 || { log "runuser is missing (util-linux)"; exit 1; }
grep -qs "managed by landfall" ${COMPOSE} || { log "the central Traefik is not landfall's own: run lf traefik setup first"; exit 1; }
docker inspect traefik >/dev/null 2>&1 || { log "the central traefik container is not running"; exit 1; }
PM=$(pkg_mgr)
case "$PM" in apt-get|dnf) ;; *) log "tenants need apt or dnf: Docker's rootless extras come from download.docker.com"; exit 1 ;; esac
for p in docker.io moby-engine; do pkg_has "$p" && { log "Docker from distro packages ($p) has no rootless extras; install docker-ce from download.docker.com"; exit 1; }; done
pkg_has docker-ce || { log "tenants need docker-ce from download.docker.com"; exit 1; }
[ "$FIREWALL" != ufw ] || LC_ALL=C ufw status 2>/dev/null | grep -q '^Status: active' || { log "tenants can open their own ports; enable the firewall first (lf firewall enable)"; exit 1; }
APPARMOR=0
[ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" != 1 ] || APPARMOR=1
host_net() { docker inspect -f '{{.HostConfig.NetworkMode}}' traefik 2>/dev/null | grep -qx host; }

if [ ! -f ${STATE_FILE} ]; then
  log "first tenant: recording the server's state in ${STATE_FILE}"
  ST_ENABLED=$(date -u +%Y-%m-%dT%H:%M:%SZ); ST_ROOT=$(stat -c %a ${ROOT}); ST_MODES=""; UNDO_MODES="chmod $ST_ROOT ${ROOT};"
  for e in ${ROOT}/* ${ROOT}/.[!.]*; do
    [ -e "$e" ] && [ ! -L "$e" ] && [ "$e" != ${TENANTS} ] || continue
    m=$(stat -c %a "$e"); n=$(basename "$e")
    ST_MODES="$ST_MODES$([ -z "$ST_MODES" ] || echo ,)\"$n\": \"$m\""
    UNDO_MODES="$UNDO_MODES chmod $m $(printf %q "$e");"
  done
  host_net && ST_HN=true || ST_HN=false
  [ -e ${DROPIN} ] && ST_DD=false || ST_DD=true
  [ "$APPARMOR" = 1 ] && [ ! -e ${APPARMOR} ] && ST_AA=true || ST_AA=false
  ST_PKGS=""; ST_UFW=""; ST_SUM=""; ST_DONE=false
  write_state() {
    printf '{\n  "enabled": "%s",\n  "complete": %s,\n  "rootMode": "%s",\n  "modes": {%s},\n  "traefikHostNetwork": %s,\n  "delegateDropIn": %s,\n  "apparmorProfile": %s,\n  "packages": [%s],\n  "ufw": [%s],\n  "composeWritten": "%s"\n}\n' \
      "$ST_ENABLED" "$ST_DONE" "$ST_ROOT" "$ST_MODES" "$ST_HN" "$ST_DD" "$ST_AA" "$ST_PKGS" "$ST_UFW" "$ST_SUM" | _put ${STATE_FILE} 600
  }
  write_state
  record "tenants: recorded the server's state in ${STATE_FILE}" "mv -f ${STATE_FILE} ${STATE_FILE}.off"

  want="slirp4netns docker-ce-rootless-extras"
  if [ "$PM" = apt-get ]; then want="$want uidmap dbus-user-session"; else want="$want shadow-utils"; fi
  missing=""
  for p in $want; do pkg_has "$p" || missing="$missing $p"; done
  if [ -n "$missing" ]; then
    pkg_install $missing
    for p in $missing; do ST_PKGS="$ST_PKGS$([ -z "$ST_PKGS" ] || echo ,)\"$p\""; done
    record "installed$missing for rootless Docker"
    write_state
  fi
  command -v dockerd-rootless-setuptool.sh >/dev/null || { log "dockerd-rootless-setuptool.sh is missing after installing docker-ce-rootless-extras"; exit 1; }

  if [ "$ST_AA" = true ]; then
    printf '# managed by landfall\nabi <abi/4.0>,\ninclude <tunables/global>\n\n"/usr/bin/rootlesskit" flags=(unconfined) {\n  userns,\n  include if exists <local/landfall-rootlesskit>\n}\n' | _put ${APPARMOR} 644
    apparmor_parser -r ${APPARMOR}
    record "AppArmor: rootlesskit may use user namespaces" "apparmor_parser -R ${APPARMOR} 2>/dev/null || true; rm -f ${APPARMOR}"
  fi
  if [ "$ST_DD" = true ]; then
    install -d -m 0755 "$(dirname ${DROPIN})"
    printf '# managed by landfall\n[Service]\nDelegate=cpu cpuset io memory pids\n' | _put ${DROPIN} 644
    systemctl daemon-reload
    record "systemd: user managers may limit cpu, memory and tasks" "rm -f ${DROPIN}; rmdir $(dirname ${DROPIN}) 2>/dev/null || true; systemctl daemon-reload"
  fi

  chmod 0751 ${ROOT}
  for e in ${ROOT}/* ${ROOT}/.[!.]*; do [ -e "$e" ] && [ ! -L "$e" ] && [ "$e" != ${TENANTS} ] && chmod o-rwx "$e" || true; done
  record "other users may enter ${ROOT} but see only tenants/" "$UNDO_MODES"

  if LC_ALL=C ufw status 2>/dev/null | grep -q '^Status: active'; then
    for r in 80/tcp 443/tcp 443/udp; do
      out=$(ufw allow "$r")
      case "$out" in
        *Skipping*|*"Rule updated"*) ;;
        *) record "ufw allow $r" "ufw --force delete allow $r >/dev/null"; ST_UFW="$ST_UFW$([ -z "$ST_UFW" ] || echo ,)\"allow $r\""; write_state ;;
      esac
    done
  fi

  if [ "$ST_HN" = false ]; then
    log "central Traefik: to the host network (a short outage)"
    cp -p ${COMPOSE} ${COMPOSE_BEFORE}
    [ ! -f ${TRAEFIK_DIR}/.landfall.sha256 ] || cp -p ${TRAEFIK_DIR}/.landfall.sha256 ${COMPOSE_BEFORE}.sha256
    undo="$(saved ${COMPOSE}); $(saved ${TRAEFIK_DIR}/.landfall.sha256); cd ${TRAEFIK_DIR} && dc up -d --force-recreate >&2"
    awk '
      /^    ports:$/ { skip = 1; next }
      /^    networks:$/ { skip = 1; next }
      /^networks:$/ { exit }
      skip && /^      - / { next }
      { skip = 0 }
      /^    volumes:$/ && !done { print "    network_mode: host"; done = 1 }
      { sub(/--entrypoints\.tunnel\.address=:/, "--entrypoints.tunnel.address=127.0.0.1:"); print }
    ' ${COMPOSE} > ${COMPOSE}.tenants
    (cd ${TRAEFIK_DIR} && dc -f docker-compose.yml.tenants config -q) || { rm -f ${COMPOSE}.tenants; log "the rewritten Traefik compose file is invalid"; exit 1; }
    mv -f ${COMPOSE}.tenants ${COMPOSE}
    [ ! -f ${TRAEFIK_DIR}/.landfall.sha256 ] || (cd ${TRAEFIK_DIR} && sha256sum docker-compose.yml > .landfall.sha256)
    (cd ${TRAEFIK_DIR} && dc up -d --force-recreate >&2)
    record "central Traefik on the host network" "$undo"
    ST_SUM=$(sha256sum ${COMPOSE} | cut -d' ' -f1)
  fi
  ST_DONE=true
  write_state
elif ! grep -q '"complete": true' ${STATE_FILE}; then
  log "the first lf tenant add stopped halfway; lf tenant off rolls back what it changed, then add again"
  exit 1
fi
`;

const ADD = String.raw`
TJSON=${TENANTS}/"$U".json; TROOT=${TENANTS}/"$U"
if id "$U" >/dev/null 2>&1; then
  [ -d "$TROOT" ] || { log "user $U exists and is not a tenant; pick another name"; exit 1; }
  id -nG "$U" | tr ' ' '\n' | grep -qx docker && { log "$U is in the docker group, which is root; take it out first"; exit 1; }
fi
[ ! -f "$TJSON" ] || { log "$U is a tenant already"; exit 1; }
for f in ${TENANTS}/*.json; do
  [ -e "$f" ] && [ "$f" != ${STATE_FILE} ] || continue
  grep -q "\"port\": $PORT," "$f" && { log "port $PORT belongs to tenant $(basename "$f" .json)"; exit 1; }
done
[ -z "$(ss -ltnH "sport = :$PORT")" ] || { log "port $PORT is in use"; exit 1; }
${COLLISIONS}
${SERVERWIDE}

if ! id "$U" >/dev/null 2>&1; then
  useradd -m -U -s /bin/bash "$U"
  user_nopw "$U"
fi
install -d -o "$U" -g "$U" -m 0700 "$TROOT"
record "added tenant $U" "$OFF"
UID_=$(id -u "$U"); H=$(home_of "$U")
chmod 0700 "$H"
next_sub() { awk -F: 'BEGIN { m = 100000 } NF == 3 && $2 + $3 > m { m = $2 + $3 } END { print m }' "$1"; }
grep -q "^$U:" /etc/subuid || { s=$(next_sub /etc/subuid); usermod --add-subuids "$s-$((s + 65535))" "$U"; }
grep -q "^$U:" /etc/subgid || { s=$(next_sub /etc/subgid); usermod --add-subgids "$s-$((s + 65535))" "$U"; }
runuser -u "$U" -- sh -c 'umask 077; mkdir -p "$1/.ssh"; grep -qxF "$2" "$1/.ssh/authorized_keys" 2>/dev/null || printf "%s\n" "$2" >> "$1/.ssh/authorized_keys"' sh "$H" "$KEY"
for d in docker sites traefik traefik/letsencrypt traefik/dynamic; do install -d -o "$U" -g "$U" -m 0700 "$TROOT/$d"; done
loginctl enable-linger "$U"
user_up "$U"
runuser -u "$U" -- sh -c 'umask 077; c=$1/.config; mkdir -p "$c/docker" "$c/systemd/user/docker.service.d"
printf "{\n  \"data-root\": \"%s/docker\",\n  \"ip\": \"127.0.0.1\"\n}\n" "$2" > "$c/docker/daemon.json"
printf "[Service]\nEnvironment=DOCKERD_ROOTLESS_ROOTLESSKIT_PORT_DRIVER=%s\n" "$3" > "$c/systemd/user/docker.service.d/landfall.conf"' sh "$H" "$TROOT" "$PORT_DRIVER"
[ -f "$H/.config/systemd/user/docker.service" ] || as_user "$U" dockerd-rootless-setuptool.sh install >&2
as_user "$U" docker context use rootless >/dev/null
as_user "$U" systemctl --user daemon-reload
as_user "$U" systemctl --user enable docker >/dev/null 2>&1
as_user "$U" systemctl --user restart docker
for _ in $(seq 60); do as_user "$U" docker info >/dev/null 2>&1 && break; sleep 1; done
as_user "$U" docker info >/dev/null 2>&1 || { log "the rootless Docker of $U does not answer"; exit 1; }

log "measuring the address the tenant's containers see"
as_user "$U" docker rm -f lf-probe >/dev/null 2>&1 || true
as_user "$U" docker run -d --name lf-probe -p "127.0.0.1:$PORT:80" traefik/whoami >/dev/null
addr=""
for _ in $(seq 30); do addr=$(curl -fsS "http://127.0.0.1:$PORT/" 2>/dev/null | awk '/^RemoteAddr:/ {print $2}') && [ -n "$addr" ] && break; sleep 1; done
as_user "$U" docker rm -f lf-probe >/dev/null
TRUSTED=$(printf %s "$addr" | sed 's/:[0-9]*$//; s/^\[//; s/\]$//')
[ -n "$TRUSTED" ] || { log "could not measure the address the tenant's containers see"; exit 1; }
as_user "$U" docker network inspect web >/dev/null 2>&1 || as_user "$U" docker network create web >/dev/null

printf %s "$JSON" | sed "s/@UID@/$UID_/; s/@TRUSTED@/$TRUSTED/" | _put "$TJSON" 640
chgrp "$U" "$TJSON"
printf %s "$ROUTE" | _put ${TRAEFIK_DIR}/dynamic/tenant-"$U".yml 644
[ -z "$LIMITS" ] || systemctl set-property "user-$UID_.slice" $LIMITS
log "tenant $U: 127.0.0.1:$PORT, containers see $TRUSTED"
`;

export interface AddTenant {
  user: string;
  key: string;
  domains: string[];
  port: number;
  limits: Limits;
  /** "ufw", or the provider firewall in front of the server. */
  firewall: string;
}

const limitProps = (l: Limits) =>
  [l.memory && `MemoryMax=${l.memory}`, l.cpu && `CPUQuota=${l.cpu}`, l.tasks && `TasksMax=${l.tasks}`].filter(Boolean).join(" ");

export function addScript(t: AddTenant) {
  const file: TenantFile = {
    user: t.user,
    uid: 0,
    port: t.port,
    domains: t.domains,
    portDriver: PORT_DRIVER,
    active: true,
    trustedIP: "@TRUSTED@",
    created: new Date().toISOString(),
    ...(Object.keys(t.limits).length ? { limits: t.limits } : {}),
  };
  const json = tenantJson(file).replace('"uid": 0', '"uid": @UID@');
  return {
    script: locked(ADD),
    env: {
      U: t.user,
      KEY: t.key,
      PORT: String(t.port),
      DOMAINS: t.domains.join(" "),
      JSON: json,
      ROUTE: routeYaml(t.user, t.port, t.domains),
      LIMITS: limitProps(t.limits),
      FIREWALL: t.firewall,
      PORT_DRIVER,
      OFF: offShell(t.user),
    },
  };
}

const DOMAINS_SET = String.raw`
${UNCHANGED}
${COLLISIONS}
R=${TRAEFIK_DIR}/dynamic/tenant-"$U".yml
[ -f "$R" ] || R=${TENANTS}/"$U".route.disabled
undo="$(saved ${TENANTS}/"$U".json); $(saved "$R")"
printf %s "$JSON" | _put ${TENANTS}/"$U".json 640
chgrp "$U" ${TENANTS}/"$U".json
printf %s "$ROUTE" | _put "$R" 644
record "tenant $U: domains $DOMAINS" "$undo"
`;

export function domainsScript(t: TenantFile, was: string, domains: string[]) {
  return {
    script: locked(DOMAINS_SET),
    env: { U: t.user, WAS: was, DOMAINS: domains.join(" "), JSON: tenantJson({ ...t, domains }), ROUTE: routeYaml(t.user, t.port, domains) },
  };
}

const LIMITS_SET = String.raw`
${UNCHANGED}
undo="$(saved ${TENANTS}/"$U".json); systemctl set-property user-$(id -u "$U").slice $BEFORE"
systemctl set-property "user-$(id -u "$U").slice" $LIMITS
printf %s "$JSON" | _put ${TENANTS}/"$U".json 640
chgrp "$U" ${TENANTS}/"$U".json
record "tenant $U: limits $LIMITS" "$undo"
`;

/** Unset limits go back to none: systemd's own values for no limit. */
export function limitsScript(t: TenantFile, was: string, limits: Limits) {
  const full = (l: Limits = {}) => `MemoryMax=${l.memory ?? "infinity"} CPUQuota=${l.cpu ?? ""} TasksMax=${l.tasks ?? "infinity"}`;
  const next = { ...t.limits, ...limits };
  for (const k of Object.keys(next) as (keyof Limits)[]) if (next[k] === "none") delete next[k];
  return {
    script: locked(LIMITS_SET),
    env: { U: t.user, WAS: was, LIMITS: full(next), BEFORE: full(t.limits), JSON: tenantJson({ ...t, limits: Object.keys(next).length ? next : undefined }) },
  };
}

const STOP = String.raw`
as_user "$U" systemctl --user stop docker docker.socket 2>/dev/null || as_user "$U" systemctl --user stop docker
record "stopped the Docker of tenant $U" "$FN_SH
user_up $(printf %q "$U"); as_user $(printf %q "$U") systemctl --user start docker"
`;
const START = String.raw`
user_up "$U"
as_user "$U" systemctl --user start docker
record "started the Docker of tenant $U" "$FN_SH
as_user $(printf %q "$U") systemctl --user stop docker"
`;

export const stopScript = (user: string, stop: boolean) => ({
  script: locked(stop ? STOP : START),
  env: { U: user, FN_SH: FN },
});

const OFF_ONE = String.raw`
${UNCHANGED}
t_off "$U"
record "deactivated tenant $U; its data stays under ${TENANTS}/$U" "$ON"
`;
const ON_ONE = String.raw`
${UNCHANGED}
id "$U" >/dev/null 2>&1 || { log "the user $U is gone; only lf tenant rm $U --purge cleans up"; exit 1; }
t_on "$U"
record "restored tenant $U" "$OFF"
`;

export const deactivateScript = (user: string, was: string) => ({
  script: locked(OFF_ONE),
  env: { U: user, WAS: was, ON: onShell(user) },
});
export const restoreScript = (user: string, was: string) => ({
  script: locked(ON_ONE),
  env: { U: user, WAS: was, OFF: offShell(user) },
});

const PURGE = String.raw`
${UNCHANGED}
if id "$U" >/dev/null 2>&1; then
  UID_=$(id -u "$U")
  if [ -f "$(home_of "$U")/.config/systemd/user/docker.service" ] && user_up "$U"; then
    as_user "$U" dockerd-rootless-setuptool.sh uninstall -f >&2 || log "the rootless Docker of $U did not uninstall cleanly"
  fi
  t_off "$U"
  pkill -KILL -u "$U" 2>/dev/null || true
  rm -rf "/etc/systemd/system.control/user-$UID_.slice.d"
  systemctl daemon-reload
  user_del "$U"
  sed -i "/^$U:/d" /etc/subuid /etc/subgid
fi
rm -rf ${TENANTS}/"$U" ${TENANTS}/"$U".json ${TENANTS}/"$U".route.disabled ${TENANTS}/"$U".crontab.disabled ${TRAEFIK_DIR}/dynamic/tenant-"$U".yml
record "deleted tenant $U, its user and all its data"
`;

export const purgeScript = (user: string, was: string) => ({ script: locked(PURGE), env: { U: user, WAS: was } });

const OFF_ALL = String.raw`
[ -f ${STATE_FILE} ] || { log "tenants are off already"; exit 1; }
[ "$(cat ${STATE_FILE})" = "$WAS" ] || { log "${STATE_FILE} changed meanwhile; run the command again"; exit 1; }
for f in ${TENANTS}/*.json; do
  [ -e "$f" ] && [ "$f" != ${STATE_FILE} ] || continue
  grep -q '"active": true' "$f" || continue
  u=$(basename "$f" .json)
  [ "$RM_TENANTS" = 1 ] || { log "tenant $u is active: lf tenant rm $u first, or pass --rm-tenants"; exit 1; }
  t_off "$u"
  record "deactivated tenant $u; its data stays under ${TENANTS}/$u" "$FN_SH
t_on $(printf %q "$u")"
done
for r in $UFW; do
  ufw --force delete allow "$r" >/dev/null || log "could not delete the ufw rule allow $r"
  record "ufw delete allow $r" "ufw allow $r >/dev/null"
done
if [ "$HOST_NET" = false ] && [ -f ${COMPOSE_BEFORE} ]; then
  [ "$(sha256sum ${COMPOSE} | cut -d' ' -f1)" = "$SUM" ] || log "${COMPOSE} changed since the first tenant; it goes back all the same"
  undo="$(saved ${COMPOSE}); $(saved ${TRAEFIK_DIR}/.landfall.sha256); cd ${TRAEFIK_DIR} && dc up -d --force-recreate >&2"
  cp -p ${COMPOSE_BEFORE} ${COMPOSE}
  [ ! -f ${COMPOSE_BEFORE}.sha256 ] || cp -p ${COMPOSE_BEFORE}.sha256 ${TRAEFIK_DIR}/.landfall.sha256
  (cd ${TRAEFIK_DIR} && dc up -d --force-recreate >&2)
  rm -f ${COMPOSE_BEFORE} ${COMPOSE_BEFORE}.sha256
  record "central Traefik back on its own network" "$undo"
fi
undo="chmod 0751 ${ROOT};"
printf '%s\n' "$MODES" | while read -r m n; do [ -z "$n" ] || [ ! -e ${ROOT}/"$n" ] || chmod "$m" ${ROOT}/"$n"; done
chmod "$ROOT_MODE" ${ROOT}
for e in ${ROOT}/* ${ROOT}/.[!.]*; do [ -e "$e" ] && [ ! -L "$e" ] && [ "$e" != ${TENANTS} ] && undo="$undo chmod o-rwx $(printf %q "$e");" || true; done
record "modes under ${ROOT} back as before the first tenant" "$undo"
if [ "$AA" = true ] && [ -f ${APPARMOR} ]; then
  undo="$(saved ${APPARMOR}) && apparmor_parser -r ${APPARMOR}"
  apparmor_parser -R ${APPARMOR} 2>/dev/null || true
  rm -f ${APPARMOR}
  record "removed the AppArmor profile for rootlesskit" "$undo"
fi
if [ "$DD" = true ] && [ -f ${DROPIN} ]; then
  undo="$(saved ${DROPIN}) && systemctl daemon-reload"
  rm -f ${DROPIN}
  rmdir "$(dirname ${DROPIN})" 2>/dev/null || true
  systemctl daemon-reload
  record "removed the systemd delegation for user managers" "$undo"
fi
if [ -n "$PKGS" ]; then
  if [ "$RM_PACKAGES" = 1 ]; then
    case "$(pkg_mgr)" in
      apt-get) DEBIAN_FRONTEND=noninteractive apt-get remove -y -q $PKGS >&2 ;;
      dnf) dnf remove -y $PKGS >&2 ;;
    esac
    record "removed the packages$(printf ' %s' $PKGS)"
  else
    log "kept the packages $PKGS (--remove-packages removes them)"
  fi
fi
mv -f ${STATE_FILE} ${STATE_FILE}.off
record "tenants off" "mv -f ${STATE_FILE}.off ${STATE_FILE}"
`;

export function offScript(st: TenantsState, was: string, o: { rmTenants?: boolean; removePackages?: boolean }) {
  return {
    script: locked(OFF_ALL),
    env: {
      WAS: was,
      FN_SH: FN,
      RM_TENANTS: o.rmTenants ? "1" : "0",
      RM_PACKAGES: o.removePackages ? "1" : "0",
      UFW: st.ufw.map((r) => r.replace(/^allow /, "")).join(" "),
      HOST_NET: String(st.traefikHostNetwork),
      SUM: st.composeWritten ?? "",
      MODES: Object.entries(st.modes ?? {})
        .map(([n, m]) => `${m} ${n}`)
        .join("\n"),
      ROOT_MODE: st.rootMode,
      AA: String(st.apparmorProfile),
      DD: String(st.delegateDropIn),
      PKGS: st.packages.join(" "),
    },
  };
}

/** Whether a first tenant changed this server: any login may see it, tenants/ is 0751. */
export async function tenantsOn(s: Server): Promise<boolean> {
  const { code } = await runScript(s, `test -f ${STATE_FILE}`, { capture: true, codes: [1] });
  return code === 0;
}
