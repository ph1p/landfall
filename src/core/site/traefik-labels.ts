import type { Match, RouteOpts, Service, SiteMeta } from "./meta";
import { routeKey, type Router } from "./routing";
import type { Proxy } from "../ssh/templates";

/** The Traefik (v3) rule that tells a matching request: the cookie among the Cookie header's pairs, or the header's exact value. */
function matchRule(m: Match): string {
  const re = (v: string) => v.replace(/\./g, "\\.");
  const parts: string[] = [];
  if (m.cookie) parts.push(`HeaderRegexp(\`Cookie\`, \`(^|;\\s*)${re(m.cookie)}(;|$)\`)`);
  if (m.header) {
    const [k, v] = m.header.split("=");
    parts.push(`Header(\`${k}\`, \`${v}\`)`);
  }
  return parts.join(" || ");
}

/** The login a router asks for: the Traefik middleware that holds it, and its htpasswd lines. */
export interface Login {
  middleware: string;
  users: string[];
}

/**
 * A router of its own for the redirect hosts: Traefik answers 301 (308 for other methods than GET) to `to`,
 * same path and query. No login or address check: it only points elsewhere.
 */
export function redirectLabels(site: string, s: Service, port: number, hosts: string[], to: string, proxy: Proxy): Record<string, string> {
  const r = routerName(site, s, port);
  const name = `${r}-redirect`;
  return {
    ...routerLabels(name, hosts, r, proxy),
    [`traefik.http.routers.${name}.middlewares`]: name,
    [`traefik.http.middlewares.${name}.redirectregex.regex`]: "^https?://[^/]+(.*)",
    [`traefik.http.middlewares.${name}.redirectregex.replacement`]: `https://${to}\${1}`,
    [`traefik.http.middlewares.${name}.redirectregex.permanent`]: "true",
  };
}

/** Traefik's name for the router to port `port` of `s`, and for its load balancer service. */
export function routerName(site: string, s: Service, port: number) {
  // "_" can't be in a site name: blog + admin-web and blog-admin + web would both be blog-admin-web.
  // A route's router carries its port: blog_web_3001 next to blog_web.
  return `${site}_${s.name.toLowerCase().replace(/\./g, "-")}${port === s.port ? "" : `_${port}`}`;
}

/** The login of the router to port `port` of `s`: its own (lf auth --route), else the site's; none: it is public. */
export function routerLogin(meta: Pick<SiteMeta, "name" | "auth" | "routeAuth">, s: Service, port: number): Login | undefined {
  const own = meta.routeAuth?.[routeKey(s.name, port)];
  if (own) return own.length ? { middleware: `${routerName(meta.name, s, port)}-auth`, users: own } : undefined;
  return meta.auth?.length ? { middleware: `${meta.name}-auth`, users: meta.auth } : undefined;
}

/** Traefik labels for one router of `s`. */
/** A router `name` for `hosts` over HTTPS, handing requests to `service`. */
const hostRule = (hosts: string[]) => hosts.map((d) => `Host(\`${d}\`)`).join(" || ");

function routerLabels(name: string, hosts: string[], service: string, proxy: Proxy): Record<string, string> {
  return {
    [`traefik.http.routers.${name}.rule`]: hostRule(hosts),
    [`traefik.http.routers.${name}.entrypoints`]: proxy.entrypoint,
    [`traefik.http.routers.${name}.tls.certresolver`]: proxy.resolver,
    [`traefik.http.routers.${name}.service`]: service,
  };
}

/** The load balancer settings of Traefik service `svc`: sticky sessions and Traefik's health check. */
function balancerLabels(svc: string, o: RouteOpts = {}): Record<string, string> {
  const lb = `traefik.http.services.${svc}.loadbalancer`;
  return {
    ...(o.sticky && {
      [`${lb}.sticky.cookie`]: "true",
      ...(typeof o.sticky === "string" && { [`${lb}.sticky.cookie.name`]: o.sticky }),
      [`${lb}.sticky.cookie.secure`]: "true",
      [`${lb}.sticky.cookie.httponly`]: "true",
    }),
    ...(o.healthcheck && {
      [`${lb}.healthcheck.path`]: o.healthcheck.path,
      ...(o.healthcheck.interval && { [`${lb}.healthcheck.interval`]: o.healthcheck.interval }),
      ...(o.healthcheck.timeout && { [`${lb}.healthcheck.timeout`]: o.healthcheck.timeout }),
    }),
  };
}

/**
 * Traefik labels for one router of `s`. In a traffic split, `split` names the router every member shares;
 * it hands requests to the weighted service of the file provider, and each member keeps its own load balancer.
 */
export function routeLabels(
  site: string,
  s: Service,
  { port, domains, allow, opts }: Pick<Router, "port" | "domains" | "allow" | "opts">,
  proxy: Proxy,
  login?: Login,
  split?: string,
): Record<string, string> {
  const svc = routerName(site, s, port);
  const r = split ?? svc;
  const out: Record<string, string> = {
    "traefik.enable": "true",
    "traefik.docker.network": proxy.network,
    ...routerLabels(r, domains, split ? `${split}@file` : svc, proxy),
    [`traefik.http.services.${svc}.loadbalancer.server.port`]: String(port),
    ...balancerLabels(svc, opts),
  };
  // The address check comes first: a refused address never sees the login prompt, nor counts against the rate limit.
  const chain: string[] = [];
  const mw = (name: string, set: Record<string, string>) => {
    for (const [k, v] of Object.entries(set)) out[`traefik.http.middlewares.${name}.${k}`] = v;
    chain.push(name);
  };
  if (allow?.length) mw(`${r}-allow`, { "ipallowlist.sourcerange": allow.join(",") });
  if (opts?.ratelimit)
    mw(`${r}-ratelimit`, {
      "ratelimit.average": String(opts.ratelimit.average),
      ...(opts.ratelimit.burst !== undefined && { "ratelimit.burst": String(opts.ratelimit.burst) }),
    });
  if (login) mw(login.middleware, { "basicauth.users": login.users.join(",") });
  if (opts?.headers) mw(`${r}-headers`, Object.fromEntries(Object.entries(opts.headers).map(([k, v]) => [`headers.customresponseheaders.${k}`, v])));
  if (opts?.compress) mw(`${r}-compress`, { compress: "true" });
  if (opts?.retry) mw(`${r}-retry`, { "retry.attempts": String(opts.retry) });
  if (chain.length) out[`traefik.http.routers.${r}.middlewares`] = chain.join(",");
  if (split && s.match) Object.assign(out, matchLabels(svc, s.match, domains, proxy, chain));
  return out;
}

/** The name of a split member's x-landfall.match router: its own router name plus this. */
export const MATCH_SUFFIX = "-match";

/**
 * x-landfall.match: a second router to one member of a traffic split, for requests with its cookie or header.
 * Its rule is longer than the split's, so Traefik tries it first. It runs the split router's middlewares:
 * a cookie must never get around the address check or the login.
 */
function matchLabels(svc: string, m: Match, hosts: string[], proxy: Proxy, middlewares: string[]): Record<string, string> {
  const r = `${svc}${MATCH_SUFFIX}`;
  return {
    ...routerLabels(r, hosts, svc, proxy),
    [`traefik.http.routers.${r}.rule`]: `(${hostRule(hosts)}) && (${matchRule(m)})`,
    ...(middlewares.length && { [`traefik.http.routers.${r}.middlewares`]: middlewares.join(",") }),
  };
}
