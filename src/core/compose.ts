import fs from "node:fs";
import { join } from "node:path";
import { Document, isMap, isSeq, parse as parseYaml, parseDocument, YAMLSeq, type YAMLMap } from "yaml";
import { DOMAIN } from "./config";
import { fail } from "./term";
import { composeEscape, OWN_PROXY, SITES, yamlStr, type Proxy } from "./templates";

/**
 * Every site is a Compose project. A release folder holds the user's compose.yaml as they wrote
 * it (or one landfall generated for a static folder, a Dockerfile or an image) and landfall's
 * compose.override.yaml, which adds Traefik's labels, the proxy network and the project name.
 * `cd /opt/landfall/sites/<site>/current && docker compose up -d` runs it without landfall.
 */

/** A site's secret files, next to its .env; each release links it, so `./.secrets/<name>` works from compose.yaml. */
export const SECRETS_DIR = ".secrets";
/** What a Compose secret may be named, and a safe file name. */
export const SECRET_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
/** A .env variable name. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/** The services of a `docker compose config` that mount one of these files of .secrets. */
export function secretUsers(config: any, keys: string[]): string[] {
  const names = Object.entries<any>(config?.secrets ?? {})
    .filter(([, d]) => keys.some((k) => String(d?.file ?? "").endsWith(`/${SECRETS_DIR}/${k}`)))
    .map(([n]) => n);
  return Object.entries<any>(config?.services ?? {})
    .filter(([, s]) => (s?.secrets ?? []).some((x: any) => names.includes(typeof x === "string" ? x : x?.source)))
    .map(([n]) => n);
}

/** A service of a release, as `docker compose config` showed it at deploy. */
export interface Service {
  name: string;
  /** Networks it is on; routed ones join the proxy network too. */
  networks: string[];
  /** Built from source: tagged per release, so a rollback never rebuilds. */
  build?: boolean;
  /** x-landfall.port: Traefik routes to this port. */
  port?: number;
  /** x-landfall.domains; none on a routed service = the site's domains (`lf domains`). */
  domains?: string[];
  /** Routed by its own traefik.* labels: landfall only adds the network. */
  own?: boolean;
  /** x-landfall.routes, or the further ports a plain compose.yaml publishes: each on its own domains. */
  routes?: Route[];
  /** x-landfall.private: ports never routed, reached by name with \`lf tunnel <site> <name>\`. */
  private?: Record<string, number>;
  /** x-landfall.private: { admin: { port: 3000, path: /admin } }: the path its tunnel opens, by private name. */
  paths?: Record<string, string>;
  /** A plain compose.yaml's ports: are dropped on the server; Traefik routes them instead. */
  unpublish?: boolean;
}

/** One more port of a service, on a subdomain of every site domain or on fixed domains. */
export interface Route {
  port: number;
  /** admin: admin.<d> for each of the site's domains (\`lf domains\`). */
  subdomain?: string;
  domains?: string[];
}

export interface Release {
  id: string;
  at: string;
  services: Service[];
  /** The commit it was deployed from, when the project is a git checkout; dirty: with uncommitted changes. */
  git?: { commit: string; branch?: string; dirty?: boolean };
  /** Who deployed it: user@machine. */
  by?: string;
}

/** "a1b2c3d4e5f6 main, uncommitted changes" for a release deployed from git. */
export const gitLabel = (g: Release["git"]) => (g ? `${g.commit}${g.branch ? ` ${g.branch}` : ""}${g.dirty ? ", uncommitted changes" : ""}` : "");

/** What the site was deployed from: static, image and dockerfile get a generated compose.yaml. */
export type SiteKind = "compose" | "static" | "image" | "dockerfile";

/** Metadata stored on the server next to each site (site.json). */
export interface SiteMeta {
  /** Layout version: site.json of landfall before Compose sites has none. */
  v: 2;
  name: string;
  kind: SiteKind;
  /** Domains of the routed service that names none itself; what `lf domains` changes. */
  domains: string[];
  /** htpasswd lines (user:bcrypt): the site asks for a login. */
  auth?: string[];
  current: string;
  releases: Release[];
  /** Adopted: a Compose project landfall did not deploy, run where it is; `current` points there. */
  adopted?: string;
  /** Compose project name of an adopted site; landfall's own are named like the site. */
  project?: string;
  /** Files in its .secrets folder (lf secret); an app, Dockerfile or image gets each at /run/secrets/<name>. */
  secrets?: string[];
  /** Named volumes kept in the site's folder, volumes/<key>, not in Docker's. Never shrinks: a rollback or undo finds them there too. */
  volumes?: string[];
  createdAt: string;
  updatedAt: string;
}

/** site.json written by landfall before sites were Compose projects. */
export const isOld = (meta: { v?: number }) => meta.v !== 2;

export const projectName = (meta: SiteMeta) => meta.project ?? meta.name;

/** Where a volume of the site keeps its files on the server. */
export const volumeDir = (site: string, key: string) => `${SITES}/${site}/volumes/${key}`;

/**
 * The named volumes of `config` (`docker compose config`) that live in the site's folder: Compose's own,
 * with no driver, options or name of their own. Those of `prev` stay unless compose.yaml now makes them its own.
 */
