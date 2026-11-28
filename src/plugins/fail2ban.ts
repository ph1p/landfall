// fail2ban: what it bans, and banning, unbanning and tuning its jails. A built-in plugin.
import { definePlugin, type PluginContext, type UiAction, type UiBlock, type UiField } from "../core/plugins/plugin-api";
import { IP } from "../core/server/system";
import { isCidr } from "../core/site/x-landfall";
import { writeFileCmd } from "../core/ssh/ssh";
import { F2B_WEB_JAIL, PROXY_CTR } from "../core/ssh/templates";
import { ACCESS_LOG_SH, parseAccessLog } from "../core/traefik/accesslog";

export interface F2bJail {
  name: string;
  banned: number;
  total: number;
  failed: number;
  ips: string[];
  /** As fail2ban reports them: seconds (bantime -1 bans for good). */
  bantime?: number;
  findtime?: number;
  maxretry?: number;
}

export interface F2bStatus {
  /** noroot: installed, but this login can read it only as root or with passwordless sudo. */
  fail2ban: "missing" | "noroot" | "stopped" | "running";
  version?: string;
  jails: F2bJail[];
}

// Read-only. fail2ban answers root only: without root or passwordless sudo it says noroot instead of guessing,
// and status() asks again through the server's root login (lf server config --root-login).
// S (from PRELUDE) runs a command as root without asking for a password.
const STATUS = String.raw`
command -v fail2ban-client >/dev/null 2>&1 || { echo "state missing"; exit 0; }
echo "version $(fail2ban-client --version 2>/dev/null | grep -oE '[0-9]+(\.[0-9]+)+' | head -1 || true)"
[ "$(id -u)" = 0 ] || sudo -n true 2>/dev/null || { echo "state noroot"; exit 0; }
st=$(S fail2ban-client status 2>/dev/null) || { echo "state stopped"; exit 0; }
echo "state running"
for j in $(printf '%s\n' "$st" | sed -n 's/.*Jail list:[[:space:]]*//p' | tr ',' ' '); do
  S fail2ban-client status "$j" 2>/dev/null | awk -v j="$j" '
    /Currently banned:/ { c = $NF } /Total banned:/ { t = $NF } /Currently failed:/ { f = $NF }
    /Banned IP list:/ { sub(/.*Banned IP list:[ \t]*/, ""); ips = $0 }
    END { print "JAIL\t" j "\t" c + 0 "\t" t + 0 "\t" f + 0 "\t" ips }' || true
  printf 'CONF\t%s\t%s\t%s\t%s\n' "$j" "$(S fail2ban-client get "$j" bantime 2>/dev/null || true)" \
    "$(S fail2ban-client get "$j" findtime 2>/dev/null || true)" "$(S fail2ban-client get "$j" maxretry 2>/dev/null || true)"
done
`;

const num = (v: string | undefined) => (v !== undefined && /^-?\d+$/.test(v.trim()) ? Number(v.trim()) : undefined);

export function parseStatus(out: string): F2bStatus {
  const st: F2bStatus = { fail2ban: "missing", jails: [] };
  for (const line of out.split("\n")) {
    const [k, ...f] = line.split("\t");
    if (line.startsWith("state ")) st.fail2ban = line.slice(6).trim() as F2bStatus["fail2ban"];
    else if (line.startsWith("version ")) {
      const v = line.slice(8).trim();
      if (v) st.version = v;
    } else if (k === "JAIL")
      st.jails.push({ name: f[0], banned: +f[1] || 0, total: +f[2] || 0, failed: +f[3] || 0, ips: (f[4] ?? "").split(/\s+/).filter(Boolean) });
    else if (k === "CONF") {
      const j = st.jails.find((x) => x.name === f[0]);
      if (!j) continue;
      const [bantime, findtime, maxretry] = [num(f[1]), num(f[2]), num(f[3])];
      Object.assign(j, bantime !== undefined && { bantime }, findtime !== undefined && { findtime }, maxretry !== undefined && { maxretry });
    }
  }
  return st;
}

export async function status(ctx: PluginContext): Promise<F2bStatus> {
  const st = parseStatus(await ctx.script(STATUS));
  if (st.fail2ban !== "noroot") return st;
  try {
    return parseStatus(await ctx.script(STATUS, { admin: "reading fail2ban" }));
  } catch {
    return st; // no login with root either: noroot stands
  }
}

