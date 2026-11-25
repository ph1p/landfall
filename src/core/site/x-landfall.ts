import { isIP } from "node:net";
import { DOMAIN } from "../lib/config";
import type { Match, Route, RouteOpts } from "./meta";

/** One or more DNS labels: admin, api.v2. */
const SUBDOMAIN = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const PRIVATE_NAME = /^[a-z0-9][a-z0-9_.-]*$/i;
export const OPT_KEYS = ["sticky", "healthcheck", "ratelimit", "compress", "headers", "retry"];
export const X_KEYS = ["port", "domains", "publish", "routes", "private", "allow", ...OPT_KEYS, "weight", "match", "update"];
const DURATION = /^\d+(ms|s|m|h)$/;
/** An HTTP token (RFC 7230): header and cookie names. */
const TOKEN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/** An IPv4 or IPv6 address, or a CIDR range of one. */
export function isCidr(v: string): boolean {
  const [ip, bits, more] = v.split("/");
  const kind = isIP(ip);
  if (!kind || more !== undefined) return false;
  return bits === undefined || (/^\d{1,3}$/.test(bits) && Number(bits) <= (kind === 4 ? 32 : 128));
}

/** x-landfall.allow of a service or route: a list of addresses; `where` names it in errors. */
export function readAllow(where: string, value: unknown, errors: string[]): string[] | undefined {
  if (value === undefined) return undefined;
  const list = (Array.isArray(value) ? value : [value]).map((v) => String(v).trim());
  const bad = list.filter((v) => !isCidr(v));
  if (bad.length) return void errors.push(`${where}: allow takes IP addresses or CIDR ranges, like allow: [10.0.0.0/8, 203.0.113.7], not ${bad.join(", ")}`);
  if (!list.length) return void errors.push(`${where}: allow is empty, so nobody could reach it; leave it out to allow everyone`);
  return list;
}

/** A cookie name, a header name, and either one's value in x-landfall.match: no character a Traefik rule must escape. */
const MATCH_NAME = /^[A-Za-z0-9_-]+$/;
const MATCH_VALUE = /^[A-Za-z0-9._-]+$/;

/** x-landfall.match: { cookie: ab=b, header: X-Variant=b }, either or both. */
export function readMatch(where: string, x: any, errors: string[]): Match | undefined {
  const form = `${where}: match is { cookie: name=value } or { header: Name=value }, or both, like match: { cookie: ab=b }`;
  if (!x || typeof x !== "object" || Array.isArray(x)) return void errors.push(form);
  const bad = Object.keys(x).filter((k) => k !== "cookie" && k !== "header");
  const m: Match = {};
  for (const k of ["cookie", "header"] as const) {
    if (x[k] === undefined) continue;
    const [name, value, more] = String(x[k]).split("=");
    if (more !== undefined || !MATCH_NAME.test(name ?? "") || !MATCH_VALUE.test(value ?? ""))
      return void errors.push(`${where}: match.${k} is name=value (letters, digits, - and _; the value may have dots), not ${JSON.stringify(x[k])}`);
    m[k] = `${name}=${value}`;
  }
  if (bad.length || !Object.keys(m).length) return void errors.push(form);
  return m;
}

export const posInt = (v: unknown, min = 1) => {
  const n = typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n >= min ? n : undefined;
};

/** The Traefik settings of a service's port or a route (sticky, healthcheck, ratelimit, compress, headers, retry); `where` names it in errors. */
export function readOpts(where: string, x: any, errors: string[]): RouteOpts | undefined {
  const o: RouteOpts = {};
  if (x.sticky !== undefined && x.sticky !== false) {
    if (x.sticky === true) o.sticky = true;
    else if (typeof x.sticky === "string" && TOKEN.test(x.sticky)) o.sticky = x.sticky;
    else errors.push(`${where}: sticky is true or a cookie name, like sticky: true, not ${JSON.stringify(x.sticky)}`);
  }
  if (x.healthcheck !== undefined) {
    const h = typeof x.healthcheck === "string" ? { path: x.healthcheck } : x.healthcheck;
    const bad = h && typeof h === "object" ? Object.keys(h).filter((k) => !["path", "interval", "timeout"].includes(k)) : [];
    if (!h || typeof h !== "object" || typeof h.path !== "string" || !h.path.startsWith("/"))
      errors.push(`${where}: healthcheck is a path, like healthcheck: /health, or { path: /health, interval: 10s, timeout: 3s }`);
    else if (bad.length) errors.push(`${where}: healthcheck knows path, interval and timeout, not ${bad.join(", ")}`);
    else {
      const durs = (["interval", "timeout"] as const).filter((k) => h[k] !== undefined && !DURATION.test(String(h[k])));
      if (durs.length) errors.push(`${where}: healthcheck ${durs.join(" and ")} must be a duration, like 10s`);
      else
        o.healthcheck = {
          path: h.path,
          ...(h.interval !== undefined && { interval: String(h.interval) }),
          ...(h.timeout !== undefined && { timeout: String(h.timeout) }),
        };
    }
  }
  if (x.ratelimit !== undefined) {
    const r = typeof x.ratelimit === "object" && x.ratelimit ? x.ratelimit : { average: x.ratelimit };
    const average = posInt(r.average);
    const burst = r.burst === undefined ? undefined : posInt(r.burst);
    if (average === undefined || (r.burst !== undefined && burst === undefined))
      errors.push(`${where}: ratelimit is requests per second per client, like ratelimit: 20 or { average: 20, burst: 50 }`);
    else o.ratelimit = { average, ...(burst !== undefined && { burst }) };
  }
  if (x.compress !== undefined && x.compress !== false) {
    if (x.compress === true) o.compress = true;
    else errors.push(`${where}: compress is true or false`);
  }
  if (x.headers !== undefined) {
    if (!x.headers || typeof x.headers !== "object" || Array.isArray(x.headers))
      errors.push(`${where}: headers is a mapping of response headers, like headers: { X-Frame-Options: DENY }`);
    else {
      const bad = Object.keys(x.headers).filter((k) => !TOKEN.test(k));
      if (bad.length) errors.push(`${where}: not a header name: ${bad.join(", ")}`);
      else if (Object.keys(x.headers).length)
        o.headers = Object.fromEntries(Object.entries<unknown>(x.headers).map(([k, v]) => [k, v == null ? "" : String(v)]));
    }
  }
  if (x.retry !== undefined) {
    const n = posInt(x.retry);
    if (n === undefined || n > 10) errors.push(`${where}: retry is how many times to try again, 1 to 10`);
    else o.retry = n;
  }
  return Object.keys(o).length ? o : undefined;
}