export function folderVolumes(config: any, prev: string[] = []): string[] {
  const vols: Record<string, any> = config?.volumes ?? {};
  const own = (k: string) => {
    const v = vols[k] ?? {};
    return !v.external && !v.driver_opts && (!v.driver || v.driver === "local") && v.name === `${config.name}_${k}`;
  };
  return [...new Set([...prev.filter((k) => !(k in vols) || own(k)), ...Object.keys(vols).filter(own)])].sort();
}

/** The live release; none for a site of the old layout, whose releases have no services. */
export const currentRelease = (meta: SiteMeta) => (isOld(meta) ? undefined : meta.releases.find((r) => r.id === meta.current));

export const routed = (s: Service) => !!(s.port || s.own || s.routes?.length);

/** The routed service serving the site's own domains, if any. */
const isMain = (s: Service) => !!s.port && !s.domains && !s.own;
export const mainService = (r?: Release) => r?.services.find(isMain);
/** The service that serves the site's own domains; none for old or adopted sites. */
export const siteMain = (meta: SiteMeta) => (meta.adopted ? undefined : mainService(currentRelease(meta)));

/** Sites of landfall before Compose sites ran as one container in the project landfall-<name>. */
export const oldProject = (name: string) => `landfall-${name}`;
/** managed: landfall deploys it; adopted: run where it is; old: deployed before Compose sites. */
export type SiteState = "managed" | "adopted" | "old";
export const siteState = (meta: { adopted?: string; v?: number }): SiteState => (meta.adopted ? "adopted" : isOld(meta) ? "old" : "managed");
/** compose, static, … ; adopted, or deployed by landfall before Compose sites. */
export const kindOf = (meta: { kind: string; adopted?: string; v?: number }) => ({ managed: meta.kind, adopted: "adopted", old: `${meta.kind} (old)` })[siteState(meta)];

export const isUp = (status: string) => /^up/i.test(status);
/** A one-shot service that finished fine: not down. */
export const isDone = (status: string) => /^exited \(0\)/i.test(status);
/** Shell that prints each site's site.json on one line, after SITE and a tab. */
export const SITE_LINES = `for f in ${SITES}/*/site.json; do [ -f "$f" ] || continue; printf 'SITE\\t'; tr -d '\\n' < "$f"; echo; done`;
/** The site.json in a SITE_LINES line; undefined for other lines and when it is corrupt. */
export function readSiteLine(line: string): SiteMeta | undefined {
  if (!line.startsWith("SITE\t")) return undefined;
  try {
    return JSON.parse(line.slice("SITE\t".length));
  } catch {
    return undefined;
  }
}

/** A container status read as: up, up but not healthy (yet) or restarting, a one-shot that finished, or down. */
export type StatusKind = "up" | "warn" | "done" | "down";
export const statusKind = (status: string): StatusKind =>
  /^restarting|\((unhealthy|health: starting)\)/i.test(status) ? "warn" : isUp(status) ? "up" : isDone(status) ? "done" : "down";
/** Higher is worse: what a group of containers shows as its one status. */
export const STATUS_RANK: Record<StatusKind, number> = { up: 0, done: 1, warn: 2, down: 3 };

/** The domains a route answers on, given the site's. */
export const routeDomains = (r: Route, site: string[]) => r.domains ?? site.map((d) => `${r.subdomain}.${d}`);

/** Domains of every route of a release that names its own: what stays when the site's domains change. */
export const fixedDomains = (services: Service[]) => services.flatMap((s) => [...(s.domains ?? []), ...(s.routes ?? []).flatMap((r) => r.domains ?? [])]);

/** The subdomain routes of a release under these site domains: they come and go with them. */
export const subDomains = (services: Service[], site: string[]) => services.flatMap((s) => (s.routes ?? []).filter((r) => r.subdomain).flatMap((r) => routeDomains(r, site)));

/** Every domain a site answers on now. */
export function siteDomains(meta: SiteMeta): string[] {
  const r = currentRelease(meta);
  if (!r) return meta.domains;
  return [...new Set([...(mainService(r) ? meta.domains : []), ...fixedDomains(r.services), ...subDomains(r.services, meta.domains)])];
}

/** What a release routes, port by port: the main service on the site's domains, each route on its own. */
export function routePlan(services: Service[], site: string[]): { service: string; port: number; domains: string[]; main?: boolean }[] {
  return services.flatMap((s) => [
    ...(s.port && !s.own ? [{ service: s.name, port: s.port, domains: s.domains ?? site, ...(isMain(s) && { main: true }) }] : []),
    ...(s.own ? [] : (s.routes ?? []).map((r) => ({ service: s.name, port: r.port, domains: routeDomains(r, site) }))),
  ]);
}

/** Image a service built for release `id` is tagged with. */
export const builtImage = (site: string, service: string, id: string) => `${site}-${service.toLowerCase()}:${id}`;