/** 600 → "10m", 86400 → "1d", -1 → "forever". */
export function duration(sec?: number): string {
  if (sec === undefined) return "";
  if (sec < 0) return "forever";
  for (const [u, n] of [
    ["w", 604800],
    ["d", 86400],
    ["h", 3600],
    ["m", 60],
  ] as const)
    if (sec >= n && sec % n === 0) return `${sec / n}${u}`;
  return `${sec}s`;
}

const JAIL = /^[A-Za-z0-9_.-]+$/;
/** fail2ban's time values: 600, 10m, 1h, 1d, 1w; -1 bans for good. */
export const TIME = /^(-1|\d+[smhdw]?)$/;

/** Writes a jail's settings to its own file in jail.d, keeping those not given, and reloads fail2ban. */
export const CONFIG = String.raw`
f="/etc/fail2ban/jail.d/50-landfall-$F2B_JAIL.local"
$SUDO fail2ban-client status "$F2B_JAIL" >/dev/null 2>&1 || { echo "fail2ban has no jail $F2B_JAIL" >&2; exit 1; }
old=$($SUDO cat "$f" 2>/dev/null || true)
get() { printf '%s\n' "$old" | sed -n "s/^$1[[:space:]]*=[[:space:]]*//p" | tail -1; }
bt=\${F2B_BANTIME:-$(get bantime)}; ft=\${F2B_FINDTIME:-$(get findtime)}; mr=\${F2B_MAXRETRY:-$(get maxretry)}
undo=$(saved "$f")
{ printf '[%s]\n' "$F2B_JAIL"; [ -z "$bt" ] || echo "bantime = $bt"; [ -z "$ft" ] || echo "findtime = $ft"; [ -z "$mr" ] || echo "maxretry = $mr"; } | $SUDO tee "$f" >/dev/null
$SUDO fail2ban-client reload >/dev/null
record "fail2ban jail $F2B_JAIL: bantime \${bt:-default}, findtime \${ft:-default}, maxretry \${mr:-default}" "$undo; \$SUDO fail2ban-client reload >/dev/null"
`.replace(/\\\$\{/g, "${");

const BAN = String.raw`
$SUDO fail2ban-client status "$F2B_JAIL" >/dev/null 2>&1 || { echo "fail2ban has no jail $F2B_JAIL" >&2; exit 1; }
$SUDO fail2ban-client set "$F2B_JAIL" banip "$F2B_IP" >/dev/null
record "banned $F2B_IP in fail2ban jail $F2B_JAIL" "\$SUDO fail2ban-client set $(printf %q "$F2B_JAIL") unbanip $(printf %q "$F2B_IP") >/dev/null"
`;

// Unbans F2B_IP in every jail that bans it, in one go. Prints "state <x>" when fail2ban does not run, else
// "unbanned" and the jails it unbanned the IP in (none: it was not banned).
const UNBAN = String.raw`
command -v fail2ban-client >/dev/null 2>&1 || { echo "state missing"; exit 0; }
st=$($SUDO fail2ban-client status 2>/dev/null) || { echo "state stopped"; exit 0; }
reban=""; hit=""
for j in $(printf '%s\n' "$st" | sed -n 's/.*Jail list:[[:space:]]*//p' | tr ',' ' '); do
  ips=$($SUDO fail2ban-client status "$j" 2>/dev/null | sed -n 's/.*Banned IP list:[[:space:]]*//p' || true)
  case " $ips " in *" $F2B_IP "*) ;; *) continue ;; esac
  $SUDO fail2ban-client set "$j" unbanip "$F2B_IP" >/dev/null
  reban="$reban\$SUDO fail2ban-client set $(printf %q "$j") banip $(printf %q "$F2B_IP") >/dev/null; "
  hit="$hit $j"
done
[ -z "$hit" ] || record "unbanned $F2B_IP" "$reban"
echo "unbanned$hit"
`;

const json = { type: "boolean", desc: "machine-readable output" } as const;

const noroot = (ctx: PluginContext) =>
  `fail2ban answers root only; ${ctx.name}'s login has no passwordless sudo and no root key login works (lf server config ${ctx.name} --root-login <ssh-alias>)`;

function needRunning(ctx: PluginContext, state: F2bStatus["fail2ban"]) {
  if (state === "missing") ctx.fail(`fail2ban is not installed on ${ctx.name}; lf fail2ban install sets it up`);
  if (state === "noroot") ctx.fail(noroot(ctx));
  if (state === "stopped") ctx.fail(`fail2ban is not running on ${ctx.name}; lf fail2ban install starts it`);
}

const SETTINGS: UiField[] = [
  {
    name: "bantime",
    label: "Ban for",
    flag: "--bantime",
    placeholder: "10m",
    suggest: ["10m", "1h", "1d", "1w", "-1"],
    hint: "Seconds, or with a unit: 10m, 1h, 1d, 1w. -1 bans for good.",
  },
  { name: "findtime", label: "Count failures over", flag: "--findtime", placeholder: "10m", suggest: ["10m", "1h", "1d"], hint: "Seconds, or 10m, 1h, 1d." },
  { name: "maxretry", label: "Failures before a ban", type: "number", min: 1, flag: "--maxretry", placeholder: "5" },
];

// ---- lf fail2ban web: ban web scanners and floods from Traefik's access log ----

/** The web jails: what they count and their defaults (tuning: lf fail2ban config <jail>, a 50- file). */
export const WEB_JAILS = ["landfall-http", "landfall-http-flood"] as const;
const FILTER_HTTP_FILE = "/etc/fail2ban/filter.d/landfall-traefik.conf";
const FILTER_FLOOD_FILE = "/etc/fail2ban/filter.d/landfall-traefik-flood.conf";
/** lf fail2ban config's tuning of the flood jail; it goes when floods go. */
const TUNE_FLOOD_FILE = "/etc/fail2ban/jail.d/50-landfall-landfall-http-flood.local";
const WEB_FILES = [FILTER_HTTP_FILE, FILTER_FLOOD_FILE, F2B_WEB_JAIL, "/etc/fail2ban/jail.d/50-landfall-landfall-http.local", TUNE_FLOOD_FILE];

// Traefik's JSON access log as Docker's json-file log stores it: {"log":"{\"ClientAddr\":…}\n","stream":…,"time":…}.
// Anchored at the line start: Traefik sorts the keys, so ClientAddr and ClientHost come first, and only the TCP
// connection sets them. A path or Host header cannot name another address: Docker escapes its quotes once more.
const FILTER_HEAD = String.raw`# landfall: lf fail2ban web. Reads Traefik's JSON access log in Docker's json-file log.
# ClientAddr and ClientHost come first and only the connection sets them: a request cannot name another address.
# Requests to /_lf/ (landfall's own endpoints, the analytics collector) never count.
[Definition]
_client = ^\{"log":"\{\\"ClientAddr\\":\\"[^\\"]*\\",\\"ClientHost\\":\\"<HOST>\\",
_own = (?!.*\\"RequestPath\\":\\"/_lf/)
datepattern = "time":"%%Y-%%m-%%dT%%H:%%M:%%S
`;
/** Responses 400–405 (bad request, unauthorized, forbidden, not found…): what scanners get. */
export const FILTER_HTTP = `${FILTER_HEAD}${String.raw`failregex = %(_client)s(?=.*\\"DownstreamStatus\\":40[0-5],)%(_own)s`}\n`;
/** Every request: floods. */
export const FILTER_FLOOD = `${FILTER_HEAD}failregex = %(_client)s%(_own)s\n`;

// Read-only: is fail2ban web on, which container it watches, and what web on needs. S runs as root when it can.
const WEB_CHECKS = String.raw`
P=${PROXY_CTR}
[ ! -e ${F2B_WEB_JAIL} ] || printf 'WEBHEAD\t%s\n' "$(sed -n 's/^# container=//p' ${F2B_WEB_JAIL} | head -1)"
pr=$(docker inspect -f '{{.Id}} {{.HostConfig.NetworkMode}} {{.LogPath}}' "$P" 2>/dev/null || true)
printf 'PROXY\t%s\n' "$pr"
${ACCESS_LOG_SH}
! command -v iptables >/dev/null 2>&1 || echo IPT
if can_root; then
  ! S iptables -n -L DOCKER-USER >/dev/null 2>&1 || echo DU4
  ! command -v ip6tables >/dev/null 2>&1 || ! S ip6tables -n -L DOCKER-USER >/dev/null 2>&1 || echo DU6
  lp=$(printf %s "$pr" | cut -d' ' -f3-)
  if [ -n "$lp" ]; then
    t=$(S tail -n 200 "$lp" 2>/dev/null | grep -F DownstreamStatus || true)
    printf 'KEYS\t%s\t%s\n' "$(printf '%s\n' "$t" | grep -c . || true)" \
      "$(printf '%s\n' "$t" | grep -cE '^[{]"log":"[{]\\"ClientAddr\\":\\"[^\\"]*\\",\\"ClientHost\\":\\"' || true)"
  fi
fi
`;
const WEB_STATUS = `${WEB_CHECKS}\n${STATUS}`;

export interface F2bWeb {
  fail2ban: F2bStatus["fail2ban"];
  /** The web jails are configured (40-landfall-http.local exists). */
  on: boolean;
  flood: boolean;
  /** Addresses never banned, besides private ranges. */
  ignore: string[];
  /** Where bans go: DOCKER-USER (bridge network) or INPUT on ports 80 and 443 (host network). */
  mode?: "bridge" | "host";
  /** The jails read the log of a Traefik container that is gone (recreated by hand): lf fail2ban web on fixes it. */
  stale: boolean;
  jails: F2bJail[];
  /** Why lf fail2ban web on refuses. */
  problem?: string;
  /** Bridge network without ip6tables' DOCKER-USER chain: IPv6 clients cannot be banned. */
  noIpv6: boolean;
}

export function parseWeb(out: string, st = parseStatus(out)): F2bWeb {
  const kv = new Map<string, string>();
  for (const line of out.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab > 0) kv.set(line.slice(0, tab), line.slice(tab + 1));
    else if (/^(IPT|DU4|DU6)$/.test(line)) kv.set(line, "");
  }
  const head = kv.get("WEBHEAD");
  const [id = "", net = ""] = (kv.get("PROXY") ?? "").trim().split(/\s+/);
  const mode = id ? (net === "host" ? "host" : "bridge") : undefined;
  const h = /^(\S*) mode=(\w+) flood=([01]) ignore=(\S*)/.exec(head ?? "");
  const web: F2bWeb = {
    fail2ban: st.fail2ban,
    on: head !== undefined,
    flood: h?.[3] === "1",
    ignore: (h?.[4] ?? "").split(",").filter(Boolean),
    ...(h ? { mode: h[2] as "bridge" | "host" } : {}),
    stale: head !== undefined && (!h || h[1] !== id || h[2] !== mode),
    jails: st.jails.filter((j) => (WEB_JAILS as readonly string[]).includes(j.name)),
    noIpv6: mode === "bridge" && kv.has("DU4") && !kv.has("DU6"),
  };
  const log = parseAccessLog(out);
  const keys = (kv.get("KEYS") ?? "").split("\t").map(Number);
  const logIs = { common: "not JSON", file: "written to a file", off: "off" } as Record<string, string>;
  const problem = (
    [
      [
        st.fail2ban === "missing" || st.fail2ban === "stopped",
        `fail2ban is not ${st.fail2ban === "missing" ? "installed" : "running"}: lf fail2ban install sets it up`,
      ],
      [!id, "no Traefik runs here: lf traefik install sets it up"],
      [
        kv.has("LD") && kv.get("LD") !== "json-file",
        `Traefik logs with Docker's ${kv.get("LD")} driver; fail2ban needs json-file, the only one with a file it can read`,
      ],
      [log !== "json", `Traefik's access log is ${logIs[log] ?? "set in a config file"}: lf traefik access-log on writes it as JSON to stdout`],
      [!kv.has("IPT"), "iptables is missing: fail2ban bans with it"],
      [
        mode === "bridge" && kv.has("KEYS") && !kv.has("DU4"),
        "Docker has no DOCKER-USER chain (nftables backend, or iptables off in daemon.json): a ban would not reach Traefik's published ports",
      ],
      [keys[0] > 0 && keys[1] < keys[0], "Traefik's access log does not start with ClientAddr, ClientHost: the filter would not read it"],
    ] as const
  ).find(([when]) => when)?.[1];
  if (problem) web.problem = problem;
  return web;
}

