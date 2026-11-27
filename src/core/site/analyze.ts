import { DOMAIN } from "../lib/config";
import { MAX_WEIGHT } from "./limits";
import type { Service } from "./meta";
import { hostsKey, isMain, routed, splitGroups, splitSets } from "./routing";
import { posInt, readAllow, readDomains, readMatch, readOpts, readPrivate, readRoutes, toPort, X_KEYS } from "./x-landfall";

/** "8080/tcp 53/udp 80" (docker's ExposedPorts keys): the TCP ports, lowest first. */
export const exposedPorts = (text: string) =>
  [
    ...new Set(
      text
        .split(/\s+/)
        .flatMap((p) => /^(\d+)(\/tcp)?$/.exec(p)?.[1] ?? [])
        .map(Number),
    ),
  ].sort((a, b) => a - b);

/** Hosts in a Traefik rule: Host(`a`) || Host(`b`, `c`). HostRegexp and HostSNI are not hosts. */
export const ruleHosts = (rule: string) =>
  [...rule.matchAll(/\bHost\(([^)]*)\)/g)].flatMap((m) => [...m[1].matchAll(/[`"]([^`"]+)[`"]/g)].map((h) => h[1].toLowerCase()));

export const ROUTER_RULE = /^traefik\.http\.routers\.[^.]+\.rule$/;
export const SERVICE_PORT = /^traefik\.http\.services\.[^.]+\.loadbalancer\.server\.port$/;

export interface Analysis {
  services: Service[];
  errors: string[];
  warnings: string[];
  /** No x-landfall anywhere: routed by what it publishes and exposes. */
  auto?: boolean;
  /** What auto mode did that the route plan does not show. */
  notes: string[];
}

/** Ports that speak something other than HTTP (and 443: TLS inside the container): a plain compose.yaml's database stays off Traefik. */
const NOT_HTTP = new Set([
  22, 25, 53, 110, 143, 389, 443, 465, 587, 636, 993, 995, 1025, 1433, 1521, 1883, 2181, 2525, 3306, 3389, 4222, 4369, 5432, 5672, 5900, 6379, 6380, 7687, 8883,
  9042, 9092, 11211, 25672, 26257, 27017,
]);
/** Where web servers usually listen: picks the main service when several or none are built here. */
export const WEB_PORTS = new Set([80, 3000, 4000, 5000, 8000, 8080, 8888]);
/** Images of tools that sit next to an app (database UIs, mail catchers): never the site itself when something else could be. */
const SIDE_TOOLS =
  /(^|\/)(adminer|phpmyadmin|pgadmin4?|mailhog|mailpit|maildev|redis-commander|redisinsight|mongo-express|portainer|dozzle|kafka-ui|swagger-ui)(:|@|$)/;

/** A service name as a DNS label. */
const label = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63) || "service";
const hasRouter = (labels: Record<string, string>) => Object.keys(labels).some((k) => ROUTER_RULE.test(k));
const labelsOf = (svc: any): Record<string, string> =>
  Array.isArray(svc?.labels)
    ? Object.fromEntries(
        svc.labels.map((l: string) => {
          const i = l.indexOf("=");
          return i < 0 ? [l, ""] : [l.slice(0, i), l.slice(i + 1)];
        }),
      )
    : (svc?.labels ?? {});

/** The TCP ports a service publishes or exposes, in order; ranges left out. */
function servicePorts(svc: any): number[] {
  const published = (svc.ports ?? []).filter((p: any) => (p?.protocol ?? "tcp") === "tcp").map((p: any) => p?.target);
  const exposed = (svc.expose ?? [])
    .map(String)
    .filter((e: string) => !e.endsWith("/udp"))
    .map((e: string) => e.replace(/\/tcp$/, ""));
  return [...new Set([...published, ...exposed].map(toPort).filter((n): n is number => n !== undefined))];
}

/** A compose.yaml with no x-landfall and no traefik labels: true when landfall routes it by its ports. */
export const isPlain = (config: any) =>
  Object.values<any>(config?.services ?? {}).every((svc) => svc?.["x-landfall"] === undefined && !hasRouter(labelsOf(svc)));

/**
 * Route a plain compose.yaml: the built service (else one on a usual web port) gets the site's domains with
 * its first HTTP port; every other HTTP port a subdomain, <service> or <service>-<port>. Picked by name, not
 * file order: `docker compose config` sorts services.
 */
