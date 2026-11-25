import { currentRelease, type Match, type Release, type RouteOpts, type Route, type Service, type SiteMeta } from "./meta";

export const routed = (s: Service) => !!(s.port || s.own || s.routes?.length);

/** The routed service serving the site's own domains, if any. */
export const isMain = (s: Service) => !!s.port && !s.domains && !s.own;
/** The hosts a routed port serves, as a key: "" for the site's own domains. */
export const hostsKey = (s: Service) => (s.domains ? [...s.domains].sort().join(",") : "");

/** Services that split the traffic to the same hosts by weight (x-landfall.weight): Traefik's file provider routes them. */
export interface SplitGroup {
  /** The router, and the weighted service in the dynamic file (name@file). */
  name: string;
  members: { service: Service; weight: number }[];
}

/** A release's traffic splits: two or more weighted services on the same hosts. lf weight's shares win over x-landfall.weight. */
export function splitGroups(meta: Pick<SiteMeta, "name" | "weights">, services: Service[]): SplitGroup[] {
  return splitSets(services).map((ss) => ({
    name: `${meta.name}-split${ss[0].domains ? `-${ss[0].name.toLowerCase().replace(/\./g, "-")}` : ""}`,
    members: ss.map((s) => ({ service: s, weight: meta.weights?.[s.name] ?? s.weight! })),
  }));
}

/** Services that split their traffic: two or more weighted ones routed on the same hosts. Each set sorted by name; the first leads. */
export function splitSets(services: Service[]): Service[][] {
  const by = new Map<string, Service[]>();
  for (const s of services) if (s.weight !== undefined && s.port && !s.own) by.set(hostsKey(s), [...(by.get(hostsKey(s)) ?? []), s]);
  return [...by.values()].filter((ss) => ss.length > 1).map((ss) => [...ss].sort((a, b) => a.name.localeCompare(b.name)));
}

export const mainService = (r?: Release) => r?.services.find(isMain);
/** The service that serves the site's own domains; none for adopted sites. */
export const siteMain = (meta: SiteMeta) => (meta.adopted ? undefined : mainService(currentRelease(meta)));

/** The domains a route answers on, given the site's. */
export const routeDomains = (r: Route, site: string[]) => r.domains ?? site.map((d) => `${r.subdomain}.${d}`);

/** Domains of every route of a release that names its own: what stays when the site's domains change. */
export const fixedDomains = (services: Service[]) => services.flatMap((s) => [...(s.domains ?? []), ...(s.routes ?? []).flatMap((r) => r.domains ?? [])]);

/** The subdomain routes of a release under these site domains: they come and go with them. */
export const subDomains = (services: Service[], site: string[]) =>
  services.flatMap((s) => (s.routes ?? []).filter((r) => r.subdomain).flatMap((r) => routeDomains(r, site)));

/** The redirect hosts and where they point: none while the site serves no domain of its own. */
export function siteRedirects(meta: SiteMeta): { hosts: string[]; to?: string } {
  const to = siteMain(meta) ? meta.domains[0] : undefined;
  return to ? { hosts: meta.redirects ?? [], to } : { hosts: [] };
}

/** Every domain a site answers on now. */
export function siteDomains(meta: SiteMeta): string[] {
  const r = currentRelease(meta);
  if (!r) return meta.domains;
  return [...new Set([...(mainService(r) ? meta.domains : []), ...fixedDomains(r.services), ...subDomains(r.services, meta.domains)])];
}

/** Every host a site claims: the domains it serves and its redirect hosts (also those waiting for a domain). */
export const siteHosts = (meta: SiteMeta): string[] => [...siteDomains(meta), ...(meta.redirects ?? [])];

/** One Traefik router of a release: a service's own port, or one of its routes. */
export interface Router {
  /** service:port, how \`lf auth --route\` names it. */
  key: string;
  service: string;
  port: number;
  domains: string[];
  main?: boolean;
  subdomain?: string;
  /** The addresses it serves; none: every one. */
  allow?: string[];
  opts?: RouteOpts;
  /** A traffic split's one router: every service in it, the leading `service` first. Its allow, options and login are the lead's. */
  members?: string[];
}

/** How \`lf auth --route\` names a router: the service and the port it routes to. */
export const routeKey = (service: string, port: number) => `${service}:${port}`;

/** What a release routes, port by port: the main service on the site's domains, each route on its own. */
export function routePlan(services: Service[], site: string[]): Router[] {
  const split = new Map(splitSets(services).flatMap((ss) => ss.map((s) => [s, ss] as const)));
  return services.flatMap((s) => {
    if (s.own) return [];
    const ss = split.get(s);
    // A split routes through its lead: the other members get no router of their own.
    const main: Router[] =
      s.port && (!ss || ss[0] === s)
        ? [
            {
              key: routeKey(s.name, s.port),
              service: s.name,
              port: s.port,
              domains: s.domains ?? site,
              ...(isMain(s) && { main: true }),
              ...(s.allow && { allow: s.allow }),
              ...(s.opts && { opts: s.opts }),
              ...(ss && { members: ss.map((m) => m.name) }),
            },
          ]
        : [];
    return [
      ...main,
      ...(s.routes ?? []).map((r) => ({
        key: routeKey(s.name, r.port),
        service: s.name,
        port: r.port,
        domains: routeDomains(r, site),
        ...(r.subdomain && { subdomain: r.subdomain }),
        ...(r.allow && { allow: r.allow }),
        ...(r.opts && { opts: r.opts }),
      })),
    ];
  });
}

/** "cookie ab=b or header X-Variant=b" */
export const matchText = (m: Match) => [m.cookie && `cookie ${m.cookie}`, m.header && `header ${m.header}`].filter(Boolean).join(" or ");

/**
 * The router of the current release that `name` picks: service:port, a subdomain (admin), one of its
 * domains, or a service for its own port. Else the routers there are, for the error.
 */
export function findRoute(meta: SiteMeta, name: string): { key: string; domains: string[] } | { routes: string[] } {
  const all = routePlan(currentRelease(meta)?.services ?? [], meta.domains);
  const want = name.trim().toLowerCase();
  // A service name means its main port: routePlan lists that before the service's routes.
  const hit =
    all.find((r) => r.key.toLowerCase() === want) ??
    all.find((r) => r.subdomain === want) ??
    all.find((r) => r.domains.includes(want)) ??
    all.find((r) => r.service.toLowerCase() === want) ??
    // A service in a traffic split: the split's one router.
    all.find((r) => r.members?.some((m) => m.toLowerCase() === want));
  return hit ? { key: hit.key, domains: hit.domains } : { routes: all.map((r) => r.key) };
}
