import bcrypt from "bcryptjs";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { nextReleaseId, releaseId } from "../../src/commands/deploy";
import { detectApp, detectStaticDir, nodeDockerfile, slug } from "../../src/projects";
import { detectBuild } from "../../src/frameworks";
import { portScheme, routerPort } from "../../src/tunnel";
import { ruleArgs } from "../../src/commands/firewall";
import { guardSsh, type FirewallState } from "../../src/firewall";
import { htpasswd, traefikSettings } from "../../src/traefik";
import { defineCommand, journalCmd, parse, secretEnv } from "../../src/cmd";
import { baseDomain, checkEmail, checkLoginName, checkImage, checkInt, environmentOf, expandDomain, guessDomains, loadProject, saveProject, withPrimary } from "../../src/config";
import { findRun, laterConflicts, parseJournal, pending } from "../../src/journal";
import { assess, foreignProxy, parseProbe, parseRule, reachability, ruleFor } from "../../src/inventory";
import { containerPorts, dashboardHosts, dotenvLines, envEntries, envView, externals, hasDashboardTunnel, maskedEnv, mergeEnv, parseEnvPairs } from "../../src/remote";
import { secretsOut } from "../../src/web/server";
import { shq, writeFileCmd } from "../../src/ssh";
import { removeHostBlock, renderHostBlock, sshAliases, upsertHostBlock } from "../../src/sshconfig";
import { changes } from "../../src/dashboard";
import { capabilities, isPublic4, noUfw, parseFacts, pickIp, sslipDomain, support } from "../../src/facts";
import { parseDisk, parseSize, parseStats } from "../../src/stats";
import { parsePrunePlan, removable } from "../../src/manage";
import { HOSTNAME, LOG_SIZE, TIMEZONE, UNIT, parseKeyLine, parseSwapSize, parseSystem, withLogLimit } from "../../src/system";
import { detectProject } from "../../src/projects";
import { account, checkPassword, checkTakeable, newPassword, parseUsers, USER_NAME, USERS } from "../../src/users";
import { cmpVersion, engineNotes, newerTag, parsePkgList, parseRef, withTag } from "../../src/updates";
import { safeParts } from "../../src/web/local";
import { DEFAULT_TRAEFIK_IMAGE, parseProxy, PRELUDE, proxyFile, TLS_FILE, traefikCompose } from "../../src/templates";
import { analyze, envComposeFile, generatedCompose, mainService, nginxConf, overrideYaml, routeLabels, ruleHosts, secretUsers, siteDomains, statusKind, type Release, type SiteMeta } from "../../src/compose";
import YAML from "yaml";

const tmp = () => fs.mkdtempSync(join(tmpdir(), "landfall-test-"));

describe("shell quoting", () => {
  test("shq survives single quotes", async () => {
    const nasty = `it's "$(rm -rf /)" \`x\``;
    const out = spawnSync("sh", ["-c", `printf %s ${shq(nasty)}`]).stdout.toString();
    expect(out).toBe(nasty);
  });

  test("writeFileCmd writes bytes exactly", () => {
    const dir = tmp();
    const content = "a $b `c` 'd'\n\\e\n";
    spawnSync("sh", ["-c", writeFileCmd(join(dir, "f"), content)]);
    expect(fs.readFileSync(join(dir, "f"), "utf8")).toBe(content);
  });

  test("compose_ok wants compose 2.24 or newer", () => {
    const ok = (v: string) => spawnSync("sh", ["-c", `${PRELUDE}\ncompose_ok ${shq(v)}`]).status === 0;
    expect(["2.24.0", "2.30.1", "2.100.0", "3.0", "10.1"].filter(ok)).toHaveLength(5);
    expect(["", "1.29.2", "2.9.0", "2.19.1", "2.23.9"].filter(ok)).toEqual([]);
  });
});

describe("env", () => {
  test("merge keeps order, replaces, appends, unsets", () => {
    const out = mergeEnv("# c\nA=1\nB=2\n", { B: "3", C: "4" }, ["A"]);
    expect(out).toBe("# c\nB=3\nC=4\n");
  });
  test("values may contain =", () => {
    expect(parseEnvPairs(["URL=a=b"])).toEqual({ URL: "a=b" });
  });
  test("rejects garbage", () => {
    expect(() => parseEnvPairs(["nope"])).toThrow();
  });
  test("entries, masked view and json", () => {
    const text = "# c\nexport A=1\n\nURL=a=b\n";
    expect(envEntries(text)).toEqual([{ key: "A", value: "1" }, { key: "URL", value: "a=b" }]);
    expect(maskedEnv(text)).toBe("A=•••••••• (1)\nURL=•••••••• (3)\n");
    expect(envView(text)).toEqual({ vars: [{ key: "A", length: 1 }, { key: "URL", length: 3 }] });
    expect(envView(text, true).vars[1]).toEqual({ key: "URL", value: "a=b" });
  });
});

describe("environments", () => {
  const read = (d: string) => JSON.parse(fs.readFileSync(join(d, ".landfall.json"), "utf8"));

  test("an environment is the project with its own block on top, domains not inherited", () => {
    const d = tmp();
    saveProject(d, { name: "shop", server: "vps", domains: ["shop.com"], port: 3000 }, "");
    expect(loadProject(d, "staging")).toEqual({ name: "shop-staging", server: "vps", domains: [], port: 3000 });
    saveProject(d, { name: "shop-staging", server: "test", domains: ["staging.shop.com"], port: 3000 }, "staging");
    expect(read(d)).toEqual({ name: "shop", server: "vps", domains: ["shop.com"], port: 3000, environments: { staging: { server: "test", domains: ["staging.shop.com"] } } });
    expect(loadProject(d, "staging")).toMatchObject({ name: "shop-staging", server: "test", domains: ["staging.shop.com"] });
    // The project's own deploy rewrites its settings and keeps the environments.
    saveProject(d, { name: "shop", server: "vps", domains: ["www.shop.com"] }, "");
    expect(read(d).environments.staging.server).toBe("test");
    expect(loadProject(d, "")).not.toHaveProperty("port");
    expect(environmentOf(d, "shop-staging")).toBe("staging");
    expect(environmentOf(d, "shop")).toBe("");
    expect(environmentOf(d, "other")).toBeUndefined();
  });

  test("a folder first deployed as an environment gets the project name without the suffix", () => {
    const d = tmp();
    saveProject(d, { name: "blog-preview", server: "vps", domains: [] }, "preview");
    expect(read(d)).toEqual({ name: "blog", server: "vps", domains: [], environments: { preview: { domains: [] } } });
    expect(loadProject(d, "preview")?.name).toBe("blog-preview");
  });

  test("the compose file an environment layers on", () => {
    expect(envComposeFile("compose.yaml", "staging")).toBe("compose.staging.yaml");
    expect(envComposeFile("docker-compose.yml", "prod")).toBe("docker-compose.prod.yml");
    expect(envComposeFile("stack", "dev")).toBe("stack.dev.yaml");
  });
});

describe("deploy helpers", () => {
  test("detects build output", () => {
    const d = tmp();
    expect(detectStaticDir(d)).toBe(".");
    fs.mkdirSync(join(d, "build"));
    fs.writeFileSync(join(d, "build/index.html"), "");
    expect(detectStaticDir(d)).toBe("build");
    fs.writeFileSync(join(d, "index.html"), "");
    expect(detectStaticDir(d)).toBe(".");
  });
  test("release ids sort chronologically", () => {
    expect(releaseId(new Date("2026-01-02T03:04:05Z"))).toBe("20260102030405");
  });
  test("a second deploy in the same second gets the next id", () => {
    const now = new Date("2026-01-02T03:04:05Z");
    expect(nextReleaseId([], now)).toBe("20260102030405");
    expect(nextReleaseId(["20260102030405", "20260102030406"], now)).toBe("20260102030407");
  });
  test("numbers and images from flags", () => {
    expect(checkInt("8080", "--port", 1, 65535)).toBe(8080);
    expect(checkInt(3000, "--port", 1, 65535)).toBe(3000);
    for (const bad of ["abc", "", "80a", "0", "70000", "1.5"]) expect(() => checkInt(bad, "--port", 1, 65535)).toThrow(/--port/);
    expect(checkImage("ghcr.io/me/app:1.2@sha256:abc")).toBe("ghcr.io/me/app:1.2@sha256:abc");
    for (const bad of ['traefik"; rm -rf /', "x $(id)", "a\nb: c", "-x"]) expect(() => checkImage(bad)).toThrow(/not an image/);
  });
  test("slug", () => {
    expect(slug("My Site.com")).toBe("my-site-com");
  });
});

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

describe("ssh config", () => {
  test("upsert/replace/remove managed host block", () => {
    const f = join(tmp(), "config");
    fs.writeFileSync(f, "Host mine\n  HostName 192.0.2.4\n\nHost *\n  ServerAliveInterval 30\n");
    const b = { alias: "vps", hostname: "5.6.7.8", user: "deploy", port: 22, key: "/k" };
    upsertHostBlock(b, f);
    upsertHostBlock({ ...b, hostname: "9.9.9.9" }, f);
    const text = fs.readFileSync(f, "utf8");
    expect(text.match(/landfall:vps/g)?.length).toBe(2);
    expect(text.indexOf("Host vps")).toBeLessThan(text.indexOf("Host *"));
    expect(text).toContain("HostName 9.9.9.9");
    expect(sshAliases(f).sort()).toEqual(["mine", "vps"]);
    expect(removeHostBlock("vps", f)).toBe(true);
    expect(fs.readFileSync(f, "utf8")).toBe("Host mine\n  HostName 192.0.2.4\n\nHost *\n  ServerAliveInterval 30\n");
  });


  test("non-default port rendered", () => {
    expect(renderHostBlock({ alias: "x", hostname: "h", user: "u", port: 2222, key: "/k" })).toContain("Port 2222");
  });
});

