import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";

// Plugins load from the config dir: point it at a temp one before anything reads it.
const tmp = fs.mkdtempSync(join(tmpdir(), "lf-plugins-"));
process.env.LANDFALL_CONFIG_DIR = join(tmp, "config");
process.env.LANDFALL_SSH_CONFIG = join(tmp, "ssh_config");
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { PRELUDE } = await import("../../src/core/templates");
const { shq } = await import("../../src/core/ssh");
const { actionArgv, pluginTab } = await import("../../src/core/plugin-api");
const core = await import("../../src/core/plugins");
const f2b = await import("../../src/plugins/fail2ban");
const trivy = await import("../../src/plugins/trivy");
const { BUILTIN } = await import("../../src/plugins");
const { scaffold } = await import("../../src/cli/commands/plugins");
const { pluginCommands, registerPlugins } = await import("../../src/cli/plugins");
const { aliases, byName } = await import("../../src/cli/registry");
type PluginContext = import("../../src/core/plugin-api").PluginContext;
type Plugin = import("../../src/core/plugin-api").Plugin;

/** bash -n: the script parses, with landfall's helpers in front as on the server. */
const parses = (script: string) => execFileSync("bash", ["-n"], { input: `${PRELUDE}\n${script}` });

/** A context that captures scripts instead of sending them. */
function fakeCtx(reply = "") {
  const calls: { body: string; o: any }[] = [];
  const ctx = {
    plugin: "test",
    name: "web1",
    server: { host: "example.com" },
    script: async (body: string, o: any = {}) => {
      calls.push({ body, o });
      return reply;
    },
    shq,
    data: { get: () => undefined, set: () => {} },
    log: { step: () => {}, ok: () => {}, info: () => {}, warn: () => {} },
    fail: (m: string): never => {
      throw new Error(m);
    },
    confirm: async () => true,
    table: () => {},
    json: () => {},
    color: new Proxy({}, { get: () => (s: string) => s }),
    paths: { root: "/opt/landfall", sites: "/opt/landfall/sites" },
    lf: async () => 0,
  } as unknown as PluginContext;
  return { ctx, calls };
}

const write = (rel: string, body: string) => {
  const f = join(core.PLUGIN_DIR, rel);
  fs.mkdirSync(join(f, ".."), { recursive: true });
  fs.writeFileSync(f, body);
  return f;
};
const plugin = (name: string, extra = "") =>
  `export default { name: ${JSON.stringify(name)}, summary: "s", commands: [{ name: "", summary: "x", run() {} }]${extra} };\n`;

beforeEach(() => fs.rmSync(core.PLUGIN_DIR, { recursive: true, force: true }));

describe("checkPlugin", () => {
  test("accepts a plugin and says what is wrong with others", () => {
    expect(core.checkPlugin({ name: "ok-1", summary: "s" })).toBe("");
    expect(core.checkPlugin(undefined)).toMatch(/exports no plugin/);
    expect(core.checkPlugin({ name: "Bad", summary: "s" })).toMatch(/lowercase/);
    expect(core.checkPlugin({ name: "a" })).toMatch(/summary/);
    expect(core.checkPlugin({ name: "a", summary: "s", commands: [{ name: "X", summary: "", run() {} }] })).toMatch(/not valid/);
    expect(core.checkPlugin({ name: "a", summary: "s", commands: [{ name: "x", summary: "" }] })).toMatch(/no run/);
    expect(core.checkPlugin({ name: "a", summary: "s", panel: { label: "A" } })).toMatch(/panel/);
  });
  test("the built-in plugins pass", () => {
    for (const p of BUILTIN) expect(core.checkPlugin(p), p.name).toBe("");
  });
});

describe("loadPlugins", () => {
  test("loads files and folders, skips broken plugins and duplicate names", async () => {
    write("one.mjs", plugin("one"));
    write("two/package.json", JSON.stringify({ main: "main.mjs" }));
    write("two/main.mjs", plugin("two"));
    write("three/index.mjs", plugin("three"));
    write("broken.mjs", "export default { name: 'broken' };\n");
    write("z-dupe.mjs", plugin("one")); // files load in name order: the first "one" wins
    write("notes.txt", "not a plugin");
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const loaded = await core.loadPlugins(BUILTIN);
      expect(loaded.map((l) => l.plugin.name)).toEqual(["fail2ban", "trivy", "one", "three", "two"]);
    } finally {
      err.mockRestore();
    }
    const view = core.pluginsView();
    expect(view.find((p) => p.name === "broken")?.error).toMatch(/summary/);
    expect(view.find((p) => p.name === "z-dupe")?.error).toMatch(/already loaded/);
    expect(view.find((p) => p.name === "one")).toMatchObject({ commands: ["one"], source: join(core.PLUGIN_DIR, "one.mjs") });
    expect(view.find((p) => p.name === "fail2ban")).toMatchObject({ source: "builtin", panel: { label: "fail2ban", group: "Machine", icon: "ban" } });
  });

  test("LANDFALL_NO_PLUGINS=1 keeps only the built-in ones", async () => {
    write("one.mjs", plugin("one"));
    process.env.LANDFALL_NO_PLUGINS = "1";
    try {
      expect((await core.loadPlugins(BUILTIN)).map((l) => l.plugin.name)).toEqual(["fail2ban", "trivy"]);
    } finally {
      delete process.env.LANDFALL_NO_PLUGINS;
    }
  });
});

