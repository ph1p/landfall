import { describe, expect, it } from "vitest";
import { infraGraph, NODE_H, STEP, type ServerInput } from "../../src/core/infra-graph";
import type { Overview, SiteStatus } from "../../src/core/remote";
import type { Remembered } from "../../src/core/projects";

const site = (name: string, o: Partial<SiteStatus> = {}): SiteStatus =>
  ({
    meta: { name, volumes: [] },
    status: "Up 2 hours",
    services: [{ service: "web", container: `${name}-web-1`, status: "Up 2 hours" }],
    domains: [],
    redirects: [],
    kind: "compose",
    ...o,
  }) as unknown as SiteStatus;

const overview = (o: Partial<Overview> = {}): Overview =>
  ({
    ready: true,
    traefik: "Up 3 days",
    proxy: "traefik",
    adopted: false,
    sites: [],
    others: [],
    dashboard: { hosts: [], tunnel: false },
    unrouted: [],
    redirects: { list: [] },
    owner: {},
    ...o,
  }) as unknown as Overview;

const web: ServerInput = {
  name: "web",
  target: "root@203.0.113.7",
  reach: "ok",
  overview: overview({
    sites: [
      site("blog", { domains: ["blog.example.com"], redirects: ["www.blog.example.com"], main: "web", meta: { name: "blog", volumes: ["data"] } as never }),
      site("worker", { status: "", services: [] }),
    ],
    others: [{ name: "grafana", domains: ["grafana.example.com"], status: "Up 1 day", containers: ["grafana"] } as never],
    unrouted: [{ container: "redis", status: "Up 1 day", image: "redis:7", ports: [6379] }],
    redirects: { list: [{ host: "old.example.com", to: "https://blog.example.com", permanent: true, path: false }] } as never,
  }),
};
const fresh: ServerInput = { name: "fresh", target: "admin@198.51.100.2", reach: "ok", overview: overview({ ready: false, traefik: "" }) };
const ids = (g: ReturnType<typeof infraGraph>) => g.nodes.map((n) => n.id);
const edge = (g: ReturnType<typeof infraGraph>, from: string, to: string) => g.edges.find((e) => e.from === from && e.to === to);