describe("server inventory", () => {
  const want = { sshPort: 22, loginUser: "root", deployUser: "deploy", firewall: true, harden: true, traefik: true };
  const fresh = [
    "pkgs_missing= fail2ban",
    "docker=",
    "user=0",
    "ufw=inactive",
    "hardened=0",
    "password_auth=yes",
    "password_users=root ",
    "traefik_compose=none",
    "listen=0.0.0.0:22 users:((\"sshd\",pid=1,fd=3))",
  ].join("\n");
  const status = (out: string, w = want) => Object.fromEntries(assess(parseProbe(out), w).map((c) => [c.part, c.status]));

  test("fresh server: everything todo", () => {
    expect(status(fresh)).toEqual({
      packages: "todo",
      docker: "todo",
      layout: "todo",
      user: "todo",
      firewall: "todo",
      harden: "todo",
      traefik: "todo",
    });
  });

  test("docker: compose, running state and podman's shim", () => {
    const docker = (extra: string[]) => assess(parseProbe([fresh, ...extra].join("\n")), want).find((c) => c.part === "docker")!;
    const ok = ["docker=Docker version 27.3.1", "docker_running=1", "compose=2.29.7"];
    expect(docker(ok)).toMatchObject({ status: "done", detail: "docker 27.3.1, compose 2.29.7" });
    expect(docker([...ok, "docker_latest=29.9.2", "compose_latest=2.29.7"]).detail).toBe("docker 27.3.1 (29.9.2 is current), compose 2.29.7");
    expect(docker(ok.slice(0, 2))).toMatchObject({ status: "todo", detail: "docker 27.3.1, install compose" });
    expect(docker(["docker=Docker version 26.1.3", "compose=2.27.0"]).detail).toContain("start it");
    expect(docker(["docker=Docker version 19.03.15", "docker_running=1", "compose=1.29.2"]).detail).toContain("install compose");
    expect(docker(["docker=podman version 4.9.3", "docker_podman=1", "docker_running=1"]).status).toBe("conflict");
  });

  test("own traefik on the host network listening on 80/443 is done, not a conflict", () => {
    const own = [
      fresh,
      "traefik_compose=landfall",
      "traefik_container=running /opt/landfall/traefik",
      'listen=tcp 0.0.0.0:80 users:(("traefik",pid=7,fd=3))',
      'listen=tcp 0.0.0.0:443 users:(("traefik",pid=7,fd=4))',
    ].join("\n");
    expect(status(own).traefik).toBe("done");
    expect(status(own.replace("/opt/landfall/traefik", "/elsewhere")).traefik).toBe("conflict");
  });

  test("parses ss and netstat listeners", () => {
    const p = parseProbe(
      'listen=tcp [::]:5432 users:(("postgres",pid=9,fd=5))\nlisten=udp :::53 11/dnsmasq\nlisten=0.0.0.0:80 3/nc\npublished=tcp [::]:25 docker',
    );
    expect(p.listen).toEqual([
      { proto: "tcp", addr: "[::]", port: 5432, proc: "postgres" },
      { proto: "udp", addr: "::", port: 53, proc: "dnsmasq" },
      { proto: "tcp", addr: "0.0.0.0", port: 80, proc: "nc" },
    ]);
    expect(p.published).toEqual([{ proto: "tcp", addr: "[::]", port: 25, proc: "docker" }]);
  });

  const firewall = (extra: string[]) => assess(parseProbe([fresh, ...extra].join("\n")), want).find((c) => c.part === "firewall")!;
  // A mail server in containers, like mailcow, next to the host's own DHCP and resolver.
  const mail = [
    "docker_fw=iptables",
    "published=tcp 0.0.0.0:25 docker",
    "published=tcp [::]:25 docker",
    "published=tcp 0.0.0.0:993 docker",
    "published=tcp 127.0.0.1:8080 docker",
    'listen=tcp 0.0.0.0:25 users:(("docker-proxy",pid=5,fd=8))',
    'listen=udp 127.0.0.53%lo:53 users:(("systemd-resolve",pid=2,fd=14))',
    'listen=udp 203.0.113.9%eth0:68 users:(("systemd-network",pid=3,fd=23))',
  ];

  test("ufw keeps container ports open while docker manages NAT", () => {
    expect(firewall([...mail, "docker_nat4=1", "docker_nat6=1"])).toMatchObject({
      status: "todo",
      detail: "enable ufw (ssh/80/443); docker keeps 25 993 open",
    });
  });

  test("ufw would block container ports without docker NAT, or with nftables", () => {
    expect(firewall([...mail, "docker_nat4=1", "docker_nat6=0"]).detail).toBe("enabling ufw would block 25 (docker, IPv6)");
    const nft = firewall([...mail, "docker_fw=nftables"]);
    expect(nft.status).toBe("conflict");
    expect(nft.detail).toContain("docker uses nftables");
  });

  test("udp services and existing ufw rules count", () => {
    const wg = 'listen=udp 0.0.0.0:51820 users:(("wg",pid=4,fd=3))';
    expect(firewall([wg]).detail).toBe("enabling ufw would block 51820/udp (wg)");
    expect(firewall([wg, "ufw_rule=allow 51820/udp", "ufw_rule=allow 25"]).status).toBe("todo");
    expect(firewall([wg, "ufw_rule=allow 51820/tcp"]).status).toBe("conflict");
    expect(firewall([wg, "ufw_rule=allow from 10.0.0.0/8 to any port 51820 proto udp"]).status).toBe("conflict");
  });

  test("does not enable ufw over public services", () => {
    const out = `${fresh}\nlisten=0.0.0.0:5432 1/postgres\nlisten=127.0.0.1:6379 2/redis\nlisten=0.0.0.0:8080 3/docker-proxy\ndocker_nat4=1`;
    const fw = assess(parseProbe(out), want).find((c) => c.part === "firewall")!;
    expect(fw.status).toBe("conflict");
    expect(fw.detail).toBe("enabling ufw would block 5432 (postgres)");
  });

  test("keeps password users and foreign port 80", () => {
    const out = `${fresh}\npassword_users=root alice \nlisten=0.0.0.0:80 7/nginx`;
    const checks = assess(parseProbe(out), want);
    expect(checks.find((c) => c.part === "harden")).toMatchObject({ status: "conflict", detail: "alice would lose ssh password login" });
    // A key of her own: keys-only ssh keeps her in, the same rule lf harden uses.
    expect(assess(parseProbe(`${out}\nkey_users= root alice`), want).find((c) => c.part === "harden")).toMatchObject({ status: "todo" });
    expect(checks.find((c) => c.part === "traefik")).toMatchObject({ status: "conflict", detail: "port 80 is in use by nginx" });
  });

  test("own running traefik is done, foreign container conflicts", () => {
    const ours = `${fresh}\ntraefik_compose=landfall\ntraefik_container=running /opt/landfall/traefik\npublish_80=traefik \nlisten=0.0.0.0:80 5/docker-proxy`;
    expect(status(ours).traefik).toBe("done");
    expect(status(`${fresh}\ntraefik_container=running /home/me/proxy`).traefik).toBe("conflict");
    expect(status(`${fresh}\npublish_443=caddy `).traefik).toBe("conflict");
  });

  // A traefik from its own compose project owns 80/443.
  const foreign = [
    "publish_80=proxy-traefik-1 ",
    "publish_443=proxy-traefik-1 ",
    "foreign_proxy=/proxy-traefik-1|traefik:v3.7.5|proxy,|--providers.docker.network=proxy --providers.docker=true " +
      "--entrypoints.web.address=:80 --entrypoints.websecure.address=:443 --entrypoints.websecure.http3 " +
      "--certificatesresolvers.letsencryptresolver.acme.httpchallenge.entrypoint=web",
  ];
  const traefik = (extra: string[]) => assess(parseProbe([fresh, ...extra].join("\n")), want).find((c) => c.part === "traefik")!;

  test("an existing traefik is used instead of a conflict", () => {
    const t = traefik(foreign);
    expect(t.status).toBe("todo");
    expect(t.proxy).toEqual({ container: "proxy-traefik-1", network: "proxy", entrypoint: "websecure", resolver: "letsencryptresolver" });
    const adopted = traefik([...foreign, "proxy=container=proxy-traefik-1 network=proxy entrypoint=websecure resolver=r "]);
    expect(adopted).toMatchObject({ status: "done", proxy: { resolver: "r" } });
  });

  test("a traefik configured by file needs its settings named", () => {
    const t = traefik(["publish_443=edge ", "foreign_proxy=/edge|traefik:v3|a,b,|"]);
    expect(t.status).toBe("conflict");
    expect(t.detail).toContain("lf traefik use edge --network … --entrypoint … --resolver …");
    expect(foreignProxy("/caddy|caddy:2|web,|")).toBeUndefined();
  });

  test("set-up server: all done, disabled parts off", () => {
    const done = [
      "pkgs_missing=",
      "docker=Docker version 28.1.1",
      "docker_running=1",
      "compose=2.35.1",
      "root_dir=1",
      "network=1",
      "sites=2",
      "user=1",
      "user_docker=1",
      "user_key=1",
      "ufw=active",
      "hardened=1",
      "traefik_compose=landfall",
      "traefik_container=running /opt/landfall/traefik",
    ].join("\n");
    expect(new Set(Object.values(status(done)))).toEqual(new Set(["done"]));
    expect(status(done, { ...want, firewall: false }).firewall).toBe("off");
  });
});