describe("plugin commands", () => {
  const lf = async () => 0;
  test("a panel without a command of its own becomes lf <plugin>", () => {
    const p: Plugin = { name: "p", summary: "s", panel: { label: "P", load: async () => [] }, commands: [{ name: "go", summary: "g", async run() {} }] };
    const names = pluginCommands(p, lf).map((c) => c.name);
    expect(names).toEqual(["p go", "p"]);
    expect(pluginCommands({ ...p, commands: [{ name: "", summary: "", options: { yes: { type: "boolean", desc: "" } }, async run() {} }] }, lf)).toHaveLength(
      1,
    );
    // landfall's own options win over a plugin's.
    const [own] = pluginCommands(
      { ...p, commands: [{ name: "", summary: "", options: { yes: { type: "boolean", desc: "" }, json: { type: "boolean", desc: "" } }, async run() {} }] },
      lf,
    );
    expect(Object.keys(own.options ?? {})).toEqual(["server", "json"]);
    expect(
      Object.keys(pluginCommands({ ...p, panel: undefined, commands: [{ name: "x", summary: "", local: true, async run() {} }] }, lf)[0].options ?? {}),
    ).toEqual([]);
  });

  test("registerPlugins leaves out a plugin that takes a name or points an alias elsewhere", async () => {
    write("clash.mjs", plugin("deploy"));
    write("stray.mjs", plugin("stray", `, aliases: { strays: "nowhere" }`));
    write("fine.mjs", plugin("fine", `, aliases: { fines: "fine" }`));
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await core.loadPlugins(BUILTIN);
      registerPlugins(lf);
    } finally {
      err.mockRestore();
    }
    const names = core.plugins().map((l) => l.plugin.name);
    expect(names).toEqual(["fail2ban", "trivy", "fine"]);
    expect(byName.has("fine")).toBe(true);
    expect(aliases.fines).toBe("fine");
    expect(aliases.unban).toBe("fail2ban unban");
    expect(byName.get("deploy")?.summary).not.toBe("s");
    const view = core.pluginsView();
    expect(view.find((p) => p.name === "deploy")?.error).toMatch(/"lf deploy" is taken/);
    expect(view.find((p) => p.name === "stray")?.error).toMatch(/alias strays points to nowhere/);
  });
});

describe("actionArgv", () => {
  test("adds fields as flags or positionals, and checks only when ticked", () => {
    const a = {
      label: "Go",
      argv: ["fail2ban", "config", "sshd"],
      fields: [
        { name: "ip", label: "IP" },
        { name: "bantime", label: "Ban", flag: "--bantime" },
        { name: "maxretry", label: "Max", flag: "--maxretry" },
        { name: "force", label: "Force", type: "check" as const, flag: "--force" },
      ],
    };
    expect(actionArgv(a, { ip: " 1.2.3.4 ", bantime: "1h", maxretry: "", force: true })).toEqual([
      "fail2ban",
      "config",
      "sshd",
      "1.2.3.4",
      "--bantime",
      "1h",
      "--force",
    ]);
    expect(actionArgv(a, { force: false })).toEqual(["fail2ban", "config", "sshd"]);
    expect(pluginTab("trivy")).toBe("plugin-trivy");
  });
});

