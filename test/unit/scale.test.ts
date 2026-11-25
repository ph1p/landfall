import { describe, expect, test } from "vitest";
import YAML from "yaml";
import { analyze, ejectYaml, overrideYaml, routeLabels, routePlan, scaleView, splitFile, type Release, type SiteMeta } from "../../src/core/site/compose";
import { OWN_PROXY } from "../../src/core/ssh/templates";

const meta = (r: Release, m: Partial<SiteMeta> = {}): SiteMeta => ({
  name: "blog",
  kind: "compose",
  domains: ["a.com"],
  current: r.id,
  releases: [r],
  createdAt: "",
  updatedAt: "",
  ...m,
});
const release = (config: any): Release => {
  const a = analyze(config, "/x");
  expect(a.errors).toEqual([]);
  return { id: "1", at: "", services: a.services };
};
const errors = (config: any) => analyze(config, "/x").errors.join("\n");
const labels = (y: string, svc: string) => YAML.parse(y).services[svc].labels as Record<string, string>;

describe("load balancer options", () => {
  test("each option reads from x-landfall and becomes its Traefik labels", () => {
    const r = release({
      services: {
        web: {
          image: "w",
          "x-landfall": {
            port: 3000,
            sticky: "sid",
            healthcheck: { path: "/health", interval: "10s", timeout: "3s" },
            ratelimit: { average: 20, burst: 50 },
            headers: { "X-Frame-Options": "DENY" },
            compress: true,
            retry: 3,
            allow: ["10.0.0.0/8"],
          },
        },
      },
    });
    const l = labels(overrideYaml(meta(r), r), "web");
    const lb = "traefik.http.services.blog_web.loadbalancer";
    expect(l).toMatchObject({
      [`${lb}.sticky.cookie`]: "true",
      [`${lb}.sticky.cookie.name`]: "sid",
      [`${lb}.healthcheck.path`]: "/health",
      [`${lb}.healthcheck.interval`]: "10s",
      [`${lb}.healthcheck.timeout`]: "3s",
      "traefik.http.middlewares.blog_web-ratelimit.ratelimit.average": "20",
      "traefik.http.middlewares.blog_web-ratelimit.ratelimit.burst": "50",
      "traefik.http.middlewares.blog_web-headers.headers.customresponseheaders.X-Frame-Options": "DENY",
      "traefik.http.middlewares.blog_web-compress.compress": "true",
      "traefik.http.middlewares.blog_web-retry.retry.attempts": "3",
    });
  });

  test("middlewares chain: address check, rate limit, login, headers, compress, retry", () => {
    const s = { name: "web", networks: ["default"], port: 3000 };
    const l = routeLabels(
      "blog",
      s,
      { port: 3000, domains: ["a.com"], allow: ["1.2.3.4"], opts: { ratelimit: { average: 5 }, headers: { "X-A": "1" }, compress: true, retry: 2 } },
      OWN_PROXY,
      { middleware: "blog-auth", users: ["bob:$2y$05$x"] },
    );
    expect(l["traefik.http.routers.blog_web.middlewares"]).toBe(
      "blog_web-allow,blog_web-ratelimit,blog-auth,blog_web-headers,blog_web-compress,blog_web-retry",
    );
  });

  test("bad values are errors that say the form", () => {
    expect(errors({ services: { web: { image: "w", "x-landfall": { port: 80, healthcheck: "health" } } } })).toMatch(/healthcheck is a path/);
    expect(errors({ services: { web: { image: "w", "x-landfall": { port: 80, healthcheck: { path: "/h", interval: "soon" } } } } })).toMatch(/duration/);
    expect(errors({ services: { web: { image: "w", "x-landfall": { port: 80, ratelimit: 0 } } } })).toMatch(/ratelimit is requests per second/);
    expect(errors({ services: { web: { image: "w", "x-landfall": { port: 80, retry: 99 } } } })).toMatch(/retry is how many times/);
    expect(errors({ services: { web: { image: "w", "x-landfall": { port: 80, headers: { "Bad Header": "x" } } } } })).toMatch(/not a header name/);
    expect(errors({ services: { web: { image: "w", "x-landfall": { port: 80, sticky: "a b" } } } })).toMatch(/sticky is true or a cookie name/);
  });
});

