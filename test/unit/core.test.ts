import bcrypt from "bcryptjs";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { detectStaticDir, nextReleaseId, releaseId, slug } from "../../src/commands/deploy";
import { guardSsh, ruleArgs, type FirewallState } from "../../src/commands/firewall";
import { htpasswd, traefikSettings } from "../../src/commands/traefik";
import { journalCmd } from "../../src/cmd";
import { baseDomain, checkImage, checkInt, expandDomain, guessDomains, loadProject, saveProject, withPrimary } from "../../src/config";
import { findRun, parseJournal, pending } from "../../src/journal";
import { assess, foreignProxy, parseProbe, parseRule, reachability, ruleFor } from "../../src/inventory";
import { mergeEnv, parseEnvPairs } from "../../src/remote";
import { shq, writeFileCmd } from "../../src/ssh";
import { hasManagedBlock, removeHostBlock, renderHostBlock, sshAliases, upsertHostBlock } from "../../src/sshconfig";
import { changes } from "../../src/dashboard";
import { isPublic4, parseFacts, pickIp, sslipDomain, support } from "../../src/facts";
import { detectProject } from "../../src/projects";
import { cmpVersion, engineNotes, newerTag, parsePkgList, parseRef, withTag } from "../../src/updates";
import { safeParts } from "../../src/web/local";
import { DEFAULT_TRAEFIK_IMAGE, MIGRATED, nginxConf, parseProxy, proxyFile, siteCompose, traefikCompose, traefikLabels, type SiteMeta } from "../../src/templates";

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
  const meta: SiteMeta = {
    name: "blog",
    kind: "static",
    domains: ["a.com", "www.a.com"],
    port: 80,
    current: "20260101000000",
    releases: [{ id: "20260101000000", at: "" }],
    createdAt: "",
    updatedAt: "",
  };

  test("labels route all domains over TLS", () => {
    const l = traefikLabels("blog", meta.domains, 80);
    expect(l).toContain("traefik.http.routers.landfall-blog.rule=Host(`a.com`) || Host(`www.a.com`)");
    expect(l).toContain("traefik.http.routers.landfall-blog.tls.certresolver=le");
  });

  test("site labels follow the proxy", () => {
    const p = { container: "x", network: "proxy", entrypoint: "https", resolver: "acme" };
    expect(parseProxy(proxyFile(p))).toEqual(p);
    const y = siteCompose(meta, p);
    expect(y).toContain('"traefik.http.routers.landfall-blog.tls.certresolver=acme"');
    expect(y).toContain("  proxy:\n    external: true");
  });

  test("static compose mounts releases, nginx pins release", () => {
    expect(siteCompose(meta)).toContain("./releases:/site/releases:ro");
    expect(nginxConf(meta.current, false)).toContain("root /site/releases/20260101000000;");
    expect(nginxConf(meta.current, true)).toContain("/index.html;");
  });

  test("image compose uses release image and env file", () => {
    const y = siteCompose({ ...meta, kind: "image", port: 3000, releases: [{ id: meta.current, at: "", image: "ghcr.io/x/y:1" }] });
    expect(y).toContain('image: "ghcr.io/x/y:1"');
    expect(y).toContain("env_file:");
    expect(y).toContain("loadbalancer.server.port=3000");
  });

  test("traefik dashboard escapes $ for compose", async () => {
    const hash = await htpasswd("admin", "pw");
    expect(hash).toMatch(/^admin:\$2y\$/);
    expect(await bcrypt.compare("pw", hash.slice(6).replace("$2y$", "$2b$"))).toBe(true);
    const y = traefikCompose({ email: "e@x", image: "traefik:v3.6", staging: true, dashboard: { host: "t.x", htpasswd: hash } });
    expect(y).toContain("$$2y$$");
    expect(y).toContain("acme-staging");
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

  test("traefik settings: flags win over what the server remembers", () => {
    const server = { host: "x", traefikImage: "traefik:v3.4", hostNetwork: true, email: "a@x" };
    expect(traefikSettings(server, {})).toEqual({ email: "a@x", staging: false, image: "traefik:v3.4", hostNetwork: true });
    expect(traefikSettings(server, { image: "traefik:v3.6", hostNetwork: false })).toMatchObject({ image: "traefik:v3.6", hostNetwork: false });
    expect(traefikSettings({ host: "x" }, {}).image).toBe(DEFAULT_TRAEFIK_IMAGE);
  });
});

