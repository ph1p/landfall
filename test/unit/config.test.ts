import { fork, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../src/core/login", async (orig) => ({
  ...(await orig<typeof import("../../src/core/login")>()),
  ensureKeyLogin: vi.fn(async () => undefined),
  loginPassword: vi.fn(async () => undefined),
}));

const dir = fs.mkdtempSync(join(tmpdir(), "lf-config-"));
process.env.LANDFALL_CONFIG_DIR = dir;
process.env.LANDFALL_SSH_CONFIG = join(dir, "ssh");
const { CONFIG_PATH, updateConfig, loadConfig, patchServer, useServer, forgetServer } = await import("../../src/core/config");
const { config } = await import("../../src/cli/commands/config");
const { serverAdd, serverDomain } = await import("../../src/cli/commands/server");
const { ensureKeyLogin } = await import("../../src/core/login");
const term = await import("../../src/core/term");

beforeEach(() => {
  for (const file of fs.readdirSync(dir)) fs.rmSync(join(dir, file), { recursive: true, force: true });
});
const write = (value: unknown) => fs.writeFileSync(CONFIG_PATH, JSON.stringify(value), { mode: 0o600 });

function message(child: ChildProcess, expected: string) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); child.kill(); reject(new Error(`worker timed out waiting for ${expected}`)); }, 10000);
    const onMessage = (m: unknown) => { if (m === expected) { cleanup(); resolve(); } };
    const onExit = (code: number | null) => { cleanup(); reject(new Error(`worker exited ${code} before ${expected}`)); };
    const cleanup = () => { clearTimeout(timer); child.off("message", onMessage); child.off("exit", onExit); };
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}

