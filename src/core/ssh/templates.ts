import { ACCESS_LOG_FLAGS } from "../traefik/traffic-merge";

/** Everything landfall puts on a server lives below this root. */
export const ROOT = "/opt/landfall";
export const SITES = `${ROOT}/sites`;
export const TENANTS = `${ROOT}/tenants`;
export const TRAEFIK_DIR = `${ROOT}/traefik`;
/** Traefik's file provider reads every file here; landfall writes TLS_FILE, other files are yours (e.g. certificates). */
export const DYNAMIC_DIR = `${TRAEFIK_DIR}/dynamic`;
export const NETWORK = "web";
/** Traefik's dashboard for `lf traefik dashboard`: inside the container, or on the host's loopback in host mode. */
export const TUNNEL_PORT = 8080;
/** The router that serves the dashboard on TUNNEL_PORT; `lf traefik dashboard` looks for it. */
export const TUNNEL_ROUTER = "dashboard-tunnel";
/** The major tag: every deploy and `lf update` gets the newest v3 release; v4 needs a config review. */
export const DEFAULT_TRAEFIK_IMAGE = "traefik:v3";
/** Present when sites go through a Traefik the server already had instead of landfall's own. */
export const PROXY_FILE = `${ROOT}/proxy.env`;
/** Shell test: the Traefik in TRAEFIK_DIR is landfall's own (its compose file carries landfall's mark). */
export const OWN_TRAEFIK = `grep -qs "managed by landfall" ${TRAEFIK_DIR}/docker-compose.yml`;
/** Append-only log of every change landfall made, each with the shell that reverts it (lf log, lf undo). */
export const JOURNAL = `${ROOT}/journal.log`;
/** Backups `saved` keeps per file; undo of an older change leaves that file as it is. */
const KEEP_BACKUPS = 10;
/** Which landfall changed the server last, the newest one that ever did, and the migrations applied (lf server upgrade). */
export const STAMP_FILE = `${ROOT}/landfall.json`;

/**
 * Shell for STAMP_FILE, part of PRELUDE: {"newest": <the newest landfall that ever changed the server>, "migration": <applied>}.
 * LANDFALL_CLI (this lf's version) and LANDFALL_MIGRATION (the migrations it knows) come from runScript. Which landfall
 * changed the server last is the journal's last line.
 */
const STAMP_SH = String.raw`
# ver_gt <a> <b>: version a is newer than b (dotted numbers; a -prerelease suffix is ignored).
ver_gt() {
  awk -v a="$1" -v b="$2" 'BEGIN { sub(/-.*/, "", a); sub(/-.*/, "", b); n = split(a, x, "."); m = split(b, y, "."); if (m > n) n = m
    for (i = 1; i <= n; i++) { if (x[i] + 0 > y[i] + 0) exit 0; if (x[i] + 0 < y[i] + 0) exit 1 }; exit 1 }'
}
_stamp_get() { [ -f ${STAMP_FILE} ] || return 0; sed -n "s/.*\"$1\": *\"\{0,1\}\([^\",}]*\).*/\1/p" ${STAMP_FILE} 2>/dev/null | head -n1 || true; }
# _stamp_level: the migrations applied. Without landfall.json: $_stamp_fresh, which setup sets on a fresh server (nothing to migrate), else 0.
_stamp_fresh=
_stamp_level() { local l=$_stamp_fresh; [ ! -f ${STAMP_FILE} ] || l=$(_stamp_get migration); case "$l" in ''|*[!0-9]*) l=0 ;; esac; printf %s "$l"; }
# _stamp_write <level> <newest>: never fails a script.
_stamp_write() {
  printf '{"newest":"%s","migration":%s}\n' "$2" "$1" | _put ${STAMP_FILE} 2>/dev/null || log "warning: could not write ${STAMP_FILE}"
}
# _stamp: _journal calls it after a script's first change. Warns once per lf run (an earlier script of the run journaled
# the line before) when a newer landfall changed the server; raises newest when this lf is newer.
_STAMPED=
_stamp() {
  [ -z "$_STAMPED" ] || return 0
  _STAMPED=1
  [ "$(tail -n2 ${JOURNAL} 2>/dev/null | cut -f2)" != "$LANDFALL_RUN"$'\n'"$LANDFALL_RUN" ] || return 0
  local level newest
  level=$(_stamp_level)
  newest=$(_stamp_get newest)
  if { [ -n "$newest" ] && ver_gt "$newest" "$LANDFALL_CLI"; } || [ "$level" -gt "$LANDFALL_MIGRATION" ]; then
    log "warning: a newer landfall changed this server ($newest, migration $level), yours is $LANDFALL_CLI (migration $LANDFALL_MIGRATION). Update it: $LANDFALL_UPDATE"
  elif [ -z "$newest" ] || ver_gt "$LANDFALL_CLI" "$newest"; then
    _stamp_write "$level" "$LANDFALL_CLI"
  fi
}
# _set_migration <level> [what]: the migrations applied; newest stays. With <what> it is journaled, and its undo sets the level back.
_set_migration() {
  local prev
  prev=$(_stamp_level)
  _stamp_write "$1" "$(_stamp_get newest)"
  [ $# -lt 2 ] || record "landfall migration $1: $2" "_set_migration $prev"
}`;

/** sshd drop-in written by setup's hardening. */
export const SSHD_CONF = "/etc/ssh/sshd_config.d/00-landfall.conf";
/** sshd drop-in written by `lf harden ssh-options`. */
export const SSHD_OPTIONS_CONF = "/etc/ssh/sshd_config.d/01-landfall-options.conf";
/** Kernel settings written by `lf harden kernel`. */
export const SYSCTL_CONF = "/etc/sysctl.d/90-landfall.conf";

/** The Traefik that routes landfall's sites. */
export interface Proxy {
  container: string;
  network: string;
  entrypoint: string;
  resolver: string;
}
export const OWN_PROXY: Proxy = { container: "traefik", network: NETWORK, entrypoint: "websecure", resolver: "le" };

/** Shell: name of the proxy container. */
export const PROXY_CTR = `"$(sed -n 's/^container=//p' ${PROXY_FILE} 2>/dev/null | grep . || echo traefik)"`;

/** Start of a script that reads the proxy: `$P` is its container; without one it prints NOPROXY and stops. */
export const PROXY_PRELUDE = `set +e
P=${PROXY_CTR}
if ! docker inspect "$P" >/dev/null 2>&1; then echo NOPROXY; exit 0; fi`;

