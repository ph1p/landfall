import type { Server } from "../lib/config";
import { currentRelease, kindOf, projectName, SITE_LINES, readSiteLine, type SiteMeta } from "../site/meta";
import { ROUTER_RULE, ruleHosts } from "../site/analyze";
import { isUp, worse, statusKind } from "../site/status";
import { routed, siteDomains, siteRedirects, siteMain } from "../site/routing";
import { scaleView, scales, type ScaleRow } from "../site/scale";
import { runScript } from "../ssh/ssh";
import { ctrPs, PROXY_CTR, PROXY_FILE, SITES, TRAEFIK_DIR, TUNNEL_ROUTER } from "../ssh/templates";
import { warn } from "../lib/term";
import { REDIRECTS_STATE, redirectsStateOf, type RedirectsState } from "../traefik/server-redirects";
import { traefikStateOf, type TraefikState } from "../traefik/traefik";

export interface ServiceStatus {
  service: string;
  container: string;
  /** e.g. "Up 3 hours (healthy)", "Exited (1) 2 minutes ago". */
  status: string;
}

export interface SiteStatus {
  meta: SiteMeta;
  status: string;
  services: ServiceStatus[];
  /** Every domain it answers on (siteDomains). */
  domains: string[];
  /** Hosts that redirect to its first domain; none while it serves no domain (siteRedirects). */
  redirects: string[];
  /** Where the redirects point: the first domain. */
  redirectTo?: string;
  /** The service serving the site's own domains: `lf domains` changes them. None: fixed in compose.yaml. */
  main?: string;
  /** kindOf: what lists show. */
  kind: string;
  /**
   * Per service: replicas wanted and up, update mode, split weight. Only when the site uses replicas,
   * rolling updates or a traffic split; other sites print as before.
   */
  scale?: Record<string, Omit<ScaleRow, "service"> & { running: number }>;
}

export function replicaState(meta: SiteMeta, services: ServiceStatus[]): SiteStatus["scale"] {
  const rows = scaleView(meta);
  if (!rows.some(scales)) return undefined;
  return Object.fromEntries(
    rows.map(({ service, ...r }) => [service, { ...r, running: services.filter((x) => x.service === service && isUp(x.status)).length }]),
  );
}

export interface Overview {
  /** docker and /opt/landfall/sites exist, i.e. `lf setup` ran. */
  ready: boolean;
  /** traefik container status, empty if not installed. */
  traefik: string;
  /** Its container name: landfall's `traefik`, or the one sites were pointed at. */
  proxy: string;
  /** Sites go through a Traefik the server already had (PROXY_FILE): landfall never reconfigures it. */
  adopted: boolean;
  sites: SiteStatus[];
  /** Containers routed by Traefik that landfall did not deploy (your own compose projects). Read only. */
  others: External[];
  /** Traefik's dashboard: the domains routers serve it on, and whether `lf traefik dashboard` can tunnel to it. */
  dashboard: { hosts: string[]; tunnel: boolean };
  /** Running containers neither a site nor routed by Traefik (databases, workers): only a tunnel reaches them. */
  unrouted: Unrouted[];
  /** Set when Docker is installed but `docker ps` failed: its error. The lists above are empty then, not known. */
  docker?: string;
  /** Hosts landfall's Traefik redirects with no site behind them (`lf redirect add`): the file as read, and whose Traefik runs. */
  redirects: RedirectsState;
  /** Who runs the Traefik: an adopted proxy's container, whose compose file is in landfall's Traefik folder. */
  owner: Omit<TraefikState, "sites">;
  /** The domains the central Traefik passes to tenants: no site here may route them. */
  tenants?: { user: string; domains: string[] }[];
}

export interface Unrouted {
  container: string;
  status: string;
  image: string;
  /** Its Compose project and service, if it has one. */
  project?: string;
  service?: string;
  /** TCP ports it listens on in its container (exposed or published), lowest first. */
  ports: number[];
}

