import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, test, vi } from "vitest";

process.env.LANDFALL_RUN = "run1";
const calls: { cmd: string; args: string[]; input: string }[] = [];
let reply = "ok\n";
vi.mock("node:child_process", async (orig) => {
  const real = await orig<typeof import("node:child_process")>();
  const spawn = (cmd: string, args: string[] = []) => {
    const call = { cmd, args, input: "" };
    calls.push(call);
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => {} });
    let piped = false;
    child.stdin.on("pipe", () => (piped = true));
    child.stdin.on("data", (d) => (call.input += d));
    child.stdin.on("finish", () => setImmediate(() => (child.stdout.end(cmd === "ssh" ? reply : ""), child.stderr.end(), child.emit("close", 0))));
    setImmediate(() => piped || child.stdin.writableEnded || child.stdin.end());
    return child;
  };
  return { ...real, spawn };
});

const ssh = await import("../../src/core/ssh/ssh");

/** Strips what differs between machines: the local user, the version, the mux socket dir, the temp dir. */
const stable = (x: string, dir: string) =>
  x
    .replaceAll(dir, "<local>")
    .replace(/LANDFALL_ACTOR='[^']*'/g, "LANDFALL_ACTOR=…")
    .replace(/LANDFALL_CLI='[^']*'/g, "LANDFALL_CLI=…")
    .replace(/LANDFALL_MIGRATION='[^']*'/g, "LANDFALL_MIGRATION=…")
    .replace(/LANDFALL_UPDATE='[^']*'/g, "LANDFALL_UPDATE=…")
    .replace(/ControlPath=[^ '"]*%C/g, "ControlPath=…");

async function boundary(s: Parameters<typeof ssh.runScript>[0]) {
  calls.length = 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-tenant-"));
  fs.writeFileSync(path.join(dir, "a.txt"), "a");
  await ssh.runScript(s, `ls /opt/landfall/sites && cat /opt/landfall/journal.log`);
  if (!s.tenant) await ssh.runScript(s, `echo root`, { sudo: true });
  await ssh.sshExec(s, ["ls", "/opt/landfall/sites/blog"]);
  await ssh.sshPipe(s, "cat /opt/landfall/sites/blog/x", { file: path.join(dir, "out") }, "down");
  await ssh.upload(s, dir, "/opt/landfall/sites/blog/releases/2", [{ path: "a.txt" } as never]);
  await ssh.upload(s, dir, "/opt/landfall/sites/blog/releases/3", [{ path: "a.txt" } as never], "/opt/landfall/sites/blog/releases/2");
  return {
    calls: calls.filter((c) => c.args[0] !== "--version").map((c) => stable(`${c.cmd} ${c.args.join(" ")}\n${c.input}`, dir)),
    remotePath: ssh.REMOTE_PATH,
    write: ssh.writeFileCmd("/opt/landfall/sites/blog/.env", "A=1\n"),
  };
}

describe("without a tenant nothing changes", () => {
  test("every way to the server sends what it sent before tenants", async () => {
    expect(await boundary({ host: "example.com", user: "deploy" })).toMatchSnapshot();
  });
});

const anna = { host: "vps", user: "anna", tenant: { uid: 1001, root: "/opt/landfall/tenants/anna", port: 8443 } };

describe("a tenant server", () => {
  test("every way to the server sends only paths under the tenant root", async () => {
    const { calls } = await boundary(anna);
    const sent = calls.join("\n");
    expect(sent).toContain("/opt/landfall/tenants/anna/sites/blog/releases/3");
    expect(sent.match(/\/opt\/landfall(?!\/tenants\/anna)/g)).toBeNull();
  });

  test("docker is the tenant's rootless daemon, everywhere", async () => {
    const { calls } = await boundary(anna);
    for (const c of calls.filter((c) => c.startsWith("ssh ") && !c.includes("tar -czf"))) expect(c).toContain("DOCKER_HOST=unix:///run/user/1001/docker.sock");
  });

  test("root work fails instead of asking for sudo", async () => {
    await expect(ssh.runScript(anna, "echo root", { sudo: true })).rejects.toThrow(/ask its admin/);
    const { adminLogin } = await import("../../src/core/ssh/privilege");
    await expect(adminLogin(anna, "ufw")).rejects.toThrow(/tenant login/);
  });

  test("paths in written files move to the tenant root", async () => {
    const { remotePath } = await import("../../src/core/ssh/paths");
    const cmd = remotePath(anna, ssh.writeFileCmd("/opt/landfall/sites/blog/backup.sh", "cd /opt/landfall/sites/blog\n"));
    const b64 = cmd.match(/printf %s '([^']*)'/)![1];
    expect(Buffer.from(b64, "base64").toString()).toBe("cd /opt/landfall/tenants/anna/sites/blog\n");
    expect(cmd).toContain("_put '/opt/landfall/tenants/anna/sites/blog/backup.sh'");
    expect(remotePath(anna, "/opt/landfall/tenants/anna/x /opt/landfall-old")).toBe("/opt/landfall/tenants/anna/x /opt/landfall-old");
  });

  test("the PRELUDE refuses $SUDO and can_root is false", async () => {
    const { PRELUDE } = await import("../../src/core/ssh/templates");
    const { spawnSync } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const run = (env: Record<string, string>, line: string) =>
      spawnSync("bash", ["-c", `set -euo pipefail\n${PRELUDE}\n${line}`], { env: { ...process.env, ...env }, encoding: "utf8" });
    expect(run({ LANDFALL_TENANT: "vps" }, "can_root && echo yes || echo no").stdout.trim()).toBe("no");
    const r = run({ LANDFALL_TENANT: "vps" }, "$SUDO true; echo after");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("ask the admin of vps");
    expect(r.stdout).not.toContain("after");
  });
});

test("only ssh.ts and tunnel.ts start ssh or rsync", () => {
  const dir = path.join(import.meta.dirname, "../../src");
  const hits = fs
    .readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => /\.tsx?$/.test(f))
    .filter((f) => /spawn(Sync|P)?\(\s*"(ssh|rsync)"/.test(fs.readFileSync(path.join(dir, f), "utf8")));
  expect(hits.sort()).toEqual(["core/ssh/ssh.ts", "core/ssh/tunnel.ts"]);
});

// A change here is a change of what tenants may do: review it like one.
const TENANT_COMMANDS = [
  "adopt",
  "auth",
  "autodeploy",
  "certs",
  "check",
  "config",
  "deploy",
  "disk",
  "domains",
  "eject",
  "env",
  "git key",
  "git track",
  "history",
  "init",
  "keygen",
  "logs",
  "open",
  "plugin add",
  "plugin new",
  "plugin rm",
  "plugins",
  "promote",
  "prune",
  "redirect add",
  "redirect rm",
  "redirects",
  "refs",
  "registries",
  "registry login",
  "registry logout",
  "release rm",
  "restart",
  "rollback",
  "scale",
  "secret",
  "server add",
  "server config",
  "server domain",
  "server info",
  "server list",
  "server rm",
  "server use",
  "sites info",
  "sites list",
  "sites rm",
  "ssh",
  "start",
  "stats",
  "stop",
  "traefik access-log",
  "traefik dashboard",
  "traefik logs",
  "traefik restart",
  "traefik setup",
  "traefik status",
  "traefik strict-tls",
  "traffic",
  "tunnel",
  "tunnels",
  "ui",
  "undo",
  "volume add",
  "volume backup",
  "volume backup rm",
  "volume pull",
  "volume push",
  "volume restore",
  "volume rm",
  "volumes",
  "weight",
];

describe("tenant commands", () => {
  test("only these say tenant: true", async () => {
    const { commands } = await import("../../src/cli/registry");
    expect(
      commands
        .filter((c) => c.tenant)
        .map((c) => c.name)
        .sort(),
    ).toEqual(TENANT_COMMANDS);
  });

  test("a tenant login is refused the rest", async () => {
    const { tenantRefusal } = await import("../../src/core/server/tenant-policy");
    expect(tenantRefusal("vps", anna, "firewall enable")).toBe("lf firewall enable is for the admin of vps; anna is a tenant there");
    expect(tenantRefusal("vps", { host: "vps" }, "firewall enable")).toBeUndefined();
    expect(tenantRefusal("vps", anna, undefined)).toBeUndefined();
  });
});

describe("what the admin gives a tenant", () => {
  test("a public port is above 1024 and not one of the tenants' Traefik", async () => {
    const { publicPortError } = await import("../../src/core/server/tenant-policy");
    expect(publicPortError("25565/tcp")).toBeUndefined();
    expect(publicPortError("53/udp")).toContain("1024 to 65535");
    expect(publicPortError("20005/tcp")).toContain("local ports");
    expect(publicPortError("8080")).toContain("not a port like");
  });

  test("the invite logs in, starts Traefik, points DNS and deploys", async () => {
    const { tenantInvite } = await import("../../src/core/server/tenant-policy");
    const t = tenantInvite({
      user: "anna",
      host: "203.0.113.7",
      port: 2222,
      domains: ["anna.dev", "*.anna.dev"],
      rights: { cron: false, ports: ["25565/tcp"] },
    });
    expect(t).toContain("lf server add anna --host 203.0.113.7 --port 2222 --user anna -i ~/.ssh/id_ed25519");
    expect(t).toMatch(/Host anna\n\s+HostName 203\.0\.113\.7\n\s+Port 2222\n\s+User anna/);
    expect(t).toContain("lf traefik setup -s anna");
    expect(t).toMatch(/\*\.anna\.dev\s+A\s+203\.0\.113\.7/);
    expect(t).toContain("lf deploy -s anna -d www.anna.dev");
    expect(t).toContain("0.0.0.0:PORT:PORT");
    expect(t).toContain("Cron is off");
    const plain = tenantInvite({ user: "bob", host: "vps.example.com", port: 22, domains: ["bob.dev"] });
    expect(plain).not.toContain("--port");
    expect(plain).toContain("the same address as vps.example.com");
    expect(plain).not.toContain("Cron");
  });

  test("a scheduled job says when the admin turned cron off", async () => {
    const { cronChange } = await import("../../src/core/server/cron");
    expect(cronChange("#lf", "* * * * * true", "run it").check.join("\n")).toContain("/etc/cron.deny");
    expect(cronChange("#lf", "", "run it").check.join("\n")).not.toContain("/etc/cron.deny");
  });
});

const { detectTenant } = await import("../../src/core/server/tenant");

describe("server add finds the tenant", () => {
  const as = async (out: string) => {
    reply = out;
    try {
      return await detectTenant({ host: "vps", user: "anna" });
    } finally {
      reply = "ok\n";
    }
  };

  test("from tenants/<user>.json", async () => {
    expect(await as('anna\n{"user":"anna","uid":1001,"port":8443,"domains":["a.dev",3]}\n')).toEqual({
      uid: 1001,
      root: "/opt/landfall/tenants/anna",
      port: 8443,
      domains: ["a.dev"],
    });
    expect(calls.at(-1)!.input).toContain('f=/opt/landfall/tenants/"$u".json');
  });

  test("its domains come from the server, not the local config", async () => {
    const { mineLine, mineOf, tenantLogin } = await import("../../src/core/server/tenant");
    expect(mineLine({ host: "vps" })).toBe("");
    expect(mineLine(anna)).toContain('/opt/landfall/tenants/"$(id -un)".json');
    expect(mineOf('x\nMINE\t{"domains":["a.dev",3]}\n')).toEqual(["a.dev"]);
    expect(mineOf("MINE\t\n")).toBeUndefined();
    expect(tenantLogin({ uid: 1, root: "/r", port: 2, domains: ["a.dev"] } as never)).toEqual({ uid: 1, root: "/r", port: 2 });
  });

  test("not without a readable, valid file", async () => {
    expect(await as("")).toBeUndefined();
    expect(await as("anna\nnot json\n")).toBeUndefined();
    expect(await as('anna\n{"uid":"x","port":8443}\n')).toBeUndefined();
  });
});

const T = await import("../../src/core/server/tenants");
const { PRELUDE } = await import("../../src/core/ssh/templates");
const { spawnSync } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
const bashOk = (script: string) => spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });

