import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const live: Record<string, unknown> = {};
vi.mock("../../src/core/site/remote", async (orig) => ({
  ...(await orig<typeof import("../../src/core/site/remote")>()),
  readSite: vi.fn(async (_s: unknown, name: string) => ({ meta: live[name], env: "", proxy: {}, exists: !!live[name], routed: true })),
}));
const deployRun = vi.fn();
vi.mock("../../src/cli/commands/deploy", async (orig) => {
  const m = await orig<typeof import("../../src/cli/commands/deploy")>();
  return { ...m, deploy: { ...m.deploy, run: (...a: unknown[]) => deployRun(...a) } };
});

const { promote } = await import("../../src/cli/commands/refs");
const { setAssumeYes } = await import("../../src/core/lib/term");

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

const g = (cwd: string, ...args: string[]) =>
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
  }).stdout.trim();

let dir: string;
const cwd = process.cwd();

/** test deploys main, prod tags v*; test runs HEAD of main. */
function setup(tagHead: boolean) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-promote-"));
  g(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(
    path.join(dir, ".landfall.json"),
    JSON.stringify({ name: "shop", server: "s", environments: { test: { git: { branch: "main" } }, prod: { git: { tag: "v*" } } } }),
  );
  g(dir, "add", "-A");
  g(dir, "commit", "-qm", "one");
  if (tagHead) g(dir, "tag", "v1.2.0");
  const sha = g(dir, "rev-parse", "HEAD");
  live["shop-test"] = {
    name: "shop-test",
    current: "r1",
    releases: [{ id: "r1", at: new Date().toISOString(), services: [], git: { commit: sha.slice(0, 12), sha, branch: "main" } }],
  };
  process.chdir(dir);
  return sha;
}

beforeEach(() => {
  process.env.LANDFALL_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lf-cfg-"));
  setAssumeYes(true);
  delete process.env.LANDFALL_ENV;
  deployRun.mockReset();
});
afterEach(() => {
  process.chdir(cwd);
  delete process.env.LANDFALL_ENV;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("lf promote", () => {
  test("refuses a commit without a tag the target's rule allows; --force deploys it", async () => {
    const sha = setup(false);
    await expect(promote.run(["test", "prod"], {} as never, [])).rejects.toThrow(/prod deploys tags v\*.*tag it first.*--force/);
    expect(deployRun).not.toHaveBeenCalled();
    await promote.run(["test", "prod"], { force: true } as never, []);
    expect(deployRun).toHaveBeenCalledWith([], expect.objectContaining({ ref: sha, force: true }), []);
    expect(process.env.LANDFALL_ENV).toBe("prod");
  });

  test("a tagged commit deploys to the next environment as that tag", async () => {
    setup(true);
    await promote.run(["test", "prod"], {} as never, []);
    expect(deployRun).toHaveBeenCalledWith([], expect.objectContaining({ ref: "refs/tags/v1.2.0" }), []);
  });

  test("unknown environment, the same one twice, or nothing running", async () => {
    setup(true);
    await expect(promote.run(["test", "staging"], {} as never, [])).rejects.toThrow(/no environment staging/);
    await expect(promote.run(["test", "test"], {} as never, [])).rejects.toThrow(/one environment to another/);
    await expect(promote.run(["prod", "test"], {} as never, [])).rejects.toThrow(/prod runs nothing/);
  });
});
