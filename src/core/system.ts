import { createHash } from "node:crypto";
import fs from "node:fs";
import { expandHome, type Server } from "./config";
import { runScript, shq } from "./ssh";
import { rootLogin } from "./privilege";
import { effectiveSsh } from "./sshconfig";
import { KV, kvRecord, PKG_MGR, PRELUDE, REBOOT_NEEDED, SEC_CHECKS } from "./templates";
import { KEY_SERVICES, serviceName } from "./status";
import { fail } from "./term";

/** Everything `lf system` shows, read in one go; root-only parts need root or passwordless sudo. */
const SYSTEM = String.raw`
set +e
${KV}
SUDO=""; R=1
if [ "$(id -u)" -ne 0 ]; then if sudo -n true 2>/dev/null; then SUDO=sudo; else R=0; fi; fi
${SEC_CHECKS}
kv root "$R"
kv user "$(id -un)"
[ -f /etc/synoinfo.conf ] && kv platform synology
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
  if st=$(S fail2ban-client status 2>/dev/null); then
    kv fail2ban running
    for j in $(printf '%s\n' "$st" | sed -n 's/.*Jail list:[[:space:]]*//p' | tr ',' ' '); do
      S fail2ban-client status "$j" 2>/dev/null | awk -v j="$j" '
        /Currently banned:/ { c = $NF } /Total banned:/ { t = $NF } /Currently failed:/ { f = $NF }
        /Banned IP list:/ { sub(/.*Banned IP list:[ \t]*/, ""); ips = $0 }
        END { print "JAIL\t" j "\t" c + 0 "\t" t + 0 "\t" f + 0 "\t" ips }'
    done
  else kv fail2ban stopped; fi
else kv fail2ban missing; fi
# Security: what sshd really uses (sshd -T needs root), who has a password, firewall, updates.
S sshd -T 2>/dev/null | awk '$1 ~ /^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin)$/ && !seen[$1]++ { print "sshd_" $1 "=" $2 }'
[ "$R" = 1 ] && kv password_users "$(password_users)"
${PKG_MGR}
kv pkg "$(pkg_mgr)"
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

export interface AuthorizedKey {
  user: string;
  type: string;
  /** SHA256:… as ssh-keygen -l prints it. */
  fingerprint: string;
  comment: string;
  /** authorized_keys options before the key (from=, command=…). */
  options: string;
  /** The whole line, as it is in the file. */
  line: string;
  /** One of the keys this machine logs in with. */
  mine?: boolean;
}

export interface Jail {
  name: string;
  banned: number;
  total: number;
  failed: number;
  ips: string[];
}

/** What sshd and the system allow; undefined = could not tell (sshd -T and /etc/shadow need root). */
export interface Security {
  /** sshd accepts passwords (PasswordAuthentication or KbdInteractiveAuthentication). */
  passwordLogin?: boolean;
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
  jails: Jail[];
  keys: AuthorizedKey[];
  security: Security;
  /** Set where the system keeps host name, time zone, swap and Docker's settings itself (Synology DSM). */
  managed?: string;
}

export { KEY_SERVICES, serviceName };

const KEY_TYPE = /^(ssh-(rsa|dss|ed25519)|ecdsa-sha2-\S+|sk-\S+@openssh\.com)$/;

/** Splits an authorized_keys line; options may hold quoted spaces (command="a b"). */
export function parseKeyLine(line: string): Omit<AuthorizedKey, "user"> | undefined {
  const toks: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of line.trim()) {
    if (ch === '"') quoted = !quoted;
    if (/\s/.test(ch) && !quoted) {
      if (cur) toks.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) toks.push(cur);
  const i = toks.findIndex((t) => KEY_TYPE.test(t));
  if (i < 0 || !toks[i + 1]) return undefined;
  const blob = Buffer.from(toks[i + 1], "base64");
  if (!blob.length) return undefined;
  return {
    type: toks[i],
    fingerprint: `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`,
    comment: toks.slice(i + 2).join(" "),
    options: toks.slice(0, i).join(" "),
    line: line.trim(),
  };
}

/** A key line as given, or the contents of a .pub file. */
export function readKey(arg: string): string {
  const p = expandHome(arg);
  const line = !/^\S+ AAAA/.test(arg) && fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim().split("\n")[0] : arg.trim();
  if (!parseKeyLine(line)) fail(`not a public key: ${arg} (a line like ssh-ed25519 AAAA… or a .pub file)`);
  return line;
}

/** Fingerprints of the public keys next to the identity files this machine uses for `s`. */
function localFingerprints(s: Server): Set<string> {
  const out = new Set<string>();
  for (const f of effectiveSsh(s).identityFiles) {
    try {
      const k = parseKeyLine(fs.readFileSync(`${f}.pub`, "utf8"));
      if (k) out.add(k.fingerprint);
    } catch {}
  }
  return out;
}

export function parseSystem(out: string, mine = new Set<string>()): SystemInfo {
  const v = kvRecord(out);
  const info: SystemInfo = {
    root: false, user: "", hostname: "", timezone: "", time: "", init: "other", swap: [], diskFree: 0, mem: 0,
    services: [], fail2ban: "missing", jails: [], keys: [], security: { reboot: false },
  };
  const enabled = new Map<string, string>();
  let daemon: string | undefined;
  for (const line of out.split("\n")) {
    const f = line.split("\t");
    if (f[0] === "SWAP") info.swap.push({ file: f[1], type: f[2], size: +f[3] || 0, used: +f[4] || 0 });
    else if (f[0] === "DAEMON") daemon = f.slice(1).join("\t");
    else if (f[0] === "SVC" && f[1]) info.services.push({ unit: f[1], load: f[2], active: f[3], sub: f[4], description: f.slice(5).join("\t") });
    else if (f[0] === "UF" && f[1]) enabled.set(f[1], f[2]);
    else if (f[0] === "JAIL") info.jails.push({ name: f[1], banned: +f[2] || 0, total: +f[3] || 0, failed: +f[4] || 0, ips: (f[5] ?? "").split(/\s+/).filter(Boolean) });
    else if (f[0] === "KEY") {
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
    rootLogin: v.sshd_permitrootlogin || undefined,
    passwordUsers: v.password_users?.split(/\s+/).filter(Boolean),
    pkg: v.pkg || undefined,
    firewall: ["active", "inactive", "missing"].includes(v.ufw) ? (v.ufw as Security["firewall"]) : undefined,
    autoUpdates: v.auto_updates ? v.auto_updates === "on" : undefined,
    reboot: v.reboot === "1",
    platform: v.platform || undefined,
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

export async function system(s: Server): Promise<SystemInfo> {
  const { stdout } = await runScript(s, SYSTEM, { capture: true });
  return parseSystem(stdout, localFingerprints(s));
}

/** Read as root when the login has no sudo but root's key works: other users' keys and the bans need it. */
export async function fullSystem(s: Server): Promise<SystemInfo> {
  const i = await system(s);
  if (i.root) return i;
  const root = await rootLogin(s);
  return root ? system(root) : i;
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

const HOME = `home=$(getent passwd "$KEY_USER" 2>/dev/null | cut -d: -f6); [ -n "$home" ] || home=$(awk -F: -v u="$KEY_USER" '$1 == u { print $6 }' /etc/passwd)
[ -n "$home" ] || { log "no user $KEY_USER"; exit 1; }
f="$home/.ssh/authorized_keys"`;

export async function addKey(s: Server, user: string, line: string) {
  if (!parseKeyLine(line)) fail("not a public key: expected a line like ssh-ed25519 AAAA… comment");
  const script = String.raw`
