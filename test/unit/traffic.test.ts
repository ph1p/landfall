import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { redirectsFile } from "../../src/core/redirects";
import { covers, mergeHosts, parseCertError, parseCerts, parseSince, parseTraffic, readCert, siteTraffic, spanLabel, TRAFFIC } from "../../src/core/traffic";

const now = new Date("2026-10-25T15:30:00Z");

const line = (o: { host: string; status: number; ms: number; path?: string; ip?: string; at?: string; size?: number; ep?: string }) =>
  JSON.stringify({
    ClientHost: o.ip ?? "203.0.113.7",
    DownstreamContentSize: o.size ?? 100,
    DownstreamStatus: o.status,
    Duration: o.ms * 1_000_000,
    RequestHost: o.host,
    RequestMethod: "GET",
    RequestPath: o.path ?? "/",
    StartUTC: o.at ?? "2026-10-25T15:20:01.5Z",
    entryPointName: o.ep ?? "websecure",
    level: "info",
    msg: "",
  });

/** The TRAFFIC script against a fake `docker` that prints these log lines. */
function runTraffic(lines: string[], secs = 3600, site?: object) {
  const dir = fs.mkdtempSync(join(tmpdir(), "lf-traffic-"));
  fs.writeFileSync(join(dir, "log"), lines.join("\n") + "\n");
  const fake = `docker() { case "$1" in inspect) return 0 ;; logs) cat ${dir}/log ;; esac; }\n`;
  let script = TRAFFIC(secs);
  if (site) {
    fs.mkdirSync(join(dir, "sites/app"), { recursive: true });
    fs.writeFileSync(join(dir, "sites/app/site.json"), JSON.stringify(site, null, 2));
    script = script.replace(/for f in \S+\/\*\/site\.json/, `for f in ${dir}/sites/*/site.json`);
  }
  const r = spawnSync("bash", ["-c", fake + script]);
  expect(r.stderr.toString()).toBe("");
  return r.stdout.toString();
}

describe("traffic", () => {
  test("since", () => {
    expect(parseSince("24h")).toBe(86400);
    expect(parseSince("30m")).toBe(1800);
    expect(parseSince("7D")).toBe(7 * 86400);
    expect(() => parseSince("30s")).toThrow();
    expect(() => parseSince("31d")).toThrow();
    expect(() => parseSince("yesterday")).toThrow();
    expect([spanLabel(86400), spanLabel(7200), spanLabel(1800), spanLabel(7 * 86400)]).toEqual(["1d", "2h", "30m", "7d"]);
  });

  test("the server-side aggregation reads traefik's JSON lines", () => {
    const out = runTraffic(
      [
        line({ host: "App.Test:443", status: 200, ms: 3, path: '/a?x=1\\u0026y=\\"q' }),
        line({ host: "app.test", status: 200, ms: 5, path: "/a", at: "2026-10-25T15:21:00Z" }),
        line({ host: "www.app.test", status: 404, ms: 1, path: "/missing", ip: "198.51.100.1" }),
        line({ host: "app.test", status: 502, ms: 2000, path: "/api", size: 0 }),
        line({ host: "other.test", status: 301, ms: 0.2 }),
        line({ host: "127.0.0.1", status: 200, ms: 1, ep: "tunnel" }),
        `172.17.0.1 - - [25/Oct/2026:15:20:00 +0000] "GET / HTTP/1.1" 200 5 "-" "-" 1 "x@docker" "http://1.2.3.4" 0ms`,
        "2026-10-25T15:19:12Z INF Starting provider",
      ],
      3600,
      { name: "app", domains: ["app.test", "www.app.test"], releases: [] },
    );
    expect(out).toMatch(/^N\t5\t1\t2026-10-25T15:20:01.5Z\t2026-10-25T15:21:00Z$/m);
    const t = parseTraffic(out, 3600, now);
    expect(t.format).toBe("json");
    expect(t.total.requests).toBe(5);
    expect(t.total.classes).toEqual({ "2xx": 2, "3xx": 1, "4xx": 1, "5xx": 1 });
    expect(t.hosts.map((h) => h.host).sort()).toEqual(["app.test", "other.test", "www.app.test"]);
    expect(t.sites).toHaveLength(1);
    expect(t.sites[0]).toMatchObject({ site: "app", requests: 4, bytes: 300 });
    const app = siteTraffic(t, "app")!;
    expect(app.paths[0]).toEqual({ path: "/a", count: 2, errors: 0 });
    expect(app.errors).toEqual(
      expect.arrayContaining([
        { status: 502, path: "/api", count: 1 },
        { status: 404, path: "/missing", count: 1 },
      ]),
    );
    expect(app.ips[0]).toEqual({ ip: "203.0.113.7", count: 3 });
    expect(app.p95).toBeGreaterThan(1500);
    expect(app.p50).toBeLessThan(8);
    // A minute per bucket over the hour, the requests in theirs.
    expect(app.series).toHaveLength(60);
    expect(app.series.find((s) => s.at === "2026-10-25T15:20")).toMatchObject({ "2xx": 1, "4xx": 1, "5xx": 1 });
    expect(siteTraffic(t, "other.test")?.requests).toBe(1);
    expect(siteTraffic(t, "nope")).toBeNull();
  });

  test("a plain-text access log, no proxy, the own proxy", () => {
    const common = parseTraffic(
      runTraffic([`1.2.3.4 - - [25/Oct/2026:15:20:00 +0000] "GET / HTTP/1.1" 200 5 "-" "-" 1 "x@docker" "http://1.2.3.4" 0ms`]),
      3600,
      now,
    );
    expect(common.format).toBe("common");
    expect(parseTraffic("N\t0\t0\t\t\n", 3600, now).format).toBe("none");
    expect(parseTraffic("NOPROXY\n", 3600, now).proxy).toBe(false);
    expect(parseTraffic("OWN\nN\t0\t0\t\t\n", 86400, now)).toMatchObject({ own: true, bucket: "hour" });
  });

  test("top 10 per host survive the transfer", () => {
    const lines = Array.from({ length: 15 }, (_, i) =>
      Array.from({ length: i + 1 }, () => line({ host: "a.test", status: 200, ms: 1, path: `/p${i}` })),
    ).flat();
    const t = parseTraffic(runTraffic(lines), 3600, now);
    expect(t.hosts[0].paths).toHaveLength(10);
    expect(t.hosts[0].paths[0]).toEqual({ path: "/p14", count: 15, errors: 0 });
    expect(t.total.requests).toBe(120);
  });

  test("merging hosts adds up and keeps the buckets", () => {
    const t = parseTraffic(
      ["C\ta.test\t200\t3\t30", "C\tb.test\t500\t1\t0", "L\ta.test\t8\t3", "L\tb.test\t20\t1", "S\ta.test\t2026-10-25T15:20\t2\t3"].join("\n"),
      3600,
      now,
    );
    const m = mergeHosts(
      t.hosts,
      t.total.series.map((s) => s.at),
    );
    expect(m).toMatchObject({ requests: 4, bytes: 30, classes: { "2xx": 3, "5xx": 1 }, p50: 4, p95: 32 });
  });
});