/** fail2ban's status and the web jails' state, in one round trip. */
async function webStatus(ctx: PluginContext, admin?: string): Promise<{ st: F2bStatus; web: F2bWeb }> {
  const read = async (a?: string) => {
    const out = await ctx.script(WEB_STATUS, a ? { admin: a } : {});
    const st = parseStatus(out);
    return { st, web: parseWeb(out, st) };
  };
  if (admin) return read(admin);
  const r = await read();
  if (r.st.fail2ban !== "noroot") return r;
  try {
    return await read("reading fail2ban");
  } catch {
    return r;
  }
}

// Ends the undo of web on and web off: the jails follow the running Traefik again, fail2ban reads them.
const UNDO_TAIL = "f2b_web_refresh; \\$SUDO fail2ban-client reload >/dev/null";

// Writes the filters and the jails, keeps a tuning (50- files) except the flood jail's when it goes, reloads.
// A config fail2ban refuses is put back before anything is journaled.
const WEB_ON = String.raw`
undo=""
files="${FILTER_HTTP_FILE} ${FILTER_FLOOD_FILE} ${F2B_WEB_JAIL}"; [ "$F2B_FLOOD" = 1 ] || files="$files ${TUNE_FLOOD_FILE}"
for f in $files; do undo="$undo$(saved "$f"); "; done
${writeFileCmd(FILTER_HTTP_FILE, FILTER_HTTP)}
${writeFileCmd(FILTER_FLOOD_FILE, FILTER_FLOOD)}
# shellcheck disable=SC2086
f2b_web_write "$F2B_FLOOD" $F2B_IGNORE
[ "$F2B_FLOOD" = 1 ] || _as /etc/fail2ban/jail.d rm -f ${TUNE_FLOOD_FILE}
if ! { $SUDO fail2ban-client reload >/dev/null 2>&1 && $SUDO fail2ban-client status landfall-http >/dev/null 2>&1; }; then
  eval "$undo"; $SUDO fail2ban-client reload >/dev/null 2>&1 || true
  echo "fail2ban did not take the web jails; nothing changed (see: journalctl -u fail2ban, or /var/log/fail2ban.log)" >&2; exit 1
fi
record "fail2ban web jails on$([ "$F2B_FLOOD" = 1 ] && echo ' (with floods)' || true)" "$undo ${UNDO_TAIL}"
`;