${HOME}
if $SUDO grep -qxF -- "$KEY" "$f" 2>/dev/null; then log "already there"; exit 0; fi
$SUDO mkdir -p "$home/.ssh"; $SUDO chmod 700 "$home/.ssh"
printf '%s\n' "$KEY" | $SUDO tee -a "$f" >/dev/null
g=$(id -gn "$KEY_USER" 2>/dev/null || echo "$KEY_USER")
$SUDO chown "$KEY_USER:$g" "$home/.ssh" "$f"; $SUDO chmod 600 "$f"
record "authorized key $WHAT for $KEY_USER" "drop_line $(printf %q "$f") $(printf %q "$KEY")"
`;
  const k = parseKeyLine(line)!;
  await runScript(s, PRELUDE + script, { env: { KEY_USER: user, KEY: k.line, WHAT: k.comment || k.fingerprint } });
}

export async function removeKey(s: Server, k: AuthorizedKey) {
  const script = String.raw`
${HOME}
$SUDO grep -qxF -- "$KEY" "$f" || { log "key not found in $f"; exit 1; }
drop_line "$f" "$KEY"
record "removed key $WHAT of $KEY_USER" "printf '%s\n' $(printf %q "$KEY") | \$SUDO tee -a $(printf %q "$f") >/dev/null"
`;
  await runScript(s, PRELUDE + script, { env: { KEY_USER: k.user, KEY: k.line, WHAT: k.comment || k.fingerprint } });
}

export const IP = /^[0-9a-fA-F.:]+$/;

export async function unban(s: Server, ip: string, jails: string[]) {
  if (!IP.test(ip)) fail(`not an IP address: ${ip}`);
  const reban = jails.map((j) => `\\$SUDO fail2ban-client set ${shq(j)} banip ${shq(ip)} >/dev/null`).join("; ");
  const script = [
    PRELUDE,
    ...jails.map((j) => `$SUDO fail2ban-client set ${shq(j)} unbanip ${shq(ip)} >/dev/null`),
    `record ${shq(`unbanned ${ip}`)} "${reban}"`,
  ].join("\n");
  await runScript(s, script);
}

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
printf %s ${shq(Buffer.from(json).toString("base64"))} | base64 -d | $SUDO tee /etc/docker/daemon.json >/dev/null
${restart ? `log "restarting docker"\n${DOCKER_RESTART}\nrecord ${shq(what)} "$undo; ${DOCKER_RESTART.replace(/\$/g, "\\$")}"` : `record ${shq(what)} "$undo"`}
`;
  await runScript(s, PRELUDE + script);
}
