// No node: imports: the web page uses this too.
import { fail } from "./fail";

/**
 * Redirect hosts as written in `lf domains --redirect`, `.landfall.json` or the web page: lowercase, each once,
 * and a bare name is a subdomain of the site's first domain (`www` = www.example.com). Without one it stays bare.
 */
export function redirectHosts(list: string[], first?: string): string[] {
  const hosts = list.map((d) => d.trim().toLowerCase()).filter(Boolean);
  return [...new Set(hosts.map((d) => (d.includes(".") || !first ? d : `${d}.${first}`)))];
}

/** A host the server's Traefik answers with a redirect, with no site behind it (`lf redirect add`). */
export interface ServerRedirect {
  host: string;
  /** Where it points: with `path`, the request's path and query are appended to it. */
  to: string;
  /** 301/308; false: 302/307. */
  permanent: boolean;
  path: boolean;
}

const HEADER = "# managed by landfall — change it with `lf redirect add` / `lf redirect rm`";
/** Path and query of the request, whatever host it came on. */
const KEEP_PATH = "^https?://[^/]+(.*)";
const PREFIX = "redirect-";

/** Traefik's file provider reads YAML, and JSON is YAML: landfall reads back what it wrote without a YAML parser. */
export function redirectsFile(list: ServerRedirect[]): string {
  const routers: Record<string, unknown> = {};
  const middlewares: Record<string, unknown> = {};
  for (const r of [...list].sort((a, b) => a.host.localeCompare(b.host))) {
    const name = PREFIX + r.host.replace(/\./g, "_");
    routers[name] = { rule: `Host(\`${r.host}\`)`, entryPoints: ["websecure"], tls: { certResolver: "le" }, middlewares: [name], service: "noop@internal" };
    middlewares[name] = {
      redirectRegex: r.path
        ? { regex: KEEP_PATH, replacement: `${r.to}\${1}`, permanent: r.permanent }
        : { regex: ".*", replacement: r.to, permanent: r.permanent },
    };
  }
  return `${HEADER}\n${JSON.stringify({ http: { routers, middlewares } }, null, 2)}\n`;
}

/** The redirects in a file landfall wrote; throws on anything else (a file edited by hand). */
export function parseRedirects(json: string): ServerRedirect[] {
  const doc = JSON.parse(json) as { http?: { routers?: Record<string, any>; middlewares?: Record<string, any> } };
  const list: ServerRedirect[] = [];
  for (const [name, router] of Object.entries(doc.http?.routers ?? {})) {
    const host = /^Host\(`([^`]+)`\)$/.exec(router?.rule ?? "")?.[1];
    const m = doc.http?.middlewares?.[router?.middlewares?.[0]]?.redirectRegex;
    if (!name.startsWith(PREFIX) || !host || !m || typeof m.replacement !== "string") throw new Error(`router ${name} is not a landfall redirect`);
    const path = m.regex === KEEP_PATH;
    list.push({ host, to: path ? m.replacement.replace(/\$\{1\}$/, "") : m.replacement, permanent: !!m.permanent, path });
  }
  return list;
}

/**
 * The target as written to the file: `example.com` → `https://example.com`; with `path`, no trailing slash.
 * Throws a plain Error (no `fail`: the web page previews with it), which the CLI turns into its error.
 */
export function redirectTarget(host: string, to: string, path: boolean): string {
  const raw = /^[a-z][a-z0-9+.-]*:/i.test(to) ? to : `https://${to}`;
  const u = URL.canParse(raw) ? new URL(raw) : fail(`not a URL: ${to}`);
  if (!/^https?:$/.test(u.protocol) || !u.hostname) fail(`not an http(s) URL: ${to}`);
  if (/[$\s]/.test(raw)) fail(`the target cannot contain \`$\` or spaces: ${to}`);
  if (path && (u.search || u.hash || raw.endsWith("?"))) fail(`${to} has a query: the request's path and query cannot follow it (--no-path)`);
  if (u.hostname === host && u.protocol === "https:" && (path || u.pathname === "/")) fail(`${host} would redirect to itself`);
  return path ? `${u.origin}${u.pathname.replace(/\/+$/, "")}` : u.href;
}