/** `key=value` lines (or words) of PROXY_FILE; undefined when incomplete. */
export function parseProxy(text: string): Proxy | undefined {
  const kv = Object.fromEntries(
    text
      .split(/\s+/)
      .filter((w) => w.includes("=") && !w.startsWith("#"))
      .map((w) => [w.slice(0, w.indexOf("=")), w.slice(w.indexOf("=") + 1)]),
  );
  const { container, network, entrypoint, resolver } = kv;
  return container && network && entrypoint && resolver ? { container, network, entrypoint, resolver } : undefined;
}

export const proxyFile = (p: Proxy) =>
  `# landfall routes its sites through this existing traefik; delete the file to let landfall run its own\n` +
  `container=${p.container}\nnetwork=${p.network}\nentrypoint=${p.entrypoint}\nresolver=${p.resolver}\n`;

/** Sets PRETTY_NAME, ID and VERSION_ID; needs kv(). Prints platform for systems that install their own way. */
export const OS_RELEASE = `PRETTY_NAME=unknown; ID=; VERSION_ID=; ID_LIKE=; . /etc/os-release 2>/dev/null
# Synology DSM has no os-release, only /etc/VERSION.
if [ -f /etc/synoinfo.conf ]; then
  productversion=; . /etc/VERSION 2>/dev/null
  ID=dsm; VERSION_ID=$productversion; PRETTY_NAME="Synology DSM $productversion"; kv platform synology
elif [ "$ID" = steamos ]; then PRETTY_NAME="SteamOS $VERSION_ID"; kv platform steamos
fi`;

/**
 * Prints `cloud=<id>` where the hypervisor's DMI strings name the provider (facts.ts CLOUDS has the ids).
 * The files are world-readable and local: no metadata request, nothing to install.
 */
export const CLOUD = String.raw`dmi=$(cd /sys/class/dmi/id 2>/dev/null && cat sys_vendor product_name bios_vendor bios_version chassis_asset_tag 2>/dev/null | tr '\n' ' ') || true
case "$dmi" in
  *OracleCloud*) kv cloud oracle ;;
  *"Amazon EC2"*|*amazon*) kv cloud aws ;;
  *"Google Compute Engine"*) kv cloud gcp ;;
  # Azure's chassis tag: Hyper-V anywhere else is "Microsoft Corporation" too.
  *7783-7084-3265-9085-8269-3286-77*) kv cloud azure ;;
  *"Alibaba Cloud"*) kv cloud alibaba ;;
  *Hetzner*) kv cloud hetzner ;;
  *DigitalOcean*) kv cloud digitalocean ;;
  *Vultr*) kv cloud vultr ;;
  *Linode*|*Akamai*) kv cloud linode ;;
  *Scaleway*) kv cloud scaleway ;;
  *UpCloud*) kv cloud upcloud ;;
esac`;

/** True when installed updates wait for a reboot: Debian's flag file, or needs-restarting on RHEL-likes (exit 1). */
export const REBOOT_NEEDED = String.raw`reboot_needed() { [ -f /var/run/reboot-required ] && return 0; command -v needs-restarting >/dev/null 2>&1 || return 1; needs-restarting -r >/dev/null 2>&1; [ $? = 1 ]; }`;

export const PKG_MGR = String.raw`pkg_mgr() { for m in apt-get dnf yum apk zypper; do command -v $m >/dev/null 2>&1 && { echo $m; return 0; }; done; echo none; }`;

/** Shell: users whose password field is empty (anyone could log in as them where passwords work). Needs root. */
export const EMPTY_PASSWORDS = String.raw`awk -F: '$2 == "" {print $1}' /etc/shadow`;
/** Shell: site env files the group or others can read; landfall writes them 600. Needs root. */
export const OPEN_ENV_FILES = String.raw`find ${SITES} -maxdepth 2 -type f -name '.env*' \( -perm -004 -o -perm -040 \)`;

/**
 * Read-only security checks shared by setup's probe, lf system and lf harden. Needs $SUDO (empty as
 * root, or where sudo would ask: then the root-only checks print nothing).
 */
export const SEC_CHECKS = String.raw`
S() { if [ -n "$SUDO" ]; then sudo -n "$@"; else "$@"; fi; }
# ufw.conf, not ufw status: that starts Python (slow) and needs root. ufw enable/disable write ENABLED.
ufw_state() {
  if ! command -v ufw >/dev/null 2>&1; then echo missing
  elif grep -qx 'ENABLED=yes' /etc/ufw/ufw.conf 2>/dev/null; then echo active
  else echo inactive; fi
}
password_users() { S awk -F: '$2 ~ /^\$/ {printf "%s ", $1}' /etc/shadow 2>/dev/null; }
# What sshd really uses (a Match block or an earlier file can override ours): "no", "" without root, else passwords work.
sshd_passwords() { S sshd -T 2>/dev/null | awk '$1 == "passwordauthentication" || $1 == "kbdinteractiveauthentication" {print $2}' | sort -u | tr -d '\n'; }
# sshd_opt <keyword>: the value sshd really uses, Include files and first-match-wins resolved; "" without root.
# awk reads to the end: an early exit would kill sshd -T with SIGPIPE, and pipefail fail the script.
sshd_opt() { S sshd -T 2>/dev/null | awk -v k="$1" '$1 == k && !f {print $2; f = 1}'; }
key_file_user() { printf %s "$1" | sed 's#^/root/.*#root#; s#^/home/\([^/]*\)/.*#\1#'; }
# Users with a key: keys-only ssh does not lock them out.
key_users() {
  for f in /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys; do
    S grep -q '^[^#[:space:]]' "$f" 2>/dev/null && printf '%s ' "$(key_file_user "$f")"
  done; return 0
}
apt_auto_updates() { dpkg -s unattended-upgrades >/dev/null 2>&1 && apt-config dump 2>/dev/null | grep '^APT::Periodic::Unattended-Upgrade "1"' >/dev/null; }
# dnf 4's dnf-automatic-install.timer installs; the other timers only download unless automatic.conf says apply_updates.
dnf_applies() { grep -qiE '^[[:space:]]*apply_updates[[:space:]]*=[[:space:]]*(yes|true|1)' /etc/dnf/automatic.conf 2>/dev/null; }
dnf_auto_updates() {
  systemctl is-enabled -q dnf-automatic-install.timer 2>/dev/null \
    || { { systemctl is-enabled -q dnf-automatic.timer 2>/dev/null || systemctl is-enabled -q dnf5-automatic.timer 2>/dev/null; } && dnf_applies; }
}
# Alpine: crond runs a job that runs apk upgrade (lf harden updates puts one in /etc/periodic/daily).
apk_auto_updates() { pidof crond >/dev/null && { S cat /etc/periodic/*/* /etc/crontabs/root 2>/dev/null || true; } | grep 'apk .*upgrade' >/dev/null; }
`;