const anna2: import("../../src/core/server/tenants").TenantFile = {
  user: "anna",
  uid: 1001,
  port: 20000,
  domains: ["anna.dev"],
  active: true,
  limits: { memory: "2G" },
};
const was = T.tenantJson(anna2);
const st: import("../../src/core/server/tenants").TenantsState = {
  enabled: "x",
  rootMode: "755",
  modes: { sites: "755" },
  traefikHostNetwork: false,
  delegateDropIn: true,
  apparmorProfile: true,
  packages: ["uidmap"],
  ufw: ["80/tcp"],
};
const scripts = {
  add: T.addScript({
    user: "anna",
    key: "ssh-ed25519 AAAA a",
    domains: ["anna.dev"],
    port: 20000,
    limits: { memory: "2G" },
    firewall: "ufw",
    traefik: { bridge: "bridge\n", host: "host\n" },
  }),
  domains: T.domainsScript(anna2, was, ["anna.dev", "*.anna.dev"]),
  limits: T.limitsScript(anna2, was, { cpu: "150%", memory: "none" }),
  stop: T.stopScript("anna"),
  start: T.startScript("anna"),
  rm: T.deactivateScript("anna", was),
  restore: T.restoreScript("anna", was),
  purge: T.purgeScript("anna", was),
  rights: T.rightsScript(anna2, was, { cron: false, ports: ["25565/tcp"] }),
  off: T.offScript(st, "{}", {}),
  purgeAll: T.purgeAllScript(["uidmap"]),
};