function autoRoute(config: any, services: Service[], notes: string[]) {
  const raw = config.services;
  const found = services
    .filter((s) => !raw[s.name].network_mode)
    .map((s) => ({ s, ports: servicePorts(raw[s.name]).filter((p) => !NOT_HTTP.has(p)) }))
    .filter((f) => f.ports.length)
    .sort((a, b) => a.s.name.localeCompare(b.s.name));
  const score = (f: (typeof found)[number]) => (f.s.build ? 4 : 0) + (SIDE_TOOLS.test(raw[f.s.name].image ?? "") ? 0 : 2) + (WEB_PORTS.has(f.ports[0]) ? 1 : 0);
  const main = found.reduce<(typeof found)[number] | undefined>((best, f) => (!best || score(f) > score(best) ? f : best), undefined);
  const tied = found.filter((f) => f !== main && main && score(f) === score(main));
  if (main && tied.length)
    notes.push(
      `${main.s.name} serves the site's domains (first by name of ${[main, ...tied].map((f) => f.s.name).join(", ")}): \`lf init\` writes the routes down to change that`,
    );
  for (const f of found) {
    const isMainOne = f === main;
    if (isMainOne) f.s.port = f.ports[0];
    const routes = (isMainOne ? f.ports.slice(1) : f.ports).map((port, i) => ({
      port,
      subdomain: isMainOne || i > 0 ? `${label(f.s.name)}-${port}` : label(f.s.name),
    }));
    if (routes.length) f.s.routes = routes;
  }
  for (const s of services) {
    const svc = raw[s.name];
    if (!svc.ports?.length || svc.network_mode) continue;
    s.unpublish = true;
    const routedPorts = new Set([s.port, ...(s.routes ?? []).map((r) => r.port)]);
    const kept = (svc.ports as any[]).map((p) => toPort(p?.target)).filter((p) => p !== undefined && !routedPorts.has(p));
    if (kept.length)
      notes.push(
        `${s.name}: ${[...new Set(kept)].join(", ")} not published on the server (not HTTP): reach it with lf tunnel <site> ${s.name} --port ${kept[0]}`,
      );
  }
}

/**
 * Check a release's `docker compose config` (YAML: its JSON drops x-* fields) and read its routing from x-landfall.
 * `dir` is the release folder on the server: writable bind mounts below it would stay behind
 * with the release, so data written there seems to vanish on the next deploy.
 * With `auto` (a compose site), a file without any x-landfall is routed by its ports instead.
 */
