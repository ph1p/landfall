import { S, sv } from "../lib/store";
import type { Cap, ServerEntry, SiteStatus } from "../lib/types";
import { SECTIONS, type Tab } from "../lib/api";
import { Badge, Bone, Dot, cx, noteClass } from "../ui/kit";
import { Star as StarIcon } from "lucide-react";
import { bytes as size, duration, pct } from "../../../core/format";
import { isUp, statusKind } from "../../../core/status";

export { bytes as size, pct } from "../../../core/format";
export { isUp };

// Small pieces many views share.

export function errorHint(error: string) {
  if (/permission denied/i.test(error)) return "No key login yet. Use Set up: landfall asks for the password once and installs a key.";
  if (/resolve|not known|nodename/i.test(error)) return "Host name not found. Check the entry in ~/.ssh/config.";
  if (/timed out|refused|no route|unreachable/i.test(error)) return "Server not reachable. Is it running, and is the ssh port right?";
  return "";
}

/** Something of a site an SSH tunnel reaches: lf <argv> opens it. priv: its private port, if that is what it opens; path: where. */
export interface Way {
  svc: string;
  label: string;
  argv: string[];
  ports: number[];
  domains: string[];
  status: string;
  priv?: number;
  path?: string;
}

/**
 * What tunnels reach on a site: each service, and each private port under its own name (lf tunnel blog admin).
 * With one service the site's name alone opens it.
 */
export function tunnelWays(n: string, site: SiteStatus): Way[] {
  const { meta: m, services, main } = site;
  const cur = m.releases.find((r) => r.id === m.current);
  const many = services.length > 1;
  return services.flatMap((x) => {
    const rel = cur?.services.find((r) => r.name === x.service);
    const routes = rel?.routes ?? [];
    const priv = Object.entries(rel?.private ?? {});
    const domains = [
      ...(x.service === main ? m.domains : (rel?.domains ?? [])),
      ...routes.flatMap((r) => r.domains ?? m.domains.map((d) => `${r.subdomain}.${d}`)),
    ];
    const ports = [...new Set([rel?.port, ...routes.map((r) => r.port), ...priv.map(([, p]) => p)].filter((p): p is number => !!p))];
    // Its tunnel opens its routed port, else a private one named like it, else its first private one.
    const key = rel?.port ? undefined : rel?.private?.[x.service] !== undefined ? x.service : priv[0]?.[0];
    const own: Way = {
      svc: x.service,
      label: x.service,
      argv: ["tunnel", m.name, ...(many ? [x.service] : []), ...sv(n)],
      ports,
      domains,
      status: x.status,
      priv: key ? rel?.private?.[key] : undefined,
      path: key ? rel?.paths?.[key] : undefined,
    };
    const named = priv
      .filter(([k]) => k !== x.service)
      .map(([k, p]): Way => ({
        svc: x.service,
        label: k,
        argv: ["tunnel", m.name, k, ...sv(n)],
        ports: [p],
        domains: [],
        status: x.status,
        priv: p,
        path: rel?.paths?.[k],
      }));
    return [own, ...named];
  });
}
/** A container's dot from its docker status. */
const DOTS = { up: ["up", "running"], warn: ["warn", "not healthy"], done: ["", "finished"], down: ["down", "down"] };

export function StatusDot({ status }: { status: string }) {
  const [cls, word] = DOTS[statusKind(status)];
  return <Dot kind={cls} role="img" aria-label={word} title={status} />;
}

