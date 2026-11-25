import { defineCommand, serverOpt } from "../cmd";
import { serverTarget } from "../target";
import { DOMAIN } from "../../core/lib/config";
import { bytes } from "../../core/server/facts";
import { ms } from "../../core/lib/format";
import { overview } from "../../core/server/overview";
import { CERT_DAYS_BAD, certs, checkUrl, type Cert, type Check } from "../../core/traefik/certs";
import { parseSince, spanLabel, traffic } from "../../core/traefik/traffic";
import { ACCESS_LOG_HINT, accessLogIssue, siteTraffic, type Detail, type Summary, type Traffic } from "../../core/traefik/traffic-merge";
import { c, fail, info, table, warn, printJson } from "../../core/lib/term";
import { siteTrafficView } from "../../core/views/views";

const num = (n: number) => n.toLocaleString("en-US");
const BARS = "▁▂▃▄▅▆▇█";

/** Requests per bucket as one line of block characters, errors in red where a bucket has any 5xx. */
function sparkline(series: Detail["series"]) {
  const tot = series.map((s) => s["2xx"] + s["3xx"] + s["4xx"] + s["5xx"]);
  const max = Math.max(1, ...tot);
  // A terminal line holds about 100 of them: merge neighbours until it fits.
  const per = Math.ceil(series.length / 100);
  let out = "";
  for (let i = 0; i < series.length; i += per) {
    const n = tot.slice(i, i + per).reduce((a, b) => a + b, 0) / per;
    const bad = series.slice(i, i + per).some((s) => s["5xx"]);
    const ch = n ? BARS[Math.min(7, Math.ceil((n / max) * 8) - 1)] : " ";
    out += bad ? c.red(ch) : c.cyan(ch);
  }
  return out;
}

const classCells = (s: Summary) => [
  num(s.requests),
  s.classes["4xx"] ? c.yellow(num(s.classes["4xx"])) : c.dim("0"),
  s.classes["5xx"] ? c.red(num(s.classes["5xx"])) : c.dim("0"),
  s.requests ? ms(s.p50) : "",
  s.requests ? ms(s.p95) : "",
  bytes(s.bytes),
];

function printDetail(d: Detail, what: string) {
  table([["requests", "4xx", "5xx", "p50", "p95", "sent"].map(c.dim), classCells(d)]);
  console.log(`\n${c.dim(`requests per ${what}`)}  ${sparkline(d.series)}`);
  if (d.paths.length) {
    console.log(`\n${c.bold("Paths")}`);
    table(d.paths.map((p) => [num(p.count), p.errors ? c.yellow(`${num(p.errors)} failed`) : "", p.path]));
  }
  if (d.errors.length) {
    console.log(`\n${c.bold("Errors")}`);
    table(d.errors.map((e) => [num(e.count), e.status >= 500 ? c.red(String(e.status)) : c.yellow(String(e.status)), e.path]));
  }
  if (d.ips.length) {
    console.log(`\n${c.bold("Clients")}`);
    table(d.ips.map((i) => [num(i.count), i.ip]));
  }
  const codes = Object.entries(d.codes).sort((a, b) => b[1] - a[1]);
  if (codes.length) console.log(`\n${c.dim("status codes")}  ${codes.map(([k, v]) => `${k} ${num(v)}`).join(c.dim(" · "))}`);
}