describe("ssh config", () => {
  test("upsert/replace/remove managed host block", () => {
    const f = join(tmp(), "config");
    fs.writeFileSync(f, "Host mine\n  HostName 1.2.3.4\n\nHost *\n  ServerAliveInterval 30\n");
    const b = { alias: "vps", hostname: "5.6.7.8", user: "deploy", port: 22, key: "/k" };
    upsertHostBlock(b, f);
    upsertHostBlock({ ...b, hostname: "9.9.9.9" }, f);
    const text = fs.readFileSync(f, "utf8");
    expect(text.match(/landfall:vps/g)?.length).toBe(2);
    expect(text.indexOf("Host vps")).toBeLessThan(text.indexOf("Host *"));
    expect(text).toContain("HostName 9.9.9.9");
    expect(sshAliases(f).sort()).toEqual(["vps", "mine"]);
    expect(removeHostBlock("vps", f)).toBe(true);
    expect(fs.readFileSync(f, "utf8")).toBe("Host mine\n  HostName 1.2.3.4\n\nHost *\n  ServerAliveInterval 30\n");
  });

  test("blocks written as srv: (landfall's old name) are still managed", () => {
    const f = join(tmp(), "config");
    const old = "# >>> srv:vps\nHost vps\n  HostName 1.1.1.1\n# <<< srv:vps\n\nHost hetzner\n  User x\n";
    fs.writeFileSync(f, old);
    expect(hasManagedBlock("vps", f)).toBe(true);
    expect(hasManagedBlock("hetzner", f)).toBe(false);
    upsertHostBlock({ alias: "vps", hostname: "2.2.2.2", user: "u", port: 22, key: "/k" }, f);
    const text = fs.readFileSync(f, "utf8");
    expect(text).not.toContain("srv:vps");
    expect(text).toContain("# >>> landfall:vps\nHost vps\n  HostName 2.2.2.2");
    expect(text).toContain("Host hetzner");
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
    'listen=udp 203.0.113.161%eth0:68 users:(("systemd-network",pid=3,fd=23))',
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
    expect(checks.find((c) => c.part === "traefik")).toMatchObject({ status: "conflict", detail: "port 80 is in use by nginx" });
  });

  test("own running traefik is done, foreign container conflicts", () => {
    const ours = `${fresh}\ntraefik_compose=landfall\ntraefik_container=running /opt/landfall/traefik\npublish_80=traefik \nlisten=0.0.0.0:80 5/docker-proxy`;
    expect(status(ours).traefik).toBe("done");
    expect(status(`${fresh}\ntraefik_container=running /home/me/proxy`).traefik).toBe("conflict");
    expect(status(`${fresh}\npublish_443=caddy `).traefik).toBe("conflict");
  });

  // vps: a traefik from its own compose project owns 80/443.
  const vps = [
    "publish_80=traefik-reverseproxy-1 ",
    "publish_443=traefik-reverseproxy-1 ",
    "foreign_proxy=/traefik-reverseproxy-1|traefik:v3.7.5|proxy,|--providers.docker.network=proxy --providers.docker=true " +
      "--entrypoints.web.address=:80 --entrypoints.websecure.address=:443 --entrypoints.websecure.http3 " +
      "--certificatesresolvers.letsencryptresolver.acme.httpchallenge.entrypoint=web",
  ];
  const traefik = (extra: string[]) => assess(parseProbe([fresh, ...extra].join("\n")), want).find((c) => c.part === "traefik")!;

  test("an existing traefik is used instead of a conflict", () => {
    const t = traefik(vps);
    expect(t.status).toBe("todo");
    expect(t.proxy).toEqual({ container: "traefik-reverseproxy-1", network: "proxy", entrypoint: "websecure", resolver: "letsencryptresolver" });
    const adopted = traefik([...vps, "proxy=container=traefik-reverseproxy-1 network=proxy entrypoint=websecure resolver=r "]);
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

  test("steps before the move from srv cannot be undone, later ones can", () => {
    const runs = parseJournal([text, line("d", "do", MIGRATED), line("e", "do", "ufw allow 8000", b64("ufw delete allow 8000"))].join("\n"));
    expect(runs.slice(0, 4).flatMap(pending)).toEqual([]);
    expect(pending(runs[4]).map((s) => s.undo)).toEqual(["ufw delete allow 8000"]);
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
    expect(isPublic4("49.12.1.1")).toBe(true);
    expect(pickIp(["192.168.1.2", "49.12.1.1"])).toBe("49.12.1.1");
    expect(pickIp(["192.168.1.2"])).toBe("192.168.1.2");
    expect(sslipDomain("blog", "49.12.1.1")).toBe("blog.49-12-1-1.sslip.io");
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
  test("upload paths stay inside", () => {
    expect(safeParts("../../etc//passwd")).toEqual(["etc", "passwd"]);
    expect(safeParts("site\\a/./b.html")).toEqual(["site", "a", "b.html"]);
  });
  test("basic auth labels", () => {
    const l = traefikLabels("blog", ["blog.test"], 80, undefined, ["bob:$apr1$x"]);
    expect(l).toContain("traefik.http.middlewares.landfall-blog-auth.basicauth.users=bob:$apr1$x");
    expect(l).toContain("traefik.http.routers.landfall-blog.middlewares=landfall-blog-auth");
    expect(traefikLabels("blog", ["blog.test"], 80).some((x) => x.includes("basicauth"))).toBe(false);
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
    const e = { docker: "29.9.2", compose: "2.40.3", composePath: "/usr/local/lib/docker/cli-plugins/docker-compose", dockerCe: false, latestDocker: "29.9.2", latestCompose: "5.6.1" };
    expect(engineNotes(e)).toMatchObject({ dockerNote: undefined, composeUpdate: true });
    expect(engineNotes({ ...e, composePath: "/usr/libexec/docker/cli-plugins/docker-compose", dockerCe: true })).toMatchObject({ composeUpdate: false, composeNote: "compose 2.40.3, 5.6.1 is current (comes with the package upgrades)" });
    expect(engineNotes({ ...e, docker: "26.1.5" }).dockerNote).toContain("29.9.2 is current");
    expect(engineNotes({ ...e, latestDocker: undefined, latestCompose: undefined })).toMatchObject({ dockerNote: undefined, composeNote: undefined, composeUpdate: false });
  });
});

test("srv.json (the old project file) is read, and replaced by .landfall.json on save", () => {
  const d = tmp();
  fs.writeFileSync(join(d, "srv.json"), JSON.stringify({ name: "blog", domains: ["a.com"] }));
  expect(loadProject(d)?.name).toBe("blog");
  saveProject(d, { name: "blog", domains: ["b.com"] });
  expect(fs.readdirSync(d)).toEqual([".landfall.json"]);
  expect(loadProject(d)?.domains).toEqual(["b.com"]);
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