/** Shared shell helpers prepended to every remote script. */
/** Any image with sh, tar, find and chown does; landfall needs nothing of its own on the server. */
export const HELPER = "alpine:3";
/** Shell: one CTR line per container: name, status, compose project, compose service, image (and ports). */
export const ctrPs = (ports = false) =>
  String.raw`docker ps -a --format 'CTR\t{{.Names}}\t{{.Status}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.service"}}\t{{.Image}}${ports ? String.raw`\t{{.Ports}}` : ""}'`;
/** Shell helper for read-only probes: kv <key> <value> prints one key=value line. */
export const KV = String.raw`kv() { printf '%s=%s\n' "$1" "$2"; }`;
/** A `key=value` line of KV's output, as [key, trimmed value]; undefined for any other line. */
export function kvLine(line: string): [string, string] | undefined {
  const i = line.indexOf("=");
  return i > 0 ? [line.slice(0, i), line.slice(i + 1).trim()] : undefined;
}
/** Every `key=value` line of KV's output as one record; other lines are skipped. */
export const kvRecord = (out: string): Record<string, string> =>
  Object.fromEntries(
    out
      .split("\n")
      .map(kvLine)
      .filter((kv) => kv !== undefined),
  );

export const PRELUDE = String.raw`
# useradd, visudo, gpasswd and friends live in sbin, which a non-root PATH often lacks.
PATH="$PATH:/usr/sbin:/sbin"
log() { printf '\033[36m  ->\033[0m %s\n' "$*" >&2; }
SUDO=""; if [ -n "${"${LANDFALL_TENANT:-}"}" ]; then SUDO=_tenant_no_root; elif [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; fi
_tenant_no_root() { echo "error: this needs root; ask the admin of $LANDFALL_TENANT" >&2; exit 1; }
${SEC_CHECKS}
# Files a container wrote may be root's.
rmf() { rm -rf "$@" 2>/dev/null || $SUDO rm -rf "$@"; }
# A user's home: getent also asks LDAP and friends; /etc/passwd where there is no getent.
home_of() { local h; h=$(getent passwd "$1" 2>/dev/null | cut -d: -f6) || true; [ -n "$h" ] || h=$(awk -F: -v u="$1" '$1 == u { print $6 }' /etc/passwd); printf '%s' "$h"; }
# The distro's package manager, and installing with it.
${PKG_MGR}
${REBOOT_NEEDED}
pkg_cmd() { case "$(pkg_mgr)" in apk) echo "apk add" ;; apt-get) echo "apt-get install" ;; none) echo "install" ;; *) echo "$(pkg_mgr) install" ;; esac; }
pkg_has() {
  case "$(pkg_mgr)" in
    apt-get) dpkg -s "$1" ;;
    # --whatprovides: dnf5's plugin provides dnf-automatic under another name.
    dnf|yum|zypper) rpm -q --whatprovides "$1" ;;
    apk) apk info -e "$1" ;;
    *) false ;;
  esac >/dev/null 2>&1
}
# Whether this login can run root commands: it is root, or it may sudo (-K's password counts: its shim drops -n).
can_root() { [ "$SUDO" != _tenant_no_root ] && { [ -z "$SUDO" ] || { command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; }; }; }
pkg_install() {
  if ! can_root; then
    if command -v sudo >/dev/null 2>&1; then
      echo "installing $* needs root: $(id -un) may not sudo without a password. Install it as root ($(pkg_cmd) $*), or give the sudo password with -K (\$LANDFALL_SUDO_PASSWORD)" >&2
    else
      echo "installing $* needs root: $(id -un) is not root and the server has no sudo. Install it as root ($(pkg_cmd) $*)" >&2
    fi
    return 1
  fi
  log "installing $*"
  case "$(pkg_mgr)" in
    # clean: apt-get keeps every downloaded .deb in /var/cache/apt/archives.
    apt-get) $SUDO apt-get update -q >&2 && $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -q "$@" >&2 && { $SUDO apt-get clean || true; } ;;
    dnf) $SUDO dnf install -y "$@" >&2 ;;
    yum) $SUDO yum install -y "$@" >&2 ;;
    apk) $SUDO apk add --no-cache "$@" >&2 ;;
    zypper) $SUDO zypper -n install "$@" >&2 ;;
    *) log "no apt, dnf, yum, apk or zypper to install $*"; return 1 ;;
  esac
}
# What setup installs (rsync: redeploys send only what changed; busybox-suid: crontab for the deploy user).
# RHEL-likes and SUSE have no ufw/fail2ban in their base repos.
base_pkgs() {
  case "$(pkg_mgr)" in
    apt-get) echo "ca-certificates curl rsync ufw fail2ban unattended-upgrades" ;;
    apk) echo "ca-certificates curl rsync ufw busybox-suid" ;;
    none) ;;
    *) echo "ca-certificates curl rsync" ;;
  esac
}
# Resolved on first use: bootstrap sources this before docker is installed.
DC=""
dc() {
  [ -n "$DC" ] || DC=$(docker compose version >/dev/null 2>&1 && echo "docker compose" || echo docker-compose)
  $DC "$@"
}
# wait_ready <seconds> <container...>: until each runs, and is healthy if it has a healthcheck; 1 when one exits, turns unhealthy or time runs out.
wait_ready() {
  _end=$(( $(date +%s) + $1 )); shift
  for _c in "$@"; do
    while :; do
      _s=$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$_c" 2>/dev/null || echo gone)
      case "$_s" in
        "running healthy"|"running ") break ;;
        exited*|dead*|gone|*unhealthy) return 1 ;;
      esac
      [ "$(date +%s)" -lt "$_end" ] || return 1
      sleep 1
    done
  done
}
# The compose plugin's version, and whether a version has what sites need (2.24+: optional env_file, up --wait).
compose_v() { docker compose version --short 2>/dev/null | sed 's/^v//'; }
compose_ok() { case "$1" in 2.2[4-9]*|2.[3-9][0-9]*|2.[1-9][0-9][0-9]*|[3-9]*|[1-9][0-9]*) ;; *) return 1 ;; esac; }
# Deploy users reach docker via the docker group; bootstrap sets DOCKER="$SUDO docker".
DOCKER=docker
ensure_network() {
  $DOCKER network inspect "$1" >/dev/null 2>&1 && return 0
  $DOCKER network create "$1" >/dev/null
  record "created docker network $1" "docker network rm $1 >/dev/null 2>&1 || \$SUDO docker network rm $1 >/dev/null 2>&1 || log 'network $1 is still in use, kept'"
}
ensure_running() {
  [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = true ] && return 0
  log "$1 failed to start, last logs:"; docker logs --tail 30 "$1" >&2 || true; return 1
}
# svc <start|stop|restart|enable|disable> <name>; enable/disable: start at boot or not.
svc() {
  if [ -d /run/systemd/system ]; then $SUDO systemctl "$1" "$2"
  elif command -v rc-service >/dev/null 2>&1; then
    case "$1" in enable) $SUDO rc-update add "$2" default ;; disable) $SUDO rc-update del "$2" default ;; *) $SUDO rc-service "$2" "$1" ;; esac
  else log "no systemd or OpenRC: cannot $1 $2"; return 1; fi
}
# user_del <user> [keep-home]: userdel (busybox: deluser) refuses while the user has processes, so it retries.
user_del() {
  r=-r; [ $# -lt 2 ] || r=""
  [ "$(id -un)" = "$1" ] || $SUDO pkill -u "$1" 2>/dev/null || true
  for i in 1 2 3 4 5; do
    if command -v userdel >/dev/null 2>&1; then $SUDO userdel $r "$1" 2>/dev/null
    elif [ -n "$r" ]; then $SUDO deluser --remove-home "$1" 2>/dev/null
    else $SUDO deluser "$1" 2>/dev/null; fi
    id "$1" >/dev/null 2>&1 || return 0
    sleep 1
  done
  log "could not remove user $1"; return 1
}
# user_nopw <user>: no password, but not locked ('*'): sshd without PAM refuses locked accounts even for keys.
# busybox chpasswd reports success on stderr: its output shows only when it fails.
user_nopw() { $SUDO usermod -p '*' "$1" 2>/dev/null || { e=$(printf '%s:*\n' "$1" | $SUDO chpasswd -e 2>&1) || { log "$e"; return 1; }; }; }
sshd_reload() { $SUDO systemctl reload ssh 2>/dev/null || $SUDO systemctl reload sshd 2>/dev/null || $SUDO service ssh reload 2>/dev/null || true; }
# sshd_dropin <file> <what> <line>...: writes the lines to an sshd_config.d file and makes sshd_config include that folder.
# Tested with sshd -t, reloaded and journaled as <what>. A failed test puts both files back and returns 1.
sshd_dropin() {
  local file=$1 what=$2 want back=""
  shift 2
  want=$(printf '%s\n' "$@")
  if [ "$($SUDO cat "$file" 2>/dev/null || true)" != "$want" ]; then
    $SUDO install -d /etc/ssh/sshd_config.d
    back=$(saved "$file")
    printf '%s\n' "$want" | $SUDO tee "$file" >/dev/null
  fi
  if ! grep -qE '^\s*Include\s+/etc/ssh/sshd_config.d' /etc/ssh/sshd_config; then
    if [ -n "$back" ]; then back="$back; "; fi
    back="$back$(saved /etc/ssh/sshd_config)"
    printf 'Include /etc/ssh/sshd_config.d/*.conf\n%s' "$($SUDO cat /etc/ssh/sshd_config)" | $SUDO tee /etc/ssh/sshd_config >/dev/null
  fi
  [ -n "$back" ] || return 0
  log "$what"
  if $SUDO sshd -t; then
    sshd_reload
    record "$what" "$back; sshd_reload"
  else
    log "sshd config test failed, putting the old config back"
    eval "$back"
    return 1
  fi
}

# Journal. LANDFALL_RUN/LANDFALL_ACTOR/LANDFALL_CMD/LANDFALL_CLI (and LANDFALL_UPDATE, how to update lf) come from runScript. Writing it never fails a script.
_clean() { printf %s "$1" | tr '\t\n' '  '; }
_journal() { # _journal <do|undo> <what> <undo shell>
  line=$(printf '%s\t' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$LANDFALL_RUN" "$(_clean "$LANDFALL_ACTOR")" "$(id -un)" "$(_clean "$LANDFALL_CMD")" "$1" "$(_clean "$2")")
  line="$line$(printf %s "$3" | base64 | tr -d '\n')"$'\t'"$LANDFALL_CLI"
  if [ -w ${JOURNAL} ] || { [ ! -e ${JOURNAL} ] && [ -w ${ROOT} ]; }; then
    printf '%s\n' "$line" >> ${JOURNAL}
  elif ! can_root; then false
  else
    { $SUDO install -d ${ROOT} && printf '%s\n' "$line" | $SUDO tee -a ${JOURNAL} >/dev/null; } 2>/dev/null
  fi || { log "warning: could not write ${JOURNAL}"; return 0; }
  # A root (or sudo) first entry would leave the file root-owned, and deploy users could no longer
  # append; it belongs to whoever owns ${ROOT}.
  [ -O ${JOURNAL} ] && [ "$(id -u)" -ne 0 ] || $([ -z "$SUDO" ] || echo sudo -n) chown "$(stat -c %u:%g ${ROOT})" ${JOURNAL} 2>/dev/null || true
  [ "$1" != do ] || _stamp
}
${STAMP_SH}
# record <what> [undo shell]: journal a change; no undo shell = not reversible.
# Under the web UI it also says so (a report line): the UI offers lf undo for exactly the runs that can be undone.
record() {
  _journal do "$1" "$(shift; printf %s "$*")"
  [ $# -lt 2 ] || ! ( set +u; [ -n "$LANDFALL_REPORT" ] ) || printf '\036{"undoable":true}\n' >&2
}
# Run as $SUDO only when <dir> is not writable: deploy users own ${ROOT} and need no sudo.
_as() { if [ -w "$1" ]; then shift; "$@"; else shift; $SUDO "$@"; fi; }
# _put <file> [mode]: stdin to <file>, mode 644 unless given. A temp file, then mv: readers never see half a file,
# a root-owned one is replaced too, and a secret is never readable by others (mktemp makes the temp file 600).
_put() {
  local d t m=644
  [ $# -lt 2 ] || m=$2
  d=$(dirname "$1")
  t=$(_as "$d" mktemp "$d/.$(basename "$1").XXXXXX") || return 1
  { _as "$d" tee "$t" >/dev/null && _as "$d" chmod "$m" "$t" && _as "$d" mv -f "$t" "$1"; } || { _as "$d" rm -f "$t"; return 1; }
}
# saved <file>: back the file up, print the shell that puts it back (or removes it if it was new).
saved() {
  d=$(dirname "$1"); b="$d/.$(basename "$1").landfall-$LANDFALL_RUN-$RANDOM"
  # $(saved ...) does not inherit set -e: fail explicitly so callers stop instead of journaling a missing backup.
  if _as "$d" test -e "$1"; then _as "$d" cp -p "$1" "$b" || return 1; printf 'restore_file %q %q' "$b" "$1"
  else printf '_as %q rm -f %q' "$d" "$1"; fi
  # Keep the newest ${KEEP_BACKUPS} backups per file: old ones pile up (and .env copies hold secrets).
  # By ctime: cp -p keeps the original's mtime, so mtime says nothing about when the backup was made.
  _as "$d" ls -1Atc "$d" 2>/dev/null | awk -v p=".$(basename "$1").landfall-" 'index($0, p) == 1' | tail -n +$((${KEEP_BACKUPS} + 1)) \
    | while IFS= read -r f; do _as "$d" rm -f "$d/$f"; done || true
}
restore_file() { # restore_file <backup> <file>
  d=$(dirname "$2")
  # Gone = an earlier undo already put it back and failed later on (retrying must get past it), or it was pruned.
  _as "$d" test -e "$1" || { log "backup $1 is gone (already restored, or older than the last ${KEEP_BACKUPS}), $2 left as is"; return 0; }
  _as "$d" cp -p "$1" "$2" && _as "$d" rm -f "$1"
}
drop_line() { # drop_line <file> <line>: remove an exact line, keeping the file's owner and mode
  $SUDO test -e "$1" || return 0
  t=$($SUDO grep -vxF -- "$2" "$1" || true)
  { [ -z "$t" ] || printf '%s\n' "$t"; } | $SUDO tee "$1" >/dev/null
}
ufw_add() { # ufw_add [prepend | insert N] <rule...>: add a ufw rule, journaled with its delete
  out=$($SUDO ufw "$@") || return 1
  case "$1" in prepend) shift ;; insert) shift 2 ;; esac
  case "$out" in
    *Skipping*) ;;
    # ufw rewrote a rule that differed only in action/comment (limit 22 -> allow 22): deleting it
    # would drop a rule that existed before, so this is not reversible.
    *"Rule updated"*) record "ufw $* (replaced an existing rule)" ;;
    *) record "ufw $*" "\$SUDO ufw --force delete $(printf '%q ' "$@") >/dev/null" ;;
  esac
}
ufw_enable() {
  case "$($SUDO ufw status)" in
    *inactive*) $SUDO ufw --force enable >/dev/null; record "enabled ufw" '$SUDO ufw disable >/dev/null' ;;
  esac
}
`;

