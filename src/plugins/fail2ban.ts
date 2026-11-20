// fail2ban: what it bans, and banning, unbanning and tuning its jails. A built-in plugin.
import { definePlugin, type PluginContext, type UiBlock, type UiField } from "../core/plugin-api";
import { IP } from "../core/system";

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
  { name: "bantime", label: "Ban for", flag: "--bantime", placeholder: "10m", hint: "600, 10m, 1h, 1d, 1w; -1 bans for good" },
  { name: "findtime", label: "Count failures over", flag: "--findtime", placeholder: "10m" },
  { name: "maxretry", label: "Failures before a ban", flag: "--maxretry", placeholder: "5" },
];

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
          console.log(`${bold(j.name)}: ${j.banned} banned now${dim(` · ${j.total} in total · ${j.failed} failing · ${conf.filter(Boolean).join(" ")}`)}`);
          for (const ip of j.ips) console.log(`  ${ip}`);
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
      const st = await status(ctx);
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
        {
          type: "facts",
          items: [
            { label: "Status", value: { text: "running", kind: "ok" } },
            ...(st.version ? [{ label: "Version", value: st.version }] : []),
            { label: "Jails", value: st.jails.length },
            { label: "Banned now", value: banned.length },
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
