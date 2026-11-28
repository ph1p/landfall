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

const { PRELUDE } = await import("../../src/core/ssh/templates");
const { shq } = await import("../../src/core/ssh/ssh");
const { actionArgv, pluginTab, RESERVED_OPTIONS } = await import("../../src/core/plugins/plugin-api");
const { GLOBAL_OPTS, serverOpt } = await import("../../src/cli/cmd");
const core = await import("../../src/core/plugins/plugins");
const f2b = await import("../../src/plugins/fail2ban");
const trivy = await import("../../src/plugins/trivy");
const { BUILTIN } = await import("../../src/plugins");
const { scaffold } = await import("../../src/cli/commands/plugins");
const { pluginCommands, registerPlugins } = await import("../../src/cli/plugins");
const { aliases, byName } = await import("../../src/cli/registry");
type PluginContext = import("../../src/core/plugins/plugin-api").PluginContext;
type Plugin = import("../../src/core/plugins/plugin-api").Plugin;

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
    confirmRisky: async () => false,
    ask: async (_q: string, def?: string) => def ?? "",
    table: () => {},
    json: () => {},
    print: () => {},
    blocks: () => {},
    file: () => "",
    color: new Proxy({}, { get: () => (s: string) => s }),
    paths: { root: "/opt/landfall", sites: "/opt/landfall/sites", traefik: "/opt/landfall/traefik" },
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
  test("checks commands' names and options", () => {
    const cmd = (extra: object) => ({ name: "a", summary: "s", commands: [{ name: "x", summary: "", run() {}, ...extra }] });
    expect(core.checkPlugin(cmd({ options: { limit: { type: "string", short: "l", desc: "d" } } }))).toBe("");
    expect(core.checkPlugin({ name: "a", summary: "s", commands: [cmd({}).commands[0], cmd({}).commands[0]] })).toMatch(/defined twice/);
    expect(core.checkPlugin(cmd({ options: { server: { type: "string", desc: "d" } } }))).toMatch(/--server is landfall's own/);
    expect(core.checkPlugin(cmd({ options: { yes: { type: "boolean", desc: "d" } } }))).toMatch(/--yes is landfall's own/);
    expect(core.checkPlugin(cmd({ options: { n: { type: "number", desc: "d" } } }))).toMatch(/type "string" or "boolean"/);
    expect(core.checkPlugin(cmd({ options: { n: { type: "string", short: "s", desc: "d" } } }))).toMatch(/-s is landfall's own/);
    expect(core.checkPlugin(cmd({ options: { n: { type: "string", short: "ab", desc: "d" } } }))).toMatch(/one letter/);
    expect(core.checkPlugin(cmd({ options: { Bad: { type: "string", desc: "d" } } }))).toMatch(/option name/);
    expect(core.checkPlugin({ name: "a", summary: "s", commands: {} })).toMatch(/array/);
    expect(core.checkPlugin({ name: "a", summary: "s", aliases: { b: 1 } })).toMatch(/aliases/);
  });
  test("the reserved options are every option landfall adds to a plugin command", () => {
    const own = { ...GLOBAL_OPTS, server: serverOpt };
    expect(RESERVED_OPTIONS).toEqual(Object.fromEntries(Object.entries(own).map(([k, o]) => [k, o.short])));
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
      expect(loaded.map((l) => l.plugin.name)).toEqual(["analytics", "exposure", "fail2ban", "trivy", "one", "three", "two"]);
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
      expect((await core.loadPlugins(BUILTIN)).map((l) => l.plugin.name)).toEqual(["analytics", "exposure", "fail2ban", "trivy"]);
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
    expect(names).toEqual(["analytics", "exposure", "fail2ban", "trivy", "fine"]);
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

  // ---- lf fail2ban web ----

  /** A fail2ban filter as a JS regex: %(x)s expanded, <HOST> a named group, the first failregex line. */
  const filterRegex = (conf: string) => {
    const defs = new Map<string, string>();
    for (const l of conf.split("\n")) {
      const m = /^(\w+) = (.*)$/.exec(l);
      if (m) defs.set(m[1], m[2]);
    }
    let re = defs.get("failregex")!;
    while (/%\((\w+)\)s/.test(re)) re = re.replace(/%\((\w+)\)s/g, (_, k) => defs.get(k)!);
    return new RegExp(re.replace("<HOST>", "(?<host>[0-9a-fA-F.:]+)"));
  };
  /** One request as Docker's json-file log stores Traefik's JSON line: keys sorted, escaped twice. */
  const dockerLine = (o: { ip?: string; status: number; path?: string; host?: string }) => {
    const ip = o.ip ?? "203.0.113.9";
    const inner = JSON.stringify({
      ClientAddr: `${ip.includes(":") ? `[${ip}]` : ip}:51234`,
      ClientHost: ip,
      ClientPort: "51234",
      DownstreamContentSize: 19,
      DownstreamStatus: o.status,
      Duration: 120000,
      RequestHost: o.host ?? "app.test",
      RequestMethod: "GET",
      RequestPath: o.path ?? "/",
      StartUTC: "2026-11-28T10:00:00.1Z",
    });
    return JSON.stringify({ log: `${inner}\n`, stream: "stdout", time: "2026-11-28T10:00:00.123456789Z" });
  };
  const hostOf = (re: RegExp, line: string) => re.exec(line)?.groups?.host ?? null;

  test("the web filters ban what scanners get, never /_lf/, and only the connection's address", () => {
    const http = filterRegex(f2b.FILTER_HTTP);
    const flood = filterRegex(f2b.FILTER_FLOOD);
    for (const st of [400, 401, 403, 404, 405]) expect(hostOf(http, dockerLine({ status: st })), String(st)).toBe("203.0.113.9");
    for (const st of [200, 301, 406, 429, 500]) expect(hostOf(http, dockerLine({ status: st })), String(st)).toBeNull();
    expect(hostOf(http, dockerLine({ status: 404, path: "/_lf/a/e" }))).toBeNull();
    expect(hostOf(flood, dockerLine({ status: 200, path: "/_lf/a/e" }))).toBeNull();
    expect(hostOf(flood, dockerLine({ status: 200 }))).toBe("203.0.113.9");
    expect(hostOf(http, dockerLine({ status: 404, ip: "2001:db8::7" }))).toBe("2001:db8::7");
    // A path or Host header naming another address, or faking /_lf/: Docker escapes their quotes once more.
    const fake = '","ClientHost":"198.51.100.66","DownstreamStatus":404,"RequestPath":"/_lf/';
    expect(hostOf(http, dockerLine({ status: 404, path: `/x${fake}` }))).toBe("203.0.113.9");
    expect(hostOf(http, dockerLine({ status: 404, host: `a${fake}` }))).toBe("203.0.113.9");
    expect(hostOf(http, dockerLine({ status: 200, path: `/x${fake}` }))).toBeNull();
    // fail2ban reads %% as %; a lone % would be an interpolation error.
    expect(f2b.FILTER_HTTP).toContain('datepattern = "time":"%%Y-%%m-%%dT%%H:%%M:%%S');
    expect(f2b.FILTER_HTTP.replace(/%%|%\(\w+\)s/g, "")).not.toContain("%");
  });

  const JSON_LOG = ["AL\t--accesslog=true", "AL\t--accesslog.format=json", "AF\t2", "AN\t0", "LD\tjson-file", "LP\t/var/lib/docker/containers/c1/c1-json.log"];
  const webOut = (...extra: string[]) =>
    [...JSON_LOG, "PROXY\tc1 landfall", "IPT", "DU4", "DU6", "KEYS\t20\t20", "version 1.0.2", "state running", "JAIL\tsshd\t0\t0\t0\t", ...extra].join("\n");

  test("parseWeb: off, on, flood, mode, stale, and why web on would refuse", () => {
    expect(f2b.parseWeb(webOut())).toMatchObject({ fail2ban: "running", on: false, flood: false, stale: false, noIpv6: false, jails: [] });
    expect(f2b.parseWeb(webOut()).problem).toBeUndefined();
    const on = f2b.parseWeb(
      webOut(
        "WEBHEAD\tc1 mode=bridge flood=1 ignore=198.51.100.0/24,2001:db8::/32",
        "JAIL\tlandfall-http\t1\t4\t0\t192.0.2.1",
        "CONF\tlandfall-http\t3600\t120\t30",
      ),
    );
    expect(on).toMatchObject({ on: true, flood: true, mode: "bridge", stale: false, ignore: ["198.51.100.0/24", "2001:db8::/32"] });
    expect(on.jails.map((j) => j.name)).toEqual(["landfall-http"]);
    expect(f2b.parseWeb(webOut("WEBHEAD\told mode=bridge flood=0 ignore=")).stale).toBe(true);
    expect(f2b.parseWeb(webOut("WEBHEAD\tc1 mode=bridge flood=0 ignore=").replace("c1 landfall", "c1 host")).stale).toBe(true);
    expect(f2b.parseWeb(webOut().replace("DU6\n", "")).noIpv6).toBe(true);
    const problem = (out: string) => f2b.parseWeb(out).problem ?? "";
    expect(problem(webOut().replace("state running", "state stopped"))).toMatch(/lf fail2ban install/);
    expect(problem(webOut().replace("PROXY\tc1 landfall", "PROXY\t"))).toMatch(/lf traefik install/);
    expect(problem(webOut().replace("LD\tjson-file", "LD\tlocal"))).toMatch(/local driver/);
    expect(problem(webOut().replace("AL\t--accesslog.format=json\n", ""))).toMatch(/lf traefik access-log on/);
    expect(problem(webOut().replace("IPT\n", ""))).toMatch(/iptables is missing/);
    expect(problem(webOut().replace("DU4\n", ""))).toMatch(/DOCKER-USER/);
    expect(problem(webOut().replace("KEYS\t20\t20", "KEYS\t20\t3"))).toMatch(/ClientAddr, ClientHost/);
    // Host network needs no DOCKER-USER; without root (no KEYS) it is not checked.
    expect(problem(webOut().replace("DU4\n", "").replace("c1 landfall", "c1 host"))).toBe("");
    expect(problem(webOut().replace("DU4\n", "").replace("KEYS\t20\t20\n", ""))).toBe("");
  });

  test("web on checks, writes the filters and jails, reloads, then journals; web off takes them away", async () => {
    const { ctx, calls } = fakeCtx(webOut());
    await cmd("web").run(ctx, ["on"], { flood: true, ignore: "198.51.100.0/24, 2001:db8::/32" });
    expect(calls).toHaveLength(2);
    const [check, on] = calls;
    parses(check.body);
    expect(check.body).toContain("WEBHEAD");
    parses(on.body);
    expect(on.o.env).toEqual({ F2B_FLOOD: "1", F2B_IGNORE: "198.51.100.0/24 2001:db8::/32" });
    const order = [
      "saved",
      "/etc/fail2ban/filter.d/landfall-traefik.conf",
      "/etc/fail2ban/filter.d/landfall-traefik-flood.conf",
      "f2b_web_write",
      "fail2ban-client reload",
      "record ",
    ];
    // Each step after the one before it (the paths also appear earlier, in the list saved backs up).
    let from = 0;
    for (const x of order) {
      const i = on.body.indexOf(x, from);
      expect(i, x).toBeGreaterThanOrEqual(0);
      from = i + 1;
    }
    // A config fail2ban refuses is put back before anything is journaled.
    expect(on.body.indexOf('eval "$undo"')).toBeLessThan(on.body.indexOf("record "));
    expect(on.body).not.toContain("\\${");

    await expect(cmd("web").run(fakeCtx(webOut()).ctx, ["on"], { ignore: "cdn.example" })).rejects.toThrow(/--ignore/);
    await expect(cmd("web").run(fakeCtx(webOut().replace("IPT\n", "")).ctx, ["on"], {})).rejects.toThrow(/iptables/);
    await expect(cmd("web").run(fakeCtx(webOut()).ctx, ["maybe"], {})).rejects.toThrow(/usage/);

    const off = fakeCtx("already off\n");
    await cmd("web").run(off.ctx, ["off"], {});
    parses(off.calls[0].body);
    expect(off.calls[0].body).toContain("/etc/fail2ban/jail.d/40-landfall-http.local");
    expect(off.calls[0].body.indexOf("saved")).toBeLessThan(off.calls[0].body.indexOf("rm -f"));
    expect(off.calls[0].body).toContain('record "fail2ban web jails off"');
  });

  test("the panel offers the web jails only where they would work, and says when they watch an old log", async () => {
    const offer = await f2b.default.panel!.load(fakeCtx(webOut()).ctx);
    expect(offer.find((b) => b.type === "note")).toMatchObject({ actions: [{ argv: ["fail2ban", "web", "on"] }] });
    const refused = await f2b.default.panel!.load(fakeCtx(webOut().replace("IPT\n", "")).ctx);
    expect(refused.some((b) => b.type === "note")).toBe(false);
    const stale = await f2b.default.panel!.load(fakeCtx(webOut("WEBHEAD\told mode=bridge flood=1 ignore=192.0.2.0/24")).ctx);
    expect(stale.find((b) => b.type === "note")).toMatchObject({
      kind: "warn",
      actions: [{ argv: ["fail2ban", "web", "on", "--flood", "--ignore", "192.0.2.0/24"] }],
    }); // On: change the settings (filled in with the current ones) or remove the jails.
    const on = await f2b.default.panel!.load(
      fakeCtx(webOut("WEBHEAD\tc1 mode=bridge flood=1 ignore=192.0.2.0/24", "JAIL\tlandfall-http\t0\t0\t0\t", "JAIL\tlandfall-http-flood\t0\t0\t0\t")).ctx,
    );
    const note = on.find((b) => b.type === "note") as any;
    expect(note.kind).toBe("info");
    expect(note.actions[0].fields.map((f: any) => f.value)).toEqual([true, "192.0.2.0/24"]);
    expect(note.actions[1]).toMatchObject({ argv: ["fail2ban", "web", "off"], danger: true });
    // The jails table removes one web jail: the flood jail alone keeps the scanners' jail and its ignore list.
    const jails = on.find((b) => b.type === "table" && b.title === "Jails") as any;
    const remove = (name: string) => jails.rows.find((r: any) => r.cells[0].text === name)?.actions.find((a: any) => a.label === "Remove");
    expect(remove("landfall-http-flood")?.argv).toEqual(["fail2ban", "web", "on", "--ignore", "192.0.2.0/24"]);
    expect(remove("landfall-http")?.argv).toEqual(["fail2ban", "web", "off"]);
    expect(remove("sshd")).toBeUndefined();
  });

  test("f2b_web_refresh follows a recreated Traefik, and does nothing without the web jails", () => {
    const fn = PRELUDE.slice(PRELUDE.indexOf("f2b_web_refresh() {"));
    expect(fn.split("\n")[1]).toContain("[ -e /etc/fail2ban/jail.d/40-landfall-http.local ]");
    expect(fn.split("\n")[1]).toContain("return 0");
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

describe("pluginContext", () => {
  test("a local command's context prints results on stdout and has no server", () => {
    const ctx = core.pluginContext("test", null);
    expect(ctx.name).toBe("");
    expect(ctx.server).toBeUndefined();
    expect(ctx.paths).toEqual({ root: "/opt/landfall", sites: "/opt/landfall/sites", traefik: "/opt/landfall/traefik" });
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    ctx.print("a", "b");
    expect(out).toHaveBeenCalledWith("a\nb\n");
    out.mockRestore();
  });

  test("file() reads what a plugin ships with: a folder plugin's folder, a built-in plugin's source folder", async () => {
    write("kit/index.mjs", plugin("kit"));
    write("kit/app/run.sh", "echo hi\n");
    await core.loadPlugins(BUILTIN);
    const ctx = core.pluginContext("kit", null);
    expect(ctx.file("app/run.sh")).toBe("echo hi\n");
    expect(() => ctx.file("app/gone.sh")).toThrow(/gone\.sh is missing next to/);
    expect(core.pluginContext("analytics", null).file("app/tz.json")).toMatch(/^\{/);
  });

  test("blocks() prints UI blocks as text on stdout", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      core.pluginContext("test", null).blocks([
        { type: "heading", text: "Speed" },
        { type: "note", text: "all good" },
      ]);
      expect(log.mock.calls.flat().join("\n")).toMatch(/SPEED[\s\S]*all good/);
    } finally {
      out.mockRestore();
      log.mockRestore();
    }
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