/** Keys-only sshd (root keeps key login unless it was off), journaled; also run by lf harden. Needs PRELUDE. */
export const HARDEN_SSH = String.raw`
harden_ssh() {
log "hardening sshd (keys only)"
# Keys only with key login off (PubkeyAuthentication no, maybe in an Include file) locks everyone out.
if [ "$(sshd_opt pubkeyauthentication)" = no ]; then
  log "warning: sshd refuses keys (PubkeyAuthentication no, check: sudo sshd -T); leaving password login on"
  return 0
fi
# Never loosen an admin's stricter root login setting.
root_login=prohibit-password
if [ "$(sshd_opt permitrootlogin)" = no ]; then root_login=no; fi
# 00- so it wins over cloud-init's 50-cloud-init.conf: sshd keeps the first value it reads.
# A failed sshd -t leaves the old config: carry on to the warning below.
sshd_dropin ${SSHD_CONF} "hardened sshd (keys only, root login $root_login)" \
  'PasswordAuthentication no' 'KbdInteractiveAuthentication no' "PermitRootLogin $root_login" || true
pw=$(sshd_passwords)
[ -z "$pw" ] || [ "$pw" = no ] || log "warning: sshd still accepts passwords; a Match block or another file in /etc/ssh overrides ${SSHD_CONF} (check: sudo sshd -T)"
}
harden_ssh
`;

