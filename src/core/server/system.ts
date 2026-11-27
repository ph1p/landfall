import type { Server } from "../lib/config";
import { runScript, shq, writeFileCmd } from "../ssh/ssh";
import { rootLogin } from "../ssh/privilege";
import { CLOUD, EMPTY_PASSWORDS, KV, kvRecord, OPEN_ENV_FILES, PKG_MGR, PRELUDE, REBOOT_NEEDED, SEC_CHECKS, SITES } from "../ssh/templates";
import { classify, FILE_RULES, KEY_NAMES, type Severity } from "../site/file-rules";
import { serviceName } from "../site/status";
import { fail } from "../lib/term";
import { cloudFor } from "./facts";
import { localFingerprints, parseKeyLine, type AuthorizedKey } from "./keys";

/** Kernel settings `lf harden kernel` writes. `ok`: other values that are safe too. */
export const KERNEL_SETTINGS: { key: string; value: string; ok?: string[] }[] = [
  // SYN floods: answer with a cookie instead of keeping half-open connections.
  { key: "net.ipv4.tcp_syncookies", value: "1" },
  // Drop packets whose source address could not come in on that interface (2: loose, safe with Docker and several networks).
  { key: "net.ipv4.conf.all.rp_filter", value: "2", ok: ["1"] },
  // ICMP redirects and source routing let others reroute this server's traffic; a server needs neither.
  { key: "net.ipv4.conf.all.accept_redirects", value: "0" },
  { key: "net.ipv4.conf.default.accept_redirects", value: "0" },
  { key: "net.ipv6.conf.all.accept_redirects", value: "0" },
  { key: "net.ipv4.conf.all.send_redirects", value: "0" },
  { key: "net.ipv4.conf.all.accept_source_route", value: "0" },
  { key: "net.ipv6.conf.all.accept_source_route", value: "0" },
  { key: "net.ipv4.icmp_echo_ignore_broadcasts", value: "1" },
  // Kernel addresses and the kernel log help an attacker who already runs code here.
  { key: "kernel.kptr_restrict", value: "1", ok: ["2"] },
  { key: "kernel.dmesg_restrict", value: "1" },
  { key: "fs.protected_symlinks", value: "1" },
  { key: "fs.protected_hardlinks", value: "1" },
  // No core dumps of setuid programs: they can hold password hashes.
  { key: "fs.suid_dumpable", value: "0" },
];

/** "key /proc/sys/path" lines for a `while read -r k f` heredoc: no fork per key, unlike sysctl -n. */
export const KERNEL_PROC = KERNEL_SETTINGS.map((k) => `${k.key} /proc/sys/${k.key.replace(/\./g, "/")}`).join("\n");

/** At most this many risky files per site; more only adds noise. */
const RELEASE_LIMIT = 50;

/** Files in each site's live release that should not be there (exposure.ts FILE_RULES); node_modules is skipped. */
function releaseScan(): string {
  const any = (dir: boolean) =>
    FILE_RULES.filter((r) => !!r.dir === dir)
      .flatMap((r) => r.names)
      .map((n) => `-name ${shq(n)}`)
      .join(" -o ");
  return String.raw`
for site in $(ls -1 ${SITES} 2>/dev/null); do
  dir=$(readlink -f ${SITES}/"$site"/current 2>/dev/null) || continue
  [ -d "$dir" ] || continue
  printf 'REL\t%s\t%s\n' "$site" "$dir"
  S find "$dir" -name node_modules -prune -o \( -type d \( ${any(true)} \) -print -prune \) -o \( -type f \( ${any(false)} \) -print \) 2>/dev/null |
    head -n ${RELEASE_LIMIT} | while IFS= read -r f; do
      t=f; [ -d "$f" ] && t=d
      k=0; case "$f" in ${KEY_NAMES.join("|")}) S grep -qs 'PRIVATE KEY' "$f" && k=1 ;; esac
      printf 'RF\t%s\t%s\t%s\n' "$t" "$k" "$f"
    done
done`;
}