describe("tenant scripts", () => {
  test.each(Object.entries(scripts))("%s parses and holds the lock before any change", (_, { script, env }) => {
    const r = bashOk(script);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const lock = script.indexOf("flock -w 60 9");
    expect(lock).toBeGreaterThan(0);
    expect(script.startsWith(PRELUDE)).toBe(true);
    expect(script.slice(PRELUDE.length, lock)).not.toContain('record "');
    expect(script.slice(lock)).toContain('record "');
    const undos = Object.values(env).filter((v) => v.includes("t_o"));
    expect(undos.map((v) => bashOk(v).status)).toEqual(undos.map(() => 0));
  });

  test("every record but purge's says how to undo it", () => {
    for (const [name, { script }] of Object.entries(scripts)) {
      const body = script.slice(script.indexOf("flock -w 60 9"));
      const bare = body.split("\n").filter((l) => /^\s*record "[^"]*"\s*$/.test(l));
      const allowed = name === "purgeAll" ? Infinity : name === "purge" || name === "off" || name === "add" ? 1 : 0;
      expect(bare.length, name).toBeLessThanOrEqual(allowed);
    }
  });

  test("the first tenant records the server's state before it changes anything", () => {
    const s = scripts.add.script;
    const lock = s.indexOf("flock -w 60 9");
    const state = s.indexOf("write_state\n  record");
    expect(state).toBeGreaterThan(lock);
    for (const change of ["pkg_install $missing", "apparmor_parser -r", "chmod 0751", 'ufw_add allow "$r"', "traefik_up", "useradd -m"]) {
      const at = s.indexOf(change, lock);
      expect(at, change).toBeGreaterThan(state);
    }
  });

  test("fail2ban's web jails follow the central Traefik to and from the host network", () => {
    for (const s of [scripts.add.script, scripts.off.script]) {
      const body = s.slice(PRELUDE.length);
      // traefik_up recreates Traefik, then f2b_web_refresh points the jails at its new log.
      expect(body).toMatch(/^\s*traefik_up --force-recreate$/m);
      expect(body).toMatch(/undo="[^\n]*; traefik_up --force-recreate"/);
    }
  });

  test("a first tenant add that stopped halfway is not taken for done", () => {
    const s = scripts.add.script;
    const done = s.indexOf("ST_DONE=true");
    expect(done).toBeGreaterThan(s.indexOf("traefik_up --force-recreate"));
    expect(s).toContain('"complete": %s');
    expect(s).toMatch(
      /elif ! grep -q '"complete": true' \/opt\/landfall\/tenants\/state\.json; then\n\s+log "the first lf tenant add stopped halfway; lf tenant off rolls back/,
    );
  });

  test("changes refuse what someone else changed meanwhile", () => {
    for (const n of ["domains", "limits", "rights", "rm", "restore", "purge"] as const)
      expect(scripts[n].script).toContain("same ${TENANTS_DIR}".replace("${TENANTS_DIR}", "/opt/landfall/tenants"));
    expect(scripts.off.script).toContain("changed meanwhile");
  });

  test("a domain clashes with another tenant's and with the admin's sites", () => {
    const s = scripts.domains.script;
    const block = s.slice(s.indexOf("bt=$(printf"), s.indexOf("\ntrue\n", s.indexOf("bt=$(printf")));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-clash-"));
    fs.mkdirSync(path.join(dir, "sites/blog"), { recursive: true });
    fs.mkdirSync(path.join(dir, "tenants"));
    fs.writeFileSync(path.join(dir, "sites/blog/route.yml"), "rule: Host(`sub.x.dev`)\n");
    fs.writeFileSync(path.join(dir, "tenants/bob.json"), '{"domains": ["bob.dev"]}');
    const code = `log() { echo "$*"; }\n${block.replaceAll("/opt/landfall/", `${dir}/`)}\ntrue`;
    const clash = (d: string) => spawnSync("bash", ["-c", code], { env: { ...process.env, U: "anna", DOMAINS: d }, encoding: "utf8" });
    expect(clash("*.x.dev").stdout).toContain("reaches a domain of a site of the admin");
    expect(clash("sub.x.dev").status).toBe(1);
    expect(clash("bob.dev").stdout).toContain("belongs to tenant bob");
    for (const d of ["x.dev", "*.y.dev", "subxdev"]) expect(clash(d).status, d).toBe(0);
  });

  test("off takes back exactly what the state says", () => {
    const { env } = scripts.off;
    expect(env).toMatchObject({
      UFW: "80/tcp",
      HOST_NET: "false",
      MODES: "755 sites",
      ROOT_MODE: "755",
      AA: "true",
      DD: "true",
      PKGS: "uidmap",
      RM_PACKAGES: "0",
    });
  });

  test("off --purge deletes every tenant and the tenants folder, and journals none of it as undoable", () => {
    const { script, env } = scripts.purgeAll;
    expect(env).toMatchObject({ RM_PACKAGES: "1", PKGS: "uidmap" });
    const body = script.slice(script.indexOf("flock -w 60 9"));
    expect(body).toContain('t_purge "$u"');
    expect(body).toContain("rm -rf /opt/landfall/tenants/* /opt/landfall/tenants/.[!.]*");
    expect(body).not.toMatch(/^\s*record "[^"]*" "/m);
  });

  test("the view reads what a plain off left", () => {
    const v = T.parseTenants(`\x1eanna 0\n${was}\n\x1estate.off 0\n{"enabled":"x","packages":["uidmap"],"ufw":[],"modes":{}}\n`);
    expect(v.on).toBe(false);
    expect(v.left).toBe(true);
    expect(v.offState?.packages).toEqual(["uidmap"]);
    expect(v.tenants.map((t) => t.user)).toEqual(["anna"]);
  });

  test("limits: none removes one, unset ones are reset", () => {
    expect(scripts.limits.env.LIMITS).toBe("MemoryMax=infinity CPUQuota=150% TasksMax=infinity");
    expect(scripts.limits.env.BEFORE).toBe("MemoryMax=2G CPUQuota= TasksMax=infinity");
    expect(JSON.parse(scripts.limits.env.JSON).limits).toEqual({ cpu: "150%" });
  });

  test("rights: only the difference runs, the file keeps what is not the default", () => {
    const { env } = scripts.rights;
    expect(env).toMatchObject({ CRON: "off", OPEN: "25565/tcp", CLOSE: "", SUMMARY: "no cron, 25565/tcp" });
    expect(JSON.parse(env.JSON).rights).toEqual({ cron: false, ports: ["25565/tcp"] });
    const back = T.rightsScript({ ...anna2, rights: { cron: false, ports: ["25565/tcp"] } }, was, { cron: true }).env;
    expect(back).toMatchObject({ CRON: "on", OPEN: "", CLOSE: "25565/tcp", SUMMARY: "default" });
    expect(JSON.parse(back.JSON).rights).toBeUndefined();
    expect(scripts.rights.script).toContain('ufw_add allow "$p"');
    expect(scripts.purge.script).toContain('drop_line /etc/cron.deny "$1"');
  });

  test("cron off is undone by cron on, and the crontab is kept aside", () => {
    const fn = scripts.rights.env.FN_SH;
    expect(fn).toContain("cron_off()");
    expect(fn).toContain('crontab -u "$1" "/opt/landfall/tenants/$1.crontab.denied"');
    expect(scripts.rights.script).toMatch(/cron_off "\$U"; record "tenant \$U: no cron jobs" "\$FN_SH\ncron_on/);
  });

  test("the add template keeps placeholders the shell fills in", () => {
    const j = scripts.add.env.JSON;
    expect(j).toContain('"uid": @UID@,');
    expect(j).toContain('"trustedIP": "@TRUSTED@"');
    expect(j).toContain('"active": true');
  });
});