export const REACH_WORD = { ok: "reachable", login: "login refused", down: "unreachable" } as const;
export const REACH_KIND = { ok: "up", login: "warn", down: "down" } as const;
/** Reachable first, then refused, then down, then not checked. */
export const reachRank = (n: string) => ({ ok: 0, login: 1, down: 2 })[S.reach[n]?.state as "ok"] ?? 3;
export function reachCount(list: ServerEntry[]) {
  const count = { ok: 0, login: 0, down: 0 };
  for (const s of list) if (S.reach[s.name]) count[S.reach[s.name].state as keyof typeof count]++;
  return count;
}
/** A faint 0, for an empty count cell. */
export const Zero = () => <span className="faint">0</span>;
export const Star = () => (
  <span className="text-warn" title="default server">
    <StarIcon className="inline-block size-3 -mt-0.5 align-middle fill-current" aria-label="default server" />
  </span>
);
/** Whether landfall's ssh login to n works, from /api/reach. */
export function ReachDot({ n, className }: { n: string; className?: string }) {
  const r = S.reach[n];
  if (!r) return <Dot className={className} role="img" aria-label="not checked yet" title={S.reaching ? "Checking…" : "Not checked yet"} />;
  const [cls, word] = [REACH_KIND[r.state as "ok"], REACH_WORD[r.state as "ok"]];
  const tip =
    r.state === "ok" ? `Key login works (${r.ms} ms)` : r.state === "login" ? `sshd answers but refuses the login: ${r.detail}` : `Unreachable: ${r.detail}`;
  return <Dot kind={cls} className={className} role="img" aria-label={word} title={tip} />;
}

/** The server's one-line summary under its name. */
export function FactsLine({ n }: { n: string }) {
  const f = S.facts[n]?.data;
  if (!f)
    return S.facts[n]?.error ? null : (
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1.5 h-[18.75px] items-center">
        {["w-28", "w-16", "w-24", "w-32", "w-20"].map((w) => (
          <Bone key={w} className={w} />
        ))}
      </div>
    );
  const disk = pct(f.disk.used, f.disk.total);
  const items = [
    <>
      <b className="text-fg font-medium">{f.os}</b> {f.arch}
    </>,
    f.cloud ? <span title={f.cloud.firewall ? `${f.cloud.firewall} in front` : undefined}>{f.cloud.name}</span> : "",
    <span title={`kernel ${f.kernel}`}>up {duration(f.uptime)}</span>,
    f.cpus ? `${f.cpus} CPU · load ${f.load.split(" ")[0]}` : "",
    f.mem.total ? `RAM ${size(f.mem.total - f.mem.available)} / ${size(f.mem.total)}` : "",
    f.disk.total ? (
      <span className={cx(disk > 85 && "text-warn")}>
        disk {disk}% of {size(f.disk.total)}
      </span>
    ) : (
      ""
    ),
    f.docker ? `docker ${f.docker}` : <span className="faint">no docker</span>,
    f.reboot ? <Badge kind="warn">reboot required</Badge> : "",
  ];
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-faint text-sm mt-1.5">
      {items.filter(Boolean).map((x, i) => (
        <span key={i}>{x}</span>
      ))}
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
      {sup.note}
      {f?.can && !f.can.docker ? `. Docker: ${f.why.docker}` : ""}
    </div>
  );
}

/** What the server can do (`lf server info --json` can); null until its facts are in, then everything shows. */
export const can = (n: string): Record<Cap, boolean> | null => S.facts[n]?.data?.can ?? null;
/** Server n's overview and facts are both in (or failed): until then its page shows placeholders, not a guess. */
export const connected = (n: string) => [S.overview[n], S.facts[n]].every((x) => x?.data || x?.error);
/** When each section is worth a tab: the same conditions the CLI checks before doing it. */
const SECTION_IF: Partial<Record<Tab, (k: Record<Cap, boolean>) => unknown>> = {
  sites: (k) => k.docker || k.setup,
  tunnels: (k) => k.docker,
  traffic: (k) => k.docker,
  traefik: (k) => k.docker,
  updates: (k) => k.packages || k.docker,
  firewall: (k) => k.firewall,
  users: (k) => k.users,
};
export const sections = (n: string) => {
  const k = can(n);
  return SECTIONS.filter(([t]) => !k || (SECTION_IF[t]?.(k) ?? true));
};