describe("replicas", () => {
  test("compose.yaml's count stays; lf scale writes the key compose.yaml uses", () => {
    const deploy = release({ services: { web: { image: "w", deploy: { replicas: 2 }, "x-landfall": { port: 80 } } } });
    expect(deploy.services[0].replicas).toBe(2);
    expect(overrideYaml(meta(deploy), deploy)).not.toMatch(/replicas|scale:/);
    expect(YAML.parse(overrideYaml(meta(deploy, { scale: { web: 3 } }), deploy)).services.web.deploy).toEqual({ replicas: 3 });
    const legacy = release({ services: { web: { image: "w", scale: 2, "x-landfall": { port: 80 } } } });
    const y = YAML.parse(overrideYaml(meta(legacy, { scale: { web: 4 } }), legacy)).services.web;
    expect(y.scale).toBe(4);
    expect(y.deploy).toBeUndefined();
  });

  test("more than one replica with a fixed name or a published port is an error", () => {
    expect(errors({ services: { web: { image: "w", container_name: "w", deploy: { replicas: 2 } } } })).toMatch(/container_name/);
    expect(
      errors({ services: { web: { image: "w", ports: [{ target: 80, published: "80" }], deploy: { replicas: 2 }, "x-landfall": { publish: true } } } }),
    ).toMatch(/publish/);
  });

  test("rolling only where it can roll", () => {
    expect(errors({ services: { web: { image: "w", container_name: "w", "x-landfall": { port: 80, update: "rolling" } } } })).toMatch(/rolling/);
    expect(errors({ services: { job: { image: "w", "x-landfall": { update: "rolling" } } } })).toMatch(/rolling/);
    expect(errors({ services: { web: { image: "w", "x-landfall": { port: 80, update: "blue-green" } } } })).toMatch(/update/);
  });

  test("scaleView: where each count comes from", () => {
    const r = release({
      services: { web: { image: "w", deploy: { replicas: 2 }, "x-landfall": { port: 80, update: "rolling" } }, worker: { image: "w" }, db: { image: "p" } },
    });
    expect(scaleView(meta(r, { scale: { worker: 3 } }))).toEqual([
      { service: "web", replicas: 2, source: "compose.yaml", update: "rolling" },
      { service: "worker", replicas: 3, source: "lf scale", update: "recreate" },
      { service: "db", replicas: 1, source: "default", update: "recreate" },
    ]);
  });
});

