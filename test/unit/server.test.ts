import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ruleArgs, specArgs } from "../../src/cli/commands/firewall";
import { guardSsh, type FirewallState } from "../../src/core/firewall";
import { journalCmd } from "../../src/cli/cmd";
import { findRun, laterConflicts, parseJournal, pending } from "../../src/core/journal";
import { assess, foreignProxy, parseProbe, parseRule, reachability, ruleFor } from "../../src/core/inventory";
import { hasManagedBlock, removeHostBlock, renderHostBlock, sshAliases, upsertHostBlock } from "../../src/core/sshconfig";
import { capabilities, isPublic4, noUfw, parseFacts, pickIp, sslipDomain, support } from "../../src/core/facts";
import { journalSize, parseDisk, parseSize, parseStats } from "../../src/core/stats";
import { JOURNAL_KEEP, parsePrunePlan, reclaimable, removable } from "../../src/core/manage";
import { JOURNAL_KEEP_BYTES } from "../../src/core/reclaim";
import { HOSTNAME, LOG_SIZE, TIMEZONE, UNIT, parseKeyLine, parseSwapSize, parseSystem, withLogLimit } from "../../src/core/system";
import { account, checkPassword, checkTakeable, newPassword, parseUsers, USER_NAME, USERS } from "../../src/core/users";
import { cmpVersion, engineNotes, newerTag, parsePkgList, parseRef, withTag } from "../../src/core/updates";
import { PRELUDE } from "../../src/core/templates";
import { statusKind } from "../../src/core/compose";

const tmp = () => fs.mkdtempSync(join(tmpdir(), "landfall-test-"));

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

  test("a CRLF config gets its block replaced, not a second one", () => {
    const f = join(tmp(), "config");
    const b = { alias: "vps", hostname: "5.6.7.8", user: "deploy", port: 22, key: "/k" };
    upsertHostBlock(b, f);
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/\n/g, "\r\n"));
    expect(hasManagedBlock("vps", f)).toBe(true);
    upsertHostBlock({ ...b, hostname: "9.9.9.9" }, f);
    expect(fs.readFileSync(f, "utf8").match(/landfall:vps/g)?.length).toBe(2);
  });

  test("a symlinked config stays a link", () => {
    const d = tmp();
    const f = join(d, "config");
    fs.writeFileSync(join(d, "real"), "Host mine\n");
    fs.symlinkSync(join(d, "real"), f);
    upsertHostBlock({ alias: "vps", hostname: "5.6.7.8", user: "deploy", port: 22, key: "/k" }, f);
    expect(fs.lstatSync(f).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(join(d, "real"), "utf8")).toContain("Host vps");
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

  test("a listed rule goes back to ufw quoted, its comment as one argument", () => {
    expect(specArgs("allow 80/tcp")).toBe("'allow' '80/tcp'");
    expect(specArgs("allow 22 comment 'Bob's $(id) box'")).toBe(`'allow' '22' 'comment' 'Bob'\\''s $(id) box'`);
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
      'SITE\t{"name":"blog","domains":[],"releases":[]}',
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

describe("prune", () => {
  const id = (c: string) => `sha256:${c.repeat(64)}`;
  const site = { name: "blog", domains: [], releases: [{ id: "20260101-1", services: [{ name: "Web", build: true, networks: [] }, { name: "db", networks: [] }] }] };
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

  test("log sizes for --logs", () => {
    expect(parsePrunePlan(out).logs).toBeUndefined();
    const p = parsePrunePlan(`${out}\nROOT\t1\nLOG\tweb\t2048\nLOG\tdb\t\nLOG\tredis\t1024\nJOURNAL\t1.5G`);
    expect(p.logs).toEqual({ root: true, size: 3 * 1024 * 1024, journal: 1.5 * 1024 ** 3 });
    // Without root the sizes are not there.
    expect(parsePrunePlan(`${out}\nROOT\t\nJOURNAL\t`).logs).toEqual({ root: false, size: 0, journal: 0 });
  });

  test("reclaimable counts logs and the journal above what it keeps", () => {
    expect(JOURNAL_KEEP_BYTES).toBe(journalSize(JOURNAL_KEEP));
    const p = parsePrunePlan(out);
    const base = reclaimable(p);
    expect(reclaimable({ ...p, logs: { root: true, size: 5, journal: JOURNAL_KEEP_BYTES + 7 } })).toBe(base + 12);
    expect(reclaimable({ ...p, logs: { root: true, size: 5, journal: 1 } })).toBe(base + 5);
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
