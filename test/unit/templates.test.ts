import bcrypt from "bcryptjs";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { portScheme, routerPort } from "../../src/core/tunnel";
import { htpasswd, traefikSettings } from "../../src/core/traefik";
import { parse } from "../../src/cli/cmd";
import { containerPorts, dashboardHosts, hasDashboardTunnel } from "../../src/core/remote";
import { DEFAULT_TRAEFIK_IMAGE, parseProxy, proxyFile, TLS_FILE, traefikCompose } from "../../src/core/templates";
import { adoptCompose, analyze, generatedCompose, localCompose, routePlan, mainService, nginxConf, overrideYaml, routeLabels, ruleHosts, secretUsers, siteDomains, type Release, type SiteMeta } from "../../src/core/compose";
import YAML from "yaml";

const tmp = () => fs.mkdtempSync(join(tmpdir(), "landfall-test-"));

describe("templates", () => {
  const release: Release = {
    id: "20260101000000",
    at: "",
    services: [
      { name: "web", networks: ["default"], build: true, port: 3000 },
      { name: "admin", networks: ["default"], port: 8080, domains: ["admin.a.com"] },
      { name: "db", networks: ["default"] },
    ],
  };
  const meta: SiteMeta = {
    v: 2,
    name: "blog",
    kind: "compose",
    domains: ["a.com", "www.a.com"],
    current: release.id,
    releases: [release],
    createdAt: "",
    updatedAt: "",
  };

  test("labels route all domains over TLS", () => {
    const l = routeLabels("blog", release.services[0], meta.domains, { container: "traefik", network: "web", entrypoint: "websecure", resolver: "le" });
    expect(l["traefik.http.routers.blog_web.rule"]).toBe("Host(`a.com`) || Host(`www.a.com`)");
    expect(l["traefik.http.routers.blog_web.tls.certresolver"]).toBe("le");
    expect(l["traefik.http.services.blog_web.loadbalancer.server.port"]).toBe("3000");
    expect(Object.keys(l).some((k) => k.includes("basicauth"))).toBe(false);
  });

  test("override: project name, release tag, proxy network only on routed services", () => {
    const p = { container: "x", network: "proxy", entrypoint: "https", resolver: "acme" };
    expect(parseProxy(proxyFile(p))).toEqual(p);
    const y = overrideYaml(meta, release, p);
    expect(y).toContain('name: "blog"');
    expect(y).toContain('image: "blog-web:20260101000000"');
    expect(y).toContain('"traefik.http.routers.blog_web.tls.certresolver": "acme"');
    expect(y).toContain('"traefik.http.routers.blog_admin.rule": "Host(`admin.a.com`)"');
    expect(y).toMatch(/"db":\n    labels:/);
    expect(y).toContain("  landfall-proxy:\n    name: \"proxy\"\n    external: true");
  });

  test("override escapes $ in basic auth", () => {
    const y = overrideYaml({ ...meta, auth: ["bob:$2y$05$x"] }, release);
    expect(y).toContain('"traefik.http.middlewares.blog-auth.basicauth.users": "bob:$$2y$$05$$x"');
    expect(y).toContain('"traefik.http.routers.blog_web.middlewares": "blog-auth"');
  });

  test("secrets: generated sites mount every one, a compose.yaml names its own", () => {
    const y = overrideYaml({ ...meta, kind: "image", secrets: ["DB_PASS", "tls.key"] }, release);
    expect(y).toMatch(/"web":\n(.*\n)*?    secrets:\n      - "DB_PASS"\n      - "tls.key"/);
    expect(y).toContain('secrets:\n  "DB_PASS":\n    file: "./.secrets/DB_PASS"\n  "tls.key":\n    file: "./.secrets/tls.key"');
    expect(overrideYaml({ ...meta, secrets: ["DB_PASS"] }, release)).not.toContain("secrets:");
    const config = {
      secrets: { db: { file: "/opt/landfall/sites/blog/releases/1/.secrets/DB_PASS" }, other: { file: "/x/y" } },
      services: { web: { secrets: [{ source: "db", target: "db" }] }, worker: { secrets: ["db"] }, cache: { secrets: ["other"] }, x: {} },
    };
    expect(secretUsers(config, ["DB_PASS"])).toEqual(["web", "worker"]);
    expect(secretUsers(config, ["NOPE"])).toEqual([]);
    expect(secretUsers(undefined, ["DB_PASS"])).toEqual([]);
  });

  test("site domains: the main service's plus each service's own", () => {
    expect(mainService(release)?.name).toBe("web");
    expect(siteDomains(meta)).toEqual(["a.com", "www.a.com", "admin.a.com"]);
    expect(ruleHosts("Host(`a.x`) || Host(`B.x`, \"c.x\") && PathPrefix(`/`)")).toEqual(["a.x", "b.x", "c.x"]);
  });

  test("generated compose files", () => {
    expect(generatedCompose("static")).toContain("./public:/usr/share/nginx/html:ro");
    expect(generatedCompose("image", { image: "ghcr.io/x/y:1", port: 4000 })).toContain('image: "ghcr.io/x/y:1"');
    expect(generatedCompose("dockerfile", { port: 4000 })).toContain("port: 4000");
    // a worker is not routed; volumes are named after their folder and outlive the release
    const worker = generatedCompose("dockerfile", { app: "Python", volumes: ["/app/data"] });
    expect(worker).not.toContain("x-landfall");
    expect(YAML.parse(worker)).toMatchObject({ services: { app: { volumes: ["app-data:/app/data"] } }, volumes: { "app-data": {} } });
    expect(analyze(YAML.parse(worker), "/x")).toMatchObject({ errors: [], warnings: [expect.stringMatching(/no service is routed/)] });
    expect(nginxConf(false)).toContain("=404;");
    expect(nginxConf(true)).toContain("/index.html;");
  });

  test("analyze reads x-landfall and refuses unsafe setups", () => {
    const dir = "/opt/landfall/sites/blog/releases/1";
    const ok = analyze(
      {
        services: {
          web: { build: { context: dir }, expose: ["3000"], "x-landfall": {}, networks: { default: null } },
          db: { image: "postgres", volumes: [{ type: "volume", source: "db", target: "/var/lib/postgresql/data" }] },
          mail: { image: "m", labels: { "traefik.http.routers.m.rule": "Host(`mail.a.com`)" } },
        },
      },
      dir,
    );
    expect(ok.errors).toEqual([]);
    expect(ok.services).toEqual([
      { name: "web", networks: ["default"], build: true, port: 3000 },
      { name: "db", networks: ["default"] },
      { name: "mail", networks: ["default"], own: true, domains: ["mail.a.com"] },
    ]);
    const bad = analyze(
      {
        services: {
          web: { image: "w", "x-landfall": { port: "x" } },
          db: { image: "postgres", ports: [{ target: 5432, published: "5432" }], volumes: [{ type: "bind", source: `${dir}/data`, target: "/d" }] },
        },
      },
      dir,
    );
    expect(bad.errors.join("\n")).toMatch(/port must be a port number/);
    expect(bad.errors.join("\n")).toMatch(/db publishes 5432:5432/);
    expect(bad.errors.join("\n")).toMatch(/writes to \.\/data/);
    expect(analyze({ services: { db: { image: "p" } } }, dir)).toMatchObject({ errors: [], warnings: [expect.stringMatching(/no service is routed/)] });
  });

  test("routes and private ports in x-landfall", () => {
    const dir = "/opt/landfall/sites/blog/releases/1";
    const a = analyze(
      {
        services: {
          web: { build: { context: dir }, "x-landfall": { port: 3000, routes: [{ port: 3001, subdomain: "admin" }, { port: 9000, domains: ["s3"] }], private: { cms: 3002 } } },
        },
      },
      dir,
      (d) => (d.includes(".") ? d : `${d}.x.io`),
    );
    expect(a.errors).toEqual([]);
    expect(a.services[0]).toMatchObject({ port: 3000, routes: [{ port: 3001, subdomain: "admin" }, { port: 9000, domains: ["s3.x.io"] }], private: { cms: 3002 } });
    expect(routePlan(a.services, ["a.com", "b.com"])).toEqual([
      { service: "web", port: 3000, domains: ["a.com", "b.com"], main: true },
      { service: "web", port: 3001, domains: ["admin.a.com", "admin.b.com"] },
      { service: "web", port: 9000, domains: ["s3.x.io"] },
    ]);
    // a port routed and private, or routed twice, is a mistake
    const bad = analyze({ services: { web: { image: "w", "x-landfall": { port: 3000, routes: [{ port: 3000, subdomain: "a" }], private: { x: 3000 } } } } }, dir);
    expect(bad.errors.join("\n")).toMatch(/routed twice/);
    expect(bad.errors.join("\n")).toMatch(/both routed and private/);
    // subdomains hang off the main service's domains
    expect(analyze({ services: { w: { image: "w", "x-landfall": { routes: [{ port: 3001, subdomain: "a" }] } } } }, dir).errors.join()).toMatch(/no service serves them/);
  });

  test("route labels and override: a router per port, published ports reset", () => {
    const svc = { name: "web", networks: ["default"], build: true, port: 3000, routes: [{ port: 3001, subdomain: "admin" }], unpublish: true };
    const rel: Release = { id: "1", at: "", services: [svc] };
    const m: SiteMeta = { ...meta, domains: ["a.com"], current: "1", releases: [rel] };
    const y = overrideYaml(m, rel);
    expect(y).toContain("ports: !reset []");
    expect(y).toContain('"traefik.http.routers.blog_web.rule": "Host(`a.com`)"');
    expect(y).toContain('"traefik.http.routers.blog_web_3001.rule": "Host(`admin.a.com`)"');
    expect(y).toContain('"traefik.http.services.blog_web_3001.loadbalancer.server.port": "3001"');
    expect(siteDomains(m)).toEqual(["a.com", "admin.a.com"]);
    // site.json from before routes reads as it did
    expect(siteDomains(meta)).toEqual(["a.com", "www.a.com", "admin.a.com"]);
  });

  test("auto mode routes a plain compose file's HTTP ports", () => {
    const dir = "/opt/landfall/sites/blog/releases/1";
    const config = {
      services: {
        web: { build: { context: dir }, ports: [{ target: 3000, published: "3000" }, { target: 3001, published: "3001" }] },
        db: { image: "postgres", ports: [{ target: 5432, published: "5432" }] },
        mail: { image: "mailpit", expose: ["8025", "1025"] },
      },
    };
    expect(analyze(config, dir).errors.join()).toMatch(/publishes/);
    const a = analyze(config, dir, undefined, { auto: true });
    expect(a).toMatchObject({ auto: true, errors: [] });
    expect(a.services).toEqual([
      { name: "web", networks: ["default"], build: true, port: 3000, routes: [{ port: 3001, subdomain: "web-3001" }], unpublish: true },
      { name: "db", networks: ["default"], unpublish: true },
      { name: "mail", networks: ["default"], routes: [{ port: 8025, subdomain: "mail" }] },
    ]);
    expect(a.notes.join()).toMatch(/db: 5432 not published/);
    // any x-landfall switches auto mode off
    expect(analyze({ services: { ...config.services, web: { image: "w", "x-landfall": { port: 3000 } } } }, dir, undefined, { auto: true }).auto).toBeUndefined();
  });

  test("auto mode: a database UI never wins the site's domains, a real tie is said", () => {
    const svc = (image: string, port: number) => ({ image, ports: [{ target: port, published: String(port) }] });
    const a = analyze({ services: { adminer: svc("adminer:4", 8080), web: svc("ghcr.io/me/web", 3000) } }, "/x", undefined, { auto: true });
    expect(a.services.find((s) => s.name === "web")?.port).toBe(3000);
    expect(a.notes.join()).not.toMatch(/first by name/);
    const b = analyze({ services: { api: svc("me/api", 3000), web: svc("me/web", 3000) } }, "/x", undefined, { auto: true });
    expect(b.services.find((s) => s.name === "api")?.port).toBe(3000);
    expect(b.notes.join()).toMatch(/api serves the site's domains \(first by name of api, web\)/);
  });

  test("local compose file: variables and short ports as docker compose config has them", () => {
    const dir = tmp();
    fs.writeFileSync(join(dir, ".env"), "PORT=4000\n");
    fs.writeFileSync(join(dir, "compose.yaml"), 'services:\n  web:\n    image: "w:${TAG:-1}"\n    ports: ["127.0.0.1:${PORT}:3000", 8080, "9000-9001:9000-9001/tcp", "53:53/udp"]\n');
    const c = localCompose(dir, "compose.yaml");
    expect(c.services.web.image).toBe("w:1");
    expect(c.services.web.ports).toEqual([
      { target: 3000, published: "4000", host_ip: "127.0.0.1", protocol: "tcp" },
      { target: 8080, protocol: "tcp" },
      { target: 9000, published: "9000-9001", protocol: "tcp" },
      { target: 9001, published: "9000-9001", protocol: "tcp" },
      { target: 53, published: "53", protocol: "udp" },
    ]);
  });

  test("lf init on a compose file writes x-landfall and moves ports, keeping comments", () => {
    const text = '# app\nservices:\n  web:\n    build: .\n    ports:\n      - "3000:3000" # local\n      - "3001:3001"\n';
    const a = analyze(YAML.parse(text.replace(/"(\d+):(\d+)"/g, "{ target: $2, published: '$1' }")), "/x", undefined, { auto: true });
    const r = adoptCompose(text, 'services:\n  web:\n    ports: ["3000:3000"]\n', a);
    expect(r.compose).toContain("# app");
    expect(YAML.parse(r.compose)).toEqual({ services: { web: { build: ".", "x-landfall": { port: 3000, routes: [{ port: 3001, subdomain: "web-3001" }] } } } });
    expect(YAML.parse(r.override)).toEqual({ services: { web: { ports: ["3000:3000", "3001:3001"] } } });
    expect(r.override).toContain('"3001:3001"');
    const again = analyze(YAML.parse(r.compose), "/x", undefined, { auto: true });
    expect(adoptCompose(r.compose, r.override, again)).toMatchObject({ routed: [], moved: [] });
  });

  test("traefik dashboard escapes $ for compose", async () => {
    const hash = await htpasswd("admin", "pw");
    expect(hash).toMatch(/^admin:\$2y\$/);
    expect(await bcrypt.compare("pw", hash.slice(6).replace("$2y$", "$2b$"))).toBe(true);
    const y = traefikCompose({ email: "e@x", image: "traefik:v3.6", staging: true, dashboard: { host: "t.x", htpasswd: hash } });
    expect(y).toContain("$$2y$$");
    expect(y).toContain("acme-staging");
  });

  test("traefik serves its dashboard to the tunnel only from the server", () => {
    const y = traefikCompose({ image: "traefik:v3.6", staging: false });
    expect(y).toContain("--entrypoints.tunnel.address=:8080");
    expect(y).toContain("routers.dashboard-tunnel.service=api@internal");
    expect(y).toContain("ipallowlist.sourcerange=127.0.0.1/32,${LANDFALL_GATEWAY:-127.0.0.1}/32");
    expect(y).not.toContain("routers.dashboard.rule");
    expect(traefikCompose({ image: "traefik:v3.6", staging: false, hostNetwork: true })).toContain("--entrypoints.tunnel.address=127.0.0.1:8080");
  });

  test("dashboard detection reads the routers that serve api@internal", () => {
    const labels = {
      "traefik.http.routers.dash.rule": "Host(`dashboard.example.dev`)",
      "traefik.http.routers.dash.service": "api@internal",
      "traefik.http.routers.site.rule": "Host(`example.dev`)",
      "traefik.http.routers.site.service": "site",
    };
    expect(dashboardHosts(labels)).toEqual(["dashboard.example.dev"]);
    expect(hasDashboardTunnel(labels)).toBe(false);
    expect(hasDashboardTunnel({ "traefik.http.routers.dashboard-tunnel.service": "api@internal" })).toBe(true);
  });

  test("a router's port comes from its entrypoint's address flag", () => {
    const ctr = {
      name: "traefik",
      host: false,
      ips: {},
      ports: [],
      args: ["--entrypoints.web.address=:80", "--entryPoints.websecure.address=:443"],
      labels: {
        "traefik.http.routers.dash.entrypoints": "websecure",
        "traefik.http.routers.dash.tls": "true",
        "traefik.http.routers.plain.entrypoints": "web",
      },
    };
    expect(routerPort(ctr, "dash")).toEqual({ port: 443, tls: true });
    expect(routerPort(ctr, "plain")).toEqual({ port: 80, tls: false });
    expect(routerPort(ctr, "any")).toEqual({ port: 80, tls: false });
    expect(routerPort({ ...ctr, args: [] }, "dash")).toBeUndefined();
  });

  test("a tunnel to a database port names its client's scheme", () => {
    expect(portScheme(5432)).toBe("postgresql");
    expect(portScheme(6379)).toBe("redis");
    expect(portScheme(993)).toBe("imaps");
    expect(portScheme(3000)).toBe("http");
  });

  test("a container's ports are the container side of docker ps, published or not", () => {
    expect(containerPorts("0.0.0.0:143->143/tcp, [::]:143->143/tcp, 0.0.0.0:110->110/tcp, 4190/tcp, 53/udp")).toEqual([110, 143, 4190]);
    expect(containerPorts("8080-8081/tcp")).toEqual([]);
    expect(containerPorts("")).toEqual([]);
  });

  test("traefik on the host network publishes no ports and joins no network", () => {
    const bridge = traefikCompose({ image: "traefik:v3.5", staging: false });
    expect(bridge).toContain('"80:80"');
    expect(bridge).toContain("external: true");
    const host = traefikCompose({ image: "traefik:v3.5", staging: false, hostNetwork: true });
    expect(host).toContain("network_mode: host");
    expect(host).toContain("image: traefik:v3.5");
    expect(host).not.toContain("ports:");
    expect(host).not.toContain("networks:");
    // still reaches sites by their IP on the web network
    expect(host).toContain("--providers.docker.network=web");
  });

  test("traefik refuses hosts no site serves", () => {
    const y = traefikCompose({ image: "traefik:v3", staging: false });
    expect(y).toContain("./dynamic:/etc/traefik/dynamic:ro");
    expect(y).toContain("--providers.file.directory=/etc/traefik/dynamic");
    expect(TLS_FILE).toMatch(/default:\n(\s+#.*\n)?\s+sniStrict: true/);
  });

  test("traefik settings: flags win over what the server remembers", () => {
    const server = { host: "x", traefikImage: "traefik:v3.4", hostNetwork: true, email: "a@x" };
    expect(traefikSettings(server, {})).toEqual({ email: "a@x", staging: false, image: "traefik:v3.4", hostNetwork: true, http3: true });
    expect(traefikSettings(server, { image: "traefik:v3.6", hostNetwork: false })).toMatchObject({ image: "traefik:v3.6", hostNetwork: false });
    expect(traefikSettings({ host: "x" }, {}).image).toBe(DEFAULT_TRAEFIK_IMAGE);
    expect(traefikSettings({ host: "x", http3: false }, {}).http3).toBe(false);
    expect(traefikSettings({ host: "x", http3: false }, { http3: true }).http3).toBe(true);
  });

  test("traefik with HTTP/3 enables it on websecure and publishes 443/udp", () => {
    const y = traefikCompose({ image: "traefik:v3", staging: false, http3: true });
    expect(y).toContain("--entrypoints.websecure.http3=true");
    expect(y).toContain('"443:443/udp"');
    const host = traefikCompose({ image: "traefik:v3", staging: false, http3: true, hostNetwork: true });
    expect(host).toContain("--entrypoints.websecure.http3=true");
    expect(host).not.toContain("ports:");
    const off = traefikCompose({ image: "traefik:v3", staging: false });
    expect(off).not.toContain("http3");
    expect(off).not.toContain("/udp");
  });
});