export function analyze(config: any, dir: string, expand: (d: string) => string = (d) => d, o: { auto?: boolean; tenant?: boolean } = {}): Analysis {
  const services: Service[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];
  const auto = !!o.auto && isPlain(config);
  for (const [name, svc] of Object.entries<any>(config?.services ?? {})) {
    const x = svc["x-landfall"] ?? {};
    const labels = labelsOf(svc);
    const s: Service = { name, networks: svc.network_mode ? [] : Object.keys(svc.networks ?? { default: null }) };
    if (svc.build) s.build = true;
    const rules = Object.entries(labels).filter(([k]) => ROUTER_RULE.test(k));
    if (typeof x !== "object" || Array.isArray(x)) errors.push(`${name}: x-landfall must be a mapping, like x-landfall: { port: 3000 }`);
    else if (rules.length) {
      s.own = true;
      s.domains = [...new Set(rules.flatMap(([, v]) => ruleHosts(v)))];
      if (Object.keys(x).some((k) => k !== "publish")) warnings.push(`${name} has its own traefik router labels: its x-landfall routing is ignored`);
    } else if (svc["x-landfall"] !== undefined) {
      const unknown = Object.keys(x).filter((k) => !X_KEYS.includes(k));
      if (unknown.length) warnings.push(`${name}: x-landfall knows ${X_KEYS.slice(0, -1).join(", ")} and ${X_KEYS.at(-1)}, not ${unknown.join(", ")}`);
      const routes = readRoutes(name, x.routes, expand, errors);
      const priv = readPrivate(name, x.private, errors);
      const expose: string[] = (svc.expose ?? []).map(String);
      // A lone expose: is the port, unless routes or private ports say there are several.
      const port = x.port ?? (expose.length === 1 && x.routes === undefined && x.private === undefined ? expose[0].replace(/\/tcp$/, "") : undefined);
      const n = toPort(port);
      if (n !== undefined) s.port = n;
      else if (x.port !== undefined) errors.push(`${name}: x-landfall.port must be a port number, got ${JSON.stringify(x.port)}`);
      else if (x.domains || (!x.publish && !routes.length && !priv))
        errors.push(`${name}: x-landfall needs the port Traefik should send requests to, like x-landfall: { port: 3000 }`);
      if (x.domains !== undefined) {
        const ds = readDomains(x.domains, expand);
        const bad = ds.filter((d) => !DOMAIN.test(d));
        if (bad.length) errors.push(`${name}: not a domain in x-landfall.domains: ${bad.join(", ")}`);
        if (!ds.length) errors.push(`${name}: x-landfall.domains is empty; leave it out to serve the site's domains`);
        s.domains = ds;
      }
      if (routes.length) s.routes = routes;
      const allow = readAllow(`${name}: x-landfall`, x.allow, errors);
      if (allow && s.port === undefined) errors.push(`${name}: x-landfall.allow guards x-landfall.port, which it has none of; put allow on its routes`);
      else if (allow) s.allow = allow;
      const opts = readOpts(`${name}: x-landfall`, x, errors);
      if (opts && s.port === undefined)
        errors.push(`${name}: x-landfall's ${Object.keys(opts).join(", ")} apply to x-landfall.port, which it has none of; put them on its routes`);
      else if (opts) s.opts = opts;
      if (x.weight !== undefined) {
        const w = posInt(x.weight, 0);
        if (w === undefined || w > MAX_WEIGHT) errors.push(`${name}: x-landfall.weight is its share of the traffic, 0 to ${MAX_WEIGHT}`);
        else if (s.port === undefined) errors.push(`${name}: x-landfall.weight splits the traffic to x-landfall.port, which it has none of`);
        else s.weight = w;
      }
      if (x.match !== undefined) {
        const m = readMatch(`${name}: x-landfall`, x.match, errors);
        if (m) {
          if (x.weight === undefined)
            errors.push(`${name}: x-landfall.match picks this service out of a traffic split, so it needs x-landfall.weight too (0: only matching requests)`);
          else s.match = m;
        }
      }
      if (x.update !== undefined && x.update !== "recreate") {
        if (x.update === "rolling") s.update = "rolling";
        else errors.push(`${name}: x-landfall.update is rolling or recreate, not ${JSON.stringify(x.update)}`);
      }
      if (x.publish) s.published = true;
      if (priv && Object.keys(priv.ports).length) s.private = priv.ports;
      if (priv && Object.keys(priv.paths).length) s.paths = priv.paths;
      const ports = [s.port, ...routes.map((r) => r.port)].filter((p) => p !== undefined);
      const twice = ports.filter((p, i) => ports.indexOf(p) !== i);
      if (twice.length) errors.push(`${name}: port ${twice.join(", ")} is routed twice`);
      const both = Object.entries(priv?.ports ?? {}).filter(([, p]) => ports.includes(p));
      if (both.length) errors.push(`${name}: ${both.map(([k, p]) => `${p} (${k})`).join(", ")} is both routed and private`);
    }
    if (svc.network_mode) {
      if (routed(s)) errors.push(`${name}: a routed service cannot use network_mode: ${svc.network_mode}; Traefik reaches it over a network`);
      else if (svc.network_mode === "host")
        warnings.push(
          o.tenant
            ? `${name} uses network_mode: host: in your rootless Docker that is your own network namespace, not the server's`
            : `${name} uses network_mode: host: it binds ports on the server itself`,
        );
    }
    if (o.tenant && svc.privileged) warnings.push(`${name} is privileged: in your rootless Docker that is your user's rights, not root's`);
    if (o.tenant && x.publish && svc.ports?.length) {
      const low = svc.ports.filter((p: any) => Number(p.published) > 0 && Number(p.published) < 1024).map((p: any) => p.published);
      if (low.length) warnings.push(`${name} publishes port ${low.join(", ")}: rootless Docker cannot bind ports below 1024`);
      warnings.push(`${name} publishes ports: the server's firewall keeps tenants' ports closed to the outside`);
    }
    if (svc.ports?.length && !x.publish && !auto) {
      const ports = svc.ports.map((p: any) => (p.published ? `${p.host_ip ? p.host_ip + ":" : ""}${p.published}:${p.target}` : String(p.target)));
      errors.push(
        `${name} publishes ${ports.join(", ")} on the server, past Traefik and the firewall. Move ports: to compose.override.yaml (local only)` +
          `${routed(s) ? "" : ` and route it with x-landfall: { port: ${svc.ports[0].target} }`}, or allow it with x-landfall: { publish: true }`,
      );
    }
    for (const v of svc.volumes ?? []) {
      const src = String(v.source ?? "");
      if (v.type === "bind" && !v.read_only && (src === dir || src.startsWith(dir + "/"))) {
        const rel = src === dir ? "." : "./" + src.slice(dir.length + 1);
        errors.push(
          `${name} writes to ${rel}, which stays behind in the release on the next deploy: use a named volume (e.g. ${name}-data:${v.target}), or mount it read-only (:ro)`,
        );
      }
    }
    if (svc.container_name) {
      s.named = true;
      warnings.push(`${name} sets container_name ${svc.container_name}: names are global on the server, leave it out unless something needs it`);
    }
    const replicas = svc.deploy?.replicas ?? svc.scale;
    if (replicas !== undefined && replicas !== null) {
      const n = posInt(replicas, 0);
      if (n === undefined) errors.push(`${name}: replicas must be a whole number, got ${JSON.stringify(replicas)}`);
      else if (n !== 1) s.replicas = n;
      if (svc.scale !== undefined && svc.deploy?.replicas === undefined) s.scaleKey = true;
    }
    if (svc.healthcheck && !svc.healthcheck.disable) s.healthcheck = true;
    const many = (s.replicas ?? 1) > 1;
    if (many && s.named) errors.push(`${name} runs ${s.replicas} containers but sets container_name: names are unique, leave it out`);
    if (many && svc.ports?.some((p: any) => p?.published))
      errors.push(`${name} runs ${s.replicas} containers but publishes ports on the server: only one can bind a port`);
    if (s.update === "rolling") {
      const why = !s.port
        ? "it has no x-landfall.port"
        : s.own
          ? "it has its own traefik labels"
          : s.named
            ? "it sets container_name"
            : s.published
              ? "it publishes ports"
              : "";
      if (why) errors.push(`${name}: x-landfall.update: rolling needs a second container beside the first, and ${why}`);
    }
    services.push(s);
  }
  if (auto) autoRoute(config, services, notes);
  if (!services.some(routed))
    warnings.push(
      `no service is routed: it runs without a domain (a worker); ${auto ? "publish or expose an HTTP port, or add " : ""}x-landfall: { port: <port> } on a service routes it through Traefik`,
    );
  const mains = services.filter(isMain);
  const split = (a: Service, b?: Service) => a.weight !== undefined && b?.weight !== undefined && hostsKey(a) === hostsKey(b);
  if (mains.length > 1 && !mains.every((s) => split(s, mains[0])))
    errors.push(
      `${mains.map((s) => s.name).join(" and ")} both serve the site's domains: give all but one their own x-landfall.domains, or each an x-landfall.weight to split the traffic`,
    );
  for (const s of services.filter((s) => s.weight !== undefined))
    if (!services.some((o) => o !== s && split(s, o)))
      warnings.push(`${s.name} has x-landfall.weight, but no other service serves the same domains with one: it gets all the traffic`);
  const seen = new Map<string, string>();
  for (const s of services) {
    for (const d of [...(s.domains ?? []), ...(s.routes ?? []).flatMap((r) => r.domains ?? [])]) {
      if (
        seen.has(d) &&
        seen.get(d) !== s.name &&
        split(
          s,
          services.find((o) => o.name === seen.get(d)),
        )
      )
        continue;
      if (seen.has(d) && seen.get(d) !== s.name)
        errors.push(
          `${d} is routed to both ${seen.get(d)} and ${s.name}${s.weight !== undefined ? ": a split needs the same domains and a weight on each" : ""}`,
        );
      else if (seen.has(d)) errors.push(`${d} is routed twice on ${s.name}`);
      seen.set(d, s.name);
    }
  }
  for (const g of splitGroups({ name: "site" }, services))
    if (!g.members.some((m) => m.weight > 0)) errors.push(`${g.members.map((m) => m.service.name).join(", ")} split the traffic, but every weight is 0`);
  // The members share the lead's router: a router setting on another member would be ignored.
  for (const [lead, ...rest] of splitSets(services))
    for (const s of rest)
      for (const k of ["allow", "ratelimit", "headers", "compress", "retry"] as const) {
        const get = (x: Service) => (k === "allow" ? x.allow : x.opts?.[k]);
        if (get(s) !== undefined && JSON.stringify(get(s)) !== JSON.stringify(get(lead)))
          errors.push(`${s.name}: x-landfall.${k} differs from ${lead.name}'s; their traffic split has one router, ${lead.name}'s: set ${k} there only`);
      }
  if (!mains.length && services.some((s) => s.routes?.some((r) => r.subdomain)))
    errors.push("a subdomain route hangs off the site's domains, but no service serves them: give one x-landfall.port, or the route its own domains");
  const subs = new Map<string, string>();
  for (const s of services) {
    for (const r of s.routes ?? []) {
      if (!r.subdomain) continue;
      if (subs.has(r.subdomain)) errors.push(`subdomain ${r.subdomain} is routed to both ${subs.get(r.subdomain)} and ${s.name}:${r.port}`);
      subs.set(r.subdomain, `${s.name}:${r.port}`);
    }
  }
  return { services, errors, warnings, notes, ...(auto && { auto: true }) };
}