describe("firewall", () => {
  test("parses the rules ufw prints", () => {
    expect(parseRule("allow 22/tcp")).toMatchObject({ action: "allow", port: "22", proto: "tcp", from: undefined, out: false });
    expect(parseRule("deny 5432")).toMatchObject({ action: "deny", port: "5432", proto: undefined });
    expect(parseRule("allow from 10.0.0.0/8 to any port 6000:6007 proto tcp comment 'x11 lan'")).toMatchObject({
      port: "6000:6007",
      proto: "tcp",
      from: "10.0.0.0/8",
      comment: "x11 lan",
    });
    expect(parseRule("allow out 53").out).toBe(true);
    expect(parseRule("allow OpenSSH").port).toBeUndefined();
  });

  test("enabling refuses when an earlier deny would still block ssh", async () => {
    const fw = { ufw: "active", sshPort: 22, rules: ["deny 22"].map(parseRule) } as FirewallState;
    await expect(guardSsh(fw, [...fw.rules, parseRule("allow 22/tcp")])).rejects.toThrow(/blocks ssh port 22/);
    await expect(guardSsh(fw, [parseRule("allow 22/tcp")])).resolves.toBeUndefined();
    await expect(guardSsh(fw, [...fw.rules, parseRule("allow 22/tcp")], true)).resolves.toBeUndefined();
  });

  test("the first matching rule wins", () => {
    const rules = ["deny 5432", "allow 5000:6000/tcp", "allow out 22", "allow 22"].map(parseRule);
    expect(ruleFor(rules, { proto: "tcp", port: 5432 })?.n).toBe(1);
    expect(ruleFor(rules, { proto: "tcp", port: 5500 })?.n).toBe(2);
    expect(ruleFor(rules, { proto: "udp", port: 5500 })).toBeUndefined();
    expect(ruleFor(rules, { proto: "tcp", port: 22 })?.n).toBe(4);
  });

  test("tells for every port whether it is reachable", () => {
    const probe = (lines: string[]) =>
      Object.fromEntries(reachability(parseProbe(lines.join("\n"))).map((r) => [`${r.port} ${r.proc}`, r.why]));
    const listen = [
      'listen=0.0.0.0:22 users:(("sshd",pid=1,fd=3))',
      'listen=0.0.0.0:5432 users:(("postgres",pid=2,fd=3))',
      'listen=0.0.0.0:3000 users:(("node",pid=3,fd=3))',
      'listen=127.0.0.1:6379 users:(("redis",pid=4,fd=3))',
      "published=0.0.0.0:25 mail",
      "docker_nat4=1",
    ];
    expect(probe([...listen, "ufw=inactive"])["5432 postgres"]).toBe("open, firewall off");
    const on = probe([...listen, "ufw=active", "ufw_rule=allow 22", "ufw_rule=allow from 10.0.0.0/8 to any port 5432"]);
    expect(on).toMatchObject({
      "22 sshd": "allowed by rule 1",
      "5432 postgres": "only from 10.0.0.0/8 (rule 2)",
      "3000 node": "blocked, no rule",
      "6379 redis": "localhost only",
      "25 docker": "open, docker skips ufw",
    });
    expect(probe([...listen, "ufw=active", "ufw_in=ACCEPT"])["3000 node"]).toBe("default policy accepts");
  });

  test("builds ufw arguments and rejects bad input", () => {
    expect(ruleArgs({ action: "allow", port: "51820/udp" })).toEqual(["allow", "51820/udp"]);
    expect(ruleArgs({ action: "deny", port: "5432", from: "10.0.0.0/8", comment: "db" })).toEqual(
      ["deny", "from", "10.0.0.0/8", "to", "any", "port", "5432", "comment", "db"],
    );
    expect(() => ruleArgs({ action: "allow", port: "80; rm -rf /" })).toThrow("not a port");
    expect(() => ruleArgs({ action: "allow", port: "6000:6007" })).toThrow("needs a protocol");
    expect(() => ruleArgs({ action: "allow", port: "70000" })).toThrow("1 to 65535");
    expect(() => ruleArgs({ action: "allow", port: "80", from: "$(id)" })).toThrow("not an address");
  });
});

describe("journal", () => {
  const b64 = (x: string) => Buffer.from(x).toString("base64");
  const line = (run: string, kind: string, what: string, undo = "") =>
    ["2026-10-01T10:00:00Z", run, "me@mac", "deploy", `cmd ${run}`, kind, what, undo].join("\t");
  const text = [
    line("a", "do", "created user deploy", b64("userdel -r deploy")),
    line("a", "do", "installed docker"),
    "garbage line",
    line("b", "do", "ufw allow 7000", b64("ufw delete allow 7000")),
    line("c", "undo", "4"),
  ].join("\n");

  test("groups lines into runs and marks undone steps", () => {
    const runs = parseJournal(text);
    expect(runs.map((r) => [r.n, r.id, r.steps.length])).toEqual([[1, "a", 2], [2, "b", 1], [3, "c", 1]]);
    expect(runs[0].steps[0]).toMatchObject({ line: 1, undo: "userdel -r deploy", undone: false });
    expect(runs[0].steps[1].undo).toBeUndefined();
    expect(runs[1].steps[0].undone).toBe(true);
    expect(runs[2].steps[0]).toMatchObject({ reverts: 4, what: "undid: ufw allow 7000" });
    expect(pending(runs[0]).length).toBe(1);
    expect(pending(runs[1]).length).toBe(0);
  });

  test("finds runs by number, id and step", () => {
    const runs = parseJournal(text);
    expect(findRun(runs, "#2").run.id).toBe("b");
    expect(findRun(runs, "a").steps.length).toBe(2);
    expect(findRun(runs, "1.2").steps.map((s) => s.what)).toEqual(["installed docker"]);
  });

  test("flags later runs that touched the same site", () => {
    const runs = parseJournal([
      line("a", "do", "deployed blog", b64("rm -rf /opt/landfall/sites/blog/releases/1")),
      line("b", "do", "deployed shop", b64("rm -rf /opt/landfall/sites/shop/releases/1")),
      line("c", "do", "redeployed blog", b64("ln -sfn x /opt/landfall/sites/blog/current")),
    ].join("\n"));
    expect(laterConflicts(runs, 1, runs[0].steps).map((x) => [x.run.n, x.subject])).toEqual([[3, "/opt/landfall/sites/blog"]]);
    expect(laterConflicts(runs, 2, runs[1].steps)).toEqual([]);
  });

});

test("journalCmd keeps flags but not defaults or secrets", () => {
  const cmd = { name: "deploy", options: { keep: { type: "string", desc: "", default: "5" }, save: { type: "boolean", desc: "", default: true } } } as const;
  expect(journalCmd(cmd, ["./dist", "TOKEN=abc"], { keep: "5", save: false, server: "vps", yes: true, env: ["A=1"], "dashboard-password": "pw", spa: true })).toBe(
    "deploy ./dist TOKEN=… --no-save --env A=… --dashboard-password … --spa",
  );
});

describe("server facts", () => {
  const day = new Date("2026-10-23");
  test("parses the probe", () => {
    const f = parseFacts("os=Ubuntu 24.04.5 LTS\nid=ubuntu\nversion=24.04\narch=aarch64\nuptime=90061.5\nmem=8000000 2000000\ndisk=100 40 60\npkg=apt-get\nreboot=1\n", day);
    expect(f).toMatchObject({ os: "Ubuntu 24.04.5 LTS", arch: "aarch64", uptime: 90062, pkg: "apt-get", reboot: true, support: { level: "ok" } });
    expect(f.mem).toEqual({ total: 8000000 * 1024, available: 2000000 * 1024 });
    expect(f.disk.used).toBe(40 * 1024);
  });
  test("end of life", () => {
    expect(support("ubuntu", "20.04", "apt-get", day).level).toBe("eol");
    expect(support("debian", "12.7", "apt-get", day).level).toBe("ok");
    expect(support("alpine", "3.21.2", "apk", day)).toMatchObject({ level: "ok", note: expect.stringContaining("2026-11-01") });
    expect(support("arch", "", "none", day).level).toBe("unsupported");
    expect(support("fedora", "40", "dnf", day)).toEqual({ level: "ok" });
  });
  test("addresses", () => {
    expect(isPublic4("10.0.0.1")).toBe(false);
    expect(isPublic4("172.20.1.1")).toBe(false);
    expect(isPublic4("198.51.100.1")).toBe(true);
    expect(pickIp(["192.168.1.2", "198.51.100.1"])).toBe("198.51.100.1");
    expect(pickIp(["192.168.1.2"])).toBe("192.168.1.2");
    expect(sslipDomain("blog", "198.51.100.1")).toBe("blog.198-51-100-1.sslip.io");
  });
});

