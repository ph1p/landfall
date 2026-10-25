import { X509Certificate } from "node:crypto";
import https from "node:https";
import type { Server } from "./config";
import { siteDomains, type SiteMeta } from "./compose";
import { runScript } from "./ssh";
import { PROXY_CTR, PROXY_FILE, SITES } from "./templates";
import { fail } from "./ui";

/** `24h`, `30m`, `7d`, `90s` → seconds; at most 30 days, what a container log keeps at best. */
export function parseSince(s: string): number {
  const m = /^(\d+)\s*([smhd])$/i.exec(s.trim());
  if (!m) return fail(`not a time span: ${s} (use e.g. 30m, 24h or 7d)`);
  const secs = Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2].toLowerCase() as "s"];
  if (secs < 60 || secs > 30 * 86400) fail(`--since must be between 1m and 30d, not ${s}`);
  return secs;
}

/** `86400` → `24h`. */
export const spanLabel = (secs: number) => (secs % 86400 === 0 ? `${secs / 86400}d` : secs % 3600 === 0 ? `${secs / 3600}h` : `${Math.round(secs / 60)}m`);

/** Up to 6 hours per minute, longer spans per hour: a chart stays at a few hundred points. */
const bucketLen = (secs: number) => (secs <= 6 * 3600 ? 16 : 13);

/** Site and their hosts, the same way every view of a server reads them. */
const SITE_LINES = `for f in ${SITES}/*/site.json; do [ -f "$f" ] || continue; printf 'SITE\\t'; tr -d '\\n' < "$f"; echo; done`;

/**
 * Traefik's JSON access log, aggregated on the server: only counts cross ssh, never a line per request.
 * Per host: requests and bytes by status, a latency histogram (4 buckets per doubling), requests per
 * minute or hour by status class, and the 10 busiest paths, client IPs and failing requests.
 */
export const TRAFFIC = (secs: number) => String.raw`
set +e
P=${PROXY_CTR}
if ! docker inspect "$P" >/dev/null 2>&1; then echo NOPROXY; exit 0; fi
[ -f ${PROXY_FILE} ] && echo OWN
${SITE_LINES}
T=$(printf '\t')
docker logs --since ${secs}s "$P" 2>&1 | LC_ALL=C awk -v B=${bucketLen(secs)} '
function str(k) { if (!match($0, "\"" k "\":\"[^\"]*")) return ""; v = substr($0, RSTART + length(k) + 4, RLENGTH - length(k) - 4); sub(/\\$/, "", v); return v }
function num(k) { return match($0, "\"" k "\":-?[0-9]+") ? substr($0, RSTART + length(k) + 3, RLENGTH - length(k) - 3) + 0 : 0 }
/^\{.*"RequestHost":/ {
  # The tunnel entrypoint is lf traefik dashboard, not traffic.
  if (str("entryPointName") == "tunnel") next
  h = tolower(str("RequestHost")); sub(/:[0-9]+$/, "", h); if (h == "") h = "-"
  s = num("DownstreamStatus"); ms = num("Duration") / 1000000; t = str("StartUTC")
  p = str("RequestPath"); sub(/\?.*/, "", p); if (length(p) > 80) p = substr(p, 1, 77) "..."; if (p == "") p = "/"
  if (first == "" || t < first) first = t; if (t > last) last = t
  C[h SUBSEP s]++; CB[h SUBSEP s] += num("DownstreamContentSize")
  L[h SUBSEP (ms < 1 ? 0 : int(log(ms) / log(2) * 4) + 1)]++
  S[h SUBSEP substr(t, 1, B) SUBSEP int(s / 100)]++
  PA[h SUBSEP p]++; if (s >= 400) { PE[h SUBSEP p]++; E[h SUBSEP s " " p]++ }
  I[h SUBSEP str("ClientHost")]++
  n++; next
}
# The plain-text (common) format: traefik set up before landfall switched it to JSON.
/^[0-9a-fA-F.:]+ - [^ ]+ \[[^]]+\] "/ { common++ }
END {
  print "N\t" n + 0 "\t" common + 0 "\t" first "\t" last
  for (x in C) { split(x, a, SUBSEP); print "C\t" a[1] "\t" a[2] "\t" C[x] "\t" CB[x] }
  for (x in L) { split(x, a, SUBSEP); print "L\t" a[1] "\t" a[2] "\t" L[x] }
  for (x in S) { split(x, a, SUBSEP); print "S\t" a[1] "\t" a[2] "\t" a[3] "\t" S[x] }
  for (x in PA) { split(x, a, SUBSEP); print "P\t" a[1] "\t" a[2] "\t" PA[x] "\t" PE[x] + 0 }
  for (x in I) { split(x, a, SUBSEP); print "I\t" a[1] "\t" a[2] "\t" I[x] }
  for (x in E) { split(x, a, SUBSEP); print "E\t" a[1] "\t" a[2] "\t" E[x] }
}' | LC_ALL=C sort -t"$T" -k1,1 -k2,2 -k4,4nr | awk -F'\t' '($1 != "P" && $1 != "I" && $1 != "E") || n[$1 FS $2]++ < 10'
exit 0
`;