const WEB_OFF = String.raw`
undo=""
for f in ${WEB_FILES.join(" ")}; do
  [ -e "$f" ] || continue
  undo="$undo$(saved "$f"); "
  _as "$(dirname "$f")" rm -f "$f"
done
[ -n "$undo" ] || { echo "already off"; exit 0; }
$SUDO fail2ban-client reload >/dev/null
record "fail2ban web jails off" "$undo ${UNDO_TAIL}"
`;

const NO_IPV6 = "IPv6 clients cannot be banned: ip6tables has no DOCKER-USER chain (Docker's ip6tables is off)";

const CDN =
  "behind Cloudflare or another CDN, Traefik sees the CDN's addresses, not the visitors': a ban would block everyone coming through that edge. Pass the CDN's ranges with --ignore, or turn this off (lf fail2ban web off).";

function printWeb(ctx: PluginContext, w: F2bWeb) {
  const { bold, dim } = ctx.color;
  if (!w.on) {
    ctx.print(`${bold("web jails")}: off`);
    if (w.problem) ctx.log.info(dim(`lf fail2ban web on would refuse: ${w.problem}`));
    else ctx.log.info(dim("lf fail2ban web on bans web scanners from Traefik's access log"));
    return;
  }
  const where = w.mode === "host" ? "INPUT, ports 80 and 443" : "DOCKER-USER, Traefik's published ports";
  ctx.print(`${bold("web jails")}: on${dim(` · bans go to ${where}${w.ignore.length ? ` · ignores ${w.ignore.join(", ")}` : ""}`)}`);
  for (const name of [WEB_JAILS[0], ...(w.flood ? [WEB_JAILS[1]] : [])]) {
    const j = w.jails.find((x) => x.name === name);
    if (!j) ctx.print(`${bold(name)}: ${w.fail2ban === "running" ? "not loaded by fail2ban" : `fail2ban ${w.fail2ban}`}`);
    else
      ctx.print(
        `${bold(j.name)}: ${j.banned} banned now${dim(` · ${j.total} in total · ban ${duration(j.bantime)} after ${j.maxretry ?? "?"} ${name === WEB_JAILS[0] ? "4xx answers" : "requests"} in ${duration(j.findtime)}`)}`,
      );
  }
  if (w.stale) ctx.log.warn("the web jails watch an old log (Traefik was recreated by hand): run lf fail2ban web on");
  if (w.noIpv6) ctx.log.warn(NO_IPV6);
}