describe("tenant routes and names", () => {
  test("TLS passes through with a PROXY header, wildcards as a regexp", () => {
    const y = T.routeYaml("anna", 20001, ["anna.dev", "*.anna.dev"]);
    expect(y).toContain('rule: "HostSNI(`anna.dev`) || HostSNIRegexp(`^[a-z0-9-]+\\\\.anna\\\\.dev$`)"');
    expect(y).toContain("passthrough: true");
    expect(y).toContain("serversTransport: tenant-anna-pp");
    expect(y).toContain('address: "127.0.0.1:20001"');
    expect(y).toMatch(/tenant-anna-pp:\n\s+proxyProtocol:\n\s+version: 2/);
  });

  test("ports: the first free one", () => {
    expect(T.nextPort([])).toBe(20000);
    expect(T.nextPort([20000, 20001, 20003])).toBe(20002);
  });

  test("domains: checked, and overlaps found", () => {
    expect(T.checkDomain(" Anna.DEV ")).toBe("anna.dev");
    expect(() => T.checkDomain("anna.dev`) || Host(`x")).toThrow(/not a domain/);
    expect(() => T.checkDomain("localhost")).toThrow(/not a domain/);
    expect(T.overlaps("*.anna.dev", "blog.anna.dev")).toBe(true);
    expect(T.overlaps("blog.anna.dev", "*.anna.dev")).toBe(true);
    expect(T.overlaps("*.anna.dev", "a.b.anna.dev")).toBe(false);
    expect(T.overlaps("*.anna.dev", "anna.dev")).toBe(false);
    expect(T.overlaps("anna.dev", "bob.dev")).toBe(false);
  });

  test("names", () => {
    expect(() => T.checkTenantName("anna")).not.toThrow();
    for (const n of ["root", "state", "Anna", "a b", "../x", ""]) expect(() => T.checkTenantName(n), n).toThrow();
  });

  test("the view: tenants, state, ufw", () => {
    const out = `\x1e ufw\nStatus: active\n\x1eanna 1\n${was}\n\x1estate 0\n{"enabled":"x","packages":[],"ufw":[],"modes":{}}\n\x1ebob 0\nbroken\n`;
    const v = T.parseTenants(out);
    expect(v.ufw).toBe(true);
    expect(v.on).toBe(true);
    expect(v.tenants.map((t) => [t.user, t.running, t.active])).toEqual([["anna", true, true]]);
    expect(v.raw.anna).toBe(was.trim());
  });

  test("the view: what each tenant uses", () => {
    const v = T.parseTenants(`\x1eanna 1 2 3 1048576 40\n${was}\n\x1ebob 0 0 - - -\n${was}\n`);
    expect(v.tenants.map(({ user, sites, containers, memory, disk }) => ({ user, sites, containers, memory, disk }))).toEqual([
      { user: "anna", sites: 2, containers: 3, memory: 1048576, disk: 40960 },
      { user: "bob", sites: 0, containers: undefined, memory: undefined, disk: undefined },
    ]);
  });
});