/** Where setup puts the official compose plugin when the distro has none (or only v1). */
export const COMPOSE_PLUGIN = "/usr/local/lib/docker/cli-plugins/docker-compose";

/** Downloads the newest compose plugin to COMPOSE_PLUGIN, keeping the old one for undo. Needs PRELUDE. */
export const COMPOSE_INSTALL = String.raw`
compose_install() {
  arch=$(uname -m); case "$arch" in armv7l) arch=armv7 ;; armv6l) arch=armv6 ;; esac
  f=${COMPOSE_PLUGIN}
  $SUDO mkdir -p "$(dirname $f)" || return 1
  $SUDO curl -fsSL -o $f.new "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$arch" || { $SUDO rm -f $f.new; return 1; }
  $SUDO chmod 755 $f.new
  # A dot name: docker reads every docker-* file there as a plugin, and lists the backup as a broken one.
  b="$(dirname $f)/.docker-compose.landfall-$LANDFALL_RUN"
  if [ -f $f ]; then $SUDO mv $f "$b"; undo="\$SUDO mv $b $f"; else undo="\$SUDO rm -f $f"; fi
  $SUDO mv $f.new $f
  # Each is a whole compose binary: only the newest 2 stay (older landfall named them docker-compose.landfall-*).
  ls -1At "$(dirname $f)" | grep -E '^\.?docker-compose\.landfall-' | tail -n +3 | while IFS= read -r old; do $SUDO rm -f "$(dirname $f)/$old"; done || true
  record "installed docker compose $(docker compose version --short 2>/dev/null) to $f" "$undo"
}
`;