/** lf fail2ban web on, asking for floods and ignored networks; filled in with the current ones when the jails are on. */
const webOnAction = (label: string, w?: F2bWeb, primary = false): UiAction => ({
  label,
  argv: ["fail2ban", "web", "on"],
  title: "Ban web scanners",
  primary,
  fields: [
    { name: "flood", label: "Also ban floods (600 requests in a minute)", type: "check", flag: "--flood", value: w?.flood ?? false },
    {
      name: "ignore",
      label: "Never ban",
      flag: "--ignore",
      value: w?.ignore.join(",") ?? "",
      placeholder: "198.51.100.0/24,2001:db8::/32",
      hint: "Behind a CDN, its ranges: else a ban blocks everyone coming through it.",
    },
  ],
});

/** A web jail's Remove in the jails table: the flood jail alone goes with web on without --flood, landfall-http takes both. */
function webJailRemove(jail: string, w: F2bWeb): UiAction[] {
  if (!w.on) return [];
  if (jail === "landfall-http-flood")
    return [
      {
        label: "Remove",
        argv: ["fail2ban", "web", "on", ...(w.ignore.length ? ["--ignore", w.ignore.join(",")] : [])],
        danger: true,
        confirm: "Stop banning floods? Scanners are still banned; bans for floods are lifted.",
      },
    ];
  if (jail === "landfall-http") return [{ label: "Remove", argv: ["fail2ban", "web", "off"], danger: true, confirm: WEB_OFF_CONFIRM }];
  return [];
}

