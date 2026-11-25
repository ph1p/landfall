// The infrastructure map: every server, its Traefik, sites, containers, volumes and domains, as nodes and edges
// laid out in columns. No node imports: the web page builds it from the overviews it already reads.
import type { Overview, Unrouted } from "../site/remote";
import type { Remembered } from "../deploy/projects";
import { statusKind, worse, type StatusKind } from "../site/status";

export type NodeKind = "machine" | "project" | "server" | "proxy" | "site" | "external" | "container" | "service" | "volume" | "domain" | "redirect" | "add";
/** What a node shows as its dot: grey when nothing is known. */
export type Health = "up" | "warn" | "down" | "";
/** What a ghost node offers to add. */
export type AddAction = "server" | "setup" | "site" | "domain";

export interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  sub?: string;
  health: Health;
  x: number;
  y: number;
  /** The server it belongs to, and the site, service or domain it names. */
  server?: string;
  site?: string;
  ref?: string;
  add?: AddAction;
}
export type EdgeKind = "ssh" | "proxy" | "route" | "runs" | "mount" | "serves" | "redirect" | "deploys" | "tunnel";
export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  health: Health;
}
export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  width: number;
  height: number;
  /** Each server's box (header included): where a dropped project deploys to. */
  bands: { server: string; y: number; h: number }[];
}

export interface ServerInput {
  name: string;
  target: string;
  isDefault?: boolean;
  /** Whether landfall's ssh login works; undefined until checked. */
  reach?: "ok" | "login" | "down";
  overview?: Overview;
  error?: string;
  /** Shown under its name in place of the address: "checking…", "reading…". */
  note?: string;
}
export interface GraphOptions {
  containers?: boolean;
  volumes?: boolean;
  domains?: boolean;
  /** Containers Traefik does not route, and Compose projects landfall did not deploy. */
  others?: boolean;
  /** Ghost nodes that add a server, a site or a domain. */
  add?: boolean;
  /** Servers drawn folded: the server and its proxy only, with a count of what runs there. */
  folded?: string[];
}

// Layout: a column per layer, a box per server that holds what runs on it; a site's block is as tall as its tallest
// child column. The server node is the box itself: its header row sits at the box's top.
export const NODE_W = 216;
export const NODE_H = 50;
export const STEP = 62;
const BAND_GAP = 28;
const COL = { machine: 0, proxy: 300, site: 556, child: 812, domain: 1068 };
/** A server's box: where it starts, how wide it is, its header and the room below its last row. */
export const BOX = { x: 268, w: COL.domain + NODE_W + 24 - 268, head: 46, foot: 14 };
export const GRAPH_COLUMNS: [keyof typeof COL, string][] = [
  ["machine", "This machine"],
  ["proxy", "Proxy"],
  ["site", "Sites and apps"],
  ["child", "Containers and volumes"],
  ["domain", "Domains"],
];
export const columnX = (c: keyof typeof COL) => COL[c];

const HEALTH: Record<StatusKind, Health> = { up: "up", done: "", warn: "warn", down: "down" };
export const healthOf = (status: string): Health => (status ? HEALTH[statusKind(status)] : "down");
/** The worst of a group's statuses. */
const worst = (statuses: string[]): Health => (statuses.length ? HEALTH[statusKind(statuses.reduce((a, b) => (worse(b, a) ? b : a)))] : "");
const ORDER: Health[] = ["", "up", "warn", "down"];
const worstOf = (hs: Health[]): Health => hs.reduce((a, b) => (ORDER.indexOf(b) > ORDER.indexOf(a) ? b : a), "" as Health);
/** What a folded server stands for: "4 sites · 1 down · 9 domains". */
function foldedSummary(ov: Overview): string {
  const down = ov.sites.filter((x) => !x.status || healthOf(x.status) === "down").length;
  const domains = ov.sites.reduce((n, x) => n + x.domains.length, 0) + ov.others.reduce((n, x) => n + x.domains.length, 0);
  const n = (k: number, one: string) => `${k} ${one}${k === 1 ? "" : "s"}`;
  return [n(ov.sites.length, "site"), down ? `${down} down` : "", ov.others.length ? `${ov.others.length} other` : "", n(domains, "domain")]
    .filter(Boolean)
    .join(" · ");
}
const REACH: Record<string, Health> = { ok: "up", login: "warn", down: "down" };