describe("server stats", () => {
  test("docker sizes", () => {
    expect(parseSize("3.254MiB")).toBe(Math.round(3.254 * 1024 ** 2));
    expect(parseSize("20.5kB")).toBe(20500);
    expect(parseSize("1.914GiB")).toBe(Math.round(1.914 * 1024 ** 3));
    expect(parseSize("0B")).toBe(0);
    expect(parseSize("--")).toBe(0);
  });
  test("parses two samples into rates", () => {
    const out = [
      "T1\t100.00",
      "CPU1\tcpu  1000 0 1000 7000 1000 0 0 0 0 0",
      "NET1\tlo\t0\t0",
      "NET1\teth0\t1000\t500",
      "NET1\tveth1\t9\t9",
      "T2\t101.00",
      "CPU2\tcpu  1100 0 1100 7700 1100 0 0 0 0 0",
      "NET2\teth0\t3000\t1500",
      "NET2\tveth1\t99\t99",
      "cpus=2",
      "load=0.37 0.16 0.07",
      "mem=2000000 1500000 1000 500",
      "page=4096",
      "docker=1",
      "DISK\t/\t100\t40\t60",
      "PROC\t357\t2\t8992\tcontainerd",
      "STAT\tweb\t1.50%\t3.254MiB / 1.914GiB\t682B / 84B\t20.5kB / 8.19kB\t3",
      "CTR\tweb\tUp 1 second\tblog\tweb\tnginx:alpine",
      "RST\t/web\t2",
      'SITE\t{"v":2,"name":"blog","releases":[]}',
    ].join("\n");
    const s = parseStats(out, new Date(0));
    expect(s).toMatchObject({ uptime: 101, cpus: 2, load: [0.37, 0.16, 0.07], docker: true });
    // 200 busy of 1000 ticks: idle includes iowait.
    expect(s.cpu).toBe(20);
    expect(s.mem).toEqual({ total: 2000000 * 1024, available: 1500000 * 1024, swapTotal: 1000 * 1024, swapFree: 500 * 1024 });
    expect(s.disks).toEqual([{ mount: "/", total: 100 * 1024, used: 40 * 1024, available: 60 * 1024 }]);
    expect(s.net).toEqual([{ iface: "eth0", rx: 2000, tx: 1000 }]);
    // 2 ticks of 1000 on 2 cores, 100% = one core.
    expect(s.procs).toEqual([{ pid: 357, name: "containerd", cpu: 0.4, rss: 8992 * 4096 }]);
    expect(s.containers).toEqual([
      expect.objectContaining({ name: "web", site: "blog", project: "blog", service: "web", cpu: 1.5, net: { rx: 682, tx: 84 }, pids: 3, restarts: 2 }),
    ]);
  });
  test("no docker access", () => {
    const s = parseStats("T1\t1\nT2\t2\ncpus=1\ndocker=\n", new Date(0));
    expect(s.docker).toBe(false);
    expect(s.containers).toEqual([]);
    expect(s.cpu).toBe(0);
  });
  test("disk usage", () => {
    const d = parseDisk(
      "root=1\nDISK\t/\t100\t40\t60\nlandfall=24\nSITE\tblog\t16\t8\t1\njournald=1048576\ndocker=1\n" +
        "DF\tImages\t3\t1\t1.2GB\t800MB (66%)\nDF\tBuild Cache\t0\t0\t0B\t0B\nVOL\tdata\t0\t12MB\nLOG\tweb\t4\n",
    );
    expect(d).toMatchObject({ root: true, docker: true, landfall: 24 * 1024, journald: 1048576 });
    expect(d.sites).toEqual([{ name: "blog", size: 16 * 1024, releasesSize: 8 * 1024, releases: 1 }]);
    expect(d.dockerDf[0]).toEqual({ type: "Images", count: 3, active: 1, size: 1.2e9, reclaimable: 8e8 });
    expect(d.volumes).toEqual([{ name: "data", links: 0, size: 12e6 }]);
    expect(d.logs).toEqual([{ container: "web", size: 4096 }]);
  });
});

describe("updates", () => {
  test("apt list", () => {
    const p = parsePkgList("mgr=apt-get\npkg=tmux\t3.4-1ubuntu0.1\t3.4-1ubuntu0.2\tnoble-updates,noble-security\npkg=curl\t8.5.0-2\t8.5.0-3\tnoble-updates\nreboot=1\n");
    expect(p.mgr).toBe("apt-get");
    expect(p.reboot).toBe(true);
    expect(p.updates).toEqual([
      { name: "tmux", from: "3.4-1ubuntu0.1", to: "3.4-1ubuntu0.2", security: true },
      { name: "curl", from: "8.5.0-2", to: "8.5.0-3", security: false },
    ]);
  });
  test("zypper list", () => {
    const p = parsePkgList("mgr=zypper\npkg=curl\t8.0.1-1.1\t8.0.1-2.1\tRepo-Update\n");
    expect(p.updates).toEqual([{ name: "curl", from: "8.0.1-1.1", to: "8.0.1-2.1", security: false }]);
  });
  test("image refs", () => {
    expect(parseRef("traefik:v3.6")).toEqual({ registry: "registry-1.docker.io", repo: "library/traefik", tag: "v3.6", digest: undefined });
    expect(parseRef("ghcr.io/me/app")).toMatchObject({ registry: "ghcr.io", repo: "me/app", tag: "latest" });
    expect(parseRef("localhost:5000/app:1@sha256:ab")).toMatchObject({ registry: "localhost:5000", repo: "app", tag: "1", digest: "sha256:ab" });
    expect(parseRef("docker.io/nginx")).toMatchObject({ registry: "registry-1.docker.io", repo: "library/nginx" });
  });
});