export const trafficCmd = defineCommand({
  name: "traffic",
  args: "[site]",
  summary: "Show requests, errors, response times, busiest paths and clients from Traefik's access log.\nWith a site (or a domain), only its requests.",
  options: {
    server: serverOpt,
    since: { type: "string", desc: "how far back: 30m, 24h, 7d (up to what the container log still holds)", default: "24h" },
    json: { type: "boolean", desc: "machine-readable output" },
  },
  async run([site], o) {
    const { name, server } = serverTarget(o);
    const secs = parseSince(o.since);
    const t = await traffic(server, secs);
    if (!t.proxy) fail(`no traefik on ${name} (lf traefik setup)`);
    const one = site ? siteTraffic(t, site) : null;
    if (o.json) return void printJson(site ? siteTrafficView(t, site) : t);
    // A log landfall cannot read: say why, and how to fix it, before "no requests".
    const problem = accessLogProblem(t, name, o.server ? ` -s ${name}` : "");
    if (problem) {
      warn(problem);
      if (t.format !== "json") return;
    }
    const span = spanLabel(secs);
    if (t.format === "none") {
      return info(
        `no requests on ${name} in the last ${span}${t.accessLog === "unknown" && t.own ? c.dim(` (or its traefik has no access log: ${ACCESS_LOG_HINT})`) : ""}`,
      );
    }
    // The container log is capped (lf log-limit): it may not reach back the whole span.
    const short = t.from && new Date(t.from).getTime() - (Date.now() - secs * 1000) > (t.bucket === "hour" ? 3_600_000 : 60_000) * 2;
    console.log(`${c.bold(name)}${c.dim(` · last ${span}${short ? ` · the log reaches back to ${new Date(t.from!).toLocaleString()}` : ""}`)}`);
    if (site) {
      if (!one) fail(`no requests for "${site}" on ${name} in the last ${span}`);
      return printDetail(one!, t.bucket);
    }
    const other = t.hosts.filter((h) => !h.site);
    table([
      ["site", "requests", "4xx", "5xx", "p50", "p95", "sent"].map(c.dim),
      ...t.sites.map((s) => [c.bold(s.site), ...classCells(s)]),
      ...other.slice(0, 8).map((h) => [c.dim(h.host), ...classCells(h)]),
      ...(other.length > 8 ? [[c.dim(`${other.length - 8} more hosts`), ...classCells(mergeSummary(other.slice(8)))]] : []),
      [c.dim("total"), ...classCells(t.total)],
    ]);
    console.log(`\n${c.dim(`requests per ${t.bucket}`)}  ${sparkline(t.total.series)}`);
    if (t.total.errors.length) {
      console.log(`\n${c.bold("Errors")}`);
      table(t.total.errors.slice(0, 5).map((e) => [num(e.count), e.status >= 500 ? c.red(String(e.status)) : c.yellow(String(e.status)), e.path]));
    }
    console.log(c.dim(`\nlf traffic <site> for its paths, errors and clients`));
  },
});

/** Why lf traffic shows nothing from this proxy's access log, and the command or edit that fixes it. */
function accessLogProblem(t: Traffic, name: string, sflag: string): string | undefined {
  const issue = accessLogIssue(t);
  if (!issue) return;
  const fix = `\`lf traefik access-log${sflag}\``;
  if (issue.kind === "file")
    return `traefik on ${name} writes its access log to a file, and lf traffic reads its output: remove --accesslog.filepath from its command`;
  if (issue.kind === "off") return `traefik on ${name} has no access log: ${fix} turns it on (traefik restarts for a moment)`;
  return `traefik on ${name} writes its access log as plain text: ${issue.fixable ? `${fix} switches it to JSON (traefik restarts for a moment)` : `${ACCESS_LOG_HINT}, then recreate it`}`;
}

function mergeSummary(xs: Summary[]): Summary {
  const s: Summary = { requests: 0, bytes: 0, classes: { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 }, codes: {}, p50: 0, p95: 0 };
  for (const x of xs) {
    s.requests += x.requests;
    s.bytes += x.bytes;
    for (const k of Object.keys(s.classes) as (keyof Summary["classes"])[]) s.classes[k] += x.classes[k];
  }
  return s;
}

/** Days left, colored: red when renewal must have failed, yellow when renewal is due. */
function certCell(x?: Cert) {
  if (!x) return c.red("none");
  const days = `${x.days} days`;
  if (x.days < CERT_DAYS_BAD) return c.red(x.days < 0 ? "expired" : days);
  if (x.staging) return c.yellow(`${days}, staging (not trusted)`);
  return x.days < 30 ? c.yellow(days) : c.green(days);
}