/** /opt/landfall/README: how to run everything here without landfall. Rewritten by every setup. */
const SERVER_README = `This server is run by landfall (https://www.npmjs.com/package/landfall).
Everything here works without it: it is plain Docker Compose.

${TRAEFIK_DIR}/          Traefik: docker-compose.yml, letsencrypt/ (certificates), dynamic/ (file provider)
${SITES}/<site>/        one Compose project per site
  .env                    the site's environment (lf env), mode 600
  site.json               landfall's notes: domains, releases
  current -> releases/<id>   the live release
  releases/<id>/compose.yaml           the site's compose file as deployed
  releases/<id>/compose.override.yaml  landfall's: Traefik labels, proxy network, project name
${JOURNAL}           every change landfall made, with the shell that undoes it
${STAMP_FILE}        the newest landfall that changed this server, and the upgrades applied (lf server upgrade)

Run a site by hand:
  cd ${SITES}/<site>/current && docker compose ps     (logs, restart, up -d, down …)
Roll back by hand:
  cd ${SITES}/<site> && ln -sfn releases/<id> current && cd -P current && docker compose up -d

Named volumes (databases, uploads) belong to the project, not the release: they survive
deploys and rollbacks. "lf sites rm" keeps them; "lf sites rm --volumes" deletes them.
`;

/**
 * Idempotent bootstrap: Docker, deploy user with our key, firewall, SSH hardening.
 * Env: PUBKEY DEPLOY_USER SSH_PORT HARDEN FIREWALL
 */
export const BOOTSTRAP = String.raw`
# A fresh server (no sites dir yet) needs no migration: its first journaled change stamps the latest level.
new_sites=$([ -d ${SITES} ] || echo 1)
[ -z "$new_sites" ] || _stamp_fresh=$LANDFALL_MIGRATION
${COMPOSE_INSTALL}
if ! can_root; then
  echo "setup needs root or sudo for $(id -un) (try: lf setup <name> --user root, or -K for the sudo password)" >&2
  exit 1
fi
# ufw only where setup turns it on: behind a provider's firewall, or with --no-firewall, it would sit there unused.
# fail2ban only where ssh passwords stay on: with keys only there is nothing to guess (lf harden fail2ban adds it).
# PACKAGES=0 (setup --minimal): none of them.
keys_only=0; if [ "$HARDEN" = 1 ] || [ "$(sshd_passwords)" = no ]; then keys_only=1; fi
missing=""; for p in $([ "$PACKAGES" != 1 ] || base_pkgs); do
  if [ "$p" = ufw ] && [ "$FIREWALL" != 1 ]; then continue; fi
  if [ "$p" = fail2ban ] && [ "$keys_only" = 1 ]; then continue; fi
  pkg_has "$p" || missing="$missing $p"
done
if [ -n "$missing" ]; then
  log "installing base packages:$missing"
  pkg_install $missing
  case " $missing " in *" fail2ban "*)
    { svc enable fail2ban && svc start fail2ban; } >/dev/null 2>&1 || log "could not start fail2ban (systemctl status fail2ban)" ;;
  esac
  record "installed packages$missing"
fi

if ! command -v docker >/dev/null 2>&1; then
  log "installing docker"
  os_id=$(. /etc/os-release 2>/dev/null; echo "$ID")
  case "$(pkg_mgr):$os_id" in
    apk:*) pkg_install docker && $SUDO rc-update add docker default >/dev/null 2>&1; $SUDO service docker start >/dev/null 2>&1 || true ;;
    # get.docker.com knows centos/rhel/fedora, not their rebuilds: those take Docker's centos repo.
    dnf:rocky|dnf:almalinux|dnf:ol|dnf:centos) $SUDO dnf -y -q install dnf-plugins-core >/dev/null \
      && $SUDO dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo >/dev/null \
      && $SUDO dnf -y install docker-ce docker-ce-cli containerd.io docker-compose-plugin >&2 ;;
    *) curl -fsSL https://get.docker.com | $SUDO sh >&2 ;;
  esac
  # Docker's script installs with apt-get itself and leaves its .debs in the cache.
  [ "$(pkg_mgr)" != apt-get ] || $SUDO apt-get clean || true
  record "installed docker"
fi
$SUDO systemctl enable --now docker >/dev/null 2>&1 || $SUDO service docker start >/dev/null 2>&1 || true
$SUDO docker info >/dev/null 2>&1 || log "docker is installed but not running: what follows needs it (systemctl status docker)"
# Distro docker packages (docker.io, moby) often lack compose 2.24+ or ship older: Docker's own repo has the newest plugin, everyone else gets the release binary.
if ! compose_ok "$(compose_v)"; then
  log "installing the newest docker compose"
  if pkg_has docker-ce && pkg_install docker-compose-plugin; then record "installed docker-compose-plugin"
  else compose_install || log "could not install docker compose; install it, then re-run setup"; fi
fi

if [ -n "$DEPLOY_USER" ]; then
  if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
    log "creating user $DEPLOY_USER"
    $SUDO useradd -m -s /bin/bash "$DEPLOY_USER"
    user_nopw "$DEPLOY_USER"
    record "created user $DEPLOY_USER" "user_del $DEPLOY_USER"
  fi
  case " $(id -nG "$DEPLOY_USER") " in
    *" docker "*) ;;
    *) $SUDO usermod -aG docker "$DEPLOY_USER"
       record "added $DEPLOY_USER to group docker" "case \" \$(id -nG $DEPLOY_USER 2>/dev/null) \" in *' docker '*) \$SUDO gpasswd -d $DEPLOY_USER docker >/dev/null 2>&1 || \$SUDO delgroup $DEPLOY_USER docker ;; esac" ;;
  esac
  home=$(home_of "$DEPLOY_USER")
  # An empty home would put the key in /.ssh.
  [ -n "$home" ] || { log "$DEPLOY_USER has no home directory"; exit 1; }
  $SUDO install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$home/.ssh"
  $SUDO touch "$home/.ssh/authorized_keys"
  if ! $SUDO grep -qxF "$PUBKEY" "$home/.ssh/authorized_keys"; then
    printf '%s\n' "$PUBKEY" | $SUDO tee -a "$home/.ssh/authorized_keys" >/dev/null
    record "authorized landfall's key for $DEPLOY_USER" "drop_line $(printf %q "$home/.ssh/authorized_keys") $(printf %q "$PUBKEY")"
  fi
  $SUDO chown "$DEPLOY_USER:$DEPLOY_USER" "$home/.ssh/authorized_keys"
  $SUDO chmod 600 "$home/.ssh/authorized_keys"
  OWNER="$DEPLOY_USER"
else
  OWNER="$(id -un)"
fi

log "preparing ${ROOT}"
new_traefik=$([ -d ${TRAEFIK_DIR} ] || echo 1)
$SUDO install -d -o "$OWNER" -g "$OWNER" ${ROOT} ${SITES} ${TRAEFIK_DIR}
$SUDO chown "$OWNER:$OWNER" ${JOURNAL} 2>/dev/null || true
_put ${ROOT}/README <<'LANDFALL_README'
${SERVER_README}LANDFALL_README
# ${ROOT} itself stays: it holds the journal. Each dir is only removed if setup created it.
[ -z "$new_sites" ] || record "created ${SITES}" "_as ${ROOT} rmdir ${SITES}"
[ -z "$new_traefik" ] || record "created ${TRAEFIK_DIR}" "_as ${ROOT} rm -rf ${TRAEFIK_DIR}"

DOCKER="$SUDO docker" ensure_network ${NETWORK}

if [ "$FIREWALL" = 1 ] && command -v ufw >/dev/null 2>&1; then
  log "configuring firewall (ssh $SSH_PORT, 80, 443)"
  ufw_add allow "$SSH_PORT/tcp"
  ufw_add allow 80/tcp
  ufw_add allow 443/tcp
  [ "$HTTP3" != 1 ] || ufw_add allow 443/udp
  ufw_enable
fi

if [ "$HARDEN" = 1 ] && [ -d /etc/ssh ]; then
${HARDEN_SSH}
fi
log "bootstrap done"
`;

