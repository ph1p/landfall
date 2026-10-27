import { S, type Any } from "../lib/store";
import { SECTIONS, type Tab } from "../lib/api";
import { Badge, Bone, Dot, cx, noteClass } from "../ui/kit";
import { Star as StarIcon } from "lucide-react";

// Small pieces many views share.

export function errorHint(error: string) {
  if (/permission denied/i.test(error)) return "No key login yet. Use Set up: landfall asks for the password once and installs a key.";
  if (/resolve|not known|nodename/i.test(error)) return "Host name not found. Check the entry in ~/.ssh/config.";
  if (/timed out|refused|no route|unreachable/i.test(error)) return "Server not reachable. Is it running, and is the ssh port right?";
  return "";
}

export const isUp = (status: string) => /^up/i.test(status);
/** A container's dot from its docker status. */
export function StatusDot({ status }: { status: string }) {
  const [cls, word] = /^restarting|\((unhealthy|health: starting)\)/i.test(status) ? ["warn", "not healthy"] : isUp(status) ? ["up", "running"] : /^exited \(0\)/i.test(status) ? ["", "finished"] : ["down", "down"];
  return <Dot kind={cls} role="img" aria-label={word} title={status} />;
}

export function size(b: number) {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) (b /= 1024), i++;
  return `${b < 10 && i ? b.toFixed(1) : Math.round(b)} ${u[i]}`;
}
export function uptime(s: number) {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
  return d ? `${d}d ${h}h` : h ? `${h}h` : `${Math.floor(s / 60)}m`;
}

export const REACH_WORD = { ok: "reachable", login: "login refused", down: "unreachable" } as const;
export const REACH_KIND = { ok: "up", login: "warn", down: "down" } as const;
/** Reachable first, then refused, then down, then not checked. */
export const reachRank = (n: string) => ({ ok: 0, login: 1, down: 2 })[S.reach[n]?.state as "ok"] ?? 3;
export function reachCount(list: Any[]) {
  const count = { ok: 0, login: 0, down: 0 };
  for (const s of list) if (S.reach[s.name]) count[S.reach[s.name].state as keyof typeof count]++;
  return count;
}
/** A faint 0, for an empty count cell. */
export const Zero = () => <span className="faint">0</span>;
/** used as a whole percentage of total. */
export const pct = (used: number, total: number) => (total ? Math.round((used / total) * 100) : 0);
export const Star = () => <span className="text-warn" title="default server"><StarIcon className="inline-block size-3 -mt-0.5 align-middle fill-current" aria-label="default server" /></span>;
/** Whether landfall's ssh login to n works, from /api/reach. */
export function ReachDot({ n, className }: { n: string; className?: string }) {
  const r = S.reach[n];
  if (!r) return <Dot className={className} role="img" aria-label="not checked yet" title={S.reaching ? "Checking…" : "Not checked yet"} />;
  const [cls, word] = [REACH_KIND[r.state as "ok"], REACH_WORD[r.state as "ok"]];
  const tip = r.state === "ok" ? `Key login works (${r.ms} ms)` : r.state === "login" ? `sshd answers but refuses the login: ${r.detail}` : `Unreachable: ${r.detail}`;
  return <Dot kind={cls} className={className} role="img" aria-label={word} title={tip} />;
}

/** The server's one-line summary under its name. */
export function FactsLine({ n }: { n: string }) {
  const f = S.facts[n]?.data;
  if (!f) return S.facts[n]?.error ? null : (
    <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1.5 h-[18.75px] items-center">{["w-28", "w-16", "w-24", "w-32", "w-20"].map((w) => <Bone key={w} className={w} />)}</div>
  );
  const disk = pct(f.disk.used, f.disk.total);
  const items = [
    <><b className="text-fg font-medium">{f.os}</b> {f.arch}</>,
    <span title={`kernel ${f.kernel}`}>up {uptime(f.uptime)}</span>,
    f.cpus ? `${f.cpus} CPU · load ${f.load.split(" ")[0]}` : "",
    f.mem.total ? `RAM ${size(f.mem.total - f.mem.available)} / ${size(f.mem.total)}` : "",
    f.disk.total ? <span className={cx(disk > 85 && "text-warn")}>disk {disk}% of {size(f.disk.total)}</span> : "",
    f.docker ? `docker ${f.docker}` : <span className="faint">no docker</span>,
    f.reboot ? <Badge kind="warn">reboot required</Badge> : "",
  ];
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-faint text-sm mt-1.5">
      {items.filter(Boolean).map((x, i) => <span key={i}>{x}</span>)}
    </div>
  );
}

/** A system that installs its own way (DSM, SteamOS) is not a problem, just a different kind of server. */
export function FactsNote({ n }: { n: string }) {
  const f = S.facts[n]?.data;
  const sup = f?.support;
  if (!sup?.note) return null;
  return (
    <div className={noteClass(sup.level === "eol" || sup.level === "unsupported" ? "bad" : "")}>
      {sup.note}{f.can && !f.can.docker ? `. Docker: ${f.why.docker}` : ""}
    </div>
  );
}

/** What the server can do (`lf server info --json` can); null until its facts are in, then everything shows. */
export const can = (n: string): Any => S.facts[n]?.data?.can ?? null;
/** Server n's overview and facts are both in (or failed): until then its page shows placeholders, not a guess. */
export const connected = (n: string) => [S.overview[n], S.facts[n]].every((x) => x?.data || x?.error);
/** When each section is worth a tab: the same conditions the CLI checks before doing it. */
const SECTION_IF: Partial<Record<Tab, (k: Any) => unknown>> = {
  sites: (k) => k.docker || k.setup,
  tunnels: (k) => k.docker,
  traffic: (k) => k.docker,
  traefik: (k) => k.docker,
  updates: (k) => k.packages || k.docker,
  firewall: (k) => k.firewall,
  users: (k) => k.users,
};
export const sections = (n: string) => SECTIONS.filter(([t]) => !can(n) || (SECTION_IF[t]?.(can(n)) ?? true));