export type StatusClass = "2xx" | "3xx" | "4xx" | "5xx";
const CLASSES: StatusClass[] = ["2xx", "3xx", "4xx", "5xx"];

export interface Summary {
  requests: number;
  /** Bytes sent to clients. */
  bytes: number;
  classes: Record<StatusClass, number>;
  codes: Record<string, number>;
  /** Milliseconds, from the histogram: within about 20%. */
  p50: number;
  p95: number;
}

export interface Detail extends Summary {
  paths: { path: string; count: number; errors: number }[];
  ips: { ip: string; count: number }[];
  errors: { status: number; path: string; count: number }[];
  /** Every minute or hour of the span, oldest first, empty ones included. */
  series: ({ at: string } & Record<StatusClass, number>)[];
}

export interface HostTraffic extends Detail {
  host: string;
  site?: string;
  /** Latency histogram: bucket k counts requests up to 2^(k/4) ms. */
  hist: Record<string, number>;
}

export interface Traffic {
  at: string;
  since: number;
  bucket: "minute" | "hour";
  /** No proxy container: nothing to read. */
  proxy: boolean;
  /** The server's own traefik (lf traefik use): landfall did not configure its log. */
  own: boolean;
  /** What the log holds: JSON lines landfall reads, only plain-text lines, or nothing in the span. */
  format: "json" | "common" | "none";
  /** First and last request the log still has in the span. */
  from?: string;
  to?: string;
  total: Detail;
  sites: (Summary & { site: string; hosts: string[] })[];
  hosts: HostTraffic[];
}