/** Everything `lf system` shows, read in one go; root-only parts need root or passwordless sudo. */
const SYSTEM = String.raw`
set +e
${KV}
SUDO=""; R=1
if [ "$(id -u)" -ne 0 ]; then if sudo -n true 2>/dev/null; then SUDO=sudo; else R=0; fi; fi
${SEC_CHECKS}
${PKG_MGR}
pm=$(pkg_mgr)
kv root "$R"
kv user "$(id -un)"
[ -f /etc/synoinfo.conf ] && kv platform synology
${CLOUD}
kv hostname "$(hostname 2>/dev/null || cat /etc/hostname)"
tz=$(timedatectl show -p Timezone --value 2>/dev/null)
[ -n "$tz" ] || tz=$(cat /etc/timezone 2>/dev/null)
[ -n "$tz" ] || tz=$(readlink /etc/localtime 2>/dev/null | sed 's#.*/zoneinfo/##')
kv timezone "$tz"
kv ntp "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)"
kv time "$(date '+%Y-%m-%d %H:%M %Z')"
if [ -d /run/systemd/system ]; then init=systemd; elif command -v rc-service >/dev/null 2>&1; then init=openrc; else init=other; fi
kv init "$init"
awk 'NR > 1 { print "SWAP\t" $1 "\t" $2 "\t" $3 * 1024 "\t" $4 * 1024 }' /proc/swaps 2>/dev/null
kv swappiness "$(cat /proc/sys/vm/swappiness 2>/dev/null)"
kv disk_free "$(df -Pk / 2>/dev/null | awk 'NR == 2 { print $4 * 1024 }')"
kv mem "$(awk '/^MemTotal:/ { print $2 * 1024 }' /proc/meminfo)"
if command -v docker >/dev/null 2>&1; then
  kv log_driver "$(docker info -f '{{.LoggingDriver}}' 2>/dev/null || S docker info -f '{{.LoggingDriver}}' 2>/dev/null)"
  printf 'DAEMON\t'; { cat /etc/docker/daemon.json 2>/dev/null || S cat /etc/docker/daemon.json 2>/dev/null; } | tr -d '\n'; echo
fi
case "$init" in
  systemd)
    systemctl list-units --type=service --all --no-legend --plain --no-pager 2>/dev/null \
      | awk '{ d = ""; for (i = 5; i <= NF; i++) d = d (i > 5 ? " " : "") $i; print "SVC\t" $1 "\t" $2 "\t" $3 "\t" $4 "\t" d }'
    systemctl list-unit-files --type=service --no-legend --no-pager 2>/dev/null | awk '{ print "UF\t" $1 "\t" $2 }' ;;
  openrc)
    rc-status -a 2>/dev/null | awk '/\[/ { s = $0; sub(/.*\[[ \t]*/, "", s); sub(/[ \t]*\].*/, "", s); print "SVC\t" $1 "\t-\t" s "\t" s "\t" }' | sort -u ;;
esac
if command -v fail2ban-client >/dev/null 2>&1; then
  # Only whether it runs: the fail2ban plugin reads its jails and bans.
  if S fail2ban-client ping >/dev/null 2>&1; then kv fail2ban running; else kv fail2ban stopped; fi
else kv fail2ban missing; fi
# Security: what sshd really uses (sshd -T needs root), who has a password, firewall, updates.
S sshd -T 2>/dev/null | awk '$1 ~ /^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin|pubkeyauthentication|permitemptypasswords|x11forwarding)$/ && !seen[$1]++ { print "sshd_" $1 "=" $2 }'
[ "$R" = 1 ] && kv password_users "$(password_users)"
# The rest of the security checks only for lf system and lf security (SEC=1): the other readers need none of it.
if [ "$SEC" = 1 ]; then
  [ "$R" = 1 ] && kv empty_password_users "$(S ${EMPTY_PASSWORDS} 2>/dev/null | tr '\n' ' ')"
  kv uid0 "$(awk -F: '$3 == 0 && $1 != "root" {printf "%s ", $1}' /etc/passwd 2>/dev/null)"
  while read -r k f; do
    { read -r v < "$f"; } 2>/dev/null && printf 'SYSCTL\t%s\t%s\n' "$k" "$v"
  done <<'KEYS'
${KERNEL_PROC}
KEYS
  # Security updates the package manager already knows about, from its cache: no network here.
  # No cache (dnf -C, zypper --no-refresh fail): unknown rather than none. apk has no security list.
  case $pm in
    apt-get) kv security_updates "$(apt list --upgradable 2>/dev/null | grep -c -- '-security')" ;;
    dnf | yum) u=$($pm -C -q updateinfo list --security 2>/dev/null) && kv security_updates "$(printf '%s\n' "$u" | grep -ciE '/sec\.|[[:space:]]security[[:space:]]')" ;;
    zypper) u=$(zypper -n --no-refresh -q list-patches --category security 2>/dev/null) && kv security_updates "$(printf '%s\n' "$u" | grep -c '| security')" ;;
  esac
  if [ "$R" = 1 ]; then
    S ${OPEN_ENV_FILES} 2>/dev/null | sed 's/^/OPENENV\t/'
    ${releaseScan()}
  fi
fi
kv pkg "$pm"
kv ufw "$(ufw_state)"
${REBOOT_NEEDED}
kv reboot "$(reboot_needed && echo 1)"
if command -v apt-get >/dev/null 2>&1; then
  if apt_auto_updates; then kv auto_updates on; else kv auto_updates off; fi
elif command -v apk >/dev/null 2>&1; then
  if apk_auto_updates; then kv auto_updates on; else kv auto_updates off; fi
elif command -v dnf >/dev/null 2>&1 && [ "$init" = systemd ]; then
  if dnf_auto_updates; then kv auto_updates on; else kv auto_updates off; fi
fi
# Keys of every user with a home: /root and /home/* (deploy users live there).
for f in /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys; do
  u=$(key_file_user "$f")
  { cat "$f" 2>/dev/null || S cat "$f" 2>/dev/null; } | while IFS= read -r l; do
    case "$l" in ''|'#'*) ;; *) printf 'KEY\t%s\t%s\n' "$u" "$l" ;; esac
  done
done
exit 0
`;