describe("traffic split", () => {
  const config = {
    services: {
      stable: { image: "a", "x-landfall": { port: 80, weight: 90, healthcheck: "/h" } },
      canary: { image: "b", "x-landfall": { port: 80, weight: 10, healthcheck: "/h" } },
    },
  };

  test("weighted services on the same domains share one router to a weighted service in the file provider", () => {
    const r = release(config);
    const m = meta(r);
    const y = overrideYaml(m, r);
    for (const svc of ["stable", "canary"]) {
      const l = labels(y, svc);
      expect(l["traefik.http.routers.blog-split.service"]).toBe("blog-split@file");
      expect(l["traefik.http.routers.blog-split.rule"]).toBe("Host(`a.com`)");
      expect(l[`traefik.http.services.blog_${svc}.loadbalancer.server.port`]).toBe("80");
    }
    const file = YAML.parse(splitFile(m, r)!);
    expect(file.http.services["blog-split"]).toEqual({
      weighted: {
        services: [
          { name: "blog_canary@docker", weight: 10 },
          { name: "blog_stable@docker", weight: 90 },
        ],
        healthCheck: {},
      },
    });
    // lf weight wins over compose.yaml.
    expect(YAML.parse(splitFile(meta(r, { weights: { canary: 0 } }), r)!).http.services["blog-split"].weighted.services[0].weight).toBe(0);
    expect(() => ejectYaml(m, r, OWN_PROXY)).toThrow(/split/);
  });

  test("one router per split: the lead's, with every member", () => {
    const r = release(config);
    expect(routePlan(r.services, ["a.com"])).toEqual([
      { key: "canary:80", service: "canary", port: 80, domains: ["a.com"], main: true, opts: { healthcheck: { path: "/h" } }, members: ["canary", "stable"] },
    ]);
    // A router setting on another member would be ignored: an error, unless it matches the lead's.
    const svc = (x: object) => ({
      services: { a: { image: "a", "x-landfall": { port: 80, weight: 1, retry: 2 } }, b: { image: "b", "x-landfall": { port: 80, weight: 1, ...x } } },
    });
    expect(errors(svc({ retry: 3 }))).toMatch(/b: x-landfall.retry differs from a's/);
    expect(errors(svc({ retry: 2, sticky: true }))).toBe("");
  });

  test("a split needs some weight, and unweighted services still may not share domains", () => {
    expect(
      errors({ services: { a: { image: "a", "x-landfall": { port: 80, weight: 0 } }, b: { image: "b", "x-landfall": { port: 80, weight: 0 } } } }),
    ).toMatch(/weight/);
    expect(errors({ services: { a: { image: "a", "x-landfall": { port: 80, weight: 5 } }, b: { image: "b", "x-landfall": { port: 80 } } } })).not.toBe("");
  });
});

describe("match: force a split member", () => {
  const config = (match: unknown, extra: object = {}) => ({
    services: {
      a: { image: "a", "x-landfall": { port: 80, weight: 100, allow: ["10.0.0.0/8"], ...extra } },
      b: { image: "b", "x-landfall": { port: 80, weight: 0, match, ...extra } },
    },
  });

  test("an extra router with a longer rule sends matching requests to the member, through the split's middlewares", () => {
    const r = release(config({ cookie: "ab=b.2", header: "X-Variant=b" }));
    const l = labels(overrideYaml(meta(r), r), "b");
    const m = "traefik.http.routers.blog_b-match";
    // $$: Compose reads the override with interpolation and turns it back into $.
    expect(l[`${m}.rule`]).toBe("(Host(`a.com`)) && (HeaderRegexp(`Cookie`, `(^|;\\s*)ab=b\\.2(;|$$)`) || Header(`X-Variant`, `b`))");
    expect(l[`${m}.service`]).toBe("blog_b");
    expect(l[`${m}.middlewares`]).toBe(l["traefik.http.routers.blog-split.middlewares"]);
    expect(l[`${m}.middlewares`]).toMatch(/allow/);
    expect(labels(overrideYaml(meta(r), r), "a")).not.toHaveProperty(`${m}.rule`);
    expect(scaleView(meta(r)).find((x) => x.service === "b")).toMatchObject({ weight: 0, match: "cookie ab=b.2 or header X-Variant=b" });
  });

  test("the form is checked, and a match needs a weight", () => {
    expect(errors(config("ab=b"))).toMatch(/match is \{ cookie: name=value \}/);
    expect(errors(config({ cookie: "ab" }))).toMatch(/match.cookie is name=value/);
    expect(errors(config({ header: "X Variant=b" }))).toMatch(/match.header is name=value/);
    expect(errors(config({ cookie: "ab=b;x" }))).toMatch(/match.cookie/);
    expect(errors({ services: { web: { image: "w", "x-landfall": { port: 80, match: { cookie: "ab=b" } } } } })).toMatch(/needs x-landfall.weight/);
  });
});

describe("opt-in", () => {
  test("a site without the new keys gets the same override as before: no replicas, balancer options or split", () => {
    const r = release({ services: { web: { image: "w", "x-landfall": { port: 3000 } }, db: { image: "p" } } });
    const y = overrideYaml(meta(r), r);
    expect(y).not.toMatch(/replicas|scale:|sticky|healthcheck|ratelimit|compress|retry|middlewares|@file/);
    expect(Object.keys(labels(y, "web")).sort()).toEqual(
      [
        "landfall.managed",
        "landfall.site",
        "traefik.docker.network",
        "traefik.enable",
        "traefik.http.routers.blog_web.entrypoints",
        "traefik.http.routers.blog_web.rule",
        "traefik.http.routers.blog_web.service",
        "traefik.http.routers.blog_web.tls.certresolver",
        "traefik.http.services.blog_web.loadbalancer.server.port",
      ].sort(),
    );
    expect(splitFile(meta(r), r)).toBeUndefined();
  });
});
