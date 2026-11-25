import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { gitTrack } from "../../src/cli/commands/git";
import { deploySource as source, pickEnvironmentForRef, type SourceOpts } from "../../src/core/source";
import { gitRules, loadProject } from "../../src/core/config";
import { exportRef, installCommand, listRefs, repoInfo, resolveRef } from "../../src/core/git";
import { loadProjects } from "../../src/core/projects";
import { gitView, projectsView, refsView } from "../../src/core/views";

// projects.json sits under the config dir fixed at import: the list is handed in instead.
vi.mock("../../src/core/projects", async (orig) => ({ ...(await orig<typeof import("../../src/core/projects")>()), loadProjects: vi.fn(() => []) }));

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

const g = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};

let dir: string;
const env = { ...process.env };

/** A repository: main with v1.0.0 and v1.1.0-rc.1, a feature branch, a .landfall.json with test and prod. */
function repo(rules?: Record<string, unknown>) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-git-"));
  g(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "index.html"), "v1");
  const project = { name: "shop", server: "s", environments: { test: {}, prod: {} }, ...rules };
  fs.writeFileSync(path.join(dir, ".landfall.json"), JSON.stringify(project));
  g(dir, "add", "-A");
  g(dir, "commit", "-qm", "one");
  g(dir, "tag", "v1.0.0");
  fs.writeFileSync(path.join(dir, "index.html"), "v2");
  g(dir, "commit", "-qam", "two");
  g(dir, "tag", "v1.1.0-rc.1");
  g(dir, "branch", "feature/x");
  return dir;
}

beforeEach(() => {
  process.env.LANDFALL_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lf-cfg-"));
  delete process.env.LANDFALL_ENV;
});
afterEach(() => {
  process.env = { ...env };
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("core/git", () => {
  test("repoInfo reads branch, tags at HEAD and uncommitted files", async () => {
    repo();
    fs.writeFileSync(path.join(dir, "index.html"), "dirty");
    fs.writeFileSync(path.join(dir, "untracked"), "x");
    expect(await repoInfo(dir)).toMatchObject({ branch: "main", tags: ["v1.1.0-rc.1"], dirty: 1 });
    expect(await repoInfo(os.tmpdir())).toBeUndefined();
  });

  test("listRefs and resolveRef: branches, tags peeled, a commit", async () => {
    repo();
    g(dir, "tag", "-a", "-m", "annotated", "v2.0.0");
    const head = g(dir, "rev-parse", "HEAD");
    const refs = await listRefs(dir);
    expect(refs.find((r) => r.name === "v2.0.0")).toMatchObject({ kind: "tag", sha: head });
    expect(refs.filter((r) => r.kind === "branch").map((r) => r.name)).toEqual(["feature/x", "main"]);
    expect(await resolveRef(dir, "v1.0.0")).toMatchObject({ kind: "tag", name: "v1.0.0" });
    expect(await resolveRef(dir, "refs/heads/main")).toMatchObject({ kind: "branch", sha: head });
    expect(await resolveRef(dir, head.slice(0, 8))).toEqual({ sha: head, name: head.slice(0, 8) });
    expect(await resolveRef(dir, "--output=x")).toBeUndefined();
    expect(await resolveRef(dir, "nope")).toBeUndefined();
  });

  test("exportRef copies the commit only: no uncommitted or ignored files", async () => {
    repo();
    fs.writeFileSync(path.join(dir, "index.html"), "dirty");
    fs.writeFileSync(path.join(dir, "untracked"), "x");
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "lf-exp-"));
    await exportRef(dir, (await resolveRef(dir, "v1.0.0"))!.sha, out);
    expect(fs.readFileSync(path.join(out, "index.html"), "utf8")).toBe("v1");
    expect(fs.existsSync(path.join(out, "untracked"))).toBe(false);
    fs.rmSync(out, { recursive: true });
  });

  test("installCommand follows the lockfile", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "lf-inst-"));
    expect(installCommand(d)).toBeUndefined();
    fs.writeFileSync(path.join(d, "package.json"), "{}");
    expect(installCommand(d)).toBe("npm install");
    fs.writeFileSync(path.join(d, "pnpm-lock.yaml"), "");
    expect(installCommand(d)).toBe("pnpm install --frozen-lockfile");
    fs.rmSync(d, { recursive: true });
  });
});