export interface Service {
  unit: string;
  /** loaded, not-found, masked… (systemd), "-" on OpenRC. */
  load: string;
  /** active, inactive, failed; started/stopped/crashed on OpenRC. */
  active: string;
  sub: string;
  description: string;
  /** enabled, disabled, static… (systemd unit files). */
  enabled?: string;
}

/** What sshd and the system allow; undefined = could not tell (sshd -T and /etc/shadow need root). */
export interface Security {
  /** sshd accepts passwords (PasswordAuthentication or KbdInteractiveAuthentication). */
  passwordLogin?: boolean;
  /** sshd takes keys (PubkeyAuthentication). false: keys only would lock everyone out. */
  keyLogin?: boolean;
  rootLogin?: string;
  /** Users with a password set: those may log in with it while passwordLogin is on. */
  passwordUsers?: string[];
  pkg?: string;
  /** ufw's state, as ufw.conf says. */
  firewall?: "active" | "inactive" | "missing";
  autoUpdates?: boolean;
  reboot: boolean;
  /** synology: a system that brings its own firewall and login bans (facts.ts PLATFORM). */
  platform?: string;
  /** aws, gcp, …: the provider, where the server's hardware strings name one (facts.ts CLOUDS). */
  cloud?: string;
  /** sshd lets accounts without a password log in (PermitEmptyPasswords). */
  emptyPasswords?: boolean;
  /** sshd forwards X11 (X11Forwarding). */
  x11Forwarding?: boolean;
  /** Accounts that have no password at all (/etc/shadow, needs root). */
  emptyPasswordUsers?: string[];
  /** Accounts other than root with user id 0: root under another name. */
  uid0?: string[];
  /** KERNEL_SETTINGS keys this kernel has, with their current values. */
  kernel?: Record<string, string>;
  /** Security updates the package manager's cache knows about and that are not installed (apt, dnf, yum, zypper). */
  securityUpdates?: number;
  /** Site env files (.env, .env backups) that others than their owner can read. */
  openEnv?: string[];
  /** Files in sites' live releases that should not be on a web server. */
  releaseFiles?: ReleaseFile[];
}

