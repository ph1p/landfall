import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import type { CiPlan } from "../../src/core/ci";

// The config dir is fixed when config.ts loads: point it (and ssh's config) at a temp folder first.
const cfg = fs.mkdtempSync(path.join(os.tmpdir(), "lf-ci-cfg-"));
process.env.LANDFALL_CONFIG_DIR = cfg;
process.env.LANDFALL_SSH_CONFIG = path.join(cfg, "ssh_config");
fs.writeFileSync(process.env.LANDFALL_SSH_CONFIG, "");
fs.writeFileSync(
  path.join(cfg, "config.json"),
  JSON.stringify({ servers: { web: { host: "203.0.113.10", user: "deploy", port: 2222, key: "~/.ssh/secret" } }, default: "web" }),
);
delete process.env.LANDFALL_ENV;
const { ciKeyScript, ciPlan, ghGlob, githubYaml, gitlabYaml, glRegex, knownHosts } = await import("../../src/core/ci");
const { globRe } = await import("../../src/core/refs");

const parses = (script: string) => execFileSync("bash", ["-n"], { input: script });
const g = (cwd: string, ...args: string[]) =>
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).stdout.trim();

const dirs: string[] = [cfg];
afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

/** A plan as ciPlan builds it: dev on develop, test on main and release/*, prod on tags v*. */
function plan(over: Partial<CiPlan> = {}): CiPlan {
  return {
    forge: "github",
    cli: "gh",
    repo: "acme/shop",
    file: ".github/workflows/landfall.yml",
    exists: false,
    yaml: "",
    secrets: ["LANDFALL_SSH_KEY", "LANDFALL_KNOWN_HOSTS"],
    servers: [{ name: "web", hostname: "203.0.113.10", user: "deploy", port: 22 }],
    targets: [
      { env: "dev", server: "web", branches: ["develop"], tags: [], prerelease: false },
      { env: "test", server: "web", branches: ["main", "release/*"], tags: [], prerelease: false },
      { env: "prod", server: "web", branches: [], tags: ["v*"], prerelease: false },
    ],
    keyComment: "landfall ci acme/shop",
    config: { servers: { web: { host: "web" } } },
    prefix: "",
    root: "/x",
    ...over,
  };
}