/** Compose file names, in the order `docker compose` looks for them. */
export const COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];
export const OVERRIDE_FILES = ["compose.override.yaml", "compose.override.yml", "docker-compose.override.yaml", "docker-compose.override.yml"];
/** What an environment layers over a compose file, as `docker compose -f compose.yaml -f compose.staging.yaml` would. */
export const envComposeFile = (file: string, env: string) => file.replace(/(\.ya?ml)?$/, (ext) => `.${env}${ext || ".yaml"}`);

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
const NOT_HTTP = new Set([22, 25, 53, 110, 143, 389, 443, 465, 587, 636, 993, 995, 1025, 1433, 1521, 1883, 2181, 2525, 3306, 3389, 4222, 4369, 5432, 5672, 5900, 6379, 6380, 7687, 8883, 9042, 9092, 11211, 25672, 26257, 27017]);
/** Where web servers usually listen: picks the main service when several or none are built here. */
const WEB_PORTS = new Set([80, 3000, 4000, 5000, 8000, 8080, 8888]);
/** Images of tools that sit next to an app (database UIs, mail catchers): never the site itself when something else could be. */
const SIDE_TOOLS = /(^|\/)(adminer|phpmyadmin|pgadmin4?|mailhog|mailpit|maildev|redis-commander|redisinsight|mongo-express|portainer|dozzle|kafka-ui|swagger-ui)(:|@|$)/;
/** One or more DNS labels: admin, api.v2. */
const SUBDOMAIN = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const PRIVATE_NAME = /^[a-z0-9][a-z0-9_.-]*$/i;
const X_KEYS = ["port", "domains", "publish", "routes", "private"];

const toPort = (v: unknown) => {
  const n = typeof v === "string" && !/^\d+$/.test(v.trim()) ? NaN : Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : undefined;
};
/** A service name as a DNS label. */
const label = (name: string) => name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63) || "service";
const hasRouter = (labels: Record<string, string>) => Object.keys(labels).some((k) => ROUTER_RULE.test(k));
const labelsOf = (svc: any): Record<string, string> =>
  Array.isArray(svc?.labels)
    ? Object.fromEntries(svc.labels.map((l: string) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]))
    : (svc?.labels ?? {});

/** The TCP ports a service publishes or exposes, in order; ranges left out. */
function servicePorts(svc: any): number[] {
  const published = (svc.ports ?? []).filter((p: any) => (p?.protocol ?? "tcp") === "tcp").map((p: any) => p?.target);
  const exposed = (svc.expose ?? []).map(String).filter((e: string) => !e.endsWith("/udp")).map((e: string) => e.replace(/\/tcp$/, ""));
  return [...new Set([...published, ...exposed].map(toPort).filter((n): n is number => n !== undefined))];
}

/** A compose.yaml with no x-landfall and no traefik labels: true when landfall routes it by its ports. */
export const isPlain = (config: any) => Object.values<any>(config?.services ?? {}).every((svc) => svc?.["x-landfall"] === undefined && !hasRouter(labelsOf(svc)));

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
  if (main && tied.length) notes.push(`${main.s.name} serves the site's domains (first by name of ${[main, ...tied].map((f) => f.s.name).join(", ")}): \`lf init\` writes the routes down to change that`);
  for (const f of found) {
    const isMainOne = f === main;
    if (isMainOne) f.s.port = f.ports[0];
    const routes = (isMainOne ? f.ports.slice(1) : f.ports).map((port, i) => ({ port, subdomain: isMainOne || i > 0 ? `${label(f.s.name)}-${port}` : label(f.s.name) }));
    if (routes.length) f.s.routes = routes;
  }
  for (const s of services) {
    const svc = raw[s.name];
    if (!svc.ports?.length || svc.network_mode) continue;
    s.unpublish = true;
    const routedPorts = new Set([s.port, ...(s.routes ?? []).map((r) => r.port)]);
    const kept = (svc.ports as any[]).map((p) => toPort(p?.target)).filter((p) => p !== undefined && !routedPorts.has(p));
    if (kept.length) notes.push(`${s.name}: ${[...new Set(kept)].join(", ")} not published on the server (not HTTP): reach it with lf tunnel <site> ${s.name} --port ${kept[0]}`);
  }
}

/** x-landfall.routes: more ports of the service, each on a subdomain or its own domains. */
function readRoutes(name: string, value: unknown, expand: (d: string) => string, errors: string[]): Route[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return void errors.push(`${name}: x-landfall.routes must be a list, like routes: [{ port: 3001, subdomain: admin }]`), [];
  const routes: Route[] = [];
  for (const r of value) {
    const port = toPort(r?.port);
    if (!r || typeof r !== "object" || port === undefined) {
      errors.push(`${name}: each x-landfall.routes entry needs a port, like { port: 3001, subdomain: admin }; got ${JSON.stringify(r)}`);
      continue;
    }
    const unknown = Object.keys(r).filter((k) => !["port", "subdomain", "domains"].includes(k));
    if (unknown.length) errors.push(`${name}: a route knows port, subdomain and domains, not ${unknown.join(", ")}`);
    if ((r.subdomain === undefined) === (r.domains === undefined)) {
      errors.push(`${name}: the route to ${port} needs a subdomain (admin: admin.<each site domain>) or domains, not ${r.subdomain === undefined ? "neither" : "both"}`);
      continue;
    }
    if (r.subdomain !== undefined) {
      const sub = String(r.subdomain).trim().toLowerCase();
      if (!SUBDOMAIN.test(sub)) errors.push(`${name}: not a subdomain: ${r.subdomain}`);
      routes.push({ port, subdomain: sub });
    } else {
      const ds = (Array.isArray(r.domains) ? r.domains : [r.domains]).map((d: unknown) => expand(String(d).trim()));
      const bad = ds.filter((d: string) => !DOMAIN.test(d));
      if (bad.length) errors.push(`${name}: not a domain in the route to ${port}: ${bad.join(", ")}`);
      if (!ds.length) errors.push(`${name}: the route to ${port} has no domains`);
      routes.push({ port, domains: ds });
    }
  }
  return routes;
}

