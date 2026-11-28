// Pure: the web UI imports this to show one site out of a server's traffic, without node.

export type StatusClass = "2xx" | "3xx" | "4xx" | "5xx";
export const CLASSES: StatusClass[] = ["2xx", "3xx", "4xx", "5xx"];

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
  /** errors: responses 400-405 outside /_lf/, what fail2ban's landfall-http jail counts. */
  ips: { ip: string; count: number; errors: number }[];
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

/**
 * What the proxy's flags say about its access log: JSON or plain text on stdout (what landfall reads), off,
 * written to a file inside the container, or unknown (configured by a file or variables landfall does not read).
 */
export type AccessLog = "json" | "common" | "off" | "file" | "unknown";

/** The access log landfall reads: on stdout, as JSON lines. landfall's Traefik starts with these; `lf traefik access-log on` adds them. */
export const ACCESS_LOG_FLAGS = ["--accesslog=true", "--accesslog.format=json"];

/** How to turn on the access log by hand, for a Traefik landfall cannot change itself. */
export const ACCESS_LOG_HINT = `add ${ACCESS_LOG_FLAGS.join(" ")} to its command (or accessLog: {format: json} to its config file)`;

/**
 * Why the proxy's access log gives landfall nothing to count: off, written to a file, or plain text. `fixable`:
 * `lf traefik access-log` can fix it from the flags; a file path or a config landfall cannot read is left to you.
 */
export function accessLogIssue(t: Pick<Traffic, "accessLog" | "format">): { kind: "off" | "file" | "common"; fixable: boolean } | undefined {
  if (t.accessLog === "off" || t.accessLog === "file") return { kind: t.accessLog, fixable: t.accessLog === "off" };
  if (t.accessLog === "common" || t.format === "common") return { kind: "common", fixable: t.accessLog === "common" };
}

/** The proxy container's log, which holds the access log: Docker's log driver and its size cap. */
export interface ProxyLog {
  driver: string;
  maxSize?: string;
  maxFile?: number;
  /** On disk, rotated files included; missing when this login cannot read it. */
  bytes?: number;
}

/** "capped at 10m × 3 files", "no size limit", or "" for a driver that keeps no file (journald, syslog). */
export function logLimitText(l: ProxyLog): string {
  if (!["json-file", "local"].includes(l.driver)) return "";
  if (!l.maxSize) return "no size limit";
  return `capped at ${l.maxSize}${(l.maxFile ?? 1) > 1 ? ` × ${l.maxFile} files` : ""}`;
}

export interface Traffic {
  at: string;
  since: number;
  bucket: "minute" | "hour";
  /** No proxy container: nothing to read. */
  proxy: boolean;
  /** The server's own traefik (lf traefik use): landfall did not configure its log. */
  own: boolean;
  /** fail2ban's web jails are on (lf fail2ban web on): a client can be banned from HTTP(S). */
  f2bWeb: boolean;
  /** What the log holds: JSON lines landfall reads, only plain-text lines, or nothing in the span. */
  format: "json" | "common" | "none";
  /** The access log as the proxy's flags configure it: `lf traefik access-log` turns it on when it is not "json". */
  accessLog: AccessLog;
  /** Where Docker keeps the proxy's log: `lf traefik access-log clear` empties it. */
  log?: ProxyLog;
  /** First and last request the log still has in the span. */
  from?: string;
  to?: string;
  total: Detail;
  sites: (Summary & { site: string; hosts: string[] })[];
  hosts: HostTraffic[];
}

export const zero = (): Record<StatusClass, number> => ({ "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 });
export const cls = (status: number) => (CLASSES[Math.floor(status / 100) - 2] ?? null) as StatusClass | null;

/** Requests, status classes and response times from status counts and a latency histogram. */
export function summarize(codes: Record<string, number>, hist: Record<string, number>) {
  const classes = zero();
  for (const [code, n] of Object.entries(codes)) {
    const c = cls(Number(code));
    if (c) classes[c] += n;
  }
  return { requests: Object.values(codes).reduce((a, b) => a + b, 0), classes, codes, p50: percentile(hist, 0.5), p95: percentile(hist, 0.95) };
}

export function percentile(hist: Record<string, number>, q: number): number {
  const ks = Object.keys(hist)
    .map(Number)
    .sort((a, b) => a - b);
  const n = ks.reduce((a, k) => a + hist[k], 0);
  let seen = 0;
  for (const k of ks) {
    seen += hist[k];
    if (seen >= q * n) return k ? Math.round(2 ** (k / 4)) : 1;
  }
  return 0;
}

/** Several hosts as one: a site with www and the bare domain, or the whole server. */
export function mergeHosts(hosts: HostTraffic[], keys: string[]): Detail {
  const hist: Record<string, number> = {};
  const codes: Record<string, number> = {};
  const classes = zero();
  const paths = new Map<string, { count: number; errors: number }>();
  const ips = new Map<string, { count: number; errors: number }>();
  const errors = new Map<string, number>();
  const series = new Map(keys.map((at) => [at, zero()]));
  let requests = 0,
    bytes = 0;
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
    for (const i of h.ips) {
      const x = ips.get(i.ip) ?? { count: 0, errors: 0 };
      ips.set(i.ip, { count: x.count + i.count, errors: x.errors + (i.errors ?? 0) });
    }
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
    ips: top([...ips].map(([ip, x]) => ({ ip, ...x }))),
    errors: top([...errors].map(([k, count]) => ({ status: Number(k.slice(0, k.indexOf(" "))), path: k.slice(k.indexOf(" ") + 1), count }))),
    series: [...series].map(([at, x]) => ({ at, ...x })),
  };
}

/** One site's (or a host's) requests out of a server's traffic. */
export function siteTraffic(t: Traffic, site: string): Detail | null {
  const hs = t.hosts.filter((h) => h.site === site || h.host === site);
  return hs.length
    ? mergeHosts(
        hs,
        t.total.series.map((s) => s.at),
      )
    : null;
}