async function worker(mode: string, name = "") {
  const child = fork("test/unit/fixtures/config-worker.ts", [mode, name], {
    execArgv: ["--import", "tsx"], env: { ...process.env, LANDFALL_CONFIG_DIR: dir },
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  await message(child, "ready");
  return child;
}

describe("global config transactions", () => {
  test("creates private config and updates defaults atomically", async () => {
    await useServer("a");
    await updateConfig((cfg) => { cfg.defaults = { keep: 3 }; });
    expect(loadConfig()).toEqual({ default: "a", servers: { a: { host: "a" } }, defaults: { keep: 3 } });
    expect(fs.statSync(CONFIG_PATH).mode & 0o777).toBe(0o600);
    await forgetServer("a");
    expect(loadConfig()).toEqual({ servers: {}, defaults: { keep: 3 } });
    expect(fs.existsSync(CONFIG_PATH + ".lock")).toBe(false);
  });

  test("exceptions, invalid JSON and async callbacks never replace config or strand owned locks", async () => {
    write({ servers: {} });
    await expect(updateConfig(() => { throw new Error("fixture"); })).rejects.toThrow("fixture");
    await expect(updateConfig(async (cfg) => { cfg.default = "wrong"; })).rejects.toThrow("synchronous");
    await expect(updateConfig(async () => { throw new Error("rejected async fixture"); })).rejects.toThrow("synchronous");
    expect(loadConfig()).toEqual({ servers: {} });
    fs.writeFileSync(CONFIG_PATH, "{broken");
    await expect(updateConfig(() => {})).rejects.toThrow("cannot read");
    expect(fs.readFileSync(CONFIG_PATH, "utf8")).toBe("{broken");
    expect(fs.existsSync(CONFIG_PATH + ".lock")).toBe(false);
  });

  test("an abandoned lock fails closed without age takeover", async () => {
    write({ servers: {} });
    fs.mkdirSync(CONFIG_PATH + ".lock");
    fs.utimesSync(CONFIG_PATH + ".lock", 1, 1);
    await expect(updateConfig(() => {}, 30)).rejects.toThrow("Check that no landfall writer is active");
    expect(fs.existsSync(CONFIG_PATH + ".lock")).toBe(true);
    expect(loadConfig()).toEqual({ servers: {} });
  });

  test("does not release another owner's replacement lock", async () => {
    await updateConfig(() => {
      fs.rmSync(CONFIG_PATH + ".lock", { recursive: true });
      fs.mkdirSync(CONFIG_PATH + ".lock");
      fs.writeFileSync(join(CONFIG_PATH + ".lock", "owner.json"), "replacement-owner");
    });
    expect(fs.readFileSync(join(CONFIG_PATH + ".lock", "owner.json"), "utf8")).toBe("replacement-owner");
  });

  test("keeps symlinks and target modes, and locks the canonical target", async () => {
    const target = join(dir, "target.json");
    fs.writeFileSync(target, '{"servers":{}}', { mode: 0o640 });
    fs.symlinkSync(target, CONFIG_PATH);
    fs.mkdirSync(target + ".lock");
    await expect(updateConfig(() => {}, 0)).rejects.toThrow(target + ".lock");
    fs.rmdirSync(target + ".lock");
    await useServer("a");
    expect(fs.lstatSync(CONFIG_PATH).isSymbolicLink()).toBe(true);
    expect(fs.statSync(target).mode & 0o777).toBe(0o640);
    expect(loadConfig().default).toBe("a");
  });

  test("independent processes keep all concurrent additions", async () => {
    const children: ChildProcess[] = [];
    try {
      for (let i = 0; i < 8; i++) children.push(await worker("add", `server-${i}`));
      await Promise.all(children.map((child) => {
        const done = message(child, "done");
        child.send("go");
        return done;
      }));
      expect(Object.keys(loadConfig().servers).sort()).toEqual(Array.from({ length: 8 }, (_, i) => `server-${i}`));
    } finally {
      children.forEach((child) => child.kill());
    }
  }, 20000);

  test("a waiting process reads the config after the previous writer commits", async () => {
    const holder = await worker("hold");
    const writer = await worker("add", "after");
    try {
      const locked = message(holder, "locked");
      const heldDone = message(holder, "done");
      holder.send("go");
      await locked;
      expect(fs.existsSync(CONFIG_PATH + ".lock")).toBe(true);
      const done = message(writer, "done");
      writer.send("go");
      holder.stdin!.write("x");
      await Promise.all([heldDone, done]);
      expect(loadConfig()).toEqual({ servers: { after: { host: "after" } }, defaults: { keep: 7 } });
    } finally {
      holder.kill(); writer.kill();
    }
  });

  test("rebases delayed updates while preserving unrelated fields and explicit deletions", async () => {
    const before = { host: "a", user: "old", domains: ["a.test"] };
    write({ servers: { a: before }, default: "a" });
    await updateConfig((cfg) => {
      cfg.servers.a.email = "other@example.com";
      cfg.servers.b = { host: "b" };
      cfg.default = "b";
    });
    await updateConfig((cfg) => {
      patchServer(cfg, "a", before, { host: "a", domains: ["a.test"], port: 2222 });
      cfg.default ??= "a";
    });
    expect(loadConfig()).toEqual({
      servers: { a: { host: "a", domains: ["a.test"], port: 2222, email: "other@example.com" }, b: { host: "b" } }, default: "b",
    });
  });

  test("refuses conflicting edits, a removed entry, and a concurrently added entry", async () => {
    const before = { host: "a", domains: ["old.test"] };
    write({ servers: { a: { ...before, domains: ["new.test"] } } });
    await expect(updateConfig((cfg) => patchServer(cfg, "a", before, { ...before, domains: [] }))).rejects.toThrow("changed during");
    expect(loadConfig().servers.a.domains).toEqual(["new.test"]);
    await forgetServer("a");
    await expect(updateConfig((cfg) => patchServer(cfg, "a", before, before))).rejects.toThrow("changed during");
    await useServer("a");
    await expect(updateConfig((cfg) => patchServer(cfg, "a", undefined, { host: "different" }))).rejects.toThrow("changed during");
  });

  test("combined default/defaults changes validate before any mutation", async () => {
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const errors = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await expect(config.run([], { default: "a", keep: "no", json: true }, [])).rejects.toThrow("whole number");
      expect(fs.existsSync(CONFIG_PATH)).toBe(false);
      await config.run([], { default: "a", keep: "4", json: true }, []);
      expect(loadConfig()).toEqual({ servers: { a: { host: "a" } }, default: "a", defaults: { keep: 4 } });
    } finally {
      output.mockRestore(); errors.mockRestore();
    }
  });

  test("server add rebases its actual delayed authentication commit", async () => {
    let resume!: (key: string | undefined) => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    vi.mocked(ensureKeyLogin).mockImplementationOnce(() => { entered(); return new Promise((resolve) => { resume = resolve; }); });
    const add = serverAdd.run(["a"], { "ssh-config": false }, []);
    await waiting;
    await useServer("b");
    resume(undefined);
    await add;
    expect(loadConfig()).toEqual({ default: "b", servers: { a: { host: "a" }, b: { host: "b" } } });
  });

  test("a delayed domain confirmation cannot discard another writer's domains or partially set tunnel-only", async () => {
    write({ servers: { a: { host: "a", domains: ["old.test"] } }, default: "a" });
    let resume!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const confirmation = vi.spyOn(term, "confirmRemoval").mockImplementationOnce(() => {
      entered(); return new Promise<void>((resolve) => { resume = resolve; });
    });
    try {
      const change = serverDomain.run(["a"], { clear: true, "tunnel-only": true }, []);
      // Attach rejection handling before the deferred confirmation is released.
      const refused = expect(change).rejects.toThrow("changed during");
      await waiting;
      await updateConfig((cfg) => { cfg.servers.a.domains = ["new.test"]; });
      resume();
      await refused;
      expect(loadConfig().servers.a).toEqual({ host: "a", domains: ["new.test"] });
    } finally {
      confirmation.mockRestore();
    }
  });
});