describe("folders and access", () => {
  test("detects what a folder deploys as", () => {
    const d = tmp();
    fs.writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { build: "vite build" } }));
    fs.writeFileSync(join(d, "pnpm-lock.yaml"), "");
    expect(detectProject(d)).toMatchObject({ kind: "static", build: "pnpm build", dir: undefined });
    fs.mkdirSync(join(d, "dist"));
    fs.writeFileSync(join(d, "dist/index.html"), "");
    expect(detectProject(d)).toMatchObject({ kind: "static", dir: "dist" });
    fs.writeFileSync(join(d, "Dockerfile"), "FROM x\nEXPOSE 8080\n");
    expect(detectProject(d)).toMatchObject({ kind: "dockerfile", port: 8080 });
  });

  test("names a folder's languages, framework and tools", () => {
    const labels = (d: string) => detectProject(d).stack.map((t) => `${t.role}:${t.label}`);
    const v = tmp();
    fs.writeFileSync(join(v, "package.json"), JSON.stringify({ scripts: { build: "vite build" }, devDependencies: { vite: "7" } }));
    fs.writeFileSync(join(v, "tsconfig.json"), "{}");
    fs.writeFileSync(join(v, "pnpm-lock.yaml"), "");
    expect(labels(v)).toEqual(["language:TypeScript", "framework:Vite", "tooling:pnpm"]);
    const py = tmp();
    fs.writeFileSync(join(py, "pyproject.toml"), "[project]\ndependencies = ['fastapi']\n");
    fs.writeFileSync(join(py, "uv.lock"), "");
    fs.writeFileSync(join(py, "main.py"), "app = FastAPI()\n");
    expect(labels(py)).toEqual(["language:Python", "framework:FastAPI", "tooling:uv"]);
    const j = tmp();
    fs.writeFileSync(join(j, "pom.xml"), "<project></project>");
    fs.writeFileSync(join(j, "Dockerfile"), "FROM x\n");
    // "Java (Maven)" names no framework, and Maven only once
    expect(labels(j)).toEqual(["language:Java", "tooling:Maven", "tooling:Dockerfile"]);
  });
  test("the publish folder comes from the site generator, before its first build", () => {
    const d = tmp();
    const pkg = (deps: Record<string, string>, scripts: Record<string, string> = { build: "x" }) => fs.writeFileSync(join(d, "package.json"), JSON.stringify({ scripts, devDependencies: deps }));
    fs.writeFileSync(join(d, "index.html"), "<script type=module src=/main.js>");
    pkg({ vite: "7" });
    expect(detectStaticDir(d)).toBe("dist");
    expect(detectProject(d)).toMatchObject({ kind: "static", dir: "dist", tool: "Vite", build: "npm run build" });
    fs.writeFileSync(join(d, "vite.config.ts"), "export default { build: { outDir: './www' } }");
    expect(detectBuild(d)).toEqual({ tool: "Vite", dir: "www", build: "npm run build" });
    pkg({ "@sveltejs/kit": "2", "@sveltejs/adapter-static": "3", vite: "7" });
    expect(detectStaticDir(d)).toBe("build");
    pkg({ next: "15" });
    fs.writeFileSync(join(d, "next.config.mjs"), "export default { output: 'export' }");
    expect(detectStaticDir(d)).toBe("out");
    fs.rmSync(join(d, "next.config.mjs"));
    pkg({ astro: "5" });
    expect(detectStaticDir(d)).toBe("dist");
    // no build script: a plain folder with its index.html
    fs.writeFileSync(join(d, "package.json"), JSON.stringify({ devDependencies: { vite: "7" } }));
    expect(detectStaticDir(d)).toBe(".");
    pkg({ vitepress: "1" }, { build: "vitepress build docs" });
    expect(detectStaticDir(d)).toBe("docs/.vitepress/dist");
    pkg({ vitepress: "1" }, { build: "vitepress build" });
    expect(detectStaticDir(d)).toBe(".vitepress/dist");
    pkg({ hexo: "7" });
    expect(detectBuild(d)).toMatchObject({ tool: "Hexo", dir: "public" });
    pkg({ "@quasar/app-vite": "2" });
    expect(detectStaticDir(d)).toBe("dist/spa");
    const z = tmp();
    fs.writeFileSync(join(z, "book.toml"), "[book]\ntitle = 'x'\n");
    expect(detectBuild(z)).toEqual({ tool: "mdBook", dir: "book", build: "mdbook build" });
    fs.rmSync(join(z, "book.toml"));
    fs.writeFileSync(join(z, "config.toml"), "base_url = 'https://x.dev'\n");
    fs.mkdirSync(join(z, "templates"));
    expect(detectBuild(z)).toEqual({ tool: "Zola", dir: "public", build: "zola build" });
    const h = tmp();
    fs.writeFileSync(join(h, "hugo.toml"), "title = 'x'");
    expect(detectProject(h)).toMatchObject({ kind: "static", dir: "public", tool: "Hugo", build: "hugo --minify" });
  });
  test("server-rendering frameworks run as Node.js apps", () => {
    const d = tmp();
    const pkg = (deps: Record<string, string>, scripts: Record<string, string> = { build: "x" }) =>
      fs.writeFileSync(join(d, "package.json"), JSON.stringify({ scripts, dependencies: deps }));
    const start = () => detectBuild(d).start;
    pkg({ next: "15" });
    expect(detectBuild(d)).toEqual({ tool: "Next.js", build: "npm run build", start: "./node_modules/.bin/next start" });
    // output: 'standalone' runs the server Next.js writes; the image keeps only it, its static files and public/
    fs.writeFileSync(join(d, "next.config.ts"), "export default { output: 'standalone' }");
    fs.mkdirSync(join(d, "public"));
    expect(detectBuild(d)).toEqual({ tool: "Next.js (output: 'standalone')", build: "npm run build", start: "node server.js", standalone: ".next" });
    const img = detectApp(d)!.dockerfile({ build: "npm run build", start: "node server.js", port: 3000 });
    expect(img).toContain("FROM node:24-slim AS build\n");
    expect(img).toContain("RUN npm run build\n\nFROM node:24-slim\nWORKDIR /app\nCOPY --from=build /app/.next/standalone ./\nCOPY --from=build /app/.next/static ./.next/static\nCOPY --from=build /app/public ./public\n");
    expect(img).toMatch(/HOSTNAME=0\.0\.0\.0 PORT=3000\nEXPOSE 3000\nCMD node server\.js\n$/);
    // a start command of one's own runs in the whole project
    expect(detectApp(d, "npm start")!.dockerfile({ start: "npm start", port: 3000 })).not.toContain("COPY --from=build");
    fs.rmSync(join(d, "next.config.ts"));
    fs.rmSync(join(d, "public"), { recursive: true });
    pkg({ nuxt: "4" }, { build: "nuxt build" });
    expect(start()).toBe("node .output/server/index.mjs");
    pkg({ nuxt: "4" }, { build: "nuxt generate" });
    expect(detectBuild(d)).toEqual({ tool: "Nuxt (nuxt generate)", dir: ".output/public", build: "npm run build" });
    pkg({ "@tanstack/react-start": "1", vite: "7" }, { build: "vite build", start: "node .output/server/index.mjs" });
    expect(detectBuild(d)).toMatchObject({ tool: "TanStack Start", start: "npm start" });
    pkg({ "@sveltejs/kit": "2", "@sveltejs/adapter-node": "5" });
    expect(start()).toBe("node build");
    pkg({ astro: "5", "@astrojs/node": "9" });
    expect(start()).toBe("node ./dist/server/entry.mjs");
    pkg({ "@react-router/dev": "7" });
    expect(start()).toBe("./node_modules/.bin/react-router-serve ./build/server/index.js");
    fs.writeFileSync(join(d, "react-router.config.ts"), "export default { ssr: false }");
    expect(detectBuild(d)).toEqual({ tool: "React Router (ssr: false)", dir: "build/client", build: "npm run build" });
    pkg({ "@sveltejs/kit": "2", "svelte-adapter-bun": "0" });
    expect(start()).toBe("bun ./build/index.js");
    // adapter-auto builds nothing a server runs: the image switches it to adapter-node first
    pkg({ "@sveltejs/kit": "2", "@sveltejs/adapter-auto": "6" });
    fs.writeFileSync(join(d, "svelte.config.js"), "import adapter from '@sveltejs/adapter-auto';\nexport default { kit: { adapter: adapter() } };");
    expect(detectBuild(d)).toMatchObject({ tool: "SvelteKit (adapter-auto, built with adapter-node)", start: "node build" });
    expect(detectApp(d)!.dockerfile({ build: "npm run build", start: "node build", port: 3000 })).toContain(
      "COPY . .\nRUN npm install -D @sveltejs/adapter-node && sed -i 's#@sveltejs/adapter-auto#@sveltejs/adapter-node#' svelte.config.js\nRUN npm run build\n",
    );
    fs.rmSync(join(d, "svelte.config.js"));
    pkg({ "@analogjs/platform": "1" });
    expect(start()).toBe("node dist/analog/server/index.mjs");
    pkg({ "@adonisjs/core": "6" }, { build: "node ace build", start: "node bin/server.js" });
    expect(detectBuild(d)).toMatchObject({ tool: "AdonisJS", start: "node build/bin/server.js" });
    // Nuxt's server on Bun, or its static preset
    pkg({ nuxt: "4" }, { build: "nuxt build" });
    fs.writeFileSync(join(d, "nuxt.config.ts"), "export default defineNuxtConfig({ nitro: { preset: 'bun' } })");
    expect(start()).toBe("bun .output/server/index.mjs");
    fs.writeFileSync(join(d, "nuxt.config.ts"), "export default defineNuxtConfig({ nitro: { preset: 'static' } })");
    expect(detectBuild(d)).toMatchObject({ tool: "Nuxt (nuxt generate)", dir: ".output/public" });
    fs.rmSync(join(d, "nuxt.config.ts"));
    // Qwik City: its adapter decides
    pkg({ "@builder.io/qwik-city": "1" });
    fs.mkdirSync(join(d, "adapters/express"), { recursive: true });
    expect(start()).toBe("node server/entry.express");
    fs.rmSync(join(d, "adapters"), { recursive: true });
    fs.mkdirSync(join(d, "adapters/static"), { recursive: true });
    expect(detectBuild(d)).toMatchObject({ tool: "Qwik City (static)", dir: "dist" });
    fs.rmSync(join(d, "adapters"), { recursive: true });
    // without an adapter it cannot deploy: it says how to add one, unless a start command of one's own is given
    expect(detectApp(d)!.fix).toMatch(/needs an adapter.*npm run qwik add/);
    expect(detectApp(d, "node srv.js")!.fix).toBeUndefined();
    // a server of its own needs no build script
    pkg({ express: "5" }, { start: "node server.js" });
    expect(detectBuild(d)).toEqual({ tool: undefined, build: undefined, start: "npm start" });
    expect(detectProject(d)).toMatchObject({ kind: "dockerfile", runtime: "Node.js", tool: undefined, start: "npm start", port: 3000, node: true });
    // saved as static, it stays static; a saved start command makes any folder an app
    fs.writeFileSync(join(d, ".landfall.json"), JSON.stringify({ name: "x", domains: [], static: true }));
    expect(detectProject(d)).toMatchObject({ kind: "static", node: true });
    expect(detectProject(d).start).toBeUndefined();
    pkg({ vite: "7" });
    fs.writeFileSync(join(d, ".landfall.json"), JSON.stringify({ name: "x", domains: [], start: "node srv.js", port: 8080 }));
    expect(detectProject(d)).toMatchObject({ kind: "dockerfile", start: "node srv.js", tool: undefined, port: 8080, build: "npm run build" });
    // saved volumes and worker come back, for an app as for a Dockerfile
    fs.writeFileSync(join(d, ".landfall.json"), JSON.stringify({ name: "x", domains: [], start: "node worker.js", worker: true, volumes: ["/app/data"] }));
    expect(detectProject(d)).toMatchObject({ kind: "dockerfile", worker: true, volumes: ["/app/data"] });
    fs.writeFileSync(join(d, "Dockerfile"), "FROM x\n");
    expect(detectProject(d)).toMatchObject({ kind: "dockerfile", worker: true, volumes: ["/app/data"] });
    // saved empty (--volume ''): no volumes, not the app's defaults
    const rails = tmp();
    fs.writeFileSync(join(rails, "Gemfile"), "gem 'rails'\ngem 'sqlite3'\n");
    fs.mkdirSync(join(rails, "config"));
    fs.writeFileSync(join(rails, "config/application.rb"), "");
    fs.writeFileSync(join(rails, "config/database.yml"), "production:\n  database: storage/production.sqlite3\n");
    expect(detectProject(rails).volumes).toEqual(["/app/storage"]);
    fs.writeFileSync(join(rails, ".landfall.json"), JSON.stringify({ name: "x", domains: [], volumes: [] }));
    expect(detectProject(rails).volumes).toEqual([]);
  });

  test("the Dockerfile for a Node.js app", () => {
    const d = tmp();
    fs.writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { build: "next build" } }));
    fs.writeFileSync(join(d, "pnpm-lock.yaml"), "");
    fs.writeFileSync(join(d, ".nvmrc"), "v22.11.0\n");
    const f = nodeDockerfile(d, { tool: "Next.js", build: "pnpm build", start: "./node_modules/.bin/next start", port: 3000 });
    expect(f).toContain("FROM node:22-slim\n");
    expect(f).toContain("RUN corepack enable || npm install -g pnpm\nCOPY package.json pnpm-lock.yaml ./\nRUN pnpm install --frozen-lockfile\nCOPY . .\nRUN pnpm build\n");
    expect(f).toMatch(/ENV NODE_ENV=production .*PORT=3000\nEXPOSE 3000\nCMD \.\/node_modules\/\.bin\/next start\n$/);
    // install scripts need the whole project; no lockfile, no npm ci
    fs.rmSync(join(d, "pnpm-lock.yaml"));
    fs.rmSync(join(d, ".nvmrc"));
    fs.writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { postinstall: "nuxt prepare" } }));
    const g = nodeDockerfile(d, { start: "node .output/server/index.mjs", port: 3000 });
    expect(g).toContain("FROM node:24-slim\nWORKDIR /app\nCOPY . .\nRUN npm install\nENV");
  });

  test("websocket and plain Node.js servers", () => {
    const d = tmp();
    const pkg = (o: object) => fs.writeFileSync(join(d, "package.json"), JSON.stringify(o));
    // a server dependency and an entry file, no scripts at all
    pkg({ dependencies: { ws: "8" } });
    fs.writeFileSync(join(d, "server.js"), "");
    expect(detectBuild(d)).toEqual({ tool: undefined, build: undefined, start: "node server.js" });
    fs.rmSync(join(d, "server.js"));
    fs.mkdirSync(join(d, "src"));
    fs.writeFileSync(join(d, "src/main.js"), "");
    pkg({ main: "src/main.js", dependencies: { "socket.io": "4" } });
    expect(detectBuild(d).start).toBe("node src/main.js");
    // any start script that is not a dev server runs as an app
    pkg({ scripts: { start: "NODE_ENV=production node dist/index.js" } });
    expect(detectBuild(d).start).toBe("npm start");
    for (const dev of ["vite", "npx serve -s build", "react-scripts start", "npm run dev"]) {
      pkg({ scripts: { start: dev } });
      expect(detectBuild(d).start).toBeUndefined();
    }
  });

  test("Bun", () => {
    const d = tmp();
    fs.writeFileSync(join(d, "package.json"), JSON.stringify({ module: "index.ts", devDependencies: { "@types/bun": "1" }, packageManager: "bun@1.2.21" }));
    fs.writeFileSync(join(d, "index.ts"), "Bun.serve({ fetch: () => new Response('ok') })");
    fs.writeFileSync(join(d, "bun.lock"), "");
    const app = detectApp(d)!;
    expect(app).toMatchObject({ name: "Bun", tool: undefined, start: "bun index.ts", port: 3000 });
    const f = app.dockerfile({ start: app.start, port: 3000 });
    expect(f).toContain("FROM oven/bun:1.2.21-slim\nWORKDIR /app\nCOPY package.json bun.lock ./\nRUN bun install --frozen-lockfile\n");
    expect(f).toContain("CMD bun index.ts\n");
    // a script, not a server
    fs.writeFileSync(join(d, "index.ts"), "console.log('hi')");
    expect(detectApp(d)).toBeUndefined();
    // Elysia runs on Bun only, and so does a start script with bun
    fs.rmSync(join(d, "bun.lock"));
    fs.writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { start: "bun src/index.ts" }, dependencies: { elysia: "1" } }));
    expect(detectApp(d)).toMatchObject({ name: "Bun", tool: undefined, start: "bun run start" });
    fs.writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { start: "bun src/index.ts" }, dependencies: { hono: "4" } }));
    expect(detectApp(d)).toMatchObject({ name: "Bun", start: "bun run start" });
    fs.writeFileSync(join(d, "bun.lock"), "");
    // a Next.js app with Bun's lockfile runs on Bun's image
    fs.writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { build: "next build", start: "next start" }, dependencies: { next: "15" } }));
    expect(detectApp(d)).toMatchObject({ name: "Bun", tool: "Next.js", build: "bun run build" });
  });

  test("Deno", () => {
    const d = tmp();
    // Fresh 2: its build writes the server to _fresh/
    fs.writeFileSync(join(d, "deno.json"), JSON.stringify({ tasks: { dev: "vite", build: "vite build", start: "deno serve -A _fresh/server.js" }, imports: { fresh: "jsr:@fresh/core@^2" } }));
    const fresh = detectApp(d)!;
    expect(fresh).toMatchObject({ name: "Deno", tool: "Fresh", build: "deno task build", start: "deno serve -A --port $PORT _fresh/server.js", port: 8000 });
    expect(fresh.dockerfile({ build: fresh.build, start: fresh.start, port: 8000 })).toContain("FROM denoland/deno:2\nWORKDIR /app\nCOPY . .\nRUN deno install\nRUN deno task build\n");
    // a start task that watches is for developing: the entry runs instead
    fs.writeFileSync(join(d, "deno.json"), JSON.stringify({ tasks: { start: "deno run --watch -A main.ts" }, imports: { hono: "jsr:@hono/hono@^4" } }));
    fs.writeFileSync(join(d, "main.ts"), "Deno.serve(() => new Response('hi'))");
    expect(detectApp(d)).toMatchObject({ name: "Deno", tool: "Hono", start: "deno run -A main.ts", build: undefined });
    fs.writeFileSync(join(d, "deno.json"), JSON.stringify({ tasks: { start: "deno run -A main.ts" } }));
    expect(detectApp(d)).toMatchObject({ name: "Deno", tool: undefined, start: "deno task start" });
    // Lume builds a site: static, built with its task
    fs.writeFileSync(join(d, "deno.json"), JSON.stringify({ imports: { "lume/": "https://deno.land/x/lume@v2/" }, tasks: { build: "deno task lume" } }));
    fs.writeFileSync(join(d, "_config.ts"), "import lume from 'lume/mod.ts';\nexport default lume();");
    expect(detectProject(d)).toMatchObject({ kind: "static", tool: "Lume", dir: "_site", build: "deno task build" });
  });

  test("other languages", () => {
    const app = (fs_: Record<string, string>) => {
      const d = tmp();
      for (const [f, body] of Object.entries(fs_)) {
        fs.mkdirSync(join(d, f, ".."), { recursive: true });
        fs.writeFileSync(join(d, f), body);
      }
      const a = detectApp(d)!;
      return { ...a, file: a?.dockerfile({ build: a.build, start: a.start, port: a.port }) };
    };
    const flask = app({ "requirements.txt": "flask\n", "app.py": "from flask import Flask\napp = Flask(__name__)\n" });
    expect(flask).toMatchObject({ name: "Python", tool: "Flask", port: 8000, start: "gunicorn app:app --bind 0.0.0.0:$PORT" });
    expect(flask.file).toContain("FROM python:3.13-slim");
    expect(app({ "requirements.txt": "fastapi\n", "main.py": "app = FastAPI()\n" }).start).toMatch(/^uvicorn main:app /);
    expect(app({ "requirements.txt": "django\n", "manage.py": "", "mysite/wsgi.py": "" }).start).toMatch(/^gunicorn mysite\.wsgi/);

    const go = app({ "go.mod": "module x\n\ngo 1.23.4\n", "main.go": "package main\nfunc main() {}\n" });
    expect(go).toMatchObject({ name: "Go", port: 8080, start: "app" });
    expect(go.file).toContain("FROM golang:1.23");
    // Hugo sites carry a go.mod too
    expect(app({ "go.mod": "module x\n", "hugo.toml": "" }).name).not.toBe("Go");

    const rust = app({ "Cargo.toml": '[package]\nname = "srv"\n', "src/main.rs": "fn main() {}" });
    expect(rust).toMatchObject({ name: "Rust", start: "srv" });
    expect(rust.file).toContain("cp target/release/srv /out/");

    const spring = app({ "pom.xml": "<parent><artifactId>spring-boot-starter-parent</artifactId></parent><properties><java.version>17</java.version></properties>" });
    expect(spring).toMatchObject({ name: "Java", tool: "Spring Boot (Maven)", start: "java -jar app.jar", build: "mvn -B -DskipTests package" });
    expect(spring.file).toContain("FROM maven:3-eclipse-temurin-17 AS build");
    expect(spring.file).toContain("FROM eclipse-temurin:17-jre");
    const ktor = app({ "build.gradle.kts": 'plugins { kotlin("jvm") }\ndependencies { implementation("io.ktor:ktor-server-netty") }\nkotlin { jvmToolchain(22) }', gradlew: "" });
    expect(ktor).toMatchObject({ name: "Kotlin", build: "./gradlew --no-daemon buildFatJar" });
    expect(ktor.file).toContain("FROM eclipse-temurin:25-jdk AS build");
    expect(app({ "build.gradle": "apply plugin: 'com.android.application'" }).name).toBeUndefined();

    expect(app({ "Api.csproj": '<Project Sdk="Microsoft.NET.Sdk.Web"><TargetFramework>net9.0</TargetFramework></Project>' })).toMatchObject({ name: ".NET", start: "dotnet Api.dll" });
    expect(app({ Gemfile: "gem 'rails'\n", "config/application.rb": "" })).toMatchObject({ name: "Ruby", secret: "RAILS_MASTER_KEY" });
    expect(app({ "composer.json": '{"require":{"laravel/framework":"11"}}', "public/index.php": "", artisan: "" })).toMatchObject({ name: "PHP", port: 80, secret: "APP_KEY" });
    expect(app({ "mix.exs": ":phoenix" }).name).toBe("Elixir");
    // a Procfile names the start command
    expect(app({ "requirements.txt": "", Procfile: "web: python -m srv --port $PORT\n" }).start).toBe("python -m srv --port $PORT");
    // a start command given makes any entry an app of its language
    const bot = tmp();
    fs.writeFileSync(join(bot, "requirements.txt"), "discord.py\n");
    expect(detectApp(bot, "python bot.py")).toMatchObject({ name: "Python", start: "python bot.py" });
    // Rails 8 on SQLite: storage/ outlives deploys and the database is prepared on start
    const rails = app({ Gemfile: "gem 'rails'\ngem 'sqlite3'\n", "config/application.rb": "", "config/database.yml": "production:\n  database: storage/production.sqlite3\n" });
    expect(rails).toMatchObject({ volumes: ["/app/storage"], start: expect.stringMatching(/^bundle exec rails db:prepare && /) });
  });

  test("upload paths stay inside", () => {
    expect(safeParts("../../etc//passwd")).toEqual(["etc", "passwd"]);
    expect(safeParts("site\\a/./b.html")).toEqual(["site", "a", "b.html"]);
  });
  test("which dashboard commands change a server", () => {
    expect(changes(["domains", "blog"])).toBe(false);
    expect(changes(["domains", "blog", "--add", "x.test"])).toBe(true);
    expect(changes(["auth", "blog", "--off"])).toBe(true);
    expect(changes(["updates", "-s", "vps"])).toBe(false);
    expect(changes(["update", "--packages"])).toBe(true);
  });
});

