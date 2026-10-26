import { DOMAIN } from "./config";
import { c } from "./ui";
import { composeEscape, OWN_PROXY, SITES, yamlStr, type Proxy } from "./templates";

/**
 * Every site is a Compose project. A release folder holds the user's compose.yaml as they wrote
 * it (or one landfall generated for a static folder, a Dockerfile or an image) and landfall's
 * compose.override.yaml, which adds Traefik's labels, the proxy network and the project name.
 * `cd /opt/landfall/sites/<site>/current && docker compose up -d` runs it without landfall.
 */

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
}

export interface Release {
  id: string;
  at: string;
  services: Service[];
}

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
  createdAt: string;
  updatedAt: string;
}

/** site.json written by landfall before sites were Compose projects. */
export const isOld = (meta: { v?: number }) => meta.v !== 2;

export const projectName = (meta: SiteMeta) => meta.project ?? meta.name;

/** The live release; none for a site of the old layout, whose releases have no services. */
export const currentRelease = (meta: SiteMeta) => (isOld(meta) ? undefined : meta.releases.find((r) => r.id === meta.current));

export const routed = (s: Service) => !!(s.port || s.own);

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
/** The site.json in a SITE_LINES line; undefined when it is corrupt. */
export function readSiteLine(line: string): SiteMeta | undefined {
  try {
    return JSON.parse(line.slice("SITE\t".length));
  } catch {
    return undefined;
  }
}

/** A container status in color: green when up, yellow when up but unhealthy or restarting, dim when done, red when down. */
export const paintStatus = (status: string) =>
  isUp(status) ? (/unhealthy|restarting/i.test(status) ? c.yellow(status) : c.green(status)) : isDone(status) ? c.dim(status) : c.red(status);

/** Every domain a site answers on now. */
export function siteDomains(meta: SiteMeta): string[] {
  const r = currentRelease(meta);
  if (!r) return meta.domains;
  const own = r.services.flatMap((s) => s.domains ?? []);
  return [...new Set([...(mainService(r) ? meta.domains : []), ...own])];
}

/** Image a service built for release `id` is tagged with. */
export const builtImage = (site: string, service: string, id: string) => `${site}-${service.toLowerCase()}:${id}`;

/** Compose file names, in the order `docker compose` looks for them. */
export const COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];
export const OVERRIDE_FILES = ["compose.override.yaml", "compose.override.yml", "docker-compose.override.yaml", "docker-compose.override.yml"];

/** Hosts in a Traefik rule: Host(`a`) || Host(`b`, `c`). HostRegexp and HostSNI are not hosts. */
export const ruleHosts = (rule: string) =>
  [...rule.matchAll(/\bHost\(([^)]*)\)/g)].flatMap((m) => [...m[1].matchAll(/[`"]([^`"]+)[`"]/g)].map((h) => h[1].toLowerCase()));

export const ROUTER_RULE = /^traefik\.http\.routers\.[^.]+\.rule$/;
export const SERVICE_PORT = /^traefik\.http\.services\.[^.]+\.loadbalancer\.server\.port$/;

export interface Analysis {
  services: Service[];
  errors: string[];
  warnings: string[];
}

/**
 * Check a release's `docker compose config` (YAML: its JSON drops x-* fields) and read its routing from x-landfall.
 * `dir` is the release folder on the server: writable bind mounts below it would stay behind
 * with the release, so data written there seems to vanish on the next deploy.
 */