/**
 * Read-only inventory of what setup would touch, one `key=value` per line
 * (`listen=` repeats). Runs before bootstrap so setup can skip finished parts
 * and refuse steps that would break services already on the server.
 * Env: PUBKEY DEPLOY_USER
 */
export const PROBE = String.raw`
set +e
${KV}
yn() { if "$@" >/dev/null 2>&1; then echo 1; else echo 0; fi; }
${OS_RELEASE}
kv os "$PRETTY_NAME"
kv os_id "$ID"
kv os_version "$VERSION_ID"
${CLOUD}
kv sudo "$(yn S true)"
kv pkg "$(pkg_mgr)"
missing=""; for p in $(base_pkgs); do pkg_has "$p" || missing="$missing $p"; done
kv pkgs_missing "$missing"
kv docker "$(docker --version 2>/dev/null | sed 's/,.*//')"
kv docker_podman "$(docker --version 2>/dev/null | grep -qi podman && echo 1)"
kv docker_running "$(yn S docker info)"
kv compose "$(compose_v)"
kv compose_v1 "$(docker-compose version --short 2>/dev/null)"
kv docker_ce "$(pkg_has docker-ce && echo 1)"
if [ -n "$DEPLOY_USER" ] && id "$DEPLOY_USER" >/dev/null 2>&1; then
  kv user 1
  kv user_docker "$(id -nG "$DEPLOY_USER" | tr ' ' '
' | grep -cx docker)"
  home=$(home_of "$DEPLOY_USER")
  kv user_key "$(yn S grep -qxF "$PUBKEY" "$home/.ssh/authorized_keys")"
else
  kv user 0
fi
kv root_dir "$(yn test -d ${SITES})"
kv sites "$(ls ${SITES} 2>/dev/null | wc -l | tr -d ' ')"
kv network "$(yn S docker network inspect ${NETWORK})"
kv proxy "$(grep -v '^#' ${PROXY_FILE} 2>/dev/null | tr '\n' ' ')"
kv ufw "$(ufw_state)"
kv tenants "$(yn test -f ${TENANTS}/state.json)"
# Without root sshd -T prints nothing: then our file is all there is to go by.
pw=$(sshd_passwords)
if [ -f ${SSHD_CONF} ] && { [ -z "$pw" ] || [ "$pw" = no ]; }; then kv hardened 1; else kv hardened 0; fi
kv password_auth "$(sshd_opt passwordauthentication)"
kv pubkey_auth "$(sshd_opt pubkeyauthentication)"
kv password_users "$(password_users)"
kv key_users "$(key_users)"
f=${TRAEFIK_DIR}/docker-compose.yml
if [ ! -f "$f" ]; then kv traefik_compose none
elif ${OWN_TRAEFIK}; then kv traefik_compose landfall
else kv traefik_compose foreign; fi
kv traefik_container "$(S docker inspect -f '{{.State.Status}} {{index .Config.Labels "com.docker.compose.project.working_dir"}}' traefik 2>/dev/null)"
kv publish_80 "$(S docker ps --filter publish=80 --format '{{.Names}}' 2>/dev/null | tr '
' ' ')"
kv publish_443 "$(S docker ps --filter publish=443 --format '{{.Names}}' 2>/dev/null | tr '
' ' ')"
# A traefik someone else runs on 443: its flags tell how to route sites through it.
for n in $(S docker ps --filter publish=443 --format '{{.Names}}' 2>/dev/null); do
  S docker inspect -f 'foreign_proxy={{.Name}}|{{.Config.Image}}|{{range $k, $v := .NetworkSettings.Networks}}{{$k}},{{end}}|{{join .Args " "}}' "$n" 2>/dev/null
done
S ufw show added 2>/dev/null | sed -n 's/^ufw /ufw_rule=/p'
kv ufw_in "$(sed -n 's/^DEFAULT_INPUT_POLICY="*\([A-Z]*\).*/\1/p' /etc/default/ufw 2>/dev/null)"
kv ssh_port "$(sshd_opt port)"
# Published container ports skip ufw only while Docker manages iptables/ip6tables NAT.
kv docker_fw "$(S docker info -f '{{.FirewallBackend.Driver}}' 2>/dev/null)"
kv docker_nat4 "$(yn S iptables -t nat -n -L DOCKER)"
kv docker_nat6 "$(yn S ip6tables -t nat -n -L DOCKER)"
S docker ps --format '{{.Ports}}' 2>/dev/null | tr ',' '\n' | sed -nE 's/^ *(.*):([0-9]+)->[0-9]+\/(tcp|udp)$/published=\3 \1:\2 docker/p' | sort -u
if command -v ss >/dev/null 2>&1; then
  S ss -Hltunp 2>/dev/null | awk '{print "listen=" $1 " " $5 " " $7}'
else
  S netstat -ltunp 2>/dev/null | awk '$1 ~ /^tcp/ {print "listen=tcp " $4 " " $7} $1 ~ /^udp/ {print "listen=udp " $4 " " $6}'
fi
exit 0
`;