test("the first tenant checks the central compose file before any change, then writes it for the host network", async () => {
  const { centralCompose } = await import("../../src/core/traefik/traefik");
  const c = centralCompose({ host: "vps", dashboard: { host: "t.example.com", user: "admin", htpasswd: "admin:$2y$x" } });
  expect(c.bridge).toContain('"443:443"');
  expect(c.host).toContain("network_mode: host");
  expect(c.host).toContain("t.example.com");
  const s = scripts.add.script;
  const check = s.indexOf(`printf '%s' "$TRAEFIK_BRIDGE" | cmp -s -`);
  expect(check).toBeGreaterThan(-1);
  expect(check).toBeLessThan(s.indexOf("write_state\n"));
  expect(s).toContain(`printf '%s' "$TRAEFIK_HOST" > /opt/landfall/traefik/docker-compose.yml`);
  expect(scripts.add.env).toMatchObject({ TRAEFIK_BRIDGE: "bridge\n", TRAEFIK_HOST: "host\n" });
});

test("a tenant's open ports close when it is removed and open again when it is restored", () => {
  const s = scripts.add.script;
  const fn = s.split("\n").find((l) => l.startsWith("t_ports()"))!;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-ports-"));
  fs.writeFileSync(
    path.join(dir, "ben.json"),
    T.tenantJson({ user: "ben", uid: 1, port: 20000, domains: [], active: true, rights: { ports: ["5000", "9877/tcp"] } }),
  );
  const ports = (u: string) =>
    spawnSync("bash", ["-c", `set -euo pipefail\n${fn.replaceAll("/opt/landfall/tenants", dir)}\nt_ports ${u}`], { encoding: "utf8" }).stdout;
  expect(ports("ben").split("\n").filter(Boolean)).toEqual(["5000", "9877/tcp"]);
  expect(ports("nobody")).toBe("");
  fs.writeFileSync(
    path.join(dir, "cid.json"),
    T.tenantJson({ user: "cid", uid: 2, port: 20001, domains: ["1.example.com"], active: true, rights: { ports: [] } }),
  );
  expect(ports("cid")).toBe("");
  const off = s.slice(s.indexOf("t_off() {"), s.indexOf("\n}", s.indexOf("t_off() {")));
  const on = s.slice(s.indexOf("t_on() {"), s.indexOf("\n}", s.indexOf("t_on() {")));
  expect(off).toContain('ufw --force delete allow "$_p"');
  expect(on).toContain('ufw allow "$_p"');
});