export function analyze(config: any, dir: string, expand: (d: string) => string = (d) => d): Analysis {
  const services: Service[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const [name, svc] of Object.entries<any>(config?.services ?? {})) {
    const x = svc["x-landfall"] ?? {};
    const labels: Record<string, string> = Array.isArray(svc.labels)
      ? Object.fromEntries(svc.labels.map((l: string) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]))
      : (svc.labels ?? {});
    const s: Service = { name, networks: svc.network_mode ? [] : Object.keys(svc.networks ?? { default: null }) };
    if (svc.build) s.build = true;
    const rules = Object.entries(labels).filter(([k]) => ROUTER_RULE.test(k));
    if (typeof x !== "object" || Array.isArray(x)) errors.push(`${name}: x-landfall must be a mapping, like x-landfall: { port: 3000 }`);
    else if (rules.length) {
      s.own = true;
      s.domains = [...new Set(rules.flatMap(([, v]) => ruleHosts(v)))];
      if (Object.keys(x).some((k) => k !== "publish")) warnings.push(`${name} has its own traefik router labels: its x-landfall routing is ignored`);
    } else if (svc["x-landfall"] !== undefined) {
      const unknown = Object.keys(x).filter((k) => !["port", "domains", "publish"].includes(k));
      if (unknown.length) warnings.push(`${name}: x-landfall knows port, domains and publish, not ${unknown.join(", ")}`);
      const expose: string[] = (svc.expose ?? []).map(String);
      const port = x.port ?? (expose.length === 1 ? expose[0] : undefined);
      const n = Number(port);
      if (port !== undefined && Number.isInteger(n) && n >= 1 && n <= 65535) s.port = n;
      else if (x.port !== undefined) errors.push(`${name}: x-landfall.port must be a port number, got ${JSON.stringify(x.port)}`);
      else if (x.domains || !x.publish) errors.push(`${name}: x-landfall needs the port Traefik should send requests to, like x-landfall: { port: 3000 }`);
      if (x.domains !== undefined) {
        const list = Array.isArray(x.domains) ? x.domains : [x.domains];
        const ds = list.map((d: unknown) => expand(String(d).trim()));
        const bad = ds.filter((d: string) => !DOMAIN.test(d));
        if (bad.length) errors.push(`${name}: not a domain in x-landfall.domains: ${bad.join(", ")}`);
        if (!ds.length) errors.push(`${name}: x-landfall.domains is empty; leave it out to serve the site's domains`);
        s.domains = ds;
      }
    }
    if (svc.network_mode) {
      if (routed(s)) errors.push(`${name}: a routed service cannot use network_mode: ${svc.network_mode}; Traefik reaches it over a network`);
      else if (svc.network_mode === "host") warnings.push(`${name} uses network_mode: host: it binds ports on the server itself`);
    }
    if (svc.ports?.length && !x.publish) {
      const ports = svc.ports.map((p: any) => (p.published ? `${p.host_ip ? p.host_ip + ":" : ""}${p.published}:${p.target}` : String(p.target)));
      errors.push(
        `${name} publishes ${ports.join(", ")} on the server, past Traefik and the firewall. Move ports: to compose.override.yaml (local only)` +
          `${s.port || s.own ? "" : ` and route it with x-landfall: { port: ${svc.ports[0].target} }`}, or allow it with x-landfall: { publish: true }`,
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
  if (!services.some(routed)) warnings.push("no service is routed: it runs without a domain (a worker); x-landfall: { port: <port> } on a service routes it through Traefik");
  const mains = services.filter(isMain);
  if (mains.length > 1) errors.push(`${mains.map((s) => s.name).join(" and ")} both serve the site's domains: give all but one their own x-landfall.domains`);
  const seen = new Map<string, string>();
  for (const s of services) {
    for (const d of s.domains ?? []) {
      if (seen.has(d)) errors.push(`${d} is routed to both ${seen.get(d)} and ${s.name}`);
      seen.set(d, s.name);
    }
  }
  return { services, errors, warnings };
}

const q = yamlStr;
/** Network key of the proxy network in the override; its `name:` is the real one. */
const PROXY_KEY = "landfall-proxy";

/** Traefik labels for one routed service. */
export function routeLabels(site: string, s: Service, domains: string[], proxy: Proxy, auth: string[] = []): Record<string, string> {
  // "_" can't be in a site name: blog + admin-web and blog-admin + web would both be blog-admin-web.
  const r = `${site}_${s.name.toLowerCase().replace(/\./g, "-")}`;
  const out: Record<string, string> = {
    "traefik.enable": "true",
    "traefik.docker.network": proxy.network,
    [`traefik.http.routers.${r}.rule`]: domains.map((d) => `Host(\`${d}\`)`).join(" || "),
    [`traefik.http.routers.${r}.entrypoints`]: proxy.entrypoint,
    [`traefik.http.routers.${r}.tls.certresolver`]: proxy.resolver,
    [`traefik.http.routers.${r}.service`]: r,
    [`traefik.http.services.${r}.loadbalancer.server.port`]: String(s.port),
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
  for (const s of r.services) {
    lines.push(`  ${q(s.name)}:`);
    if (s.build) lines.push(`    image: ${q(builtImage(meta.name, s.name, r.id))}`);
    let labels: Record<string, string> = {};
    if (routed(s)) {
      usesProxy = true;
      lines.push("    networks:", ...s.networks.map((n) => `      ${q(n)}: {}`), `      ${PROXY_KEY}: {}`);
      if (s.own) labels["traefik.docker.network"] = proxy.network;
      // A main service with no domains left stays up, unrouted.
      else if ((s.domains ?? meta.domains).length) labels = routeLabels(meta.name, s, s.domains ?? meta.domains, proxy, meta.auth);
    }
    labels["landfall.managed"] = "true";
    labels["landfall.site"] = meta.name;
    lines.push("    labels:", ...Object.entries(labels).map(([k, v]) => `      ${q(k)}: ${q(composeEscape(v))}`));
  }
  if (usesProxy) lines.push("networks:", `  ${PROXY_KEY}:`, `    name: ${q(proxy.network)}`, "    external: true");
  return lines.join("\n") + "\n";
}

/** The named volume for a folder in the container: /app/storage is app-storage. */
export const volumeName = (target: string) => target.replace(/^\/+|\/+$/g, "").replace(/[^\w.-]+/g, "-") || "data";

/**
 * compose.yaml landfall writes for a site deployed without one.
 * port: where Traefik sends requests; none, a worker: it runs without a domain.
 */
export function generatedCompose(kind: Exclude<SiteKind, "compose">, o: { port?: number; image?: string; app?: string; volumes?: string[] } = {}): string {
  const head = `# generated by landfall for a ${kind === "static" ? "static folder" : kind === "image" ? "prebuilt image" : o.app ? `${o.app} app` : "Dockerfile"}; \`lf init\` writes one you can edit into your project\nservices:\n`;
  if (kind === "static") {
    return `${head}  web:
    image: nginx:alpine
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