export interface ReleaseFile {
  site: string;
  /** Relative to the release; folders end in /. */
  path: string;
  severity: Severity;
  why: string;
}

export interface SystemInfo {
  /** Root or passwordless sudo: without, keys of other users, bans and daemon.json may be missing. */
  root: boolean;
  user: string;
  hostname: string;
  timezone: string;
  /** Clock synced via NTP; undefined when timedatectl is missing. */
  ntp?: boolean;
  time: string;
  init: "systemd" | "openrc" | "other";
  swap: { file: string; type: string; size: number; used: number }[];
  swappiness?: number;
  diskFree: number;
  mem: number;
  docker?: { driver: string; maxSize?: string; maxFile?: number; daemon: Record<string, unknown>; daemonError?: string };
  services: Service[];
  fail2ban: "running" | "stopped" | "missing";
  keys: AuthorizedKey[];
  security: Security;
  /** Set where the system keeps host name, time zone, swap and Docker's settings itself (Synology DSM). */
  managed?: string;
}

export function parseSystem(out: string, mine = new Set<string>()): SystemInfo {
  const v = kvRecord(out);
  const info: SystemInfo = {
    root: false,
    user: "",
    hostname: "",
    timezone: "",
    time: "",
    init: "other",
    swap: [],
    diskFree: 0,
    mem: 0,
    services: [],
    fail2ban: "missing",
    keys: [],
    security: { reboot: false },
  };
  const enabled = new Map<string, string>();
  let daemon: string | undefined;
  const kernel: Record<string, string> = {};
  const openEnv: string[] = [];
  const releaseFiles: ReleaseFile[] = [];
  let site = "";
  let release = "";
  for (const line of out.split("\n")) {
    const f = line.split("\t");
    if (f[0] === "SWAP") info.swap.push({ file: f[1], type: f[2], size: +f[3] || 0, used: +f[4] || 0 });
    else if (f[0] === "DAEMON") daemon = f.slice(1).join("\t");
    else if (f[0] === "SVC" && f[1]) info.services.push({ unit: f[1], load: f[2], active: f[3], sub: f[4], description: f.slice(5).join("\t") });
    else if (f[0] === "UF" && f[1]) enabled.set(f[1], f[2]);
    else if (f[0] === "SYSCTL" && f[1]) kernel[f[1]] = f[2] ?? "";
    else if (f[0] === "OPENENV" && f[1]) openEnv.push(f.slice(1).join("\t"));
    else if (f[0] === "REL") [, site, release] = f;
    else if (f[0] === "RF" && site && f.length >= 4) {
      const full = f.slice(3).join("\t");
      const path = full.startsWith(`${release}/`) ? full.slice(release.length + 1) : full;
      const dir = f[1] === "d";
      const r = classify(path.slice(path.lastIndexOf("/") + 1), dir, f[2] === "1");
      if (r) releaseFiles.push({ site, path: dir ? `${path}/` : path, severity: r.severity, why: r.why });
    } else if (f[0] === "KEY") {
      const k = parseKeyLine(f.slice(2).join("\t"));
      if (k) info.keys.push({ user: f[1], ...k, ...(mine.has(k.fingerprint) ? { mine: true } : {}) });
    }
  }
  for (const s of info.services) if (enabled.has(s.unit)) s.enabled = enabled.get(s.unit);
  Object.assign(info, {
    root: v.root === "1",
    user: v.user ?? "",
    hostname: v.hostname ?? "",
    timezone: v.timezone || "UTC",
    ntp: v.ntp === "yes" ? true : v.ntp === "no" ? false : undefined,
    time: v.time ?? "",
    init: (["systemd", "openrc"].includes(v.init) ? v.init : "other") as SystemInfo["init"],
    swappiness: v.swappiness ? +v.swappiness : undefined,
    diskFree: +v.disk_free || 0,
    mem: +v.mem || 0,
    fail2ban: (["running", "stopped"].includes(v.fail2ban) ? v.fail2ban : "missing") as SystemInfo["fail2ban"],
  });
  const pw = [v.sshd_passwordauthentication, v.sshd_kbdinteractiveauthentication].filter(Boolean);
  info.security = {
    passwordLogin: pw.length ? pw.includes("yes") : undefined,
    keyLogin: v.sshd_pubkeyauthentication ? v.sshd_pubkeyauthentication !== "no" : undefined,
    rootLogin: v.sshd_permitrootlogin || undefined,
    passwordUsers: v.password_users?.split(/\s+/).filter(Boolean),
    pkg: v.pkg || undefined,
    firewall: ["active", "inactive", "missing"].includes(v.ufw) ? (v.ufw as Security["firewall"]) : undefined,
    autoUpdates: v.auto_updates ? v.auto_updates === "on" : undefined,
    reboot: v.reboot === "1",
    platform: v.platform || undefined,
    cloud: v.cloud || undefined,
    emptyPasswords: v.sshd_permitemptypasswords ? v.sshd_permitemptypasswords === "yes" : undefined,
    x11Forwarding: v.sshd_x11forwarding ? v.sshd_x11forwarding === "yes" : undefined,
    emptyPasswordUsers: v.empty_password_users?.split(/\s+/).filter(Boolean),
    uid0: v.uid0?.split(/\s+/).filter(Boolean),
    kernel: Object.keys(kernel).length ? kernel : undefined,
    securityUpdates: v.security_updates ? +v.security_updates || 0 : undefined,
    openEnv: v.root === "1" ? openEnv : undefined,
    releaseFiles: v.root === "1" ? releaseFiles : undefined,
  };
  if (v.platform === "synology") info.managed = "DSM keeps this itself: change it in Control Panel (Regional Options, Info Center, Container Manager)";
  if (v.log_driver !== undefined) {
    let d: Record<string, unknown> = {};
    let daemonError: string | undefined;
    try {
      d = daemon?.trim() ? JSON.parse(daemon) : {};
    } catch (e: any) {
      daemonError = `/etc/docker/daemon.json is not valid JSON: ${e.message}`;
    }
    const opts = (d["log-opts"] ?? {}) as Record<string, string>;
    info.docker = {
      driver: v.log_driver || String(d["log-driver"] ?? "json-file"),
      ...(opts["max-size"] ? { maxSize: opts["max-size"] } : {}),
      ...(opts["max-file"] ? { maxFile: Number(opts["max-file"]) } : {}),
      daemon: d,
      ...(daemonError ? { daemonError } : {}),
    };
  }
  return info;
}