const zero = (): Record<StatusClass, number> => ({ "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 });
const cls = (status: number) => (CLASSES[Math.floor(status / 100) - 2] ?? null) as StatusClass | null;

function percentile(hist: Record<string, number>, q: number): number {
  const ks = Object.keys(hist).map(Number).sort((a, b) => a - b);
  const n = ks.reduce((a, k) => a + hist[k], 0);
  let seen = 0;
  for (const k of ks) {
    seen += hist[k];
    if (seen >= q * n) return k ? Math.round(2 ** (k / 4)) : 1;
  }
  return 0;
}

/** The buckets of the span ending now: `2026-10-25T15` (hour) or `2026-10-25T15:04` (minute). */
function buckets(secs: number, now: Date): string[] {
  const len = bucketLen(secs);
  const step = len === 16 ? 60_000 : 3_600_000;
  const end = Math.floor(now.getTime() / step) * step;
  const out: string[] = [];
  for (let t = end - Math.ceil(secs / (step / 1000)) * step + step; t <= end; t += step) out.push(new Date(t).toISOString().slice(0, len));
  return out;
}

/** Several hosts as one: a site with www and the bare domain, or the whole server. */
export function mergeHosts(hosts: HostTraffic[], keys: string[]): Detail {
  const hist: Record<string, number> = {};
  const codes: Record<string, number> = {};
  const classes = zero();
  const paths = new Map<string, { count: number; errors: number }>();
  const ips = new Map<string, number>();
  const errors = new Map<string, number>();
  const series = new Map(keys.map((at) => [at, zero()]));
  let requests = 0, bytes = 0;
  for (const h of hosts) {
    requests += h.requests;
    bytes += h.bytes;
    for (const [k, v] of Object.entries(h.hist)) hist[k] = (hist[k] ?? 0) + v;
    for (const [k, v] of Object.entries(h.codes)) codes[k] = (codes[k] ?? 0) + v;
    for (const c of CLASSES) classes[c] += h.classes[c];
    for (const p of h.paths) {
      const x = paths.get(p.path) ?? { count: 0, errors: 0 };
      paths.set(p.path, { count: x.count + p.count, errors: x.errors + p.errors });
    }
    for (const i of h.ips) ips.set(i.ip, (ips.get(i.ip) ?? 0) + i.count);
    for (const e of h.errors) errors.set(`${e.status} ${e.path}`, (errors.get(`${e.status} ${e.path}`) ?? 0) + e.count);
    for (const s of h.series) {
      const x = series.get(s.at);
      if (x) for (const c of CLASSES) x[c] += s[c];
    }
  }
  const top = <T extends { count: number }>(xs: T[]) => xs.sort((a, b) => b.count - a.count).slice(0, 10);
  return {
    requests,
    bytes,
    classes,
    codes,
    p50: percentile(hist, 0.5),
    p95: percentile(hist, 0.95),
    paths: top([...paths].map(([path, x]) => ({ path, ...x }))),
    ips: top([...ips].map(([ip, count]) => ({ ip, count }))),
    errors: top([...errors].map(([k, count]) => ({ status: Number(k.slice(0, k.indexOf(" "))), path: k.slice(k.indexOf(" ") + 1), count }))),
    series: [...series].map(([at, x]) => ({ at, ...x })),
  };
}

/** Which site answers a host: exact domains first, then wildcard ones (`*.example.com`). */
function siteOf(sites: Map<string, string>, host: string): string | undefined {
  return sites.get(host) ?? sites.get(`*.${host.slice(host.indexOf(".") + 1)}`);
}

function siteHosts(out: string): Map<string, string> {
  const sites = new Map<string, string>();
  for (const line of out.split("\n")) {
    if (!line.startsWith("SITE\t")) continue;
    try {
      const meta = JSON.parse(line.slice(5)) as SiteMeta;
      for (const d of siteDomains(meta)) sites.set(d.toLowerCase(), meta.name);
    } catch {}
  }
  return sites;
}

export function parseTraffic(out: string, secs: number, now = new Date()): Traffic {
  const keys = buckets(secs, now);
  const sites = siteHosts(out);
  const hosts = new Map<string, Omit<HostTraffic, keyof Summary | "series"> & { codes: Record<string, number>; bytes: number; series: Map<string, Record<StatusClass, number>> }>();
  const host = (h: string) => {
    let x = hosts.get(h);
    if (!x) hosts.set(h, (x = { host: h, ...(siteOf(sites, h) && { site: siteOf(sites, h) }), codes: {}, bytes: 0, hist: {}, paths: [], ips: [], errors: [], series: new Map() }));
    return x;
  };
  const t: Traffic = { at: now.toISOString(), since: secs, bucket: bucketLen(secs) === 16 ? "minute" : "hour", proxy: true, own: false, format: "none", total: mergeHosts([], keys), sites: [], hosts: [] };
  for (const line of out.split("\n")) {
    const f = line.split("\t");
    if (f[0] === "NOPROXY") t.proxy = false;
    else if (f[0] === "OWN") t.own = true;
    else if (f[0] === "N") {
      t.format = Number(f[1]) ? "json" : Number(f[2]) ? "common" : "none";
      if (f[3]) (t.from = f[3]), (t.to = f[4]);
    } else if (f[0] === "C") {
      const x = host(f[1]);
      x.codes[f[2]] = (x.codes[f[2]] ?? 0) + Number(f[3]);
      x.bytes += Number(f[4]) || 0;
    } else if (f[0] === "L") host(f[1]).hist[f[2]] = Number(f[3]);
    else if (f[0] === "S") {
      const c = cls(Number(f[3]) * 100);
      if (!c) continue;
      const s = host(f[1]).series;
      const at = s.get(f[2]) ?? zero();
      at[c] += Number(f[4]);
      s.set(f[2], at);
    } else if (f[0] === "P") host(f[1]).paths.push({ path: f[2], count: Number(f[3]), errors: Number(f[4]) || 0 });
    else if (f[0] === "I") host(f[1]).ips.push({ ip: f[2], count: Number(f[3]) });
    else if (f[0] === "E") {
      const i = f[2].indexOf(" ");
      host(f[1]).errors.push({ status: Number(f[2].slice(0, i)), path: f[2].slice(i + 1), count: Number(f[3]) });
    }
  }
  t.hosts = [...hosts.values()]
    .map((x) => {
      const classes = zero();
      for (const [code, n] of Object.entries(x.codes)) {
        const c = cls(Number(code));
        if (c) classes[c] += n;
      }
      const requests = Object.values(x.codes).reduce((a, b) => a + b, 0);
      return { ...x, requests, classes, p50: percentile(x.hist, 0.5), p95: percentile(x.hist, 0.95), series: keys.map((at) => ({ at, ...(x.series.get(at) ?? zero()) })) };
    })
    .sort((a, b) => b.requests - a.requests);
  t.total = mergeHosts(t.hosts, keys);
  const bySite = Map.groupBy(t.hosts.filter((h) => h.site), (h) => h.site!);
  t.sites = [...bySite]
    .map(([site, hs]) => {
      const { paths, ips, errors, series, ...sum } = mergeHosts(hs, keys);
      return { site, hosts: hs.map((h) => h.host), ...sum };
    })
    .sort((a, b) => b.requests - a.requests);
  return t;
}

export async function traffic(s: Server, secs: number): Promise<Traffic> {
  const { stdout } = await runScript(s, TRAFFIC(secs), { capture: true });
  return parseTraffic(stdout, secs);
}

/** One site's (or a host's) requests out of a server's traffic. */
export function siteTraffic(t: Traffic, site: string): Detail | null {
  const hs = t.hosts.filter((h) => h.site === site || h.host === site);
  return hs.length ? mergeHosts(hs, t.total.series.map((s) => s.at)) : null;
}

// ---- certificates ----------------------------------------------------------

/**
 * Certificates of the proxy, found in what it mounts: acme.json (Let's Encrypt) and certificate files
 * (dynamic/). Only certificates leave the server, never keys: from acme.json the "certificate" fields,
 * from files the first CERTIFICATE block. Plus the proxy's ACME errors in the span.
 */
export const CERTS = (secs: number) => String.raw`
set +e
P=${PROXY_CTR}
if ! docker inspect "$P" >/dev/null 2>&1; then echo NOPROXY; exit 0; fi
${SITE_LINES}
readf() { cat "$1" 2>/dev/null || sudo -n cat "$1" 2>/dev/null; }
for d in $(docker inspect -f '{{range .Mounts}}{{.Source}} {{end}}' "$P"); do
  [ -d "$d" ] || [ -f "$d" ] || continue
  case "$d" in */docker.sock) continue ;; esac
  # Directories in letsencrypt/ belong to root and may not be listable: name acme.json directly too.
  { find "$d" -maxdepth 2 \( -name '*.json' -o -name '*.crt' -o -name '*.pem' -o -name '*.cert' \) 2>/dev/null; [ -d "$d" ] && echo "$d/acme.json"; } | sort -u | while read -r f; do
    case "$f" in
      *.json)
        [ -e "$f" ] || sudo -n test -e "$f" 2>/dev/null || continue
        j=$(readf "$f") || { printf 'DENIED\t%s\n' "$f"; continue; }
        printf '%s' "$j" | grep -q '"Certificates"' || continue
        printf 'ACME\t%s\n' "$f"
        printf '%s' "$j" | grep -o '"certificate": *"[^"]*"' | awk -F'"' '{ print "CERT\tacme\t" $(NF - 1) }' ;;
      *)
        b=$(readf "$f" | awk '/-----BEGIN CERTIFICATE-----/ { p = 1 } p { print } /-----END CERTIFICATE-----/ { exit }' | base64 | tr -d '\n')
        [ -n "$b" ] && printf 'CERT\t%s\t%s\n' "$f" "$b" ;;
    esac
  done
done
docker logs --since ${secs}s "$P" 2>&1 | grep -v '^{' | grep -i acme | grep -E ' ERR |level=error' | tail -n 100 | sed 's/^/LOG\t/'
exit 0
`;

export interface Cert {
  domains: string[];
  expires: string;
  days: number;
  issuer: string;
  /** Let's Encrypt's staging CA: browsers do not trust it. */
  staging: boolean;
  source: "acme" | "file";
  path?: string;
}

export interface CertError {
  at?: string;
  domains: string[];
  error: string;
}

export interface Certs {
  at: string;
  proxy: boolean;
  /** acme.json files found; denied ones need root. */
  acme: string[];
  denied: string[];
  certs: Cert[];
  errors: CertError[];
  /** Each site domain with the certificate that covers it (by expiry, latest first) and its last error. */
  domains: { domain: string; site: string; cert?: Cert; error?: CertError }[];
}

const ANSI = /\x1b\[[0-9;]*m/g;

/** A traefik log line about an ACME failure: when, for which domains, why. */
export function parseCertError(raw: string): CertError | null {
  const line = raw.replace(ANSI, "");
  const at = /^(\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:?\d\d))/.exec(line)?.[1] ?? /time="([^"]+)"/.exec(line)?.[1];
  let domains: string[] = [];
  const list = /domains=(\[[^\]]*\])/.exec(line)?.[1];
  if (list) {
    try {
      domains = JSON.parse(list);
    } catch {}
  }
  if (!domains.length) domains = (/domains \[([^\]]*)\]/.exec(line)?.[1] ?? "").split(/[\s,]+/).filter(Boolean);
  const error = /error="((?:[^"\\]|\\.)*)"/.exec(line)?.[1]?.replace(/\\"/g, '"') ?? /msg="((?:[^"\\]|\\.)*)"/.exec(line)?.[1] ?? line.replace(/^\S+\s+(ERR\s+)?/, "");
  return domains.length || error ? { ...(at && { at }), domains, error: error.trim() } : null;
}

