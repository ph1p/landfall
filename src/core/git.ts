// git on this machine: what a checkout is at, its refs, and a clean copy of a commit. Never through a shell.
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Release } from "./compose";
import { fail } from "./fail";
import { newestTag, parseRefName, type Ref, type RefKind } from "./refs";

/** git's stdout, trimmed; undefined when git fails or is missing. Async: the web UI's server reads through it. */
export function git(cwd: string, ...args: string[]): Promise<string | undefined> {
  return new Promise((resolve) =>
    execFile("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => resolve(err ? undefined : stdout.trim())),
  );
}

/** A remote URL without the user's password or token (https://user:token@host/…). */
/** Whether a folder is in a git checkout, from the files alone: no git runs. A .git folder, or a worktree's .git file. */
export function inCheckout(dir: string): boolean {
  for (let d = dir; ; d = dirname(d)) {
    if (fs.existsSync(join(d, ".git"))) return true;
    if (dirname(d) === d) return false;
  }
}

export const safeRemote = (url: string | undefined) => url?.replace(/^(https?:\/\/)[^@/]+@/, "$1") || undefined;

export interface RepoInfo {
  root: string;
  /** This folder's place in the repository: "" at the top, else "sub/dir/". */
  prefix: string;
  sha: string;
  commit: string;
  branch?: string;
  /** Tags at HEAD. */
  tags: string[];
  /** Files with uncommitted changes (untracked ones left out). */
  dirty: number;
  remote?: string;
  subject?: string;
}

/** The checkout a folder is in, if it is in one with a commit. Four git calls at once: it runs on every deploy and UI read. */
export async function repoInfo(cwd: string): Promise<RepoInfo | undefined> {
  const [head, top, status = "", remote] = await Promise.all([
    // %D: "HEAD -> main, tag: v1.2.0, origin/main" (ref names hold no ", ").
    git(cwd, "log", "-1", "--decorate=short", "--format=%H%x00%D%x00%s"),
    git(cwd, "rev-parse", "--show-toplevel", "--show-prefix"),
    git(cwd, "status", "--porcelain", "--untracked-files=no"),
    git(cwd, "remote", "get-url", "origin"),
  ]);
  if (!head) return undefined;
  const [sha, deco, subject] = head.split("\0");
  const names = deco ? deco.split(", ") : [];
  const [root, prefix = ""] = (top ?? cwd).split("\n");
  return {
    root,
    prefix,
    sha,
    commit: sha.slice(0, 12),
    branch: names.find((n) => n.startsWith("HEAD -> "))?.slice(8),
    tags: names.filter((n) => n.startsWith("tag: ")).map((n) => n.slice(5)),
    dirty: status ? status.split("\n").length : 0,
    remote: safeRemote(remote),
    subject: subject || undefined,
  };
}

/** What a release from this working tree records: its commit, branch, tag, remote and uncommitted changes. */
export function releaseGit(r: RepoInfo): NonNullable<Release["git"]> {
  const tag = newestTag(r.tags.map((name) => ({ name, kind: "tag" as const })));
  return {
    commit: r.commit,
    sha: r.sha,
    ...(r.branch && { branch: r.branch }),
    ...(tag && { tag }),
    ...(r.dirty > 0 && { dirty: true }),
    ...(r.remote && { remote: r.remote }),
  };
}

/** The CI run deploying, from the variables GitHub Actions and GitLab CI set. */
export function ciRun(env = process.env): { provider: "github" | "gitlab"; url?: string } | undefined {
  if (env.GITHUB_ACTIONS === "true") {
    const url =
      env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
        ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
        : undefined;
    return { provider: "github", ...(url && { url }) };
  }
  if (env.GITLAB_CI === "true") return { provider: "gitlab", ...(env.CI_JOB_URL && { url: env.CI_JOB_URL }) };
  return undefined;
}

export interface Resolved {
  sha: string;
  /** The ref's name as given, without refs/heads/ or refs/tags/. */
  name: string;
  /** Branch or tag; undefined for a commit. */
  kind?: RefKind;
}

/** A tag, a branch (local, then origin's), or a commit: the commit it names. */
export async function resolveRef(cwd: string, ref: string): Promise<Resolved | undefined> {
  const { name, kind } = parseRefName(ref);
  if (!name || name.startsWith("-")) return undefined;
  const at = (r: string) => git(cwd, "rev-parse", "--verify", "-q", `${r}^{commit}`);
  const tries: [string, RefKind | undefined][] = [];
  if (kind !== "branch") tries.push([`refs/tags/${name}`, "tag"]);
  if (kind !== "tag") tries.push([`refs/heads/${name}`, "branch"], [`refs/remotes/origin/${name}`, "branch"]);
  if (!kind) tries.push([name, undefined]);
  for (const [r, k] of tries) {
    const sha = await at(r);
    if (sha) return { sha, name, ...(k && { kind: k }) };
  }
  return undefined;
}

/** What git for-each-ref prints per ref: parseRefLines reads it. The server's mirror is read with it too. */
export const REF_FORMAT = "%(refname)%09%(objectname)%09%(*objectname)%09%(creatordate:iso-strict)%09%(*subject)%09%(subject)";

/** Branches and tags (local and origin's) as refs, tags peeled to their commit. */
export async function listRefs(cwd: string): Promise<Ref[]> {
  return parseRefLines(await git(cwd, "for-each-ref", `--format=${REF_FORMAT}`, "refs/heads", "refs/tags", "refs/remotes/origin"));
}

/** for-each-ref lines in REF_FORMAT as refs. A local branch wins over origin's of the same name. */
export function parseRefLines(out: string | undefined): Ref[] {
  const refs = new Map<string, Ref>();
  for (const line of (out ?? "").split("\n").filter(Boolean)) {
    const [full, obj, peeled, date, tagSubject, subject] = line.split("\t");
    if (full === "refs/remotes/origin/HEAD") continue;
    const { name, kind } = parseRefName(full);
    if (!kind) continue;
    const key = `${kind}:${name}`;
    if (full.startsWith("refs/remotes/") && refs.has(key)) continue;
    refs.set(key, { name, kind, sha: peeled || obj, ...(date && { date }), ...((tagSubject || subject) && { subject: tagSubject || subject }) });
  }
  return [...refs.values()];
}

/** A commit's files, as committed, into dest: nothing uncommitted, nothing ignored. */
export async function exportRef(cwd: string, sha: string, dest: string) {
  if ((await git(cwd, "cat-file", "-e", `${sha}:.gitmodules`)) !== undefined)
    fail(`${sha.slice(0, 12)} has git submodules, which a clean export leaves out: deploy the working tree instead (without --ref/--tag)`);
  const tar = join(fs.mkdtempSync(join(tmpdir(), "lf-archive-")), "src.tar");
  try {
    const a = spawnSync("git", ["-C", cwd, "archive", "--format=tar", "-o", tar, sha], { encoding: "utf8" });
    if (a.status !== 0) fail(`git archive ${sha.slice(0, 12)} failed: ${a.stderr?.trim() || `exit ${a.status}`}`);
    fs.mkdirSync(dest, { recursive: true });
    const x = spawnSync("tar", ["-xf", tar, "-C", dest], { encoding: "utf8" });
    if (x.status !== 0) fail(`unpacking ${sha.slice(0, 12)} failed: ${x.stderr?.trim() || `exit ${x.status}`}`);
  } finally {
    fs.rmSync(join(tar, ".."), { recursive: true, force: true });
  }
}

/** The install that a clean export needs before a local build, picked by the lockfile. */
export function installCommand(dir: string): string | undefined {
  const has = (f: string) => fs.existsSync(join(dir, f));
  if (!has("package.json")) return undefined;
  if (has("pnpm-lock.yaml")) return "pnpm install --frozen-lockfile";
  if (has("yarn.lock")) return "yarn install --frozen-lockfile";
  if (has("bun.lock") || has("bun.lockb")) return "bun install --frozen-lockfile";
  if (has("package-lock.json")) return "npm ci";
  return "npm install";
}