export const toPort = (v: unknown) => {
  const n = posInt(v);
  return n !== undefined && n <= 65535 ? n : undefined;
};

/** x-landfall's domains: one or a list, each through `expand`; an empty key is an empty list. */
export const readDomains = (value: unknown, expand: (d: string) => string): string[] =>
  (Array.isArray(value) ? value : [value]).filter((d) => d != null).map((d) => expand(String(d).trim()));

/** x-landfall.routes: more ports of the service, each on a subdomain or its own domains. */
export function readRoutes(name: string, value: unknown, expand: (d: string) => string, errors: string[]): Route[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return (void errors.push(`${name}: x-landfall.routes must be a list, like routes: [{ port: 3001, subdomain: admin }]`), []);
  const routes: Route[] = [];
  for (const r of value) {
    const port = toPort(r?.port);
    if (!r || typeof r !== "object" || port === undefined) {
      errors.push(`${name}: each x-landfall.routes entry needs a port, like { port: 3001, subdomain: admin }; got ${JSON.stringify(r)}`);
      continue;
    }
    const unknown = Object.keys(r).filter((k) => !["port", "subdomain", "domains", "allow", ...OPT_KEYS].includes(k));
    if (unknown.length) errors.push(`${name}: a route knows port, subdomain, domains, allow and ${OPT_KEYS.join(", ")}, not ${unknown.join(", ")}`);
    const allow = readAllow(`${name}: the route to ${port}`, r.allow, errors);
    const opts = readOpts(`${name}: the route to ${port}`, r, errors);
    const subdomain = r.subdomain ?? undefined;
    if ((subdomain === undefined) === (r.domains === undefined)) {
      errors.push(
        `${name}: the route to ${port} needs a subdomain (admin: admin.<each site domain>) or domains, not ${subdomain === undefined ? "neither" : "both"}`,
      );
      continue;
    }
    if (subdomain !== undefined) {
      const sub = String(subdomain).trim().toLowerCase();
      if (!SUBDOMAIN.test(sub)) errors.push(`${name}: not a subdomain: ${subdomain}`);
      routes.push({ port, subdomain: sub, ...(allow && { allow }), ...(opts && { opts }) });
    } else {
      const ds = readDomains(r.domains, expand);
      const bad = ds.filter((d) => !DOMAIN.test(d));
      if (bad.length) errors.push(`${name}: not a domain in the route to ${port}: ${bad.join(", ")}`);
      if (!ds.length) errors.push(`${name}: the route to ${port} has no domains`);
      routes.push({ port, domains: ds, ...(allow && { allow }), ...(opts && { opts }) });
    }
  }
  return routes;
}

/**
 * x-landfall.private: { admin: 3001 }: named ports nothing routes. { admin: { port: 3001, path: /admin } } also
 * names the path `lf tunnel` opens.
 */
export function readPrivate(name: string, value: unknown, errors: string[]): { ports: Record<string, number>; paths: Record<string, string> } | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    return (void errors.push(`${name}: x-landfall.private must be a mapping, like private: { admin: 3001 }`), undefined);
  const out = { ports: {} as Record<string, number>, paths: {} as Record<string, string> };
  for (const [k, v] of Object.entries(value)) {
    const long = !!v && typeof v === "object" && !Array.isArray(v);
    const port = toPort(long ? (v as any).port : v);
    const path = long ? (v as any).path : undefined;
    const extra = long ? Object.keys(v).filter((x) => x !== "port" && x !== "path") : [];
    if (!PRIVATE_NAME.test(k)) errors.push(`${name}: not a name in x-landfall.private: ${k}`);
    else if (port === undefined)
      errors.push(
        `${name}: x-landfall.private.${k} must be a port number${long ? " in port:" : ""}, like ${k}: 3001 or ${k}: { port: 3001, path: /${k} }, got ${JSON.stringify(long ? (v as any).port : v)}`,
      );
    else if (extra.length) errors.push(`${name}: x-landfall.private.${k} knows port and path, not ${extra.join(", ")}`);
    else if (path !== undefined && (typeof path !== "string" || !PATH.test(path)))
      errors.push(`${name}: x-landfall.private.${k}.path must start with /, like /${k}, got ${JSON.stringify(path)}`);
    else {
      out.ports[k] = port;
      if (path) out.paths[k] = path;
    }
  }
  return out;
}
/** A URL path with no spaces: /admin, /admin/?tab=users. */
const PATH = /^\/[^\s]*$/;