/** security: also the checks only lf system and lf security show (accounts, kernel, files in releases). */
export async function system(s: Server, o: { security?: boolean } = {}): Promise<SystemInfo> {
  const { stdout } = await runScript(s, SYSTEM, { capture: true, env: { SEC: !!o.security } });
  const info = parseSystem(stdout, localFingerprints(s));
  if (s.cloud) info.security.cloud = cloudFor(s) || undefined;
  return info;
}

/** Read as root when the login has no sudo but root's key works: other users' keys and the bans need it. */
export async function fullSystem(s: Server): Promise<SystemInfo> {
  const i = await system(s, { security: true });
  if (i.root) return i;
  const root = await rootLogin(s);
  return root ? system(root, { security: true }) : i;
}

// Changes. Each runs as a login with root or passwordless sudo (adminLogin) and journals its undo.

export const UNIT = /^[A-Za-z0-9@_.:-]+$/;

export async function serviceAction(s: Server, verb: "restart" | "start" | "stop", unit: string) {
  if (!UNIT.test(unit)) fail(`not a service name: ${unit}`);
  const undo = verb === "start" ? "stop" : verb === "stop" ? "start" : "";
  const what = `${verb} service ${unit}`;
  await runScript(s, [PRELUDE, `svc ${verb} ${shq(unit)}`, `record ${shq(what)}${undo ? ` ${shq(`svc ${undo} ${shq(unit)}`)}` : ""}`].join("\n"));
}