describe("deploySource", () => {
  // Only --git connects to the server.
  const deploySource = (cwd: string, p: Parameters<typeof source>[1], env: string, o: SourceOpts) =>
    source(cwd, p, env, o, () => Promise.reject(new Error("connected")));
  const prod = { tag: "v*" };
  const test_ = { branch: "main" };

  test("without a rule or an option: the working tree, as before", async () => {
    repo();
    const s = await deploySource(dir, loadProject(dir, "test")!, "test", {});
    expect(s).toMatchObject({ dir, git: { branch: "main", tag: "v1.1.0-rc.1", source: "local" } });
  });

  test("not a git checkout: unchanged without a rule, refused with one unless --force", async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "lf-nogit-"));
    dir = d;
    expect(await deploySource(d, {}, "", {})).not.toHaveProperty("git");
    await expect(deploySource(d, { git: prod }, "prod", {})).rejects.toThrow(/not a git checkout.*--force/);
    expect(await deploySource(d, { git: prod }, "prod", { force: true })).not.toHaveProperty("git");
    await expect(deploySource(d, {}, "", { ref: "main" })).rejects.toThrow(/needs a git checkout/);
  });

  test("a rule refuses the wrong ref; --force deploys it", async () => {
    repo({ environments: { test: { git: test_ }, prod: { git: prod } } });
    g(dir, "checkout", "-q", "feature/x");
    g(dir, "commit", "-q", "--allow-empty", "-m", "feature");
    const p = loadProject(dir, "test")!;
    await expect(deploySource(dir, p, "test", {})).rejects.toThrow(/deploys branch main; HEAD on feature\/x is not one.*--force/);
    expect((await deploySource(dir, p, "test", { force: true })).dir).toBe(dir);
  });

  test("a pre-release tag at HEAD does not satisfy a tag rule; --tag latest exports the newest release", async () => {
    repo({ environments: { test: { git: test_ }, prod: { git: prod } } });
    const p = loadProject(dir, "prod")!;
    await expect(deploySource(dir, p, "prod", {})).rejects.toThrow(/tags v\*.*--tag latest/);
    const s = await deploySource(dir, p, "prod", { tag: "latest" });
    expect(s).toMatchObject({ git: { source: "ref" } });
    expect(s.dir).not.toBe(dir);
    expect(s.git).toMatchObject({ tag: "v1.0.0", source: "ref" });
    expect(fs.readFileSync(path.join(s.dir, "index.html"), "utf8")).toBe("v1");
  });

  test("requireClean refuses uncommitted changes in the working tree, not in an export", async () => {
    repo({ environments: { test: { git: { ...test_, requireClean: true } }, prod: {} } });
    fs.writeFileSync(path.join(dir, "index.html"), "dirty");
    const p = loadProject(dir, "test")!;
    await expect(deploySource(dir, p, "test", {})).rejects.toThrow(/uncommitted changes.*--ref main/);
    expect((await deploySource(dir, p, "test", { ref: "main" })).dir).not.toBe(dir);
  });

  test("--ref, --tag and --for-ref exclude each other", async () => {
    repo();
    await expect(deploySource(dir, {}, "", { ref: "main", tag: "v1.0.0" })).rejects.toThrow(/exclude each other/);
  });

  test("--for-ref on the checked-out commit deploys the working tree, named after the ref", async () => {
    repo({ environments: { test: { git: test_ }, prod: { git: prod } } });
    g(dir, "checkout", "-q", "--detach", "HEAD");
    const s = await deploySource(dir, loadProject(dir, "test")!, "test", { "for-ref": "refs/heads/main" });
    expect(s).toMatchObject({ dir, git: { branch: "main" } });
  });
});