/** The container side of `docker ps`'s Ports column ("0.0.0.0:25->25/tcp, 80/tcp"); ranges left out. */
export const containerPorts = (col: string) => [...new Set([...col.matchAll(/(?:^|[\s>])(\d+)\/tcp/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);

/** Domains a container's routers serve Traefik's dashboard (api@internal) on. */
export function dashboardHosts(labels: Record<string, string>): string[] {
  return dashboardRouters(labels).flatMap((r) => r.hosts);
}

/** The routers serving Traefik's dashboard (api@internal), with the domains in their rules. */
export function dashboardRouters(labels: Record<string, string>): { router: string; hosts: string[] }[] {
  return Object.entries(labels)
    .map(([k, v]) => [k.match(/^traefik\.http\.routers\.([^.]+)\.service$/)?.[1], v])
    .filter(([r, v]) => r && v === "api@internal")
    .map(([r]) => ({ router: r!, hosts: ruleHosts(labels[`traefik.http.routers.${r}.rule`] ?? "") }));
}
/** landfall's Traefik serves its dashboard to the server itself, for `lf traefik dashboard`. */
export const hasDashboardTunnel = (labels: Record<string, string>) => labels[`traefik.http.routers.${TUNNEL_ROUTER}.service`] === "api@internal";

export interface External {
  /** Compose project, or the container name without one. */
  name: string;
  domains: string[];
  /** Status of its routed containers, e.g. "Up 3 hours". */
  status: string;
  containers: string[];
  /** Compose working directory on the server. */
  dir?: string;
  /** Compose files it was started with, comma-separated (com.docker.compose.project.config_files). */
  files?: string;
}

/**
 * Group containers that carry Traefik router rules by compose project. Skips landfall's own
 * sites, projects landfall adopted, the proxy itself, and
 * traefik.enable=false.
 */
export function externals(
  ctrs: { name: string; labels: Record<string, string> }[],
  status: Map<string, string>,
  proxy: string,
  sites: Set<string> = new Set(),
): External[] {
  const out = new Map<string, External>();
  for (const { name, labels } of ctrs) {
    if (name === proxy || labels["landfall.managed"] || labels["traefik.enable"] === "false") continue;
    const project = labels["com.docker.compose.project"];
    if (project && sites.has(project)) continue;
    const hosts = Object.entries(labels)
      .filter(([k]) => ROUTER_RULE.test(k))
      .flatMap(([, v]) => ruleHosts(v));
    if (!hosts.length) continue;
    const key = project || name;
    const e = out.get(key) ?? {
      name: key,
      domains: [],
      status: "",
      containers: [],
      dir: labels["com.docker.compose.project.working_dir"],
      files: labels["com.docker.compose.project.config_files"],
    };
    e.domains = [...new Set([...e.domains, ...hosts])];
    e.containers.push(name);
    const st = status.get(name) ?? "not running";
    // A group shows its worst container.
    if (!e.status || worse(st, e.status)) e.status = st;
    out.set(key, e);
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * One status for a site: the first routed service that is not up, else any other service that
 * is down (one-shot jobs exit 0), else any unhealthy one, else the routed service's.
 */
function siteStatus(meta: SiteMeta, services: ServiceStatus[]): string {
  if (!services.length) return "not running";
  const r = currentRelease(meta);
  const names = new Set(r?.services.filter(routed).map((s) => s.name));
  const main = services.filter((s) => names.has(s.service));
  const bad =
    main.find((s) => !isUp(s.status)) ??
    services.find((s) => !names.has(s.service) && statusKind(s.status) === "down") ??
    services.find((s) => statusKind(s.status) === "warn");
  return (bad ?? main[0] ?? services[0]).status;
}

export async function overview(s: Server): Promise<Overview> {
  const { stdout } = await runScript(
    s,
    `printf 'READY\\t%s\\n' "$([ -d ${SITES} ] && command -v docker >/dev/null 2>&1 && echo 1)"
P=${PROXY_CTR}
printf 'TRAEFIK\\t%s\\t%s\\t%s\\n' "$(docker ps -a --filter "name=^$P$" --format '{{.Status}}' 2>/dev/null || true)" "$P" "$([ -f ${PROXY_FILE} ] && echo 1)"
${SITE_LINES}
${REDIRECTS_STATE}
for _f in ${TRAEFIK_DIR}/dynamic/tenant-*.yml; do [ ! -r "$_f" ] || printf 'TENANT\\t%s\\t%s\\n' "$(basename "$_f" .yml)" "$(sed -n 's/^# domains: //p' "$_f")"; done
${ctrPs(true)} 2>/dev/null || true
# Docker is there but does not answer (no access to its socket, daemon down): say why, an empty list would lie.
ids=$(docker ps -aq 2>/dev/null) || { ids=; ! command -v docker >/dev/null 2>&1 || printf 'DOCKER\\t%s\\n' "$(docker ps -q 2>&1 | tail -n1)"; }
# inspect, unlike ps, does not expand \\t: hence {{"\\t"}}.
[ -z "$ids" ] || docker inspect -f 'LABELS{{"\\t"}}{{.Name}}{{"\\t"}}{{json .Config.Labels}}' $ids 2>/dev/null || true`,
    { capture: true },
  );
  const status = new Map<string, string>();
  const byProject = new Map<string, ServiceStatus[]>();
  const metas: SiteMeta[] = [];
  const labeled: { name: string; labels: Record<string, string> }[] = [];
  const o: Overview = {
    ready: false,
    traefik: "",
    proxy: "traefik",
    adopted: false,
    sites: [],
    others: [],
    dashboard: { hosts: [], tunnel: false },
    unrouted: [],
    redirects: redirectsStateOf(stdout),
    owner: traefikStateOf(stdout),
  };
  const ctrs: Unrouted[] = [];
  for (const line of stdout.split("\n")) {
    const [kind, a = "", b = "", project = "", service = "", image = "", ports = ""] = line.split("\t");
    if (kind === "READY") o.ready = a === "1";
    if (kind === "DOCKER") o.docker = a || "docker ps failed";
    if (kind === "TENANT") (o.tenants ??= []).push({ user: a.replace(/^tenant-/, ""), domains: b.split(" ").filter(Boolean) });
    if (kind === "TRAEFIK") {
      o.traefik = a;
      o.proxy = b || "traefik";
      o.adopted = project === "1";
    }
    if (kind === "SITE") {
      // One broken site.json must not hide every other site.
      const meta = readSiteLine(line);
      if (meta) metas.push(meta);
      else warn(`skipped a corrupt site.json on ${s.host}: ${line.slice(kind.length + 1, 80)}`);
    }
    if (kind === "CTR") {
      status.set(a, b);
      ctrs.push({ container: a, status: b, image, ports: containerPorts(ports), ...(project && { project, service }) });
      if (project) byProject.set(project, [...(byProject.get(project) ?? []), { service: service || a, container: a, status: b }]);
    }
    if (kind === "LABELS") {
      try {
        labeled.push({ name: a.replace(/^\//, ""), labels: JSON.parse(b ?? "null") ?? {} });
      } catch {}
    }
  }
  const siteProjects = new Set(metas.map(projectName));
  o.others = externals(labeled, status, o.proxy, siteProjects);
  o.dashboard = {
    hosts: [...new Set(labeled.flatMap((x) => dashboardHosts(x.labels)))],
    // Through landfall's tunnel entrypoint, else through a router that serves it on a domain.
    tunnel: labeled.some((x) => x.name === o.proxy && (hasDashboardTunnel(x.labels) || dashboardHosts(x.labels).length > 0)),
  };
  const known = new Set([o.proxy, ...o.others.flatMap((e) => e.containers)]);
  o.unrouted = ctrs
    .filter((x) => isUp(x.status) && !known.has(x.container) && !(x.project && siteProjects.has(x.project)))
    .sort((x, y) => x.container.localeCompare(y.container));
  o.sites = metas.map((meta) => {
    const { hosts, to } = siteRedirects(meta);
    const services = (byProject.get(projectName(meta)) ?? []).sort((x, y) => x.service.localeCompare(y.service));
    const scale = replicaState(meta, services);
    return {
      meta,
      status: siteStatus(meta, services),
      services,
      domains: siteDomains(meta),
      redirects: hosts,
      redirectTo: to,
      main: siteMain(meta)?.name,
      kind: kindOf(meta),
      ...(scale && { scale }),
    };
  });
  return o;
}
