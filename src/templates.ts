/** Everything landfall puts on a server lives below this root. */
export const ROOT = "/opt/landfall";
export const SITES = `${ROOT}/sites`;
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
/** Append-only log of every change landfall made, each with the shell that reverts it (lf log, lf undo). */
export const JOURNAL = `${ROOT}/journal.log`;
/** Backups `saved` keeps per file; undo of an older change leaves that file as it is. */
export const KEEP_BACKUPS = 10;
/** sshd drop-in written by setup's hardening. */
export const SSHD_CONF = "/etc/ssh/sshd_config.d/00-landfall.conf";

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

/** Shared shell helpers prepended to every remote script. */
export const PRELUDE = String.raw`
log() { printf '\033[36m  ->\033[0m %s\n' "$*" >&2; }
SUDO=""; if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; fi
# Files a container wrote may be root's.
rmf() { rm -rf "$@" 2>/dev/null || $SUDO rm -rf "$@"; }
# The distro's package manager, and installing with it.
pkg_mgr() { for m in apt-get dnf yum apk zypper; do command -v $m >/dev/null 2>&1 && { echo $m; return 0; }; done; echo none; }
pkg_has() {
  case "$(pkg_mgr)" in
    apt-get) dpkg -s "$1" ;;
    dnf|yum|zypper) rpm -q "$1" ;;
    apk) apk info -e "$1" ;;
    *) false ;;
  esac >/dev/null 2>&1
}
pkg_install() {
  case "$(pkg_mgr)" in
    apt-get) $SUDO apt-get update -qq && $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" >/dev/null ;;
    dnf) $SUDO dnf install -y -q "$@" >/dev/null ;;
    yum) $SUDO yum install -y -q "$@" >/dev/null ;;
    apk) $SUDO apk add -q --no-cache "$@" >/dev/null ;;
    zypper) $SUDO zypper -n -q install "$@" >/dev/null ;;
    *) log "no apt, dnf, yum, apk or zypper to install $*"; return 1 ;;
  esac
}
# What setup installs. RHEL-likes and SUSE have no ufw/fail2ban in their base repos.
base_pkgs() {
  case "$(pkg_mgr)" in
    apt-get) echo "ca-certificates curl ufw fail2ban unattended-upgrades" ;;
    apk) echo "ca-certificates curl ufw" ;;
    none) ;;
    *) echo "ca-certificates curl" ;;
  esac
}
# Resolved on first use: bootstrap sources this before docker is installed.
DC=""
dc() {
  [ -n "$DC" ] || DC=$(docker compose version >/dev/null 2>&1 && echo "docker compose" || echo docker-compose)
  $DC "$@"
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
sshd_reload() { $SUDO systemctl reload ssh 2>/dev/null || $SUDO systemctl reload sshd 2>/dev/null || $SUDO service ssh reload 2>/dev/null || true; }

# Journal. LANDFALL_RUN/LANDFALL_ACTOR/LANDFALL_CMD come from runScript. Writing it never fails a script.
_clean() { printf %s "$1" | tr '\t\n' '  '; }
_journal() { # _journal <do|undo> <what> <undo shell>
  line=$(printf '%s\t' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$LANDFALL_RUN" "$(_clean "$LANDFALL_ACTOR")" "$(id -un)" "$(_clean "$LANDFALL_CMD")" "$1" "$(_clean "$2")")
  line="$line$(printf %s "$3" | base64 | tr -d '\n')"
  if [ -w ${JOURNAL} ] || { [ ! -e ${JOURNAL} ] && [ -w ${ROOT} ]; }; then
    printf '%s\n' "$line" >> ${JOURNAL}
  elif [ -n "$SUDO" ] && ! sudo -n true 2>/dev/null; then false
  else
    { $SUDO install -d ${ROOT} && printf '%s\n' "$line" | $SUDO tee -a ${JOURNAL} >/dev/null; } 2>/dev/null
  fi || { log "warning: could not write ${JOURNAL}"; return 0; }
  # A root (or sudo) first entry would leave the file root-owned, and deploy users could no longer
  # append; it belongs to whoever owns ${ROOT}.
  [ -O ${JOURNAL} ] && [ "$(id -u)" -ne 0 ] || $([ -z "$SUDO" ] || echo sudo -n) chown "$(stat -c %u:%g ${ROOT})" ${JOURNAL} 2>/dev/null || true
}
# record <what> [undo shell]: journal a change; no undo shell = not reversible.
record() { _journal do "$1" "$(shift; printf %s "$*")"; }
# Run as $SUDO only when <dir> is not writable: deploy users own ${ROOT} and need no sudo.
_as() { if [ -w "$1" ]; then shift; "$@"; else shift; $SUDO "$@"; fi; }
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

/**
 * Idempotent bootstrap: Docker, deploy user with our key, firewall, SSH hardening.
 * Env: PUBKEY DEPLOY_USER SSH_PORT HARDEN FIREWALL
 */
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
  if [ -f $f ]; then $SUDO mv $f $f.landfall-$LANDFALL_RUN; undo="\$SUDO mv $f.landfall-$LANDFALL_RUN $f"; else undo="\$SUDO rm -f $f"; fi
  $SUDO mv $f.new $f
  record "installed docker compose $(docker compose version --short 2>/dev/null) to $f" "$undo"
}
`;