/** Compose interpolates `$` in label values; `$$` is a literal one. */
export const composeEscape = (s: string) => s.replace(/\$/g, "$$$$");
/** A YAML string: JSON's double-quoted form is valid YAML. */
export const yamlStr = (s: string) => JSON.stringify(s);

export interface TraefikOpts {
  email?: string;
  image: string;
  staging: boolean;
  /** network_mode: host — traefik binds 80/443 itself, so it sees real client IPs (also IPv6) and ufw guards it. */
  hostNetwork?: boolean;
  /** HTTP/3 (QUIC) on websecure; bridge mode also publishes 443/udp. */
  http3?: boolean;
  /** The JSON access log on stdout that lf traffic reads; on unless false. */
  accessLog?: boolean;
  dashboard?: { host: string; htpasswd: string };
  /** A tenant's Traefik: TLS passed through from the central one, on 127.0.0.1:port only. */
  tenant?: { uid: number; port: number; trustedIP: string };
}

/** dynamic/landfall.yml: hosts no router serves get no certificate, so they look like nothing is there. */
export const TLS_FILE = `# managed by landfall — rewritten by \`lf traefik setup\`; other files in this folder are yours
tls:
  options:
    default:
      # Refuse the handshake for a name no certificate covers: no 404, no warning about a bad certificate.
      sniStrict: true
`;

export function traefikCompose(o: TraefikOpts): string {
  const t = o.tenant;
  if (t) o = { ...o, hostNetwork: false, http3: false, dashboard: undefined };
  const cmd = [
    "--providers.docker=true",
    "--providers.docker.exposedbydefault=false",
    `--providers.docker.network=${NETWORK}`,
    "--providers.file.directory=/etc/traefik/dynamic",
    ...(t
      ? []
      : [
          "--entrypoints.web.address=:80",
          "--entrypoints.web.http.redirections.entrypoint.to=websecure",
          "--entrypoints.web.http.redirections.entrypoint.scheme=https",
        ]),
    "--entrypoints.websecure.address=:443",
    // Only the central Traefik's address may say who the client is: any other, and a container could fake it.
    ...(t ? [`--entrypoints.websecure.proxyProtocol.trustedIPs=${t.trustedIP}`] : []),
    "--entrypoints.websecure.http.tls.certresolver=le",
    "--certificatesresolvers.le.acme.storage=/letsencrypt/acme.json",
    // Port 80 belongs to the central Traefik: a tenant proves its domains over TLS.
    t ? "--certificatesresolvers.le.acme.tlschallenge=true" : "--certificatesresolvers.le.acme.httpchallenge.entrypoint=web",
    "--log.level=INFO",
    // JSON lines: lf traffic aggregates them on the server; plain log lines without color codes for lf certs.
    ...(o.accessLog === false ? [] : ACCESS_LOG_FLAGS),
    "--log.nocolor=true",
  ];
  // Optional: Let's Encrypt no longer mails expiry warnings, the address is only an account contact.
  if (o.email) cmd.push(`--certificatesresolvers.le.acme.email=${o.email}`);
  if (o.http3) cmd.push("--entrypoints.websecure.http3=true");
  if (o.staging) cmd.push("--certificatesresolvers.le.acme.caserver=https://acme-staging-v02.api.letsencrypt.org/directory");
  const labels: string[] = [];
  // The dashboard always answers on the tunnel entrypoint (`lf traefik dashboard`), only to the host itself:
  // bridge mode sees the tunnel come from the network's gateway, which install writes to .env.
  cmd.push("--api.dashboard=true", `--entrypoints.tunnel.address=${o.hostNetwork ? "127.0.0.1" : ""}:${TUNNEL_PORT}`);
  labels.push(
    "traefik.enable=true",
    `traefik.http.routers.${TUNNEL_ROUTER}.rule=PathPrefix(\`/\`)`,
    `traefik.http.routers.${TUNNEL_ROUTER}.entrypoints=tunnel`,
    `traefik.http.routers.${TUNNEL_ROUTER}.service=api@internal`,
    `traefik.http.routers.${TUNNEL_ROUTER}.middlewares=tunnel-only`,
    // A tenant's tunnel comes through a relay container on the network.
    `traefik.http.middlewares.tunnel-only.ipallowlist.sourcerange=127.0.0.1/32,${t ? "${LANDFALL_SUBNET:-127.0.0.1/32}" : "${LANDFALL_GATEWAY:-127.0.0.1}/32"}`,
  );
  if (o.dashboard) {
    labels.push(
      `traefik.http.routers.dashboard.rule=Host(\`${o.dashboard.host}\`)`,
      "traefik.http.routers.dashboard.entrypoints=websecure",
      "traefik.http.routers.dashboard.service=api@internal",
      "traefik.http.routers.dashboard.middlewares=dashboard-auth",
      `traefik.http.middlewares.dashboard-auth.basicauth.users=${composeEscape(o.dashboard.htpasswd)}`,
    );
  }
  return `# managed by landfall — regenerate with \`lf traefik setup\`
services:
  traefik:
    image: ${o.image}
    container_name: traefik
    restart: unless-stopped
    command:
${cmd.map((c) => `      - ${yamlStr(c)}`).join("\n")}
${
  o.hostNetwork
    ? "    network_mode: host\n"
    : `    ports:
${t ? `      - "127.0.0.1:${t.port}:443"` : '      - "80:80"\n      - "443:443"'}
${o.http3 ? '      - "443:443/udp"\n' : ""}`
}    volumes:
      - ${t ? `/run/user/${t.uid}/docker.sock` : "/var/run/docker.sock"}:/var/run/docker.sock:ro
      - ./letsencrypt:/letsencrypt
      - ./dynamic:/etc/traefik/dynamic:ro
${o.hostNetwork ? "" : `    networks:\n      - ${NETWORK}\n`}${labels.length ? `    labels:\n${labels.map((l) => `      - ${yamlStr(l)}`).join("\n")}\n` : ""}${
    // Host mode still reaches sites by their IP on the web network (providers.docker.network).
    o.hostNetwork ? "" : `networks:\n  ${NETWORK}:\n    external: true\n`
  }`;
}
