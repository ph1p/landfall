import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";

// The shell landfall would run on the server, captured instead of sent; sshPipe "downloads" a commit with a compose.yaml.
const scripts: string[] = [];
const reply = { stdout: "" };
const uploads: string[] = [];
vi.mock("../../src/core/ssh", async (orig) => ({
  ...(await orig<typeof import("../../src/core/ssh")>()),
  runScript: async (_s: unknown, script: string) => {
    scripts.push(script);
    return { code: 0, stdout: reply.stdout, stderr: "" };
  },
  sshPipe: async (_s: unknown, remote: string, argv: string[]) => {
    scripts.push(remote);
    const dest = argv[argv.indexOf("-C") + 1];
    fs.writeFileSync(path.join(dest, "compose.yaml"), "services: {}\n");
    fs.mkdirSync(path.join(dest, "docs"));
    fs.writeFileSync(path.join(dest, "docs", "a.md"), "");
  },
  upload: async (_s: unknown, local: string) => {
    uploads.push(local);
    return "tar:no-local-rsync";
  },
}));
const { archiveCmd, fetchScript, keyRemoveScript, keyScript, parseFetched, parseGitUrl, repoId, repoName, unpackScript } =
  await import("../../src/core/remote-git");
const { deploySource, leftOut } = await import("../../src/core/source");

/** bash -n: the script parses. */
const parses = (script: string) => execFileSync("bash", ["-n"], { input: script });
const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);

beforeEach(() => {
  scripts.length = 0;
  uploads.length = 0;
});

describe("parseGitUrl", () => {
  test("the forms a deploy takes, with an optional #ref", () => {
    expect(parseGitUrl("gh:acme/shop#v1.2.0")).toEqual({ url: "git@github.com:acme/shop.git", ref: "v1.2.0", host: "github.com", path: "acme/shop" });
    expect(parseGitUrl("gl:group/sub/app")).toMatchObject({ url: "git@gitlab.com:group/sub/app.git", host: "gitlab.com", path: "group/sub/app" });
    expect(parseGitUrl("ssh://git@Git.Example.com:2222/team/app.git#main")).toMatchObject({ host: "git.example.com", path: "team/app", ref: "main" });
    expect(parseGitUrl("https://github.com/acme/shop.git")).toMatchObject({ host: "github.com", path: "acme/shop" });
    expect(parseGitUrl("/srv/git/shop.git#release/1.x")).toEqual({ url: "/srv/git/shop.git", ref: "release/1.x", path: "srv/git/shop" });
  });

  test("refuses logins, options and odd refs", () => {
    expect(() => parseGitUrl("https://user:token@github.com/acme/shop.git")).toThrow(/deploy key/);
    expect(() => parseGitUrl("--upload-pack=evil")).toThrow(/not a git URL/);
    expect(() => parseGitUrl("gh:acme/shop#-x")).toThrow(/not a branch/);
    expect(() => parseGitUrl("gh:acme/shop#a b")).toThrow();
    expect(() => parseGitUrl("shop")).toThrow(/not a git URL/);
  });

  test("ids and names", () => {
    expect(repoId(parseGitUrl("gh:Acme/Shop"))).toBe("github.com-acme-shop");
    expect(repoId(parseGitUrl("/srv/git/shop.git"))).toBe("local-srv-git-shop");
    expect(repoName(parseGitUrl("gl:group/sub/app"))).toBe("app");
  });
});