/** Shell that prints a service's last lines: journald, else OpenRC's usual log files. */
export function serviceLogs(unit: string, o: { lines: number; follow?: boolean }): string {
  if (!UNIT.test(unit)) fail(`not a service name: ${unit}`);
  const S = `$([ "$(id -u)" = 0 ] || echo sudo -n)`;
  const n = String(o.lines);
  return o.follow
    ? `${S} journalctl -u ${shq(unit)} -n ${n} -f --no-pager 2>/dev/null || ${S} tail -n ${n} -f /var/log/${shq(serviceName(unit))}.log /var/log/messages`
    : `${S} journalctl -u ${shq(unit)} -n ${n} --no-pager 2>/dev/null || ${S} tail -n ${n} /var/log/${shq(serviceName(unit))}.log /var/log/messages 2>/dev/null`;
}

export const IP = /^[0-9a-fA-F.:]+$/;

/** 512M, 2G, 1.5G → bytes; swap is sized in MiB/GiB. */
export function parseSwapSize(v: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([mg])i?b?$/i.exec(v.trim());
  if (!m) fail(`not a size: ${v} (e.g. 512M, 2G)`);
  return Math.round(Number(m![1]) * (m![2].toLowerCase() === "g" ? 1024 : 1)) * 1024 * 1024;
}

const FSTAB = "/swapfile none swap sw 0 0";

const ADD_SWAP = (mb: number) => String.raw`
if [ -e /swapfile ]; then log "/swapfile exists already: lf swap off first"; exit 1; fi
mk() { # fallocate is instant but makes files swapon refuses on some filesystems (btrfs, older xfs): dd then
  { $SUDO fallocate -l ${mb}M /swapfile 2>/dev/null || $SUDO dd if=/dev/zero of=/swapfile bs=1M count=${mb} status=none; } &&
  $SUDO chmod 600 /swapfile && $SUDO mkswap /swapfile >/dev/null && $SUDO swapon /swapfile
}
if ! mk; then
  $SUDO rm -f /swapfile
  $SUDO dd if=/dev/zero of=/swapfile bs=1M count=${mb} status=none && $SUDO chmod 600 /swapfile && $SUDO mkswap /swapfile >/dev/null && $SUDO swapon /swapfile \
    || { $SUDO rm -f /swapfile; log "could not turn on swap (a container, or a filesystem without swap files?)"; exit 1; }
fi
record "created ${mb} MB swap at /swapfile" '$SUDO swapoff /swapfile 2>/dev/null; $SUDO rm -f /swapfile'
if ! grep -qxF '${FSTAB}' /etc/fstab 2>/dev/null; then
  printf '%s\n' '${FSTAB}' | $SUDO tee -a /etc/fstab >/dev/null
  record "added /swapfile to /etc/fstab" "drop_line /etc/fstab '${FSTAB}'"
fi
`;

export const addSwap = (s: Server, bytes: number) => runScript(s, PRELUDE + ADD_SWAP(Math.round(bytes / 1024 / 1024)));

const REMOVE_SWAP = String.raw`
[ -e /swapfile ] || { log "no /swapfile: landfall only removes the swap file it made"; exit 1; }
$SUDO swapoff /swapfile
$SUDO rm -f /swapfile
drop_line /etc/fstab '${FSTAB}'
record "removed the swap file /swapfile"
`;