describe("fail2ban", () => {
  const out = [
    "version 1.0.2",
    "state running",
    "JAIL\tsshd\t2\t9\t1\t1.2.3.4 5.6.7.8",
    "CONF\tsshd\t600\t-1\t5",
    "JAIL\trecidive\t0\t0\t0\t",
    "CONF\trecidive\t\t\t",
  ].join("\n");

  test("parses its status", () => {
    expect(f2b.parseStatus(out)).toEqual({
      fail2ban: "running",
      version: "1.0.2",
      jails: [
        { name: "sshd", banned: 2, total: 9, failed: 1, ips: ["1.2.3.4", "5.6.7.8"], bantime: 600, findtime: -1, maxretry: 5 },
        { name: "recidive", banned: 0, total: 0, failed: 0, ips: [] },
      ],
    });
    expect(f2b.parseStatus("state missing\n")).toEqual({ fail2ban: "missing", jails: [] });
  });

  test("durations and times", () => {
    expect([600, 86400, 1209600, 90, 7200, -1, undefined].map(f2b.duration)).toEqual(["10m", "1d", "2w", "90s", "2h", "forever", ""]);
    for (const t of ["600", "10m", "1h", "-1", "1w"]) expect(f2b.TIME.test(t), t).toBe(true);
    for (const t of ["1y", "-2", "1 h", "h"]) expect(f2b.TIME.test(t), t).toBe(false);
  });

  const cmd = (name: string) => f2b.default.commands!.find((c) => c.name === name)!;

  test("config writes a journaled jail.d file", async () => {
    const { ctx, calls } = fakeCtx();
    await cmd("config").run(ctx, ["sshd"], { bantime: "1h", maxretry: "3" });
    expect(calls).toHaveLength(1);
    const [{ body, o }] = calls;
    parses(body);
    expect(body).toContain("/etc/fail2ban/jail.d/50-landfall-$F2B_JAIL.local");
    expect(body.indexOf("saved")).toBeLessThan(body.indexOf("record"));
    expect(body).not.toContain("\\${");
    expect(o).toMatchObject({ admin: expect.any(String), env: { F2B_JAIL: "sshd", F2B_BANTIME: "1h", F2B_MAXRETRY: "3" } });
    await expect(cmd("config").run(ctx, ["sshd"], {})).rejects.toThrow(/nothing to change/);
    await expect(cmd("config").run(ctx, ["sshd"], { bantime: "1y" })).rejects.toThrow(/--bantime/);
    await expect(cmd("config").run(ctx, ["ss hd"], { bantime: "1h" })).rejects.toThrow(/not a jail/);
  });

  test("ban and unban journal how to take them back", async () => {
    const { ctx, calls } = fakeCtx("unbanned sshd\n");
    await cmd("ban").run(ctx, ["9.9.9.9"], { jail: "sshd" });
    await cmd("unban").run(ctx, ["1.2.3.4"], {});
    const [ban, unban] = calls; // one script each: unban finds the jails on the server
    for (const c of [ban, unban]) {
      parses(c.body);
      expect(c.body).toContain("record ");
    }
    expect(ban.o.env).toEqual({ F2B_JAIL: "sshd", F2B_IP: "9.9.9.9" });
    expect(unban.o.env).toEqual({ F2B_IP: "1.2.3.4" });
    await expect(cmd("unban").run(fakeCtx("unbanned\n").ctx, ["8.8.8.8"], {})).rejects.toThrow(/not banned/);
    await expect(cmd("unban").run(fakeCtx("state stopped\n").ctx, ["8.8.8.8"], {})).rejects.toThrow(/not running/);
    await expect(cmd("ban").run(ctx, ["nope"], {})).rejects.toThrow(/not an IP/);
  });

  test("the panel offers to install fail2ban when it is missing", async () => {
    const { ctx } = fakeCtx("state missing\n");
    const blocks = await f2b.default.panel!.load(ctx);
    expect(blocks[0]).toMatchObject({ type: "note", actions: [{ argv: ["fail2ban", "install"] }] });
    const running = await f2b.default.panel!.load(fakeCtx(out).ctx);
    expect(running.map((b) => b.type)).toEqual(["facts", "table", "table"]);
  });
});

describe("trivy files", () => {
  test("the scan script parses and quotes the sites", () => {
    const s = trivy.filesScript("/opt/landfall/sites", ["blog", "it's"], shq);
    parses(s);
    expect(s).toContain(shq("blog it's"));
    expect(s).toContain("--skip-files '**/.env'");
  });

  test("parses findings per site, most severe first, and failed scans", () => {
    const report = {
      Results: [
        {
          Target: "Dockerfile",
          Misconfigurations: [
            { AVDID: "AVD-DS-0002", Severity: "HIGH", Title: "root user", Status: "FAIL", CauseMetadata: { StartLine: 3 } },
            { AVDID: "AVD-DS-0001", Severity: "LOW", Title: "passes", Status: "PASS" },
          ],
        },
        { Target: "config.js", Secrets: [{ RuleID: "aws-key", Severity: "CRITICAL", Title: "AWS key", StartLine: 7 }] },
      ],
    };
    const out = ["SCAN\tblog", JSON.stringify(report), "SCAN\tshop", "", "ERR\tno space left", "SCAN\tbad", "{not json"].join("\n");
    const r = trivy.parseFiles(out);
    expect(r.sites).toEqual(["blog", "shop", "bad"]);
    expect(r.findings).toEqual([
      { site: "blog", file: "config.js", line: 7, kind: "secret", id: "aws-key", severity: "CRITICAL", title: "AWS key" },
      { site: "blog", file: "Dockerfile", line: 3, kind: "misconfig", id: "AVD-DS-0002", severity: "HIGH", title: "root user" },
    ]);
    expect(r.errors).toEqual([
      { site: "shop", error: "no space left" },
      { site: "bad", error: "Trivy's output did not parse" },
    ]);
  });
});

describe("lf plugin new", () => {
  test("the scaffold loads as a plugin and its script parses", async () => {
    const f = write("hello.mjs", scaffold("hello"));
    const p = await core.importPlugin(f);
    expect(p.name).toBe("hello");
    const { ctx, calls } = fakeCtx(" up 3 days\n");
    await p.commands!.find((c) => c.name === "note")!.run(ctx, ["it's me"], {});
    parses(calls[0].body);
    expect(calls[0].body).toContain(shq("it's me"));
    expect(calls[0].o.admin).toBeTruthy();
    const blocks = await p.panel!.load(ctx);
    expect(blocks[0]).toEqual({ type: "facts", items: [{ label: "Uptime", value: "up 3 days" }] });
  });
});