/**
 * x-landfall.private: { admin: 3001 }: named ports nothing routes. { admin: { port: 3001, path: /admin } } also
 * names the path `lf tunnel` opens.
 */
function readPrivate(name: string, value: unknown, errors: string[]): { ports: Record<string, number>; paths: Record<string, string> } | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return void errors.push(`${name}: x-landfall.private must be a mapping, like private: { admin: 3001 }`), undefined;
  const out = { ports: {} as Record<string, number>, paths: {} as Record<string, string> };
  for (const [k, v] of Object.entries(value)) {
    const long = !!v && typeof v === "object" && !Array.isArray(v);
    const port = toPort(long ? (v as any).port : v);
    const path = long ? (v as any).path : undefined;
    const extra = long ? Object.keys(v).filter((x) => x !== "port" && x !== "path") : [];
    if (!PRIVATE_NAME.test(k)) errors.push(`${name}: not a name in x-landfall.private: ${k}`);
    else if (port === undefined)
      errors.push(`${name}: x-landfall.private.${k} must be a port number${long ? " in port:" : ""}, like ${k}: 3001 or ${k}: { port: 3001, path: /${k} }, got ${JSON.stringify(long ? (v as any).port : v)}`);
    else if (extra.length) errors.push(`${name}: x-landfall.private.${k} knows port and path, not ${extra.join(", ")}`);
    else if (path !== undefined && (typeof path !== "string" || !PATH.test(path))) errors.push(`${name}: x-landfall.private.${k}.path must start with /, like /${k}, got ${JSON.stringify(path)}`);
    else {
      out.ports[k] = port;
      if (path) out.paths[k] = path;
    }
  }
  return out;
}
/** A URL path with no spaces: /admin, /admin/?tab=users. */
const PATH = /^\/[^\s]*$/;

/**
 * Check a release's `docker compose config` (YAML: its JSON drops x-* fields) and read its routing from x-landfall.
 * `dir` is the release folder on the server: writable bind mounts below it would stay behind
 * with the release, so data written there seems to vanish on the next deploy.
 * With `auto` (a compose site), a file without any x-landfall is routed by its ports instead.
 */