describe("infraGraph", () => {
  it("connects machine, server, Traefik, sites and their children", () => {
    const g = infraGraph([web], []);
    expect(edge(g, "machine", "server:web")).toMatchObject({ kind: "ssh", health: "up" });
    expect(edge(g, "server:web", "proxy:web")).toMatchObject({ kind: "proxy", health: "up" });
    expect(edge(g, "proxy:web", "site:web:blog")).toMatchObject({ kind: "route", health: "up" });
    // No domain: reachable through a tunnel only.
    expect(edge(g, "proxy:web", "site:web:worker")?.kind).toBe("tunnel");
    expect(edge(g, "site:web:blog", "service:web:blog:web")?.kind).toBe("runs");
    expect(edge(g, "site:web:blog", "volume:web:blog:data")?.kind).toBe("mount");
    expect(edge(g, "site:web:blog", "domain:web:blog.example.com")?.kind).toBe("serves");
    // A redirect host points at the site it redirects to.
    expect(edge(g, "domain:web:www.blog.example.com", "site:web:blog")?.kind).toBe("redirect");
    expect(edge(g, "proxy:web", "external:web:grafana")?.kind).toBe("route");
    expect(edge(g, "server:web", "container:web:redis")?.kind).toBe("tunnel");
    expect(edge(g, "proxy:web", "redirect:web:old.example.com")?.kind).toBe("redirect");
    expect(g.nodes.find((n) => n.id === "site:web:worker")?.health).toBe("down");
    // Every edge joins two nodes that exist.
    const all = new Set(ids(g));
    for (const e of g.edges) expect(all.has(e.from) && all.has(e.to), e.id).toBe(true);
  });

  it("offers what is missing as ghost nodes", () => {
    const g = infraGraph([web, fresh], []);
    expect(ids(g)).toContain("add:site:web");
    expect(ids(g)).toContain("add:domain:web:blog");
    expect(ids(g)).not.toContain("add:domain:web:worker");
    expect(ids(g)).toContain("add:server");
    const setup = g.nodes.find((n) => n.id === "add:setup:fresh");
    expect(setup).toMatchObject({ add: "setup", label: "Set up this server" });
    // Not set up: nothing to deploy to yet.
    expect(ids(g)).not.toContain("add:site:fresh");
  });

  it("leaves out the layers turned off", () => {
    const g = infraGraph([web], [], { containers: false, volumes: false, domains: false, others: false, add: false });
    const kinds = new Set(g.nodes.map((n) => n.kind));
    for (const k of ["service", "volume", "domain", "external", "container", "add"]) expect(kinds.has(k as never), k).toBe(false);
    expect(ids(g)).toContain("site:web:blog");
  });

  it("gives each server its own band, without overlapping nodes", () => {
    const g = infraGraph([web, fresh], []);
    const [a, b] = g.bands;
    expect(a.server).toBe("web");
    expect(b.y).toBeGreaterThan(a.y + a.h);
    const seen = new Set<string>();
    for (const n of g.nodes) {
      const k = `${n.x},${n.y}`;
      expect(seen.has(k), `${n.id} overlaps`).toBe(false);
      seen.add(k);
    }
    expect(g.height).toBeGreaterThanOrEqual(Math.max(...g.nodes.map((n) => n.y)) + NODE_H);
  });

  it("puts local projects beside the site they deploy", () => {
    const p = (name: string, server: string): Remembered => ({ path: `/home/me/${name}`, name, server, domains: [], kind: "compose", at: "" }) as Remembered;
    const g = infraGraph([web], [p("blog", "web"), p("gone", "web"), p("elsewhere", "nope")]);
    const blog = g.nodes.find((n) => n.id === "project:/home/me/blog")!;
    // Row 0 holds the machine: the first project sits as close below it as it can.
    expect(blog.y).toBe(Math.max(STEP, g.nodes.find((n) => n.id === "site:web:blog")!.y));
    expect(edge(g, "project:/home/me/blog", "site:web:blog")).toMatchObject({ kind: "deploys", health: "" });
    // Its site is gone: it points at its server, as a warning.
    expect(edge(g, "project:/home/me/gone", "server:web")).toMatchObject({ kind: "deploys", health: "warn" });
    // Its server is not registered: not drawn.
    expect(ids(g)).not.toContain("project:/home/me/elsewhere");
  });

  it("draws the containers of one Compose project as one node", () => {
    const mail = (container: string, status = "Up 1 day") => ({ container, status, image: "mailserver", ports: [], project: "mail" });
    const g = infraGraph([{ ...web, overview: overview({ unrouted: [mail("mail-smtp-1"), mail("mail-imap-1", "Exited (1) 2 hours ago")] }) }], []);
    expect(g.nodes.filter((n) => n.kind === "container")).toEqual([
      expect.objectContaining({ id: "container:web:mail", label: "mail", ref: "mail", sub: "2 containers · tunnel only", health: "down" }),
    ]);
  });

  it("folds a server to itself and its proxy, with a summary", () => {
    const g = infraGraph([web, fresh], [], { folded: ["web"] });
    expect(ids(g).filter((i) => i.includes(":web"))).toEqual(["server:web", "proxy:web"]);
    // The worker has no running container: the folded server shows it as down.
    expect(g.nodes.find((n) => n.id === "server:web")).toMatchObject({ health: "down", sub: expect.stringContaining("2 sites") });
    expect(ids(g)).toContain("add:setup:fresh");
  });

  it("draws a server it cannot read", () => {
    const g = infraGraph([{ name: "down", target: "x", reach: "down", error: "ssh: connect refused" }], []);
    expect(g.nodes.find((n) => n.id === "server:down")).toMatchObject({ health: "down", sub: "cannot read it" });
    expect(edge(g, "machine", "server:down")?.health).toBe("down");
  });
});