describe("server scripts", () => {
  const g = parseGitUrl("gh:acme/shop");

  test("fetch: parses, makes the mirror once and journals it, then fetches under a lock", () => {
    const s = fetchScript(g, { head: true, sha: "abc1234" });
    parses(s);
    expect(s).toContain(`record 'git mirror of git@github.com:acme/shop.git'`);
    expect(s).toContain("pkg_install git");
    expect(s.indexOf("flock")).toBeLessThan(s.indexOf("fetch -q --prune"));
    expect(s).toContain("@@head");
    expect(s).toContain(`'abc1234^{commit}'`);
    expect(s).toContain("lf git key");
  });

  test("key: made once, journaled, only the public key printed", () => {
    const s = keyScript(g, "landfall web");
    parses(s);
    expect(s).toContain("ssh-keygen -q -t ed25519");
    expect(s).toMatch(/record 'deploy key for .*' 'rm -f /);
    expect(s).toContain(`cat "$R/key.pub"`);
    expect(s).not.toMatch(/cat "\$R\/key"(\s|$)/);
    parses(keyRemoveScript(g));
    expect(keyRemoveScript(g)).toMatch(/record 'removed the deploy key[^']*'$/m);
  });

  test("unpack: the commit's folder, then what the upload leaves out removed", () => {
    const s = unpackScript(g, SHA, "web", "/opt/landfall/sites/shop/releases/1", ["node_modules", "a b"]);
    parses(s);
    expect(s).toContain(`archive --format=tar '${SHA}:web' | tar -xof - -C '/opt/landfall/sites/shop/releases/1'`);
    expect(s).toContain(`rm -rf -- './node_modules' './a b'`);
    expect(archiveCmd(g, SHA)).toBe(`git --git-dir='/opt/landfall/repos/github.com-acme-shop/mirror.git' archive --format=tar '${SHA}'`);
  });

  test("parseFetched", () => {
    const out = [
      "@@head",
      "main",
      "@@sha",
      SHA,
      "@@refs",
      `refs/heads/main\t${SHA}\t\t2026-01-01T00:00:00Z\t\tfix`,
      `refs/tags/v1.0.0\t${OTHER}\t${SHA}\t2026-01-02T00:00:00Z\trelease\t`,
    ].join("\n");
    const f = parseFetched(out);
    expect(f.head).toBe("main");
    expect(f.sha).toBe(SHA);
    expect(f.refs.map((r) => [r.kind, r.name, r.sha])).toEqual([
      ["branch", "main", SHA],
      ["tag", "v1.0.0", SHA],
    ]);
    expect(parseFetched("@@refs\n")).toEqual({ refs: [] });
  });
});

test("leftOut: what the list leaves out, a folder once", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "lf-left-"));
  fs.mkdirSync(path.join(d, "src"));
  fs.mkdirSync(path.join(d, "node_modules/x"), { recursive: true });
  for (const f of ["src/a.ts", "src/b.log", "node_modules/x/i.js", "compose.yaml"]) fs.writeFileSync(path.join(d, f), "");
  const list = ["src", "src/a.ts", "compose.yaml"].map((p) => ({ path: p, size: 0, dir: p === "src" }));
  expect(leftOut(d, list).sort()).toEqual(["node_modules", "src/b.log"]);
  fs.rmSync(d, { recursive: true });
});

describe("deploy --git", () => {
  const server = { host: "example.com" } as any;
  const connect = async () => ({ server, serverName: "web" });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "lf-empty-"));
  const fetched = (head = "main") =>
    `@@head\n${head}\n@@refs\nrefs/heads/main\t${SHA}\t\t2026-01-01T00:00:00Z\t\tfix\nrefs/tags/v1.0.0\t${OTHER}\t\t2026-01-02T00:00:00Z\t\trelease\n`;

  test("the default branch: fetched on the server, the commit copied here, sent from the mirror", async () => {
    reply.stdout = fetched();
    const s = await deploySource(cwd, {}, "", { git: "gh:acme/shop" }, connect);
    expect(s.name).toBe("shop");
    expect(s.git).toMatchObject({ sha: SHA, branch: "main", source: "server", remote: "git@github.com:acme/shop.git" });
    expect(fs.existsSync(path.join(s.dir, "compose.yaml"))).toBe(true);
    expect(scripts[0]).toContain("@@head");
    expect(scripts[1]).toContain(`archive --format=tar '${SHA}'`);
    expect(s.fromServer()).toBe(true);
    scripts.length = 0;
    expect(await s.send(server, s.dir, "/r/1", [{ path: "compose.yaml", size: 1, dir: false }])).toBe("git");
    expect(scripts[0]).toContain(`'./docs'`);
    expect(uploads).toEqual([]);
  });

  test("a tag by #ref; a local build uploads instead", async () => {
    reply.stdout = fetched();
    const s = await deploySource(cwd, {}, "", { git: "gh:acme/shop#v1.0.0" }, connect);
    expect(s.git).toMatchObject({ sha: OTHER, tag: "v1.0.0" });
    s.prepare();
    expect(s.fromServer()).toBe(false);
    await s.send(server, s.dir, "/r/1", []);
    expect(uploads).toEqual([s.dir]);
  });

  test("the rule is checked on the server's refs; #ref and --ref exclude each other", async () => {
    reply.stdout = fetched();
    await expect(deploySource(cwd, { git: { tag: "v*" } }, "prod", { git: "gh:acme/shop#main" }, connect)).rejects.toThrow(/tags v\*.*--force/);
    expect((await deploySource(cwd, { git: { tag: "v*" } }, "prod", { git: "gh:acme/shop", tag: "latest" }, connect)).git?.tag).toBe("v1.0.0");
    await expect(deploySource(cwd, {}, "", { git: "gh:acme/shop#main", ref: "dev" }, connect)).rejects.toThrow(/drop --ref/);
    await expect(deploySource(cwd, {}, "", { git: "gh:acme/shop#nope" }, connect)).rejects.toThrow(/no branch, tag or commit nope/);
  });
});