export function infraGraph(servers: ServerInput[], projects: Remembered[], o: GraphOptions = {}): Graph {
  const opt = { containers: true, volumes: true, domains: true, others: true, add: true, folded: [] as string[], ...o };
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const bands: Graph["bands"] = [];
  const node = (n: Omit<GraphNode, "health"> & { health?: Health }) => (nodes.push({ health: "", ...n }), n.id);
  const edge = (from: string, to: string, kind: EdgeKind, health: Health = "") => edges.push({ id: `${kind}:${from}>${to}`, from, to, kind, health });

  const machine = node({ id: "machine", kind: "machine", label: "This machine", sub: "lf, ssh keys, projects", x: COL.machine, y: 0 });
  let y = 0;
  for (const s of servers) {
    const top = y;
    const sid = `server:${s.name}`;
    const ov = s.overview;
    const folded = opt.folded.includes(s.name);
    // Rows in the sites column; each site's block may span more rows for its children and domains.
    let row = 0;
    const at = (r: number) => top + BOX.head + r * STEP;
    const front = ov?.traefik ? `proxy:${s.name}` : sid;
    const block = (rows: number) => ((row += Math.max(1, rows)), row - Math.max(1, rows));
    const domains = (owner: string, list: string[], redirects: string[], r: number, health: Health) => {
      if (!opt.domains) return;
      list.forEach((d, i) =>
        edge(owner, node({ id: `domain:${s.name}:${d}`, kind: "domain", label: d, server: s.name, ref: d, health, x: COL.domain, y: at(r + i) }), "serves"),
      );
      redirects.forEach((d, i) =>
        edge(
          node({ id: `domain:${s.name}:${d}`, kind: "domain", label: d, sub: "redirect", server: s.name, ref: d, x: COL.domain, y: at(r + list.length + i) }),
          owner,
          "redirect",
        ),
      );
    };
    if (ov && !folded) {
      for (const site of ov.sites) {
        const m = site.meta;
        const vols = opt.volumes ? (m.volumes ?? []) : [];
        const svcs = opt.containers ? site.services : [];
        const doms = opt.domains ? site.domains.length + site.redirects.length + (opt.add && site.main ? 1 : 0) : 0;
        const r = block(Math.max(svcs.length + vols.length, doms));
        const id = node({
          id: `site:${s.name}:${m.name}`,
          kind: "site",
          label: m.name,
          sub: [site.kind, m.adopted ? "adopted" : "", site.status || "not running"].filter(Boolean).join(" · "),
          health: site.status ? worst(site.services.map((x) => x.status)) || healthOf(site.status) : "down",
          server: s.name,
          site: m.name,
          x: COL.site,
          y: at(r),
        });
        edge(front, id, site.domains.length ? "route" : "tunnel", site.domains.length ? healthOf(site.status) : "");
        svcs.forEach((x, i) =>
          edge(
            id,
            node({
              id: `service:${s.name}:${m.name}:${x.service}`,
              kind: "service",
              label: x.service,
              sub: x.status,
              health: healthOf(x.status),
              server: s.name,
              site: m.name,
              ref: x.service,
              x: COL.child,
              y: at(r + i),
            }),
            "runs",
            healthOf(x.status),
          ),
        );
        vols.forEach((v, i) =>
          edge(
            id,
            node({
              id: `volume:${s.name}:${m.name}:${v}`,
              kind: "volume",
              label: v,
              sub: "volume",
              server: s.name,
              site: m.name,
              ref: v,
              x: COL.child,
              y: at(r + svcs.length + i),
            }),
            "mount",
          ),
        );
        domains(id, site.domains, site.redirects, r, healthOf(site.status));
        if (opt.add && opt.domains && site.main) {
          const d = site.domains.length + site.redirects.length;
          edge(
            id,
            node({
              id: `add:domain:${s.name}:${m.name}`,
              kind: "add",
              add: "domain",
              label: "Add a domain",
              server: s.name,
              site: m.name,
              x: COL.domain,
              y: at(r + d),
            }),
            "serves",
          );
        }
      }
      if (opt.others) {
        for (const e of ov.others) {
          const r = block(opt.domains ? e.domains.length : 1);
          const id = node({
            id: `external:${s.name}:${e.name}`,
            kind: "external",
            label: e.name,
            sub: `not landfall's · ${e.status}`,
            health: healthOf(e.status),
            server: s.name,
            ref: e.name,
            x: COL.site,
            y: at(r),
          });
          edge(front, id, "route", healthOf(e.status));
          domains(id, e.domains, [], r, healthOf(e.status));
        }
        // Containers of one Compose project (a mail server's dozen) are one node; a lone container is itself.
        const groups = new Map<string, Unrouted[]>();
        for (const c of ov.unrouted) {
          const k = c.project ?? `\0${c.container}`;
          groups.set(k, [...(groups.get(k) ?? []), c]);
        }
        for (const [k, list] of groups) {
          const r = block(1);
          const c = list[0];
          const one = list.length === 1;
          const sub = one ? [c.image, c.ports.length ? `:${c.ports.join(", :")}` : ""].filter(Boolean).join(" ") : `${list.length} containers · tunnel only`;
          const ref = one ? c.container : k;
          edge(
            sid,
            node({
              id: `container:${s.name}:${ref}`,
              kind: "container",
              label: one ? c.container : k,
              sub,
              health: worst(list.map((x) => x.status)),
              server: s.name,
              ref,
              x: COL.site,
              y: at(r),
            }),
            "tunnel",
            worst(list.map((x) => x.status)),
          );
        }
      }
      for (const red of ov.redirects.list) {
        const r = block(1);
        edge(
          front,
          node({
            id: `redirect:${s.name}:${red.host}`,
            kind: "redirect",
            label: red.host,
            sub: `→ ${red.to}`,
            server: s.name,
            ref: red.host,
            x: COL.site,
            y: at(r),
          }),
          "redirect",
        );
      }
      if (opt.add && ov.ready) {
        const r = block(1);
        edge(front, node({ id: `add:site:${s.name}`, kind: "add", add: "site", label: "Deploy a site", server: s.name, x: COL.site, y: at(r) }), "route");
      }
    }
    const rows = Math.max(row, 1);
    // The server is its box; the proxy sits in the first row, beside the first site.
    node({
      id: sid,
      kind: "server",
      label: s.name,
      sub: s.error ? "cannot read it" : folded && ov ? foldedSummary(ov) : (s.note ?? s.target),
      health: s.error
        ? "down"
        : folded && ov
          ? worstOf([REACH[s.reach ?? ""] ?? "", ...ov.sites.map((x) => (x.status ? healthOf(x.status) : "down"))])
          : (REACH[s.reach ?? ""] ?? ""),
      server: s.name,
      x: BOX.x,
      y: top,
    });
    edge(machine, sid, "ssh", REACH[s.reach ?? ""] ?? "");
    if (ov?.traefik) {
      const h = healthOf(ov.traefik);
      node({
        id: front,
        kind: "proxy",
        label: ov.proxy,
        sub: `Traefik${ov.adopted ? " (yours)" : ""} · ${ov.traefik}`,
        health: h,
        server: s.name,
        x: COL.proxy,
        y: at(0),
      });
      edge(sid, front, "proxy", h);
    } else if (ov && opt.add) {
      // Not set up, or set up without Traefik: the next step is setup.
      const id = node({
        id: `add:setup:${s.name}`,
        kind: "add",
        add: "setup",
        label: ov.ready ? "Install Traefik" : "Set up this server",
        sub: ov.ready ? "lf setup" : "Docker, Traefik, firewall",
        server: s.name,
        x: COL.proxy,
        y: at(0),
      });
      edge(sid, id, "proxy");
    }
    // A server it could not read is its header alone.
    const h = ov ? BOX.head + rows * STEP - (STEP - NODE_H) + BOX.foot : BOX.head - 8;
    bands.push({ server: s.name, y: top, h });
    y = top + h + BAND_GAP;
  }
  if (opt.add) {
    const id = node({ id: "add:server", kind: "add", add: "server", label: "Add a server", sub: "ssh alias or new machine", x: BOX.x, y });
    edge(machine, id, "ssh");
    y += STEP;
  }

  // Local projects sit beside the site they deploy, below the machine; one that lost its site points at its server.
  const at = new Map(nodes.map((n) => [n.id, n]));
  let next = STEP;
  const placed = projects
    .map((p) => ({ p, to: at.get(`site:${p.server}:${p.name}`) ?? at.get(`server:${p.server}`) }))
    .filter((x) => x.to)
    .sort((a, b) => a.to!.y - b.to!.y);
  for (const { p, to } of placed) {
    const py = Math.max(next, to!.y);
    next = py + STEP;
    const id = node({
      id: `project:${p.path}`,
      kind: "project",
      label: p.name,
      sub: p.path,
      server: p.server,
      site: p.name,
      ref: p.path,
      x: COL.machine,
      y: py,
    });
    edge(id, to!.id, "deploys", to!.kind === "site" ? "" : "warn");
  }
  const height = Math.max(y, next, NODE_H);
  return { nodes, edges, width: BOX.x + BOX.w, height, bands };
}
