import { S, plural, render, sv } from "../lib/store";
import type { Overview } from "../lib/types";
import { go } from "../lib/api";
import { TunnelBtn, openTunnels, tunnelFor } from "../lib/jobs";
import { ACTS, Badge, Btn, Card, CardHead, Empty, Lede, MONO, Scroll, cx } from "../ui/kit";
import { StatusDot, tunnelWays } from "./shared";

// ---- tunnels -------------------------------------------------------------------

/** One thing a tunnel opens. depth 1: a service or container of a block, 2: a service's named private port. */
interface Target {
  key: string;
  name: string;
  depth?: 1 | 2;
  status?: string;
  serves: string[];
  argv: string[] | null;
  why?: string;
  ports?: number[];
  mono?: boolean;
}
/** A site or Compose project and what of it a tunnel reaches; a block with no rows is one target itself. */
interface Block {
  head: Target;
  rows: Target[];
  summary?: string;
}
interface Section {
  title: string;
  lede?: string;
  blocks: Block[];
}

/** argv without -s <server>. */
const bare = (argv: string[]) => argv.filter((a, i, l) => a !== "-s" && l[i - 1] !== "-s");

function siteBlocks(n: string, o: Overview): Block[] {
  const blocks: Block[] = [];
  for (const x of o.sites) {
    const ways = tunnelWays(n, x);
    const name = x.meta.name;
    const head: Target = { key: name, name, status: x.status, serves: x.domains, argv: null };
    if (x.services.length <= 1 && ways.length <= 1) {
      blocks.push({ head: { ...head, argv: ["tunnel", name, ...sv(n)], ports: ways[0]?.ports }, rows: [] });
      continue;
    }
    // Each service, then the private ports it names (lf tunnel blog admin) under it.
    const rows = ways.map((w): Target => {
      const own = w.label === w.svc;
      return {
        key: `${name}/${w.label}`,
        name: w.label,
        depth: own ? 1 : 2,
        status: own ? w.status : undefined,
        serves: w.priv ? [`:${w.priv}${w.path ?? ""} private`] : w.domains,
        argv: w.argv,
        ports: w.ports,
        mono: !!w.priv,
      };
    });
    const priv = rows.filter((r) => r.depth === 2).length;
    blocks.push({ head, rows, summary: [plural(x.services.length, "service"), priv && plural(priv, "private port")].filter(Boolean).join(" · ") });
  }
  return blocks;
}

/** Running containers no domain routes to (databases, workers), by Compose project; "" holds those without one. */
function byProject(o: Overview) {
  const m = new Map<string, Overview["unrouted"]>();
  for (const x of o.unrouted ?? []) {
    const k = x.project && x.service ? x.project : "";
    m.set(k, [...(m.get(k) ?? []), x]);
  }
  return m;
}

/** Rows for a project's unrouted containers: lf tunnel <project> <service>. */
const looseRows = (n: string, p: string, list: Overview["unrouted"], short: boolean): Target[] =>
  list.map((x) => ({
    key: x.container,
    name: short ? x.service! : x.container,
    depth: 1,
    status: x.status,
    serves: [x.image],
    argv: ["tunnel", p, x.service!, ...sv(n)],
    ports: x.ports ?? [],
    mono: true,
  }));

/** Apps Traefik routes that landfall did not deploy, each with the databases and workers of its Compose project. */
function otherBlocks(n: string, o: Overview, loose: Map<string, Overview["unrouted"]>): Block[] {
  return o.others.map((e) => {
    const head: Target = { key: `e:${e.name}`, name: e.name, status: e.status, serves: e.domains, argv: ["tunnel", e.name, ...sv(n)] };
    const list = loose.get(e.name) ?? [];
    loose.delete(e.name);
    return { head, rows: looseRows(n, e.name, list, true), summary: list.length ? `+ ${plural(list.length, "container")}` : undefined };
  });
}