/** Leaf certificate of a PEM chain (base64-wrapped, as acme.json and the probe carry it). */
export function readCert(b64: string, source: Cert["source"], path?: string, now = new Date()): Cert | null {
  try {
    const x = new X509Certificate(Buffer.from(b64, "base64"));
    const domains = (x.subjectAltName ?? "")
      .split(/,\s*/)
      .filter((d) => d.startsWith("DNS:"))
      .map((d) => d.slice(4).toLowerCase());
    const cn = /CN=([^\n,]+)/.exec(x.subject)?.[1];
    const expires = new Date(x.validTo);
    const issuer = [/O=([^\n]+)/.exec(x.issuer)?.[1], /CN=([^\n]+)/.exec(x.issuer)?.[1]].filter(Boolean).join(" · ");
    return {
      domains: domains.length ? domains : cn ? [cn.toLowerCase()] : [],
      expires: expires.toISOString(),
      days: Math.floor((expires.getTime() - now.getTime()) / 86_400_000),
      issuer,
      staging: /staging|fake|\(STAGING\)/i.test(x.issuer),
      source,
      ...(path && { path }),
    };
  } catch {
    return null;
  }
}

/** Whether a certificate name covers a host: exact, or a wildcard for exactly one label. */
export const covers = (name: string, host: string) => name === host || (name.startsWith("*.") && host.slice(host.indexOf(".") + 1) === name.slice(2) && host.indexOf(".") > 0);