describe("versions", () => {
  test("cmpVersion compares numerically", () => {
    expect(cmpVersion("3.10", "3.9")).toBeGreaterThan(0);
    expect(cmpVersion("v2.29.7", "2.29.7")).toBe(0);
    expect(cmpVersion("28.5.2", "29.9.2")).toBeLessThan(0);
  });

  test("newerTag keeps prefix and depth, skips non-version tags", () => {
    const tags = ["v3", "v3.6", "v3.7", "v3.10", "v3.6.2", "v3.7.16", "v4.0-rc1", "latest", "3.7", "v2.11"];
    expect(newerTag("v3.6", tags)).toBe("v3.10");
    expect(newerTag("v3.6.2", tags)).toBe("v3.7.16");
    expect(newerTag("v3.10", tags)).toBeUndefined();
    expect(newerTag("v3", tags)).toBeUndefined();
    expect(newerTag("latest", tags)).toBeUndefined();
    expect(newerTag("1.27-alpine", ["1.29-alpine"])).toBeUndefined();
    expect(withTag("ghcr.io:443/a/b:v3.6", "v3.7")).toBe("ghcr.io:443/a/b:v3.7");
  });

  test("engineNotes: landfall's own compose can be updated, distro ones are only reported", () => {
    const e = { docker: "29.9.2", compose: "2.40.3", composePath: "/usr/local/lib/docker/cli-plugins/docker-compose", dockerCe: false, synology: false, latestDocker: "29.9.2", latestCompose: "5.6.1" };
    expect(engineNotes(e)).toMatchObject({ dockerNote: undefined, composeUpdate: true });
    expect(engineNotes({ ...e, composePath: "/usr/libexec/docker/cli-plugins/docker-compose", dockerCe: true })).toMatchObject({ composeUpdate: false, composeNote: "compose 2.40.3, 5.6.1 is current (comes with the package upgrades)" });
    expect(engineNotes({ ...e, docker: "26.1.5" }).dockerNote).toContain("29.9.2 is current");
    expect(engineNotes({ ...e, latestDocker: undefined, latestCompose: undefined })).toMatchObject({ dockerNote: undefined, composeNote: undefined, composeUpdate: false });
    // Same plugin path on DSM, but Container Manager owns it.
    expect(engineNotes({ ...e, synology: true })).toMatchObject({ composeUpdate: false, composeNote: "compose 2.40.3, 5.6.1 is current (comes with Container Manager updates in Package Center)" });
  });
});