export const certsCmd = defineCommand({
  name: "certs",
  summary: "Show each site domain's HTTPS certificate: when it expires, who issued it, and why getting one failed.",
  options: {
    server: serverOpt,
    since: { type: "string", desc: "how far back to look for certificate errors", default: "7d" },
    json: { type: "boolean", desc: "machine-readable output" },
  },
  async run(_, o) {
    const { name, server } = serverTarget(o);
    const r = await certs(server, parseSince(o.since));
    if (o.json) return void printJson(r);
    if (!r.proxy) fail(`no traefik on ${name} (lf traefik setup)`);
    if (r.domains.length) {
      table([
        ["domain", "site", "certificate", "expires", "issuer"].map(c.dim),
        ...r.domains.map((d) => [
          d.domain,
          c.dim(d.site ?? `→ ${d.redirect}`),
          certCell(d.cert),
          d.cert ? d.cert.expires.slice(0, 10) : "",
          c.dim(d.cert?.issuer ?? ""),
        ]),
      ]);
      for (const d of r.domains.filter((d) => d.error && (!d.cert || d.cert.days < 30)))
        warn(`${d.domain}: ${d.error!.error}${d.error!.at ? c.dim(` (${new Date(d.error!.at).toLocaleString()})`) : ""}`);
    } else info(`no site domains on ${name}`);
    const used = new Set(r.domains.map((d) => d.cert));
    const rest = r.certs.filter((x) => !used.has(x));
    if (rest.length) {
      console.log(`\n${c.bold("Other certificates")}`);
      table(rest.map((x) => [x.domains.join(" "), certCell(x), c.dim(x.path ?? "acme.json")]));
    }
    const loose = r.errors.filter((e) => !e.domains.some((d) => r.domains.some((x) => x.domain === d))).slice(-3);
    for (const e of loose) warn(`${e.domains.join(" ") || "acme"}: ${e.error}`);
    if (r.denied.length) warn(`${r.denied.join(", ")} needs root to read: ${name}'s login has no passwordless sudo`);
  },
});

const isDomain = (s: string) => s.includes(".") && DOMAIN.test(s.toLowerCase());

export const checkCmd = defineCommand({
  name: "check",
  args: "[site|domain…]",
  summary:
    "Request each site over HTTPS from this machine: status, response time and days left on the certificate.\nExits 1 when one fails: use it from cron or CI.",
  options: {
    server: serverOpt,
    resolve: { type: "string", desc: "connect to this ip[:port] instead of what DNS says (test before DNS points here)" },
    json: { type: "boolean", desc: "machine-readable output" },
  },
  async run(args, o) {
    // Domains need no server: lf check example.com works anywhere.
    let targets = args.filter(isDomain).map((domain) => ({ domain, site: undefined as string | undefined }));
    const sites = args.filter((a) => !isDomain(a));
    if (!args.length || sites.length) {
      const { name, server } = serverTarget(o);
      const ov = await overview(server);
      for (const s of sites) if (!ov.sites.some((x) => x.meta.name === s)) fail(`no site "${s}" on ${name}. See \`lf ls\``);
      const pick = ov.sites.filter((x) => !sites.length || sites.includes(x.meta.name));
      targets = [...targets, ...pick.flatMap((x) => x.domains.filter((d) => !d.startsWith("*.")).map((domain) => ({ domain, site: x.meta.name })))];
      if (!targets.length) return info(`no site on ${name} has a domain`);
    }
    const res: Check[] = await Promise.all(
      targets.map(async (t) => ({ ...(await checkUrl(t.domain, { resolve: o.resolve })), ...(t.site && { site: t.site }) })),
    );
    if (o.json) printJson(res);
    else {
      table([
        ["", "domain", "site", "status", "time", "certificate"].map(c.dim),
        ...res.map((r) => [
          r.ok ? c.green("✓") : c.red("✗"),
          r.domain,
          c.dim(r.site ?? ""),
          r.error ? c.red(r.error) : (r.status ?? 0) >= 500 ? c.red(String(r.status)) : String(r.status),
          r.ms === undefined ? "" : r.ms > 1000 ? c.yellow(ms(r.ms)) : ms(r.ms),
          !r.tls
            ? ""
            : !r.tls.valid
              ? c.red(r.tls.error ?? "not trusted")
              : r.tls.days < CERT_DAYS_BAD
                ? c.red(`${r.tls.days} days`)
                : r.tls.days < 30
                  ? c.yellow(`${r.tls.days} days`)
                  : c.green(`${r.tls.days} days`),
        ]),
      ]);
    }
    return res.every((r) => r.ok) ? 0 : 1;
  },
});