const WEB_OFF_CONFIRM = "Remove the web jails (landfall-http and landfall-http-flood)? Bans they set are lifted.";

/** The panel's word on the web jails: off with a quiet way on (only where it would work), or on with a way to change or remove them. */
function webBlocks(w: F2bWeb): UiBlock[] {
  if (!w.on)
    return w.problem
      ? []
      : [
          {
            type: "note",
            kind: "info",
            text: "fail2ban reads only login logs. It can also ban web scanners from Traefik's access log: clients with many 4xx answers, and with floods, many requests.",
            actions: [webOnAction("Ban web scanners")],
          },
        ];
  const ignored = w.ignore.length ? `, never ${w.ignore.join(", ")}` : "";
  const out: UiBlock[] = [];
  if (w.stale)
    out.push({
      type: "note",
      kind: "warn",
      text: "The web jails watch an old log: Traefik was recreated outside landfall.",
      actions: [
        {
          label: "Watch the new log",
          argv: ["fail2ban", "web", "on", ...(w.flood ? ["--flood"] : []), ...(w.ignore.length ? ["--ignore", w.ignore.join(",")] : [])],
          primary: true,
        },
      ],
    });
  out.push({
    type: "note",
    kind: "info",
    text: `fail2ban bans web scanners${w.flood ? " and floods" : ""} from Traefik's access log${ignored}.`,
    actions: [
      webOnAction("Change", w),
      {
        label: "Stop banning",
        argv: ["fail2ban", "web", "off"],
        danger: true,
        confirm: WEB_OFF_CONFIRM,
      },
    ],
  });
  if (w.noIpv6) out.push({ type: "note", kind: "warn", text: `${NO_IPV6}.` });
  return out;
}