describe("certs", () => {
  test("ACME errors from traefik's log", () => {
    expect(
      parseCertError(
        `2026-10-25T15:19:12Z ERR Unable to obtain ACME certificate for domains error="unable to generate a certificate for the domains [app.example.com]: acme: error: 403 :: urn:ietf:params:acme:error:unauthorized :: \\"Invalid response\\"" ACME CA=https://acme-v02.api.letsencrypt.org/directory domains=["app.example.com","www.app.example.com"] providerName=le.acme routerName=app@docker`,
      ),
    ).toEqual({
      at: "2026-10-25T15:19:12Z",
      domains: ["app.example.com", "www.app.example.com"],
      error:
        'unable to generate a certificate for the domains [app.example.com]: acme: error: 403 :: urn:ietf:params:acme:error:unauthorized :: "Invalid response"',
    });
    expect(parseCertError('\x1b[90m2026-10-25T15:19:12Z\x1b[0m \x1b[31mERR\x1b[0m error="x" for the domains [a.test b.test]')).toEqual({
      at: "2026-10-25T15:19:12Z",
      domains: ["a.test", "b.test"],
      error: "x",
    });
    expect(parseCertError('2026-10-25T15:19:12Z ERR msg error="unable to generate a certificate for the domains [a.test b.test]: x"')).toMatchObject({
      domains: ["a.test", "b.test"],
    });
  });

  test("certificates and which domain they cover", () => {
    const dir = fs.mkdtempSync(join(tmpdir(), "lf-cert-"));
    const r = spawnSync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(dir, "k.pem"),
      "-out",
      join(dir, "c.pem"),
      "-days",
      "20",
      "-subj",
      "/CN=app.test",
      "-addext",
      "subjectAltName=DNS:app.test,DNS:*.app.test",
    ]);
    expect(r.status).toBe(0);
    const b64 = Buffer.from(fs.readFileSync(join(dir, "c.pem"))).toString("base64");
    const cert = readCert(b64, "file", "/x/c.pem", now)!;
    expect(cert.domains).toEqual(["app.test", "*.app.test"]);
    expect(cert.days).toBeGreaterThanOrEqual(19);
    expect(cert.staging).toBe(false);
    expect(readCert("bm90IGEgY2VydA==", "acme")).toBeNull();
    expect([
      covers("*.app.test", "www.app.test"),
      covers("*.app.test", "a.b.app.test"),
      covers("*.app.test", "app.test"),
      covers("app.test", "app.test"),
    ]).toEqual([true, false, false, true]);
    const certs = parseCerts(
      [
        `SITE\t{"name":"app","domains":["app.test","www.app.test","other.test"],"releases":[]}`,
        `CERT\t/x/c.pem\t${b64}`,
        'LOG\t2026-10-25T15:00:00Z ERR x error="nope" domains=["other.test"]',
        `REDIRECTS\tabc\t${JSON.stringify(JSON.parse(redirectsFile([{ host: "old.test", to: "https://app.test", permanent: true, path: true }]).replace(/^#.*\n/, "")))}`,
      ].join("\n"),
      now,
    );
    expect(certs.domains.map((d) => [d.domain, d.cert?.path, d.error?.error])).toEqual([
      ["app.test", "/x/c.pem", undefined],
      ["other.test", undefined, "nope"],
      ["www.app.test", "/x/c.pem", undefined],
      ["old.test", undefined, undefined],
    ]);
    expect(certs.domains.at(-1)?.redirect).toBe("https://app.test");
  });
});