describe("globs for the forges", () => {
  test("ghGlob: ? widens, + and brackets are literal", () => {
    expect(ghGlob("release/*")).toBe("release/*");
    expect(ghGlob("v?.x")).toBe("v*.x");
    expect(ghGlob("c++[1]")).toBe("c\\+\\+\\[1\\]");
    expect(ghGlob("!x")).toBe("\\!x");
  });

  test("glRegex matches what landfall's globs match", () => {
    const re = glRegex(["main", "release/*", "v*"]);
    expect(re.startsWith("/^(?:") && re.endsWith(")$/")).toBe(true);
    const js = new RegExp(re.slice(1, -1).replace(/\\\//g, "/"));
    for (const [ref, want] of [
      ["main", true],
      ["release/1.x", true],
      ["release/a/b", false],
      ["v1.2.0", true],
      ["mainline", false],
    ] as const) {
      expect(js.test(ref), ref).toBe(want);
      expect(
        ["main", "release/*", "v*"].some((x) => globRe(x).test(ref)),
        ref,
      ).toBe(want);
    }
  });
});

describe("the job's file", () => {
  test("GitHub: branches and tags of every rule, pre-releases left out, --for-ref", () => {
    const y = githubYaml(plan());
    expect(y.startsWith("# Written by lf ci init")).toBe(true);
    expect(y).toContain(`branches: ["develop", "main", "release/*"]`);
    expect(y).toContain(`tags: ["v*", "!**[0-9]+.[0-9]+.[0-9]+-**"]`);
    expect(y).toContain(`deploy --for-ref "$GITHUB_REF" -y`);
    expect(y).toContain("${{ secrets.LANDFALL_SSH_KEY }}");
    expect(y).toContain("Host web\n");
    expect(y).toContain("StrictHostKeyChecking yes");
    expect(y).not.toContain("working-directory");
  });

  test("GitHub: a prerelease rule keeps pre-releases; a subfolder runs there; no rules deploy the branch", () => {
    const pre = plan();
    pre.targets[2].prerelease = true;
    expect(githubYaml(pre)).toContain(`tags: ["v*"]\n`);
    expect(githubYaml(plan({ prefix: "apps/web" }))).toContain(`working-directory: "apps/web"`);
    const fb = githubYaml(plan({ fallbackBranch: "feat", targets: [{ env: "", server: "web", branches: ["feat"], tags: [], prerelease: false }] }));
    expect(fb).toContain(`branches: ["feat"]`);
    expect(fb).not.toContain("tags:");
    expect(fb).not.toContain("--for-ref");
  });

  test("GitLab: rules with regexes, pre-releases first as never, the ref rebuilt", () => {
    const y = gitlabYaml(plan({ forge: "gitlab", cli: "glab", file: ".gitlab-ci.yml" }));
    const never = y.indexOf("when: never");
    expect(never).toBeGreaterThan(0);
    expect(never).toBeLessThan(y.indexOf("$CI_COMMIT_BRANCH =~"));
    expect(y).toContain("$CI_COMMIT_TAG =~ /^(?:v[^\\/]*)$/");
    expect(y).toContain(`REF="refs/tags/$CI_COMMIT_TAG"`);
    expect(y).toContain(`deploy --for-ref "$REF" -y`);
    // The script block is shell: it parses.
    const script = y.slice(y.indexOf("    - |\n") + 8).replace(/^ {6}/gm, "");
    parses(script);
  });
});

describe("the server's side", () => {
  test("ciKeyScript parses, journals each key, carries no key itself", () => {
    const s = ciKeyScript();
    parses(s);
    expect(s).toMatch(/record "authorized key \$MARK/);
    expect(s).toMatch(/record "removed the CI key \$MARK/);
    expect(s).toContain("@@hostkeys");
    expect(s).not.toMatch(/BEGIN OPENSSH|ssh-ed25519 AAAA/);
  });

  test("knownHosts: one line per host key, [host]:port off 22", () => {
    const out = "noise\n@@hostkeys\nssh-ed25519 AAAAC3 root@x\necdsa-sha2-nistp256 AAAAE2 root@x\nnot a key\n";
    expect(knownHosts({ name: "web", hostname: "h.example", user: "d", port: 22 }, out)).toEqual([
      "h.example ssh-ed25519 AAAAC3",
      "h.example ecdsa-sha2-nistp256 AAAAE2",
    ]);
    expect(knownHosts({ name: "web", hostname: "h.example", user: "d", port: 2222 }, out)[0]).toBe("[h.example]:2222 ssh-ed25519 AAAAC3");
    expect(knownHosts({ name: "web", hostname: "h", user: "d", port: 22 }, "@@hostkeys\n")).toEqual([]);
  });
});

describe("ciPlan", () => {
  function repo(project: object, origin = "git@github.com:acme/shop.git") {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-ci-repo-"));
    dirs.push(dir);
    g(dir, "init", "-q", "-b", "main");
    g(dir, "remote", "add", "origin", origin);
    fs.writeFileSync(path.join(dir, ".landfall.json"), JSON.stringify(project));
    g(dir, "add", "-A");
    g(dir, "commit", "-qm", "one");
    return dir;
  }

  test("the rules' environments, the server's login, no local keys in the job's config", async () => {
    const dir = repo({ name: "shop", server: "web", environments: { test: { git: { branch: "main" } }, prod: { git: { tag: "v*" } } } });
    const p = await ciPlan(dir);
    expect(p).toMatchObject({ forge: "github", repo: "acme/shop", file: ".github/workflows/landfall.yml", exists: false, keyComment: "landfall ci acme/shop" });
    expect(p.targets.map((t) => [t.env, t.branches, t.tags])).toEqual([
      ["test", ["main"], []],
      ["prod", [], ["v*"]],
    ]);
    expect(p.servers).toEqual([{ name: "web", hostname: "203.0.113.10", user: "deploy", port: 2222 }]);
    expect(JSON.stringify(p.config)).not.toMatch(/secret|203\.0\.113\.10|deploy/);
    expect(p.untracked).toBeUndefined();
  });

  test("GitLab with someone else's .gitlab-ci.yml: a file of its own and an include", async () => {
    const dir = repo({ name: "app", server: "web" }, "git@gitlab.example.com:g/sub/app.git");
    fs.writeFileSync(path.join(dir, ".gitlab-ci.yml"), "build: {}\n");
    const p = await ciPlan(dir);
    expect(p).toMatchObject({ forge: "gitlab", repo: "gitlab.example.com/g/sub/app", file: ".gitlab/landfall.yml", fallbackBranch: "main" });
    expect(p.include).toContain("local: .gitlab/landfall.yml");
  });

  test("refuses -E", async () => {
    const dir = repo({ name: "shop", server: "web" });
    process.env.LANDFALL_ENV = "prod";
    await expect(ciPlan(dir)).rejects.toThrow(/drop -E/);
    delete process.env.LANDFALL_ENV;
  });
});