export default definePlugin({
  name: "fail2ban",
  summary: "What fail2ban bans; ban, unban and tune its jails.",
  aliases: { bans: "fail2ban", unban: "fail2ban unban", "bans unban": "fail2ban unban" },
  commands: [
    {
      name: "",
      summary: "Show what fail2ban blocks: its jails, their settings and the banned IPs.",
      options: { json },
      async run(ctx, _, o) {
        const st = await status(ctx);
        if (o.json) return ctx.json(st);
        if (st.fail2ban !== "running") {
          if (st.fail2ban === "noroot") ctx.fail(noroot(ctx));
          return ctx.log.info(st.fail2ban === "missing" ? `fail2ban is not installed on ${ctx.name}` : `fail2ban is not running on ${ctx.name}`);
        }
        const { bold, dim } = ctx.color;
        for (const j of st.jails) {
          const conf = [
            j.bantime !== undefined && `ban ${duration(j.bantime)}`,
            j.maxretry !== undefined && `after ${j.maxretry} failures`,
            j.findtime !== undefined && `in ${duration(j.findtime)}`,
          ];
          ctx.print(
            `${bold(j.name)}: ${j.banned} banned now${dim(` · ${j.total} in total · ${j.failed} failing · ${conf.filter(Boolean).join(" ")}`)}`,
            ...j.ips.map((ip) => `  ${ip}`),
          );
        }
        if (st.jails.some((j) => j.ips.length)) ctx.log.info(dim("lf fail2ban unban <ip> lets one in again"));
      },
    },
    {
      name: "unban",
      args: "<ip>",
      summary: "Let a banned IP in again (all jails that ban it). Undo bans it again.",
      async run(ctx, [ip]) {
        if (!ip) ctx.fail("usage: lf fail2ban unban <ip>");
        if (!IP.test(ip)) ctx.fail(`not an IP address: ${ip}`);
        const out = await ctx.script(UNBAN, { admin: "unbanning", env: { F2B_IP: ip } });
        const state = /^state (\w+)/m.exec(out)?.[1];
        if (state) needRunning(ctx, state as F2bStatus["fail2ban"]);
        const jails = (/^unbanned(.*)$/m.exec(out)?.[1] ?? "").split(/\s+/).filter(Boolean);
        if (!jails.length) ctx.fail(`${ip} is not banned on ${ctx.name}`);
        ctx.log.ok(`unbanned ${ip} (${jails.join(", ")})`);
      },
    },
    {
      name: "ban",
      args: "<ip>",
      summary: "Ban an IP now, in one jail (sshd unless --jail). Undo unbans it.",
      options: { jail: { type: "string", desc: "the jail to ban it in", default: "sshd" } },
      async run(ctx, [ip], o) {
        if (!ip) ctx.fail("usage: lf fail2ban ban <ip> [--jail <jail>]");
        if (!IP.test(ip)) ctx.fail(`not an IP address: ${ip}`);
        const jail = String(o.jail ?? "sshd");
        if (!JAIL.test(jail)) ctx.fail(`not a jail name: ${jail}`);
        await ctx.script(BAN, { admin: "banning", env: { F2B_JAIL: jail, F2B_IP: ip } });
        ctx.log.ok(`banned ${ip} in ${jail}`);
      },
    },
    {
      name: "config",
      args: "<jail>",
      summary: "Set how long a jail bans and after how many failures (in jail.d/50-landfall-<jail>.local). Undo restores it.",
      options: {
        bantime: { type: "string", desc: "how long a ban lasts: 600, 10m, 1h, 1d; -1 for good" },
        findtime: { type: "string", desc: "the window failures are counted in" },
        maxretry: { type: "string", desc: "failures in that window before a ban" },
      },
      async run(ctx, [jail], o) {
        if (!jail) ctx.fail("usage: lf fail2ban config <jail> [--bantime <t>] [--findtime <t>] [--maxretry <n>]");
        if (!JAIL.test(jail)) ctx.fail(`not a jail name: ${jail}`);
        for (const k of ["bantime", "findtime"])
          if (o[k] !== undefined && !TIME.test(o[k])) ctx.fail(`--${k} takes 600, 10m, 1h, 1d or 1w (-1 for good), not ${o[k]}`);
        if (o.maxretry !== undefined && !/^[1-9]\d*$/.test(o.maxretry)) ctx.fail(`--maxretry takes a positive number, not ${o.maxretry}`);
        if (o.bantime === undefined && o.findtime === undefined && o.maxretry === undefined)
          ctx.fail("nothing to change: give --bantime, --findtime or --maxretry");
        await ctx.script(CONFIG, {
          admin: "configuring fail2ban",
          env: { F2B_JAIL: jail, F2B_BANTIME: o.bantime, F2B_FINDTIME: o.findtime, F2B_MAXRETRY: o.maxretry },
        });
        ctx.log.ok(`fail2ban jail ${jail} updated`);
      },
    },
    {
      name: "web",
      args: "[on|off]",
      summary: "Ban web scanners (4xx answers) and, with --flood, floods from Traefik's access log. Without on or off: show it.",
      options: {
        flood: { type: "boolean", desc: "on: also ban clients sending more than 600 requests a minute" },
        ignore: { type: "string", desc: "on: never ban these addresses or networks, comma-separated (a CDN's ranges)" },
        json,
      },
      async run(ctx, [sub], o) {
        if (sub === undefined) {
          const w = (await webStatus(ctx)).web;
          if (o.json) return ctx.json(w);
          if (w.fail2ban === "noroot") ctx.fail(noroot(ctx));
          return printWeb(ctx, w);
        }
        if (sub !== "on" && sub !== "off") ctx.fail("usage: lf fail2ban web [on [--flood] [--ignore <ip|cidr>,…] | off]");
        if (sub === "off") {
          const out = await ctx.script(WEB_OFF, { admin: "turning off fail2ban's web jails" });
          return /^already off/m.test(out) ? ctx.log.info(`fail2ban's web jails are off on ${ctx.name}`) : ctx.log.ok("fail2ban no longer bans web clients");
        }
        const ignore = String(o.ignore ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        for (const a of ignore) if (!isCidr(a)) ctx.fail(`--ignore takes IPs and networks (198.51.100.0/24), not ${a}`);
        const w = (await webStatus(ctx, "turning on fail2ban's web jails")).web;
        if (w.fail2ban === "noroot") ctx.fail(noroot(ctx));
        if (w.problem) ctx.fail(w.problem);
        ctx.log.warn(CDN);
        if (w.noIpv6) ctx.log.warn(NO_IPV6);
        await ctx.script(WEB_ON, {
          admin: "turning on fail2ban's web jails",
          env: { F2B_FLOOD: o.flood ? "1" : "0", F2B_IGNORE: ignore.join(" ") },
        });
        ctx.log.ok(`fail2ban bans web clients: 30 4xx answers in 2m${o.flood ? " or 600 requests in 1m" : ""} ban for 1h by default`);
        ctx.log.info(ctx.color.dim(`lf fail2ban config ${WEB_JAILS[0]}${o.flood ? ` (or ${WEB_JAILS[1]})` : ""} --maxretry <n> tunes it`));
      },
    },
    {
      name: "install",
      summary: "Install fail2ban (where landfall can) and start it with an sshd jail: lf harden fail2ban.",
      run: (ctx) => ctx.lf(["harden", "fail2ban"]),
    },
  ],
  panel: {
    label: "fail2ban",
    group: "Machine",
    icon: "ban",
    async load(ctx): Promise<UiBlock[]> {
      const { st, web } = await webStatus(ctx);
      if (st.fail2ban === "missing")
        return [
          {
            type: "note",
            kind: "info",
            text: "fail2ban is not installed. It bans addresses that keep failing to log in.",
            actions: [{ label: "Install fail2ban", argv: ["fail2ban", "install"], primary: true }],
          },
        ];
      if (st.fail2ban === "noroot")
        return [
          {
            type: "note",
            kind: "warn",
            text: "fail2ban answers root only. This login has no passwordless sudo, and no root key login works. Pick a root login under Settings, or add a Host with User root to ~/.ssh/config.",
          },
        ];
      if (st.fail2ban === "stopped")
        return [
          {
            type: "note",
            kind: "warn",
            text: "fail2ban is installed but not running.",
            actions: [{ label: "Start fail2ban", argv: ["fail2ban", "install"], primary: true }],
          },
        ];
      const banned = st.jails.flatMap((j) => j.ips.map((ip) => ({ ip, jail: j.name })));
      const jailNames = st.jails.map((j) => j.name);
      return [
        ...webBlocks(web),
        {
          type: "facts",
          items: [
            { label: "Status", value: { text: "running", kind: "ok" } },
            ...(st.version ? [{ label: "Version", value: st.version }] : []),
            { label: "Jails", value: st.jails.length },
            { label: "Banned now", value: banned.length },
            ...(web.on ? [{ label: "Web jails", value: { text: web.flood ? "scanners and floods" : "scanners", kind: "ok" as const } }] : []),
          ],
          actions: [
            {
              label: "Ban an IP",
              argv: ["fail2ban", "ban"],
              title: "Ban an IP",
              fields: [
                { name: "ip", label: "IP address", required: true, placeholder: "203.0.113.7" },
                ...(jailNames.length
                  ? [
                      {
                        name: "jail",
                        label: "Jail",
                        type: "select" as const,
                        options: jailNames,
                        value: jailNames.includes("sshd") ? "sshd" : jailNames[0],
                        flag: "--jail",
                      },
                    ]
                  : []),
              ],
            },
          ],
        },
        {
          type: "table",
          title: "Jails",
          columns: ["Jail", "Banned", "Total", "Failing", "Ban for", "After", "Within"],
          rows: st.jails.map((j) => ({
            cells: [{ text: j.name, mono: true }, j.banned, j.total, j.failed, duration(j.bantime), j.maxretry ?? "", duration(j.findtime)],
            actions: [
              {
                label: "Settings",
                argv: ["fail2ban", "config", j.name],
                title: `Settings of ${j.name}`,
                fields: SETTINGS.map((f) => ({
                  ...f,
                  value: f.name === "maxretry" ? String(j.maxretry ?? "") : duration(j[f.name as "bantime" | "findtime"]).replace("forever", "-1"),
                })),
              },
              ...webJailRemove(j.name, web),
            ],
          })),
          empty: "fail2ban runs no jails.",
        },
        {
          type: "table",
          title: "Banned IPs",
          columns: ["IP", "Jail"],
          rows: banned.map((b) => ({
            cells: [{ text: b.ip, mono: true }, b.jail],
            actions: [{ label: "Unban", argv: ["fail2ban", "unban", b.ip], confirm: `Let ${b.ip} in again?` }],
          })),
          empty: "Nobody is banned right now.",
        },
      ];
    },
  },
});