describe("pickEnvironmentForRef", () => {
  test("the rules pick the environment", () => {
    repo({ environments: { test: { git: { branch: "main" } }, prod: { git: { tag: "v*" } } } });
    pickEnvironmentForRef(dir, "refs/tags/v1.0.0");
    expect(process.env.LANDFALL_ENV).toBe("prod");
    delete process.env.LANDFALL_ENV;
    pickEnvironmentForRef(dir, "main");
    expect(process.env.LANDFALL_ENV).toBe("test");
  });

  test("no match, two matches, -E or no rules: refused", () => {
    repo({ environments: { test: { git: { branch: "main" } }, prod: { git: { branch: "main" } } } });
    expect(() => pickEnvironmentForRef(dir, "feature/x")).toThrow(/no environment deploys/);
    expect(() => pickEnvironmentForRef(dir, "main")).toThrow(/matches the rules of test and prod/);
    process.env.LANDFALL_ENV = "test";
    expect(() => pickEnvironmentForRef(dir, "main")).toThrow(/drop -E/);
    delete process.env.LANDFALL_ENV;
    repo();
    expect(() => pickEnvironmentForRef(dir, "main")).toThrow(/needs git rules/);
  });
});

describe("lf git track", () => {
  const track = async (args: Record<string, unknown>, envName?: string) => {
    if (envName) process.env.LANDFALL_ENV = envName;
    else delete process.env.LANDFALL_ENV;
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      await gitTrack.run([], args as never, []);
    } finally {
      process.chdir(cwd);
    }
  };

  test("writes each environment's rule, keeps the rest, --off drops it", async () => {
    repo();
    await track({ tag: ["v*"], "require-clean": true }, "prod");
    await track({ branch: ["main", "release/*"] }, "test");
    expect(gitRules(dir)).toMatchObject({ prod: { tag: "v*", requireClean: true }, test: { branch: ["main", "release/*"] } });
    await track({ prerelease: true }, "prod");
    expect(gitRules(dir).prod).toEqual({ tag: "v*", requireClean: true, prerelease: true });
    await track({ off: true }, "test");
    expect(gitRules(dir).test).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(path.join(dir, ".landfall.json"), "utf8")).name).toBe("shop");
  });

  test("the same rule again leaves .landfall.json as it is", async () => {
    repo();
    await track({ branch: ["main", "release/*"] }, "test");
    const file = path.join(dir, ".landfall.json");
    // An old mtime: a rewrite, even of the same text, shows.
    fs.utimesSync(file, 1000, 1000);
    await track({ branch: ["release/*", "main"] }, "test");
    expect(fs.statSync(file).mtimeMs).toBe(1_000_000);
  });

  test("a rule must name something; --off takes no globs", async () => {
    repo();
    await expect(track({ prerelease: true }, "prod")).rejects.toThrow(/--branch <glob> or --tag <glob>/);
    await expect(track({ off: true, branch: ["main"] }, "prod")).rejects.toThrow(/--off drops the rule/);
  });
});

describe("views", () => {
  test("refsView reads the refs of the gitView it is handed, not again", async () => {
    // No server: the view reports that environment as unreadable, and no ssh runs.
    repo({ server: undefined, environments: { prod: { git: { tag: "v*" } } } });
    const gv = await gitView(dir);
    const view = await refsView(dir, "prod", { ...gv, refs: [{ name: "v9.9.9", kind: "tag", sha: "abc" }] });
    expect(view.envs[0].matching.map((r) => r.name)).toEqual(["v9.9.9"]);
  });

  test("projectsView flags git checkouts and rules from the files alone", async () => {
    repo({ environments: { prod: { git: { tag: "v*" } } } });
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "lf-plain-"));
    const at = "2026-01-01T00:00:00Z";
    vi.mocked(loadProjects).mockReturnValueOnce([
      { path: dir, name: "shop", server: "s", kind: "compose", at },
      { path: plain, name: "plain", server: "s", kind: "compose", at },
    ] as ReturnType<typeof loadProjects>);
    expect(projectsView().map((p) => [p.name, p.inGit, p.hasGitRules])).toEqual([
      ["shop", true, true],
      ["plain", false, false],
    ]);
    fs.rmSync(plain, { recursive: true, force: true });
  });
});