export function parseCerts(out: string, now = new Date()): Certs {
  const r: Certs = { at: now.toISOString(), proxy: true, acme: [], denied: [], certs: [], errors: [], domains: [] };
  for (const line of out.split("\n")) {
    const f = line.split("\t");
    if (f[0] === "NOPROXY") r.proxy = false;
    else if (f[0] === "ACME") r.acme.push(f[1]);
    else if (f[0] === "DENIED") r.denied.push(f[1]);
    else if (f[0] === "CERT") {
      const c = readCert(f[2], f[1] === "acme" ? "acme" : "file", f[1] === "acme" ? undefined : f[1], now);
      if (c) r.certs.push(c);
    } else if (f[0] === "LOG") {
      const e = parseCertError(line.slice(4));
      if (e) r.errors.push(e);
    }
  }
  r.certs.sort((a, b) => (a.domains[0] ?? "").localeCompare(b.domains[0] ?? "") || b.days - a.days);
  const sites = siteHosts(out);
  r.domains = [...sites]
    .filter(([d]) => !d.startsWith("*."))
    .map(([domain, site]) => {
      const cert = r.certs.filter((c) => c.domains.some((n) => covers(n, domain))).sort((a, b) => b.days - a.days)[0];
      const error = r.errors.filter((e) => e.domains.includes(domain)).at(-1);
      return { domain, site, ...(cert && { cert }), ...(error && { error }) };
    })
    .sort((a, b) => a.site.localeCompare(b.site) || a.domain.localeCompare(b.domain));
  return r;
}