/** What is left: by Compose project, else alone; tunnels by project and service, else by container name. */
function looseBlocks(n: string, loose: Map<string, Overview["unrouted"]>): Block[] {
  const blocks: Block[] = [];
  for (const p of [...loose.keys()].filter(Boolean).sort()) {
    const list = loose.get(p)!;
    const rows = looseRows(n, p, list, list.length > 1);
    if (list.length === 1) blocks.push({ head: { ...rows[0], depth: undefined }, rows: [] });
    else blocks.push({ head: { key: `p:${p}`, name: p, serves: [], argv: null }, rows, summary: `Compose project · ${plural(list.length, "container")}` });
  }
  for (const x of loose.get("") ?? [])
    blocks.push({
      head: {
        key: x.container,
        name: x.container,
        status: x.status,
        serves: [x.image],
        argv: ["tunnel", x.container, ...sv(n)],
        ports: x.ports ?? [],
        mono: true,
      },
      rows: [],
    });
  return blocks;
}

/** Everything an SSH tunnel reaches on server n, and the tunnels open now. */
export function TunnelsView({ n, o }: { n: string; o: Overview }) {
  if (!o.ready && !o.others.length && !o.unrouted?.length)
    return (
      <Card>
        <Empty title="Nothing to tunnel to yet">
          <p className="my-[1em]">Set up the server and deploy a site first.</p>
        </Empty>
      </Card>
    );
  const open = openTunnels(n);
  const one = (head: Target): Block => ({ head, rows: [] });
  const loose = byProject(o);
  const others = otherBlocks(n, o, loose);
  const sections: Section[] = [
    { title: "Sites", blocks: siteBlocks(n, o) },
    {
      title: "Not landfall's",
      lede: "routed by Traefik, deployed some other way; with their databases and workers",
      blocks: others,
    },
    {
      title: "Other containers",
      lede: "no domain routes to them (databases, caches, workers): the tunnel goes to the port their image exposes",
      blocks: looseBlocks(n, loose),
    },
    {
      title: "Server",
      blocks: [
        one({
          key: "traefik",
          name: "Traefik dashboard",
          status: o.traefik,
          serves: o.dashboard.hosts,
          argv: o.dashboard.tunnel ? ["traefik", "dashboard", ...sv(n)] : null,
          why: "no tunnel yet: see Traefik",
        }),
      ],
    },
  ].filter((s) => s.blocks.length);
  // An open tunnel names what it reaches: the target whose command it extends (--lan, -p…), under its block.
  const nameOf = (argv: string[]) => {
    const job = bare(argv);
    let best: { name: string; len: number } | undefined;
    for (const b of sections.flatMap((s) => s.blocks))
      for (const t of [b.head, ...b.rows])
        if (t.argv && bare(t.argv).every((a, i) => job[i] === a) && t.argv.length > (best?.len ?? 0))
          best = { name: t === b.head ? t.name : `${b.head.name} · ${t.name}`, len: t.argv.length };
    return best?.name;
  };
  return (
    <>
      {open.length > 0 && (
        <Card>
          <Scroll>
            <CardHead>
              Open <Badge kind="ok">{open.length}</Badge>
            </CardHead>
            <table>
              <tbody>
                {open.map((j) => {
                  const name = nameOf(j.info.argv);
                  return (
                    <tr key={j.info.id}>
                      <td>
                        {name && <b className="block">{name}</b>}
                        <span className={cx(MONO, name ? "faint" : "font-bold")}>lf {bare(j.info.argv).join(" ")}</span>
                      </td>
                      <td className={ACTS}>
                        <TunnelBtn n={n} argv={j.info.argv} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Scroll>
        </Card>
      )}
      <Card>
        <CardHead>Tunnel to</CardHead>
        <Lede>
          An SSH tunnel forwards a port on this machine to a container on {n}: test a site on localhost with no domain, HTTPS or login. Nothing changes on the
          server, and closing the tunnel ends it.
        </Lede>
        {sections.map((s) => (
          <SectionTiles key={s.title} n={n} s={s} />
        ))}
      </Card>
    </>
  );
}

/** A section: its title, how many targets, what they are; then a tile per site, project or container. */
function SectionTiles({ n, s }: { n: string; s: Section }) {
  return (
    <section className="px-[18px] py-4 border-b border-line last:border-b-0">
      <h3 className="m-0 mb-2.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm font-semibold">
        {s.title} <span className="faint font-normal tabular-nums">{s.blocks.length}</span>
        {s.lede && <span className="faint font-normal">{s.lede}</span>}
      </h3>
      {/* Columns, not a grid: a tall tile (a project's many containers) leaves no holes beside it. */}
      <div className="columns-[340px] gap-2.5">
        {s.blocks.map((b) => (
          <Tile key={b.head.key} n={n} b={b} />
        ))}
      </div>
    </section>
  );
}

/** What opens a target: its tunnel button, else why there is none. */
const Opener = ({ n, t }: { n: string; t: Target }) =>
  t.argv ? (
    <TunnelBtn n={n} argv={t.argv} ports={t.ports} label="Tunnel" compact />
  ) : t.why ? (
    <span className="inline-flex items-center gap-1.5">
      <span className="faint text-sm">{t.why}</span>
      <Btn cls="sm" on={() => go(n, "traefik")}>
        Traefik
      </Btn>
    </span>
  ) : null;

/** What a target serves, in one line: its domains, a private port, an image. */
const Serves = ({ t, className }: { t: Target; className?: string }) =>
  t.serves.length ? (
    <span className={cx("faint text-sm truncate min-w-0", t.mono && MONO, className)} title={t.serves.join("\n")}>
      {t.serves.join(" · ")}
    </span>
  ) : null;

/** A site or project: its name and status, then a row per service and private port, each with its own tunnel. */
const FOLD = 5;

function Tile({ n, b }: { n: string; b: Block }) {
  const live = [b.head, ...b.rows].filter((t) => t.argv && tunnelFor(n, t.argv)).length;
  // Long lists (mailcow's 18 containers) show the first few; the rest unfold, remembered in S.open.
  const id = `tun:${n}/${b.head.key}`;
  const all = S.open.has(id) || b.rows.length <= FOLD;
  const rows = all ? b.rows : b.rows.slice(0, FOLD - 1);
  const toggle = () => (S.open.has(id) ? S.open.delete(id) : S.open.add(id), render());
  return (
    <div className={cx("break-inside-avoid mb-2.5 rounded-md border bg-bg/50 min-w-0", live ? "border-ok/50" : "border-line")}>
      <div className="flex items-center gap-2 px-3 py-2.5 min-w-0">
        {b.head.status && <StatusDot status={b.head.status} />}
        <div className="min-w-0 flex-1 flex flex-col">
          <span className="flex items-baseline gap-2 min-w-0">
            <b className="truncate">{b.head.name}</b>
            {b.summary && <span className="faint text-sm whitespace-nowrap">{b.summary}</span>}
          </span>
          <Serves t={b.head} />
        </div>
        {b.rows.length > 0 && live > 0 && <Badge kind="ok">{live} open</Badge>}
        <span className="shrink-0">
          <Opener n={n} t={b.head} />
        </span>
      </div>
      {b.rows.length > 0 && (
        <ul className="list-none m-0 p-0 border-t border-line">
          {rows.map((t) => (
            <li key={t.key} className={cx("flex items-center gap-2 py-1.5 pr-3 min-w-0 [&+&]:border-t [&+&]:border-line/60", t.depth === 2 ? "pl-9" : "pl-3")}>
              {t.status ? (
                <StatusDot status={t.status} />
              ) : (
                <span className="faint" aria-hidden="true">
                  ↳
                </span>
              )}
              <span className={cx("whitespace-nowrap", t.depth === 2 && MONO)}>{t.name}</span>
              <Serves t={t} className="flex-1" />
              <span className="shrink-0 ml-auto">
                <Opener n={n} t={t} />
              </span>
            </li>
          ))}
          {b.rows.length > FOLD && (
            <li className="border-t border-line/60">
              <button
                type="button"
                className="w-full border-0 rounded-none bg-transparent shadow-none px-3 py-1.5 text-left text-sm text-dim hover:text-fg hover:bg-hover"
                aria-expanded={all}
                onClick={toggle}
              >
                {all ? "Show fewer" : `Show ${b.rows.length - rows.length} more`}
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
