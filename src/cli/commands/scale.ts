import { defineCommand, serverOpt } from "../cmd";
import { checkInt } from "../../core/config";
import { currentRelease, MAX_REPLICAS, MAX_WEIGHT, scaleView, splitGroups, type ScaleRow, type SiteMeta } from "../../core/compose";
import { changeSite, requireSite, setWeights } from "../../core/remote";
import { c, fail, info, ok, printJson, table, warn } from "../../core/term";
import { ms, pct } from "../../core/format";
import { parseSince, serviceTraffic, spanLabel, splitStats, type SiteServiceTraffic } from "../../core/traffic";
import { target } from "./sites";

/** The site name and the service=value pairs of `[site] [service=value...]`. */
function sitePairs(pos: string[], what: string) {
  const [n, ...rest] = pos.filter((p) => !p.includes("="));
  if (rest.length) fail(`${rest.join(" ")}: give ${what} as service=value, like web=3`);
  const pairs = pos
    .filter((p) => p.includes("="))
    .map((p) => {
      const i = p.indexOf("=");
      return { service: p.slice(0, i), value: p.slice(i + 1) };
    });
  return { n, pairs };
}

function services(meta: SiteMeta, site: string) {
  const r = currentRelease(meta);
  if (!r) fail(`${site} has no release yet: deploy it first`);
  return r!.services;
}

function printRows(site: string, rows: ScaleRow[], json?: boolean) {
  if (json) return printJson({ site, services: rows });
  const match = rows.some((r) => r.match);
  table([
    ["SERVICE", "REPLICAS", "FROM", "UPDATE", "WEIGHT", ...(match ? ["MATCH"] : [])].map((h) => c.dim(h)),
    ...rows.map((r) => [r.service, String(r.replicas), r.source, r.update, r.split ? String(r.weight) : c.dim("-"), ...(match ? [r.match ?? c.dim("-")] : [])]),
  ]);
}

/** 893 (9%): a count and its share. */
const share = (n: number, of: number) => `${n.toLocaleString("en-US")} ${c.dim(of ? `(${pct(n, of)}%)` : "")}`.trimEnd();

/** lf weight --stats: each split member's requests, errors and response times from Traefik's access log. */
async function printStats(name: string, meta: SiteMeta, secs: number, traffic: Promise<SiteServiceTraffic>, json?: boolean) {
  const t = await traffic;
  if (!t.proxy) fail(`no traefik on ${name} (lf traefik setup)`);
  const rows = splitStats(meta, t);
  if (json) return printJson({ site: meta.name, since: secs, format: t.format, services: rows });
  if (t.format === "common") return warn(`traefik on ${name} writes its access log as plain text: \`lf traefik setup\` switches it to JSON`);
  console.log(`${c.bold(meta.name)}${c.dim(` · last ${spanLabel(secs)}`)}`);
  for (const split of new Set(rows.map((r) => r.split))) {
    const group = rows.filter((r) => r.split === split);
    const total = group.reduce((a, r) => a + r.requests, 0);
    const weights = group.reduce((a, r) => a + r.weight, 0);
    const match = group.some((r) => r.match);
    table([
      ["SERVICE", "WEIGHT", "REQUESTS", ...(match ? ["MATCHED"] : []), "4XX", "5XX", "P50", "P95"].map((h) => c.dim(h)),
      ...group.map((r) => [
        r.service,
        share(r.weight, weights),
        share(r.requests, total),
        ...(match ? [r.match ? r.matched.toLocaleString("en-US") : c.dim("-")] : []),
        share(r.classes["4xx"], r.requests),
        share(r.classes["5xx"], r.requests),
        ...[r.p50, r.p95].map((v) => (r.requests ? ms(v) : c.dim("-"))),
      ]),
    ]);
  }
  if (t.format === "none") info(c.dim(`no requests in the last ${spanLabel(secs)} (or traefik has no access log: lf traefik setup)`));
}