export async function certs(s: Server, secs = 7 * 86400): Promise<Certs> {
  const { stdout } = await runScript(s, CERTS(secs), { capture: true });
  return parseCerts(stdout);
}

// ---- checks from here --------------------------------------------------------

export interface Check {
  domain: string;
  site?: string;
  ok: boolean;
  status?: number;
  /** Until the response headers arrived, connection and TLS included. */
  ms?: number;
  error?: string;
  tls?: { valid: boolean; error?: string; expires: string; days: number; issuer: string };
}

/** A certificate this close to expiry means renewal fails: Let's Encrypt renews 30 days ahead. */
export const CERT_DAYS_BAD = 7;

/**
 * One HTTPS request from this machine, the way a visitor sees the site: status, time to the response,
 * and the certificate served. `resolve` connects to that address (ip or ip:port) instead of DNS.
 */
export function checkUrl(domain: string, o: { resolve?: string; timeout?: number } = {}): Promise<Check> {
  // ip, ip:port, [ipv6]:port; a bare IPv6 address has more than one colon.
  const [addr, port] = !o.resolve ? [] : /^[^:]*(:[^:]*)?$|^\[/.test(o.resolve) ? (/^\[?([^\]]+?)\]?(?::(\d+))?$/.exec(o.resolve)?.slice(1) ?? []) : [o.resolve];
  const start = performance.now();
  return new Promise((done) => {
    const req = https.request(
      { host: addr || domain, port: Number(port) || 443, servername: domain, path: "/", method: "GET", headers: { host: domain, "user-agent": "landfall-check" }, rejectUnauthorized: false, agent: false, timeout: o.timeout ?? 10_000 },
      (res) => {
        const ms = Math.round(performance.now() - start);
        const sock = res.socket as import("node:tls").TLSSocket;
        const peer = sock.getPeerCertificate();
        const tls = peer?.valid_to
          ? {
              valid: sock.authorized,
              ...(!sock.authorized && { error: String(sock.authorizationError ?? "not trusted") }),
              expires: new Date(peer.valid_to).toISOString(),
              days: Math.floor((new Date(peer.valid_to).getTime() - Date.now()) / 86_400_000),
              issuer: [peer.issuer?.O, peer.issuer?.CN].filter(Boolean).join(" · "),
            }
          : undefined;
        res.resume();
        req.destroy();
        const status = res.statusCode ?? 0;
        done({ domain, ok: status < 500 && !!tls?.valid && tls.days >= CERT_DAYS_BAD, status, ms, ...(tls && { tls }) });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", (e: any) => done({ domain, ok: false, error: e?.code ?? e?.message ?? String(e) }));
    req.end();
  });
}
