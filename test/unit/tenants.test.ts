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

const anna = { host: "vps", user: "anna", tenant: { uid: 1001, root: "/opt/landfall/tenants/anna", port: 8443, domains: [] } };

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

describe("the allowlist", () => {
  test("names only commands that exist", async () => {
    const { commands } = await import("../../src/cli/registry");
    const { TENANT_COMMANDS } = await import("../../src/core/server/tenant-policy");
    const names = new Set(commands.map((c) => c.name));
    expect([...TENANT_COMMANDS].filter((n) => !names.has(n))).toEqual([]);
  });

  test("refuses the rest on a tenant server only", async () => {
    const { tenantRefusal } = await import("../../src/core/server/tenant-policy");
    expect(tenantRefusal("vps", anna, "firewall enable")).toBe("lf firewall enable is for the admin of vps; anna is a tenant there");
    expect(tenantRefusal("vps", anna, "deploy")).toBeUndefined();
    expect(tenantRefusal("vps", { host: "vps" }, "firewall enable")).toBeUndefined();
    expect(tenantRefusal("vps", anna, undefined)).toBeUndefined();
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
  portDriver: "builtin",
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
  ufw: ["allow 80/tcp"],
};
const scripts = {
  add: T.addScript({ user: "anna", key: "ssh-ed25519 AAAA a", domains: ["anna.dev"], port: 20000, limits: { memory: "2G" }, firewall: "ufw" }),
  domains: T.domainsScript(anna2, was, ["anna.dev", "*.anna.dev"]),
  limits: T.limitsScript(anna2, was, { cpu: "150%", memory: "none" }),
  stop: T.stopScript("anna", true),
  start: T.stopScript("anna", false),
  rm: T.deactivateScript("anna", was),
  restore: T.restoreScript("anna", was),
  purge: T.purgeScript("anna", was),
  off: T.offScript(st, "{}", {}),
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
      const allowed = name === "purge" || name === "off" ? 1 : name === "add" ? 1 : 0;
      expect(bare.length, name).toBeLessThanOrEqual(allowed);
    }
  });

  test("the first tenant records the server's state before it changes anything", () => {
    const s = scripts.add.script;
    const lock = s.indexOf("flock -w 60 9");
    const state = s.indexOf("write_state\n  record");
    expect(state).toBeGreaterThan(lock);
    for (const change of ["pkg_install $missing", "apparmor_parser -r", "chmod 0751", 'ufw allow "$r"', "dc up -d", "useradd -m"]) {
      const at = s.indexOf(change, lock);
      expect(at, change).toBeGreaterThan(state);
    }
  });

  test("a first tenant add that stopped halfway is not taken for done", () => {
    const s = scripts.add.script;
    const done = s.indexOf("ST_DONE=true");
    expect(done).toBeGreaterThan(s.indexOf("dc up -d --force-recreate"));
    expect(s).toContain('"complete": %s');
    expect(s).toMatch(
      /elif ! grep -q '"complete": true' \/opt\/landfall\/tenants\/state\.json; then\n\s+log "the first lf tenant add stopped halfway; lf tenant off rolls back/,
    );
  });

  test("changes refuse what someone else changed meanwhile", () => {
    for (const n of ["domains", "limits", "rm", "restore", "purge"] as const)
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

  test("limits: none removes one, unset ones are reset", () => {
    expect(scripts.limits.env.LIMITS).toBe("MemoryMax=infinity CPUQuota=150% TasksMax=infinity");
    expect(scripts.limits.env.BEFORE).toBe("MemoryMax=2G CPUQuota= TasksMax=infinity");
    expect(JSON.parse(scripts.limits.env.JSON).limits).toEqual({ cpu: "150%" });
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

test("the first tenant's rewrite gives the compose file landfall writes for the host network", async () => {
  const { traefikCompose } = await import("../../src/core/ssh/templates");
  const s = scripts.add.script;
  const prog = s.slice(s.indexOf("awk '\n      /^    ports:$/") + 5, s.indexOf("' /opt/landfall/traefik/docker-compose.yml >"));
  const opts = { image: "traefik:v3.5", staging: false, http3: true, accessLog: true };
  const r = spawnSync("awk", [prog], { input: traefikCompose({ ...opts, hostNetwork: false }), encoding: "utf8" });
  expect(r.stderr).toBe("");
  const norm = (x: string) =>
    x
      .split("\n")
      .filter((l) => l.trim())
      .sort();
  expect(norm(r.stdout)).toEqual(norm(traefikCompose({ ...opts, hostNetwork: true })));
});