export const removeSwap = (s: Server) => runScript(s, PRELUDE + REMOVE_SWAP);

export const HOSTNAME = /^(?=.{1,63}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i;

const SET_HOSTNAME = (v: string) =>
  `$SUDO hostnamectl set-hostname ${shq(v)} 2>/dev/null || { printf '%s\\n' ${shq(v)} | $SUDO tee /etc/hostname >/dev/null && $SUDO hostname ${shq(v)}; }`;

export async function setHostname(s: Server, old: string, name: string) {
  if (!HOSTNAME.test(name)) fail(`not a host name: ${name} (letters, digits and -, up to 63)`);
  const script = [
    PRELUDE,
    SET_HOSTNAME(name),
    `record ${shq(`hostname ${old} → ${name}`)} ${shq(SET_HOSTNAME(old))}`,
    // Debian's 127.0.1.1 line names the host: sudo warns "unable to resolve host" until it matches.
    `if grep -qE '^127\\.0\\.1\\.1[[:space:]]' /etc/hosts; then`,
    `  undo=$(saved /etc/hosts) || exit 1`,
    `  $SUDO sed -i 's/^127\\.0\\.1\\.1[[:space:]].*/127.0.1.1\\t'${shq(name)}'/' /etc/hosts`,
    `  record "named ${name} in /etc/hosts" "$undo"`,
    `fi`,
  ].join("\n");
  await runScript(s, script);
}

export const TIMEZONE = /^[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+)*$/;

const SET_TZ = (tz: string) =>
  `$SUDO timedatectl set-timezone ${shq(tz)} 2>/dev/null || { $SUDO ln -sf /usr/share/zoneinfo/${shq(tz)} /etc/localtime && printf '%s\\n' ${shq(tz)} | $SUDO tee /etc/timezone >/dev/null; }`;

export async function setTimezone(s: Server, old: string, tz: string) {
  if (!TIMEZONE.test(tz)) fail(`not a time zone: ${tz} (e.g. Europe/Berlin, UTC)`);
  const script = [
    PRELUDE,
    `[ -e /usr/share/zoneinfo/${shq(tz)} ] || { log ${shq(`unknown time zone ${tz} (or tzdata is not installed)`)}; exit 1; }`,
    SET_TZ(tz),
    `record ${shq(`time zone ${old} → ${tz}`)} ${shq(SET_TZ(old))}`,
  ].join("\n");
  await runScript(s, script);
}

/** Docker's size format for log-opts: 10m, 100k, 1g. */
export const LOG_SIZE = /^\d+[kmg]$/;

/** daemon.json with log rotation for json-file/local logs; everything else in it stays. */
export function withLogLimit(daemon: Record<string, unknown>, size: string | undefined, files: number | undefined) {
  const opts = { ...((daemon["log-opts"] ?? {}) as Record<string, string>) };
  if (size) opts["max-size"] = size;
  else delete opts["max-size"];
  if (size && files) opts["max-file"] = String(files);
  else delete opts["max-file"];
  const d: Record<string, unknown> = { ...daemon, "log-opts": opts };
  if (!Object.keys(opts).length) delete d["log-opts"];
  return d;
}

const DOCKER_RESTART = `$SUDO systemctl restart docker 2>/dev/null || $SUDO rc-service docker restart 2>/dev/null || $SUDO service docker restart`;

export async function setDaemon(s: Server, daemon: Record<string, unknown>, what: string, restart: boolean) {
  const json = JSON.stringify(daemon, null, 2) + "\n";
  const script = String.raw`
$SUDO install -d /etc/docker
undo=$(saved /etc/docker/daemon.json) || exit 1
${writeFileCmd("/etc/docker/daemon.json", json)}
${restart ? `log "restarting docker"\n${DOCKER_RESTART}\nrecord ${shq(what)} "$undo; ${DOCKER_RESTART.replace(/\$/g, "\\$")}"` : `record ${shq(what)} "$undo"`}
`;
  await runScript(s, PRELUDE + script);
}