describe("main domains", () => {
  test("picks the base domain most routed hosts share", () => {
    const hosts = ["example.dev", "www.example.dev", "kcal.example.dev", "kcal.example.dev", "example.net", "www.example.net", "mail.example.dev"];
    expect(guessDomains(hosts)).toEqual([{ domain: "example.dev", hosts: 4 }, { domain: "example.net", hosts: 2 }]);
  });
  test("needs two hosts and skips free wildcard DNS", () => {
    expect(guessDomains(["blog.example.com"])).toEqual([]);
    expect(guessDomains(["a.1-2-3-4.sslip.io", "b.1-2-3-4.sslip.io", "x.example.com"])).toEqual([]);
  });
  test("short names use the primary", () => {
    const server = { host: "h", domains: ["example.dev", "example.org"] };
    expect(expandDomain("blog", server)).toBe("blog.example.dev");
    expect(expandDomain("Blog.Example.org", server)).toBe("blog.example.org");
    expect(expandDomain("blog", { host: "h" })).toBe("blog");
    expect(withPrimary(server.domains, "example.org")).toEqual(["example.org", "example.dev"]);
    expect(withPrimary(undefined, "a.dev")).toEqual(["a.dev"]);
  });
  test("keeps co.uk-style suffixes", () => {
    expect(baseDomain("shop.example.co.uk")).toBe("example.co.uk");
    expect(baseDomain("a.b.example.com")).toBe("example.com");
  });
});

describe("externals", () => {
  test("groups routed containers by compose project, skips landfall and the proxy", () => {
    const p = { "com.docker.compose.project": "korro", "com.docker.compose.project.working_dir": "/root/container/korro" };
    const out = externals(
      [
        { name: "korro-korro-1", labels: { ...p, "traefik.http.routers.k.rule": "Host(`korro.app`) || Host(`www.korro.app`, `KORRO.app`)" } },
        { name: "korro-pg-1", labels: p },
        { name: "mail", labels: { "traefik.http.routers.m.rule": "Host(`mail.x.dev`)", "traefik.http.routers.m-http.rule": "Host(`mail.x.dev`) && PathPrefix(`/`)" } },
        { name: "landfall-blog", labels: { "landfall.managed": "true", "traefik.http.routers.b.rule": "Host(`blog.dev`)" } },
        { name: "off", labels: { "traefik.enable": "false", "traefik.http.routers.o.rule": "Host(`o.dev`)" } },
        { name: "traefik", labels: { "traefik.http.routers.d.rule": "Host(`traefik.x.dev`)" } },
      ],
      new Map([["korro-korro-1", "Up 2 hours"], ["mail", "Exited (1)"]]),
      "traefik",
    );
    expect(out).toEqual([
      { name: "korro", domains: ["korro.app", "www.korro.app"], status: "Up 2 hours", containers: ["korro-korro-1"], dir: "/root/container/korro" },
      { name: "mail", domains: ["mail.x.dev"], status: "Exited (1)", containers: ["mail"], dir: undefined },
    ]);
  });
});

describe("secrets stay off the command line", () => {
  test("web jobs pass passwords as env and env pairs on stdin", () => {
    expect(secretsOut(["deploy", "--auth-password", "s3cret", "-y"])).toEqual({ args: ["deploy", "-y"], env: { LANDFALL_SECRET_AUTH_PASSWORD: "s3cret" }, stdin: undefined });
    expect(secretsOut(["auth", "blog", "--password=a b"]).env).toEqual({ LANDFALL_SECRET_PASSWORD: "a b" });
    expect(secretsOut(["env", "blog", "-s", "x", "A=1", "B=two=2", "-u", "C"])).toEqual({
      args: ["env", "blog", "-s", "x", "-u", "C", "--env-file", "-"],
      env: {},
      stdin: "A=1\nB=two=2\n",
    });
    // Not an env command: KEY=VALUE stays an argument.
    expect(secretsOut(["deploy", "-e", "A=1"]).args).toEqual(["deploy", "-e", "A=1"]);
    expect(secretsOut(["secret", "blog", "tls.key=abc"])).toEqual({ args: ["secret", "blog", "--env-file", "-"], env: {}, stdin: "tls.key=abc\n" });
  });

  test("password options fall back to LANDFALL_SECRET_*", () => {
    const cmd = defineCommand({ name: "t", summary: "", options: { "dashboard-password": { type: "string", desc: "" } }, async run() {} });
    expect(secretEnv("dashboard-password")).toBe("LANDFALL_SECRET_DASHBOARD_PASSWORD");
    process.env.LANDFALL_SECRET_DASHBOARD_PASSWORD = "from-env";
    try {
      expect(parse(cmd, []).values["dashboard-password"]).toBe("from-env");
      expect(parse(cmd, ["--dashboard-password", "flag"]).values["dashboard-password"]).toBe("flag");
    } finally {
      delete process.env.LANDFALL_SECRET_DASHBOARD_PASSWORD;
    }
  });

  test("dotenv lines", () => {
    expect(parseEnvPairs(dotenvLines("# c\nexport A=1\n\nC=a=b\n"))).toEqual({ A: "1", C: "a=b" });
  });
});

describe("input checks", () => {
  test("login names and emails that reach remote files", () => {
    expect(checkLoginName("admin.me@x")).toBe("admin.me@x");
    expect(() => checkLoginName("a:b")).toThrow();
    expect(() => checkLoginName("a\nb")).toThrow();
    expect(checkEmail("me@example.com")).toBe("me@example.com");
    expect(() => checkEmail("me@example.com'; rm -rf /")).toThrow();
    expect(() => checkEmail("$(id)@x.com")).toThrow();
  });
});

describe("prune", () => {
  const id = (c: string) => `sha256:${c.repeat(64)}`;
  const site = { v: 2, name: "blog", releases: [{ id: "20260101-1", services: [{ name: "Web", build: true, networks: [] }, { name: "db", networks: [] }] }] };
  const out = [
    `IMG\t${id("a")}\tnginx\talpine\t50MB\t2026-01-01 10:00:00 +0000 UTC`,
    `IMG\t${id("b")}\tblog-web\t20260101-1\t120MB\t2026-01-01`,
    `IMG\t${id("c")}\t<none>\t<none>\t80MB\t2026-01-01`,
    `IMG\t${id("d")}\t<none>\t<none>\t90MB\t2026-01-01`,
    `IMG\t${id("e")}\t<none>\t<none>\t10MB\t2026-01-01`,
    `IMG\t${id("f")}\tredis\t7\t40MB\t2026-01-01`,
    `IMG\t${id("f")}\tredis\tlatest\t40MB\t2026-01-01`,
    `USED\t${id("e")}`,
    `KEEP\t${id("d")}`,
    `SITE\t${JSON.stringify(site)}`,
    "DF\tImages\t1.2GB (40%)",
    "DF\tBuild Cache\t300MB (100%)",
  ].join("\n");

  test("keeps used, release and undo images; tagged ones only without --all", () => {
    const p = parsePrunePlan(out);
    const keep = Object.fromEntries(p.images.map((i) => [i.id.slice(7, 8), i.keep]));
    expect(keep).toEqual({ a: "tagged", b: "release", c: undefined, d: "undo", e: "used", f: "tagged" });
    expect(p.images.find((i) => i.id === id("f"))!.tags).toEqual(["redis:7", "redis:latest"]);
    expect(p.buildCache).toBe(300e6);
    expect(removable(p).map((i) => i.id)).toEqual([id("c")]);
    expect(removable(parsePrunePlan(out, true)).map((i) => i.id).sort()).toEqual([id("a"), id("c"), id("f")]);
  });

  test("no docker", () => {
    expect(parsePrunePlan("NODOCKER\n").docker).toBe(false);
  });
});