export function analyze(config: any, dir: string, expand: (d: string) => string = (d) => d, o: { auto?: boolean } = {}): Analysis {
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
      const port = x.port ?? (expose.length === 1 && x.routes === undefined && x.private === undefined ? expose[0] : undefined);
      const n = toPort(port);
      if (n !== undefined) s.port = n;
      else if (x.port !== undefined) errors.push(`${name}: x-landfall.port must be a port number, got ${JSON.stringify(x.port)}`);
      else if (x.domains || (!x.publish && !routes.length && !priv)) errors.push(`${name}: x-landfall needs the port Traefik should send requests to, like x-landfall: { port: 3000 }`);
      if (x.domains !== undefined) {
        const list = Array.isArray(x.domains) ? x.domains : [x.domains];
        const ds = list.map((d: unknown) => expand(String(d).trim()));
        const bad = ds.filter((d: string) => !DOMAIN.test(d));
        if (bad.length) errors.push(`${name}: not a domain in x-landfall.domains: ${bad.join(", ")}`);
        if (!ds.length) errors.push(`${name}: x-landfall.domains is empty; leave it out to serve the site's domains`);
        s.domains = ds;
      }
      if (routes.length) s.routes = routes;
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
      else if (svc.network_mode === "host") warnings.push(`${name} uses network_mode: host: it binds ports on the server itself`);
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
        errors.push(`${name} writes to ${rel}, which stays behind in the release on the next deploy: use a named volume (e.g. ${name}-data:${v.target}), or mount it read-only (:ro)`);
      }
    }
    if (svc.container_name) warnings.push(`${name} sets container_name ${svc.container_name}: names are global on the server, leave it out unless something needs it`);
    services.push(s);
  }
  if (auto) autoRoute(config, services, notes);
  if (!services.some(routed))
    warnings.push(`no service is routed: it runs without a domain (a worker); ${auto ? "publish or expose an HTTP port, or add " : ""}x-landfall: { port: <port> } on a service routes it through Traefik`);
  const mains = services.filter(isMain);
  if (mains.length > 1) errors.push(`${mains.map((s) => s.name).join(" and ")} both serve the site's domains: give all but one their own x-landfall.domains`);
  const seen = new Map<string, string>();
  for (const s of services) {
    for (const d of [...(s.domains ?? []), ...(s.routes ?? []).flatMap((r) => r.domains ?? [])]) {
      if (seen.has(d) && seen.get(d) !== s.name) errors.push(`${d} is routed to both ${seen.get(d)} and ${s.name}`);
      else if (seen.has(d)) errors.push(`${d} is routed twice on ${s.name}`);
      seen.set(d, s.name);
    }
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

/**
 * A variable a project wants in its .env. Compose refuses `${NAME:?message}` unset or empty (strict),
 * `${NAME?message}` unset; an example .env's keys are wanted too, but the app may do without them (optional).
 */
export interface RequiredVar {
  name: string;
  /** The file that wants it: a compose file or an example .env. */
  from: string;
  message?: string;
  strict: boolean;
  optional?: boolean;
  /** The value an example .env shows: only suggested, never sent as it is. */
  example?: string;
}

/** Whether a missing var is asked for: an example's key with a value is only suggested. */
export const askable = (v: RequiredVar) => v.example === undefined;

/** The variables a compose file requires, in order, from its text (comment lines left out). */
export function requiredVars(text: string, from: string): RequiredVar[] {
  const out = new Map<string, RequiredVar>();
  const body = text.replace(/^\s*#.*$/gm, "");
  // `$$` first, so an escaped `$${NAME:?}` is not one.
  for (const [, name, op, message] of body.matchAll(/\$(?:\$|\{(\w+)(:?)\?([^}]*)\})/g)) {
    if (!name) continue;
    const had = out.get(name);
    out.set(name, { name, from, message: had?.message ?? (message.trim() || undefined), strict: !!had?.strict || op === ":" });
  }
  return [...out.values()];
}

/** Example .env files, in the order looked for: their keys are what the app reads, in any language. */
export const EXAMPLE_ENV_FILES = [".env.example", ".env.sample", ".env.template", ".env.dist"];

/**
 * The keys of an example .env, all optional: one left empty is asked for, one with a value only
 * suggested. The comment line right above a key is its message.
 */
export function exampleVars(text: string, from: string): RequiredVar[] {
  const out = new Map<string, RequiredVar>();
  let comment: string | undefined;
  for (const raw of text.split("\n")) {
    const l = raw.trim().replace(/^export\s+/, "");
    const m = l.match(/^([^=\s]+)\s*=\s*(.*)$/);
    if (m && ENV_NAME.test(m[1]) && !out.has(m[1])) {
      const quoted = m[2].match(/^(["'])(.*)\1/);
      const value = quoted ? quoted[2] : m[2].replace(/(^|\s)#.*$/, "").trim();
      out.set(m[1], { name: m[1], from, message: comment, strict: false, optional: true, ...(value && { example: value }) });
    }
    // A commented-out KEY=value is no message.
    const text = l.startsWith("#") ? l.replace(/^#+\s*/, "") : undefined;
    comment = text && !ENV_NAME.test(text.split("=")[0].trim()) ? text : undefined;
  }
  return [...out.values()];
}

/**
 * What a deploy of root wants in the site's .env: what its compose files require, and an example
 * .env's keys where the .env reaches the app: always for an app, Dockerfile or image (the compose
 * landfall writes reads it as env_file), for a compose project only if it names an env_file.
 */
export function wantedVars(root: string, composeFiles: string[] = []): RequiredVar[] {
  const texts = composeFiles.map((f) => [f, fs.readFileSync(join(root, f), "utf8")]);
  const envFile = (text: string) => {
    try {
      return Object.values<any>(parseYaml(text)?.services ?? {}).some((s) => s?.env_file);
    } catch {
      return false;
    }
  };
  const vars = texts.flatMap(([f, text]) => requiredVars(text, f));
  const example = EXAMPLE_ENV_FILES.find((f) => fs.existsSync(join(root, f)));
  if (example && (!texts.length || texts.some(([, text]) => envFile(text)))) vars.push(...exampleVars(fs.readFileSync(join(root, example), "utf8"), example));
  // The first file to want a name says it: compose before the example.
  return vars.filter((v, i) => vars.findIndex((u) => u.name === v.name) === i);
}

/** The required variables vars leaves without a value in env (a .env's pairs). */
export const missingVars = (vars: RequiredVar[], env: Record<string, string>) => vars.filter((v) => (v.strict ? !env[v.name] : env[v.name] === undefined));

/** `${VAR}`, `${VAR:-default}`, `${VAR-default}`, `${VAR:+alt}`, `$VAR` and `$$`, as docker compose fills them in. */
function interpolate(text: string, env: Record<string, string | undefined>): string {
  return text.replace(/\$(?:\$|\{(\w+)(?:(:?[-+?])([^}]*))?\}|(\w+))/g, (m, name, op, arg, bare) => {
    if (m === "$$") return "$";
    const v = env[name ?? bare];
    if (op === ":-") return v || arg;
    if (op === "-") return v ?? arg;
    if (op === ":+") return v ? arg : "";
    if (op === "+") return v !== undefined ? arg : "";
    return v ?? "";
  });
}

/** A short-syntax port (`8080:80`, `127.0.0.1:3000:3000/tcp`, `3000-3002`) in the long form `docker compose config` prints. */
function longPort(p: unknown): any[] {
  if (p && typeof p === "object") return [p];
  const [spec, protocol = "tcp"] = String(p).split("/");
  const at = spec.lastIndexOf(":");
  const target = spec.slice(at + 1);
  const rest = at < 0 ? "" : spec.slice(0, at);
  const pubAt = rest.lastIndexOf(":");
  const published = rest.slice(pubAt + 1) || undefined;
  const host_ip = pubAt < 0 ? undefined : rest.slice(0, pubAt).replace(/^\[|\]$/g, "");
  const range = /^(\d+)-(\d+)$/.exec(target);
  const targets = range ? Array.from({ length: Math.min(Math.max(+range[2] - +range[1] + 1, 0), 100) }, (_, i) => +range[1] + i) : [Number(target)];
  return targets.map((t) => ({ target: t, ...(published && { published }), ...(host_ip && { host_ip }), protocol }));
}

/**
 * A local compose file in the shape `docker compose config` prints, for `analyze`: variables filled from the
 * environment and .env, ports in long form. Overrides are left out, as on deploy.
 */
export function localCompose(dir: string, file: string): any {
  let dotenv: Record<string, string> = {};
  try {
    for (const l of fs.readFileSync(join(dir, ".env"), "utf8").split("\n")) {
      const m = /^\s*(?:export\s+)?(\w+)\s*=\s*(.*?)\s*$/.exec(l);
      if (m && !l.trim().startsWith("#")) dotenv[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
    }
  } catch {}
  const env = { ...dotenv, ...process.env };
  const fill = (v: unknown): unknown =>
    typeof v === "string" ? interpolate(v, env) : Array.isArray(v) ? v.map(fill) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)])) : v;
  const config: any = fill(parseYaml(fs.readFileSync(join(dir, file), "utf8")) ?? {});
  for (const svc of Object.values<any>(config?.services ?? {})) if (Array.isArray(svc?.ports)) svc.ports = svc.ports.flatMap(longPort);
  return config;
}

const q = yamlStr;
/** Network key of the proxy network in the override; its `name:` is the real one. */
const PROXY_KEY = "landfall-proxy";

/** Traefik labels for one routed service. */
export function routeLabels(site: string, s: Service, domains: string[], proxy: Proxy, auth: string[] = [], port = s.port): Record<string, string> {
  // "_" can't be in a site name: blog + admin-web and blog-admin + web would both be blog-admin-web.
  // A route's router carries its port: blog_web_3001 next to blog_web.
  const r = `${site}_${s.name.toLowerCase().replace(/\./g, "-")}${port === s.port ? "" : `_${port}`}`;
  const out: Record<string, string> = {
    "traefik.enable": "true",
    "traefik.docker.network": proxy.network,
    [`traefik.http.routers.${r}.rule`]: domains.map((d) => `Host(\`${d}\`)`).join(" || "),
    [`traefik.http.routers.${r}.entrypoints`]: proxy.entrypoint,
    [`traefik.http.routers.${r}.tls.certresolver`]: proxy.resolver,
    [`traefik.http.routers.${r}.service`]: r,
    [`traefik.http.services.${r}.loadbalancer.server.port`]: String(port),
  };
  if (auth.length) {
    out[`traefik.http.middlewares.${site}-auth.basicauth.users`] = auth.join(",");
    out[`traefik.http.routers.${r}.middlewares`] = `${site}-auth`;
  }
  return out;
}

/**
 * landfall's compose.override.yaml for a release: the project name (named volumes belong to
 * it, so it never changes), per-release tags for built images, the proxy network on routed
 * services next to the networks they had, Traefik's labels, and landfall.* on every service.
 */
export function overrideYaml(meta: SiteMeta, r: Release, proxy: Proxy = OWN_PROXY): string {
  const lines = [
    "# generated by landfall: rewritten on every deploy, rollback and domain change. Edit compose.yaml instead.",
    `name: ${q(projectName(meta))}`,
    "services:",
  ];
  let usesProxy = false;
  // A compose.yaml names the secrets it uses itself; the one landfall generates gets every one here.
  const secrets = meta.kind === "dockerfile" || meta.kind === "image" ? (meta.secrets ?? []) : [];
  for (const s of r.services) {
    lines.push(`  ${q(s.name)}:`);
    if (s.build) lines.push(`    image: ${q(builtImage(meta.name, s.name, r.id))}`);
    // A plain compose.yaml publishes its ports for local use; on the server Traefik routes them.
    if (s.unpublish) lines.push("    ports: !reset []");
    if (secrets.length) lines.push("    secrets:", ...secrets.map((k) => `      - ${q(k)}`));
    let labels: Record<string, string> = {};
    if (routed(s)) {
      usesProxy = true;
      lines.push("    networks:", ...s.networks.map((n) => `      ${q(n)}: {}`), `      ${PROXY_KEY}: {}`);
      if (s.own) labels["traefik.docker.network"] = proxy.network;
      else {
        // A main service with no domains left stays up, unrouted; so do its subdomain routes.
        if (s.port && (s.domains ?? meta.domains).length) labels = routeLabels(meta.name, s, s.domains ?? meta.domains, proxy, meta.auth);
        for (const route of s.routes ?? []) {
          const ds = routeDomains(route, meta.domains);
          if (ds.length) Object.assign(labels, routeLabels(meta.name, s, ds, proxy, meta.auth, route.port));
        }
      }
    }
    labels["landfall.managed"] = "true";
    labels["landfall.site"] = meta.name;
    lines.push("    labels:", ...Object.entries(labels).map(([k, v]) => `      ${q(k)}: ${q(composeEscape(v))}`));
  }
  if (usesProxy) lines.push("networks:", `  ${PROXY_KEY}:`, `    name: ${q(proxy.network)}`, "    external: true");
  if (secrets.length) lines.push("secrets:", ...secrets.flatMap((k) => [`  ${q(k)}:`, `    file: ${q(`./${SECRETS_DIR}/${k}`)}`]));
  // Bound to the site's folder: the data sits next to its releases, and `docker volume` still lists it.
  const vols = meta.adopted ? [] : (meta.volumes ?? []);
  if (vols.length)
    lines.push("volumes:", ...vols.flatMap((k) => [`  ${q(k)}:`, "    driver_opts:", "      type: none", "      o: bind", `      device: ${q(volumeDir(meta.name, k))}`]));
  return lines.join("\n") + "\n";
}

/** The named volume for a folder in the container: /app/storage is app-storage. */
export const volumeName = (target: string) => target.replace(/^\/+|\/+$/g, "").replace(/[^\w.-]+/g, "-") || "data";

/** What serves a static site. */
export const STATIC_IMAGE = "nginx:alpine";

/**
 * compose.yaml landfall writes for a site deployed without one.
 * port: where Traefik sends requests; none, a worker: it runs without a domain.
 */
export function generatedCompose(kind: Exclude<SiteKind, "compose">, o: { port?: number; image?: string; app?: string; volumes?: string[] } = {}): string {
  const head = `# generated by landfall for a ${kind === "static" ? "static folder" : kind === "image" ? "prebuilt image" : o.app ? `${o.app} app` : "Dockerfile"}; \`lf init\` writes one you can edit into your project\nservices:\n`;
  if (kind === "static") {
    return `${head}  web:
    image: ${STATIC_IMAGE}
    restart: unless-stopped
    volumes:
      - ./public:/usr/share/nginx/html:ro
      - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro
    x-landfall:
      port: 80
`;
  }
  const volumes = o.volumes ?? [];
  return `${head}  app:
    ${kind === "image" ? `image: ${q(o.image!)}` : "build: ."}
    restart: unless-stopped${o.app ? "\n    init: true" : ""}
    env_file:
      - path: .env
        required: false
${volumes.length ? `    volumes:\n${volumes.map((v) => `      - ${q(`${volumeName(v)}:${v}`)}\n`).join("")}` : ""}${o.port ? `    x-landfall:\n      port: ${o.port}\n` : ""}${
    volumes.length ? `volumes:\n${volumes.map((v) => `  ${q(volumeName(v))}: {}\n`).join("")}` : ""
  }`;
}

/** A folder in a container: absolute, as `--volume` and `lf volume add` take it. */
export const CONTAINER_PATH = /^\/[\w.\/-]*\w/;
/** A named volume's key in compose.yaml. */
export const VOLUME_KEY = /^\w[\w.-]*$/;

/** A compose.yaml volume entry ("db:/var/lib/data:ro" or the long syntax): the named volume it mounts (none: a bind mount or anonymous) and where. */
export function mountOf(item: unknown): { key?: string; path?: string } {
  if (typeof item === "string") {
    const [src, dst] = item.split(":");
    if (dst === undefined) return { path: src };
    return { key: VOLUME_KEY.test(src) ? src : undefined, path: dst };
  }
  if (!item || typeof item !== "object") return {};
  const o = item as Record<string, unknown>;
  return { key: (o.type ?? "volume") === "volume" && typeof o.source === "string" ? o.source : undefined, path: typeof o.target === "string" ? o.target : undefined };
}

/** mountOf for an item of a parsed document's volumes list. */
const nodeMount = (i: unknown) => mountOf((i as { toJSON?: () => unknown })?.toJSON?.() ?? i);

/**
 * compose.yaml with a named volume `key` mounted at `path` in `service`, declared under the top-level
 * volumes too: plain Compose, comments and order kept. The key defaults to the path's last folders (/app/data: app-data).
 */
export function addVolumeMount(text: string, service: string, path: string, key = volumeName(path)): { compose: string; key: string } {
  if (!CONTAINER_PATH.test(path)) fail(`a volume goes on a folder in the container, like /app/data: not ${path}`);
  if (!VOLUME_KEY.test(key)) fail(`a volume name takes letters, digits, ., _ and -: not ${key}`);
  const doc = parseDocument(text);
  const svc = doc.getIn(["services", service], true);
  if (!isMap(svc)) {
    const names = Object.keys((doc.toJS()?.services ?? {}) as object);
    fail(`no service ${service} in the compose file${names.length ? `: ${names.join(", ")}` : ""}`);
  }
  const s = svc as YAMLMap;
  const at = (p: string) => p.replace(/\/+$/, "");
  const list = s.get("volumes", true);
  const taken = isSeq(list) ? list.items.map(nodeMount).find((m) => m.path && at(m.path) === at(path)) : undefined;
  if (taken) fail(`${service} already has ${taken.key ? `volume ${taken.key}` : "a folder"} at ${path}`);
  const entry = doc.createNode(`${key}:${path}`);
  if (isSeq(list)) list.items.push(entry);
  else {
    const seq = new YAMLSeq();
    seq.items.push(entry);
    s.set("volumes", seq);
  }
  const top = doc.get("volumes", true);
  if (!isMap(top) || !top.has(key)) doc.setIn(["volumes", key], doc.createNode({}, { flow: true }));
  return { compose: doc.toString(), key };
}

/**
 * compose.yaml without the named volume `key`: its mounts (in `service` only, if given) and, once nothing mounts it,
 * its top-level declaration. Lists and maps left empty go too. The data stays on the server. `from` is empty when nothing mounts it.
 */
export function removeVolumeMount(text: string, key: string, service?: string): { compose: string; from: string[] } {
  const doc = parseDocument(text);
  const services = doc.get("services", true);
  const from: string[] = [];
  let left = false;
  if (isMap(services))
    for (const pair of services.items) {
      const name = String((pair.key as any)?.value ?? pair.key);
      const list = isMap(pair.value) ? pair.value.get("volumes", true) : undefined;
      if (!isSeq(list)) continue;
      const mine = (i: unknown) => nodeMount(i).key === key;
      if (service && name !== service) {
        left ||= list.items.some(mine);
        continue;
      }
      const keep = list.items.filter((i) => !mine(i));
      if (keep.length === list.items.length) continue;
      from.push(name);
      if (keep.length) list.items = keep;
      else (pair.value as YAMLMap).delete("volumes");
    }
  if (!from.length) return { compose: text, from };
  const top = doc.get("volumes", true);
  if (!left && isMap(top)) {
    top.delete(key);
    if (!top.items.length) doc.delete("volumes");
  }
  return { compose: doc.toString(), from };
}

export function nginxConf(spa: boolean): string {
  return `# generated by landfall
server {
  listen 80;
  server_name _;
  root /usr/share/nginx/html;
  index index.html;
  absolute_redirect off;

  gzip on;
  gzip_types text/plain text/css application/javascript application/json image/svg+xml application/xml;

  location ~* \\.(?:css|js|mjs|woff2?|ttf|otf|eot|svg|png|jpe?g|gif|webp|avif|ico)$ {
    expires 30d;
    add_header Cache-Control "public";
    try_files $uri =404;
  }

  location / {
    try_files $uri $uri/ $uri.html ${spa ? "/index.html" : "=404"};
  }

  error_page 404 /404.html;
  location = /404.html { internal; }
}
`;
}

/**
 * `lf init` on an existing compose file: writes down what auto mode routes as x-landfall, and moves published
 * `ports:` into the local-only override (merged with one that exists). Comments and order stay.
 */
export function adoptCompose(text: string, override: string | undefined, a: Analysis): { compose: string; override: string; routed: string[]; moved: string[] } {
  const doc = parseDocument(text);
  const over = override !== undefined ? parseDocument(override) : new Document({ services: {} });
  if (override === undefined) over.commentBefore = " Local only: docker compose merges this file, lf deploy leaves it out.";
  const routed: string[] = [];
  const moved: string[] = [];
  for (const s of a.services) {
    const svc = doc.getIn(["services", s.name], true);
    if (!isMap(svc)) continue;
    if (a.auto && (s.port || s.routes?.length)) {
      const x = doc.createNode({ ...(s.port && { port: s.port }), ...(s.routes?.length && { routes: s.routes.map((r) => ({ port: r.port, subdomain: r.subdomain })) }) }) as YAMLMap;
      const routes = x.get("routes", true);
      if (isSeq(routes)) for (const r of routes.items) if (isMap(r)) r.flow = true;
      svc.set("x-landfall", x);
      routed.push(s.name);
    }
    const ports = svc.get("ports", true);
    if (!isSeq(ports) || svc.getIn(["x-landfall", "publish"])) continue;
    const local = over.getIn(["services", s.name, "ports"], true);
    const have = new Set(isSeq(local) ? local.items.map((i) => JSON.stringify((i as any)?.toJSON?.() ?? i)) : []);
    // The nodes themselves, so "8080:80" stays quoted (unquoted, YAML 1.1 reads it as a number in base 60).
    const add = ports.items.filter((i) => !have.has(JSON.stringify((i as any)?.toJSON?.() ?? i))).map((i) => (i as any)?.clone?.() ?? i);
    if (isSeq(local)) local.items.push(...add);
    else {
      const seq = new YAMLSeq();
      seq.items.push(...add);
      over.setIn(["services", s.name, "ports"], seq);
    }
    svc.delete("ports");
    moved.push(s.name);
  }
  return { compose: doc.toString(), override: over.toString(), routed, moved };
}