/** /opt/landfall/README: how to run everything here without landfall. Rewritten by every setup. */
export const SERVER_README = `This server is run by landfall (https://www.npmjs.com/package/landfall).
Everything here works without it: it is plain Docker Compose.

${TRAEFIK_DIR}/          Traefik: docker-compose.yml, letsencrypt/ (certificates), dynamic/ (file provider)
${SITES}/<site>/        one Compose project per site
  .env                    the site's environment (lf env), mode 600
  site.json               landfall's notes: domains, releases
  current -> releases/<id>   the live release
  releases/<id>/compose.yaml           the site's compose file as deployed
  releases/<id>/compose.override.yaml  landfall's: Traefik labels, proxy network, project name
${JOURNAL}           every change landfall made, with the shell that undoes it

Run a site by hand:
  cd ${SITES}/<site>/current && docker compose ps     (logs, restart, up -d, down …)
Roll back by hand:
  cd ${SITES}/<site> && ln -sfn releases/<id> current && cd -P current && docker compose up -d

Named volumes (databases, uploads) belong to the project, not the release: they survive
deploys and rollbacks. "lf sites rm" keeps them; "lf sites rm --volumes" deletes them.
`;

export const BOOTSTRAP = String.raw`
${COMPOSE_INSTALL}
if [ -n "$SUDO" ] && ! sudo -n true 2>/dev/null; then
  echo "setup needs root or passwordless sudo for $(id -un) (try: lf setup <name> --user root)" >&2
  exit 1
fi
missing=""; for p in $(base_pkgs); do pkg_has "$p" || missing="$missing $p"; done
if [ -n "$missing" ]; then
  log "installing base packages:$missing"
  pkg_install $missing
  $SUDO systemctl enable --now fail2ban >/dev/null 2>&1 || true
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
      && $SUDO dnf -y -q install docker-ce docker-ce-cli containerd.io docker-compose-plugin >/dev/null ;;
    *) curl -fsSL https://get.docker.com | $SUDO sh >/dev/null ;;
  esac
  record "installed docker"
fi
$SUDO systemctl enable --now docker >/dev/null 2>&1 || $SUDO service docker start >/dev/null 2>&1 || true
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
    # '*' = no password but not locked; sshd without PAM refuses locked accounts even for keys.
    $SUDO usermod -p '*' "$DEPLOY_USER"
    # userdel refuses while the user has processes (a lingering ssh session of landfall's own).
    record "created user $DEPLOY_USER" "[ \"\$(id -un)\" = $DEPLOY_USER ] || \$SUDO pkill -u $DEPLOY_USER 2>/dev/null || true; for i in 1 2 3 4 5; do \$SUDO userdel -r $DEPLOY_USER 2>/dev/null && break; ! id $DEPLOY_USER >/dev/null 2>&1 && break; sleep 1; done; ! id $DEPLOY_USER >/dev/null 2>&1 || \$SUDO deluser --remove-home $DEPLOY_USER"
  fi
  case " $(id -nG "$DEPLOY_USER") " in
    *" docker "*) ;;
    *) $SUDO usermod -aG docker "$DEPLOY_USER"
       record "added $DEPLOY_USER to group docker" "case \" \$(id -nG $DEPLOY_USER 2>/dev/null) \" in *' docker '*) \$SUDO gpasswd -d $DEPLOY_USER docker >/dev/null 2>&1 || \$SUDO delgroup $DEPLOY_USER docker ;; esac" ;;
  esac
  home=$(getent passwd "$DEPLOY_USER" | cut -d: -f6)
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
new_sites=$([ -d ${SITES} ] || echo 1)
new_traefik=$([ -d ${TRAEFIK_DIR} ] || echo 1)
$SUDO install -d -o "$OWNER" -g "$OWNER" ${ROOT} ${SITES} ${TRAEFIK_DIR}
$SUDO chown "$OWNER:$OWNER" ${JOURNAL} 2>/dev/null || true
$SUDO tee ${ROOT}/README >/dev/null <<'LANDFALL_README'
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
  log "hardening sshd (keys only)"
  # Never loosen an admin's stricter root login setting.
  root_login=prohibit-password
  if [ "$($SUDO sshd -T 2>/dev/null | awk '$1 == "permitrootlogin" {print $2}')" = no ]; then root_login=no; fi
  # 00- so it wins over cloud-init's 50-cloud-init.conf: sshd keeps the first value it reads.
  want=$(printf '%s\n' 'PasswordAuthentication no' 'KbdInteractiveAuthentication no' "PermitRootLogin $root_login")
  undo=""
  if [ "$($SUDO cat ${SSHD_CONF} 2>/dev/null || true)" != "$want" ]; then
    $SUDO install -d /etc/ssh/sshd_config.d
    undo=$(saved ${SSHD_CONF})
    printf '%s\n' "$want" | $SUDO tee ${SSHD_CONF} >/dev/null
  fi
  if ! grep -qE '^\s*Include\s+/etc/ssh/sshd_config.d' /etc/ssh/sshd_config; then
    if [ -n "$undo" ]; then undo="$undo; "; fi
    undo="$undo$(saved /etc/ssh/sshd_config)"
    printf 'Include /etc/ssh/sshd_config.d/*.conf\n%s' "$($SUDO cat /etc/ssh/sshd_config)" | $SUDO tee /etc/ssh/sshd_config >/dev/null
  fi
  if [ -z "$undo" ]; then :
  elif $SUDO sshd -t; then
    sshd_reload
    record "hardened sshd (keys only, root login $root_login)" "$undo; sshd_reload"
  else
    log "sshd config test failed, putting the old config back"
    eval "$undo"
  fi
  pw=$($SUDO sshd -T 2>/dev/null | awk '$1 == "passwordauthentication" || $1 == "kbdinteractiveauthentication" {print $2}' | sort -u | tr -d '\n')
  [ -z "$pw" ] || [ "$pw" = no ] || log "warning: sshd still accepts passwords; a Match block or another file in /etc/ssh overrides ${SSHD_CONF} (check: sudo sshd -T)"
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
S() { if [ -n "$SUDO" ]; then sudo -n "$@"; else "$@"; fi; }
kv() { printf '%s=%s
' "$1" "$2"; }
yn() { if "$@" >/dev/null 2>&1; then echo 1; else echo 0; fi; }
PRETTY_NAME=unknown; ID=; VERSION_ID=; . /etc/os-release 2>/dev/null
kv os "$PRETTY_NAME"
kv os_id "$ID"
kv os_version "$VERSION_ID"
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
  home=$(getent passwd "$DEPLOY_USER" | cut -d: -f6)
  kv user_key "$(yn S grep -qxF "$PUBKEY" "$home/.ssh/authorized_keys")"
else
  kv user 0
fi
kv root_dir "$(yn test -d ${SITES})"
kv sites "$(ls ${SITES} 2>/dev/null | wc -l | tr -d ' ')"
kv network "$(yn S docker network inspect ${NETWORK})"
kv proxy "$(grep -v '^#' ${PROXY_FILE} 2>/dev/null | tr '\n' ' ')"
if command -v ufw >/dev/null 2>&1; then kv ufw "$(S ufw status 2>/dev/null | awk 'NR == 1 {print $2}')"; else kv ufw missing; fi
# Hardened = what sshd really uses (a Match block or an earlier file can override ours). Without
# root, sshd -T prints nothing: then our file is all there is to go by.
pw=$(S sshd -T 2>/dev/null | awk '$1 == "passwordauthentication" || $1 == "kbdinteractiveauthentication" {print $2}' | sort -u | tr -d '\n')
if [ -f ${SSHD_CONF} ] && { [ -z "$pw" ] || [ "$pw" = no ]; }; then kv hardened 1; else kv hardened 0; fi
kv password_auth "$(S sshd -T 2>/dev/null | awk '$1 == "passwordauthentication" {print $2}')"
kv password_users "$(S awk -F: '$2 ~ /^\$/ {printf "%s ", $1}' /etc/shadow 2>/dev/null)"
f=${TRAEFIK_DIR}/docker-compose.yml
if [ ! -f "$f" ]; then kv traefik_compose none
elif grep -q "managed by landfall" "$f"; then kv traefik_compose landfall
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
kv ssh_port "$(S sshd -T 2>/dev/null | awk '$1 == "port" {print $2; exit}')"
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
  dashboard?: { host: string; htpasswd: string };
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
  const cmd = [
    "--providers.docker=true",
    "--providers.docker.exposedbydefault=false",
    `--providers.docker.network=${NETWORK}`,
    "--providers.file.directory=/etc/traefik/dynamic",
    "--entrypoints.web.address=:80",
    "--entrypoints.web.http.redirections.entrypoint.to=websecure",
    "--entrypoints.web.http.redirections.entrypoint.scheme=https",
    "--entrypoints.websecure.address=:443",
    "--entrypoints.websecure.http.tls.certresolver=le",
    "--certificatesresolvers.le.acme.storage=/letsencrypt/acme.json",
    "--certificatesresolvers.le.acme.httpchallenge.entrypoint=web",
    "--log.level=INFO",
    "--accesslog=true",
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
    "traefik.http.middlewares.tunnel-only.ipallowlist.sourcerange=127.0.0.1/32,${LANDFALL_GATEWAY:-127.0.0.1}/32",
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
      - "80:80"
      - "443:443"
${o.http3 ? '      - "443:443/udp"\n' : ""}`
}    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./letsencrypt:/letsencrypt
      - ./dynamic:/etc/traefik/dynamic:ro
${o.hostNetwork ? "" : `    networks:\n      - ${NETWORK}\n`}${labels.length ? `    labels:\n${labels.map((l) => `      - ${yamlStr(l)}`).join("\n")}\n` : ""}${
  // Host mode still reaches sites by their IP on the web network (providers.docker.network).
  o.hostNetwork ? "" : `networks:\n  ${NETWORK}:\n    external: true\n`
}`;
}