describe("capabilities", () => {
  const base = "os=X\nid=debian\nversion=12\npkg=apt\ndocker=27.0.1\ncompose=2.29.1\ninit=systemd\nuser=root\nadmin=1\nufw=1\nusertool=useradd\n";
  const facts = (extra = "") => parseFacts(base + extra, new Date("2026-01-01"));

  test("a plain server can do everything", () => {
    const k = capabilities(facts());
    expect(Object.values(k.can).every(Boolean)).toBe(true);
    expect(k.why).toEqual({});
  });

  test("Synology: no setup or packages, DSM's firewall, docker and services work", () => {
    const f = facts("id=dsm\nversion=7.2\npkg=none\nufw=0\nplatform=synology\n");
    expect(f.support.level).toBe("limited");
    const k = capabilities(f);
    expect(k.can).toMatchObject({ setup: false, packages: false, firewall: false, docker: true, compose: true, services: true, admin: true });
    expect(k.why.firewall).toMatch(/Control Panel/);
    expect(noUfw("synology", "none", false)).toMatch(/DSM/);
  });

  test("SteamOS without docker or sudo: says how to get docker; root's key makes it admin", () => {
    const f = facts("id=steamos\npkg=none\ndocker=\ncompose=\nuser=deck\nadmin=0\nufw=0\nplatform=steamos\n");
    const k = capabilities(f);
    expect(k.can).toMatchObject({ docker: false, compose: false, admin: false, firewall: false, setup: false });
    expect(k.why.docker).toMatch(/home directory/);
    expect(k.why.admin).toMatch(/deck has no passwordless sudo/);
    expect(capabilities(f, true).can.admin).toBe(true);
    expect(capabilities({ ...f, podman: "5.4.0" }).why.docker).toMatch(/^only podman 5.4.0 here: landfall needs docker/);
  });

  test("no init system: no services; no package manager: a firewall needs ufw already there", () => {
    const f = facts("init=\npkg=none\nid=\n");
    expect(f.support.level).toBe("unsupported");
    const k = capabilities(f);
    expect(k.can.services).toBe(false);
    expect(k.can.firewall).toBe(true);
    expect(capabilities({ ...f, ufw: false }).why.firewall).toMatch(/no ufw/);
  });

  test("users: needs admin and useradd or adduser; DSM keeps its own", () => {
    expect(capabilities(facts("usertool=adduser\n")).can.users).toBe(true);
    expect(capabilities(facts("usertool=\n")).why.users).toMatch(/no useradd or adduser/);
    const deck = facts("user=deck\nadmin=0\n");
    expect(capabilities(deck).can.users).toBe(false);
    expect(capabilities(deck).why.users).toMatch(/deck has no passwordless sudo/);
    expect(capabilities(deck, true).can.users).toBe(true);
    expect(capabilities(facts("id=dsm\npkg=none\nplatform=synology\n")).why.users).toMatch(/Control Panel/);
  });
});

describe("users", () => {
  const out = [
    "admin=root",
    "sudo=1",
    "sshd_passwords=no",
    "PW\troot\tlocked",
    "PW\tdeploy\tnone",
    "PW\tanna\tset",
    "PW\tci\tnone",
    "USER\troot\t0\t/root\t/bin/bash\troot\t1\t\t",
    "USER\tdeploy\t1000\t/home/deploy\t/bin/bash\tdeploy,docker\t2\t1\t1",
    "USER\tanna\t1001\t/home/anna\t/bin/bash\tanna,sudo\t0\t\t",
    "USER\tci\t1002\t/home/ci\t/usr/sbin/nologin\tci\t1\t\t",
  ].join("\n");

  test("parseUsers: sudo from group or landfall's rule, password state, keys, who landfall is", () => {
    const u = parseUsers(out, "deploy");
    expect(u).toMatchObject({ admin: "root", sudo: true, passwordLogin: false });
    const [root, deploy, anna, ci] = u.accounts;
    expect(root).toMatchObject({ uid: 0, sudo: true, password: "locked", keys: 1, me: false });
    expect(deploy).toMatchObject({ sudo: true, nopasswd: true, password: "none", keys: 2, me: true, groups: ["deploy", "docker"] });
    expect(anna).toMatchObject({ sudo: true, nopasswd: false, password: "set", keys: 0 });
    expect(ci).toMatchObject({ sudo: false, login: false });
    // Without sudo installed, group sudo gives nothing.
    expect(parseUsers(out.replace("sudo=1", "sudo="), "deploy").accounts[2].sudo).toBe(false);
    expect(parseUsers(out.replace("sshd_passwords=no\n", "")).passwordLogin).toBeUndefined();
  });

  test("never root, landfall's login or the managing login", () => {
    const u = parseUsers(out, "deploy");
    const take = (name: string) => () => checkTakeable(account(u, name), "x");
    expect(take("root")).toThrow(/not root/);
    expect(take("deploy")).toThrow(/landfall logs in as deploy/);
    expect(take("anna")).not.toThrow();
    expect(() => account(u, "bob")).toThrow(/no user bob/);
  });

  test("user names, passwords and the scripts' shell", () => {
    for (const ok of ["anna", "_ci", "deploy-2", "a".repeat(32)]) expect(USER_NAME.test(ok)).toBe(true);
    for (const bad of ["Anna", "1st", "a.b", "a b", "", "a".repeat(33), "-x", "a;rm"]) expect(USER_NAME.test(bad)).toBe(false);
    expect(() => checkPassword("short")).toThrow(/at least/);
    expect(() => checkPassword("long enough\nx")).toThrow(/line breaks/);
    expect(newPassword()).toMatch(/^[\w-]{20}$/);
    expect(spawnSync("bash", ["-n", "-c", PRELUDE + USERS]).status).toBe(0);
  });
});

describe("system", () => {
  const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINh+y8rAZynEZZ03LAQjLtr3Sz/M8prCpgPxEwF0w5L6 test@example";
  const FP = "SHA256:pmKhY0kEQAIs7Svq6OkGNRmuGnS1+qMxYra0TnoCQ+g";

  test("key lines: fingerprint as ssh-keygen -l, options with quoted spaces", () => {
    expect(parseKeyLine(KEY)).toMatchObject({ type: "ssh-ed25519", fingerprint: FP, comment: "test@example", options: "" });
    const k = parseKeyLine(`from="10.0.0.1",command="echo hi there" ${KEY}`)!;
    expect(k).toMatchObject({ fingerprint: FP, options: 'from="10.0.0.1",command="echo hi there"', comment: "test@example" });
    expect(parseKeyLine("not a key")).toBeUndefined();
    expect(parseKeyLine("ssh-ed25519")).toBeUndefined();
  });

  test("parseSystem", () => {
    const out = [
      "root=1", "user=deploy", "hostname=box", "timezone=Europe/Berlin", "ntp=yes", "time=2026-01-01T00:00:00Z", "init=systemd",
      "SWAP\t/swapfile\tfile\t2147483648\t1048576", "swappiness=60", "disk_free=10000000000", "mem=1000000000",
      "log_driver=json-file", 'DAEMON\t{ "log-opts": { "max-size": "10m", "max-file": "3" }, "bip": "10.1.0.1/24" }',
      "SVC\tdocker.service\tloaded\tactive\trunning\tDocker Application Container Engine",
      "SVC\tnginx.service\tloaded\tfailed\tfailed\tA high performance web server",
      "UF\tdocker.service\tenabled",
      "kv junk", "fail2ban=running", "JAIL\tsshd\t2\t40\t1\t1.2.3.4 5.6.7.8",
      `KEY\tdeploy\t${KEY}`, "KEY\troot\tgarbage",
    ].join("\n");
    const i = parseSystem(out, new Set([FP]));
    expect(i).toMatchObject({ root: true, hostname: "box", timezone: "Europe/Berlin", ntp: true, init: "systemd", fail2ban: "running", mem: 1e9 });
    expect(i.swap).toEqual([{ file: "/swapfile", type: "file", size: 2147483648, used: 1048576 }]);
    expect(i.docker).toMatchObject({ driver: "json-file", maxSize: "10m", maxFile: 3 });
    expect(i.services[0]).toMatchObject({ unit: "docker.service", active: "active", enabled: "enabled", description: "Docker Application Container Engine" });
    expect(i.services[1].active).toBe("failed");
    expect(i.jails).toEqual([{ name: "sshd", banned: 2, total: 40, failed: 1, ips: ["1.2.3.4", "5.6.7.8"] }]);
    expect(i.keys).toHaveLength(1);
    expect(i.keys[0]).toMatchObject({ user: "deploy", mine: true });
    const bare = parseSystem("root=0\nuser=me\nlog_driver=json-file\nDAEMON\t{oops");
    expect(bare).toMatchObject({ root: false, timezone: "UTC", ntp: undefined, fail2ban: "missing" });
    expect(bare.docker?.daemonError).toMatch(/not valid JSON/);
    expect(parseSystem("root=1").docker).toBeUndefined();
  });

  test("log limit keeps the rest of daemon.json", () => {
    const d = { bip: "10.1.0.1/24", "log-opts": { "max-size": "50m", labels: "x" } };
    expect(withLogLimit(d, "10m", 3)).toEqual({ bip: "10.1.0.1/24", "log-opts": { "max-size": "10m", "max-file": "3", labels: "x" } });
    expect(withLogLimit({ "log-opts": { "max-size": "10m", "max-file": "3" } }, undefined, 3)).toEqual({});
    expect(LOG_SIZE.test("10m") && !LOG_SIZE.test("10mb") && !LOG_SIZE.test("10")).toBe(true);
  });

  test("validation", () => {
    expect(parseSwapSize("2G")).toBe(2 * 1024 ** 3);
    expect(parseSwapSize("512M")).toBe(512 * 1024 ** 2);
    expect(parseSwapSize("1.5g")).toBe(1536 * 1024 ** 2);
    expect(() => parseSwapSize("lots")).toThrow();
    expect(HOSTNAME.test("web-1") && !HOSTNAME.test("-web") && !HOSTNAME.test("a.b") && !HOSTNAME.test("x".repeat(64))).toBe(true);
    expect(TIMEZONE.test("Europe/Berlin") && TIMEZONE.test("Etc/GMT+1") && !TIMEZONE.test("../etc/passwd") && !TIMEZONE.test("a b")).toBe(true);
    expect(UNIT.test("docker.service") && UNIT.test("getty@tty1") && !UNIT.test("x; rm -rf /")).toBe(true);
  });
});

test("statusKind: unhealthy, starting and restarting containers are warnings", () => {
  expect(statusKind("Up 3 hours")).toBe("up");
  expect(statusKind("Up 3 hours (healthy)")).toBe("up");
  expect(statusKind("Up 3 hours (unhealthy)")).toBe("warn");
  expect(statusKind("Up 5 seconds (health: starting)")).toBe("warn");
  expect(statusKind("Restarting (1) 5 seconds ago")).toBe("warn");
  expect(statusKind("Exited (0) 2 minutes ago")).toBe("done");
  expect(statusKind("Exited (1) 2 minutes ago")).toBe("down");
  expect(statusKind("not running")).toBe("down");
});