export const scale = defineCommand({
  name: "scale",
  args: "[site] [service=count...]",
  summary: `Show or change how many containers each service of a site runs.

Traefik balances requests over a routed service's containers. The count goes
into the site's compose.override.yaml, over compose.yaml's deploy.replicas, and
stays for later deploys. service=default goes back to compose.yaml's count.
Undoable with lf undo.`,
  options: {
    server: serverOpt,
    json: { type: "boolean", desc: "machine-readable output (listing)" },
  },
  async run(pos, o) {
    const { n, pairs } = sitePairs(pos, "counts");
    const { site, server } = target(n, o.server);
    const { meta, proxy } = await requireSite(server, site, pairs.length ? { deployed: "scale" } : {});
    if (!pairs.length) return printRows(site, scaleView(meta), o.json);
    const all = services(meta, site);
    const next: Record<string, number | undefined> = {};
    for (const { service, value } of pairs) {
      const s = all.find((x) => x.name === service);
      if (!s) fail(`${site} has no service ${service}: ${all.map((x) => x.name).join(", ")}`);
      if (value === "default") {
        next[service] = undefined;
        continue;
      }
      const count = checkInt(value, `replicas of ${service}`, 0, MAX_REPLICAS);
      if (count > 1 && s!.named) fail(`${service} sets container_name, so it runs only once: remove container_name from compose.yaml first`);
      if (count > 1 && s!.published) fail(`${service} publishes ports on the server, so it runs only once: drop x-landfall.publish first`);
      next[service] = count;
    }
    const said = Object.entries(next).map(([k, v]) => `${k}=${v ?? "default"}`);
    await changeSite(server, site, proxy, `scale ${site} ${said.join(" ")}`, (m) => {
      const scale = { ...m.scale };
      for (const [k, v] of Object.entries(next)) {
        if (v === undefined) delete scale[k];
        else scale[k] = v;
      }
      if (Object.keys(scale).length) m.scale = scale;
      else delete m.scale;
    });
    ok(`scaled ${site}: ${said.join(", ")}`);
    if (Object.values(next).includes(0)) info(c.dim("a service at 0 runs no container: lf scale <site> <service>=1 starts it again"));
  },
});

export const weight = defineCommand({
  name: "weight",
  args: "[site] [service=weight...]",
  summary: `Show or change how a traffic split shares requests between its services.

A split is two or more services with x-landfall.weight on the same domains.
web=90 web-next=10 sends about one request in ten to web-next. Only Traefik's
file provider changes: no container restarts. Undoable with lf undo.
--stats compares the services: requests, errors and response times from
Traefik's access log.`,
  options: {
    server: serverOpt,
    stats: { type: "boolean", desc: "each service's requests, 4xx, 5xx, p50 and p95 from the access log" },
    since: { type: "string", desc: "how far back --stats looks: 30m, 24h, 7d", default: "24h" },
    json: { type: "boolean", desc: "machine-readable output (listing, --stats)" },
  },
  async run(pos, o) {
    const { n, pairs } = sitePairs(pos, "weights");
    const { site, server, name } = target(n, o.server);
    if (o.stats && pairs.length) fail("--stats only shows the split: change the weights in a separate lf weight");
    // --stats reads the access log while requireSite reads the site: two ssh round trips at once.
    const secs = o.stats ? parseSince(o.since) : 0;
    const traffic = o.stats ? serviceTraffic(server, site, secs) : undefined;
    traffic?.catch(() => {});
    const { meta } = await requireSite(server, site, pairs.length ? { deployed: "change the traffic split of" } : {});
    const groups = splitGroups(meta, services(meta, site));
    if (!groups.length) fail(`${site} splits no traffic: give two services on the same domains an x-landfall.weight in compose.yaml`);
    if (traffic) return printStats(name, meta, secs, traffic, o.json);
    if (!pairs.length)
      return printRows(
        site,
        scaleView(meta).filter((r) => r.split),
        o.json,
      );
    const next: Record<string, number> = {};
    for (const { service, value } of pairs) {
      if (!groups.some((g) => g.members.some((m) => m.service.name === service)))
        fail(`${service} is in no traffic split of ${site}: ${groups.flatMap((g) => g.members.map((m) => m.service.name)).join(", ")} are`);
      next[service] = checkInt(value, `weight of ${service}`, 0, MAX_WEIGHT);
    }
    const weights = { ...meta.weights, ...next };
    for (const g of groups)
      if (g.members.every((m) => (weights[m.service.name] ?? m.weight) === 0))
        fail(`${g.members.map((m) => m.service.name).join(", ")} would all get weight 0: one must take the traffic`);
    const said = Object.entries(next).map(([k, v]) => `${k}=${v}`);
    await setWeights(server, site, next, `weight ${site} ${said.join(" ")}`);
    ok(`traffic split of ${site}: ${said.join(", ")}`);
  },
});
