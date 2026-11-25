// What a deploy sends: the working tree, a clean export of a commit (--ref, --tag, --for-ref), or a commit the
// server fetches itself (--git). Checks the environment's git rule on the way.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import type { ReleaseGit } from "../site/meta";
import { activeEnvironment, gitRules, loadProject, PROJECT_FILE, type ProjectConfig, type Server } from "../lib/config";
import { ciRun, exportRef, installCommand, listRefs, releaseGit, repoInfo, resolveRef, safeRemote, type Resolved } from "./git";
import type { Entry } from "./ignore";
import { onStop } from "../lib/job";
import { ensureTools } from "../ssh/privilege";
import { allows, envsForRef, hasRule, latestTag, list, namesAt, newestTag, parseRefName, ruleText, type Ref, type RefRule } from "./refs";
import { archiveCmd, fetchScript, parseFetched, parseGitUrl, repoName, unpackScript, type GitUrl } from "./remote-git";
import { runScript, sshPipe, upload, type Sent } from "../ssh/ssh";
import { c, fail, info, step, warn } from "../lib/term";

export type SourceOpts = { ref?: string; tag?: string; "for-ref"?: string; git?: string; force?: boolean };

/** The server a deploy goes to, connected (and set up) once, when first asked: only --git needs it this early. */
export type Connect = () => Promise<{ server: Server; serverName: string }>;

export interface DeploySource {
  /** The folder to deploy from: the working tree, or a clean copy of a commit. */
  dir: string;
  git?: ReleaseGit;
  /** --git without a .landfall.json here: the commit's. */
  project?: Partial<ProjectConfig>;
  /** --git: the repository's name, for a site that is given none. */
  name?: string;
  /** Before a local hook or build: a clean copy installs its dependencies, once. */
  prepare(): void;
  /** send unpacks the files from the server's mirror: nothing was built or changed here. */
  fromServer(): boolean;
  /** Sends the release's files to the server: uploaded from here, or (--git, nothing built here) unpacked from the server's mirror. */
  send(s: Server, localDir: string, remoteDir: string, files: Entry[], seed?: string): Promise<Sent | "git">;
}

const envFlag = (env: string) => (env ? ` -E ${env}` : "");

/**
 * --for-ref: the environment whose git rule matches the ref, set as the active one. CI hands over
 * refs/heads/main or refs/tags/v1.2.0 and leaves picking the environment to the rules.
 */
export function pickEnvironmentForRef(cwd: string, ref: string) {
  if (activeEnvironment()) fail("--for-ref picks the environment from the git rules: drop -E (and LANDFALL_ENV)");
  const rules = gitRules(cwd);
  if (!Object.values(rules).some(hasRule)) fail(`--for-ref needs git rules in ${PROJECT_FILE}: lf git track -E <env> --branch <glob> or --tag <glob>`);
  const { name, kind } = parseRefName(ref);
  const refs = kind
    ? [{ name, kind }]
    : [
        { name, kind: "branch" as const },
        { name, kind: "tag" as const },
      ];
  const envs = envsForRef(rules, refs);
  if (!envs.length) fail(`no environment deploys ${ref}: ${rulesLine(rules)}`);
  if (envs.length > 1) fail(`${ref} matches the rules of ${envs.map((e) => e || "the project").join(" and ")}: make the rules not overlap, or deploy with -E`);
  // The -E mechanism (cli.ts sets it the same way): loadProject and the deploy read the active environment from it.
  if (envs[0]) process.env.LANDFALL_ENV = envs[0];
  info(c.dim(`${ref} deploys to ${envs[0] || "the project"} (${ruleText(rules[envs[0]])})`));
}

const rulesLine = (rules: Record<string, RefRule | undefined>) =>
  Object.entries(rules)
    .filter(([, r]) => hasRule(r))
    .map(([e, r]) => `${e || "the project"} deploys ${ruleText(r)}`)
    .join("; ");

/** Refuses a commit the rule does not allow; --force deploys it anyway, -y never does. */
function checkRule(rule: RefRule | undefined, names: { name: string; kind: Ref["kind"] }[], what: string, environment: string, force?: boolean) {
  if (!hasRule(rule) || allows(rule, names)) return;
  const where = environment ? `environment ${environment}` : "the project";
  const hint = list(rule.tag).length
    ? `deploy a tag: lf deploy${envFlag(environment)} --tag latest`
    : `deploy one: lf deploy${envFlag(environment)} --ref ${list(rule.branch)[0].replace(/\*.*$/, "") || "<branch>"}`;
  if (!force) fail(`${where} deploys ${ruleText(rule)}; ${what} is not one. ${hint} (--force deploys it anyway)`);
  warn(`${what} is not what ${where} deploys (${ruleText(rule)}): deploying anyway (--force)`);
}

/** A temp folder for a clean copy, removed when the run ends or is stopped. */
function tempDir(): string {
  const tmp = fs.mkdtempSync(join(tmpdir(), "lf-src-"));
  const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
  const off = onStop(async () => cleanup());
  process.once("exit", () => {
    off();
    cleanup();
  });
  return tmp;
}

/** Installs a clean copy's dependencies once, before the first local hook or build needs them. */
function installer(dir: string, what: () => string) {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const cmd = installCommand(dir);
    if (!cmd) return;
    step(`installing the export's dependencies: ${cmd}`);
    const r = spawnSync(cmd, { cwd: dir, shell: true, stdio: ["ignore", 2, 2] });
    if (r.status !== 0) fail(`${cmd} failed (exit ${r.status}) in the export of ${what()}`);
  };
}

const uploadTo: DeploySource["send"] = (s, localDir, remoteDir, files, seed) => upload(s, localDir, remoteDir, files, seed);

/** What deploySource checks the asked-for commit against, and how it names it. */
const askedFor = (o: SourceOpts) => o.tag ?? o.ref ?? o["for-ref"];

/**
 * What a deploy sends: the working tree, as always, or with --ref/--tag/--for-ref a commit, or with --git a commit
 * the server fetches. Checks the environment's git rule when it has one; --force deploys anyway, -y never does.
 */
export async function deploySource(cwd: string, project: Partial<ProjectConfig>, environment: string, o: SourceOpts, connect: Connect): Promise<DeploySource> {
  const given = (["ref", "tag", "for-ref"] as const).filter((k) => o[k]);
  if (given.length > 1) fail(`--${given.join(" and --")} exclude each other`);
  if (o.git) return serverSource(cwd, project, environment, o, connect);
  const rule = project.git;
  const repo = await repoInfo(cwd);
  const ci = ciRun();
  const where = environment ? `environment ${environment}` : "the project";
  const tree = { prepare() {}, fromServer: () => false, send: uploadTo };
  if (!repo) {
    if (given.length) fail(`--${given[0]} needs a git checkout: ${cwd} is not in one`);
    if (hasRule(rule)) {
      if (!o.force) fail(`${where} deploys ${ruleText(rule)}, but ${cwd} is not a git checkout (--force deploys it anyway)`);
      warn(`not a git checkout: deploying past the git rule of ${where} (--force)`);
    }
    return { dir: cwd, ...tree };
  }

  // The commit asked for, if any.
  const refs = await listRefs(cwd);
  let named: Resolved | undefined;
  if (o.tag === "latest") named = pickLatest(rule, refs);
  else if (o.tag) named = await resolveRef(cwd, `refs/tags/${o.tag}`);
  else if (o.ref ?? o["for-ref"]) named = await resolveRef(cwd, (o.ref ?? o["for-ref"])!);
  const asked = askedFor(o);
  if (asked && !named) fail(`no ${o.tag ? "tag" : "branch, tag or commit"} ${asked} here (git fetch fetches it)`);
  if (o["for-ref"] && named) {
    // CI's checkout: the ref's kind comes from the argument, not from a detached HEAD.
    const k = parseRefName(o["for-ref"]).kind;
    if (k) named.kind = k;
  }

  const sha = named?.sha ?? repo.sha;
  // CI checks out the commit it deploys: the working tree is it, no export needed.
  const exported = !!named && !(o["for-ref"] && named.sha === repo.sha);

  // Every name the commit goes by: the one asked for, the branch checked out, the branches and tags at it.
  const names = namesAt(sha, refs, [named ?? { name: repo.branch, kind: "branch" }]);
  if (hasRule(rule)) {
    checkRule(
      rule,
      names,
      named ? `${named.name} (${sha.slice(0, 12)})` : repo.branch ? `HEAD on ${repo.branch}` : `HEAD (${repo.commit})`,
      environment,
      o.force,
    );
    if (rule.requireClean && !exported && repo.dirty) {
      const msg = `${where} deploys only committed files, and ${repo.dirty} ${repo.dirty === 1 ? "file has" : "files have"} uncommitted changes`;
      if (!o.force) fail(`${msg}: commit them, or deploy the commit with --ref ${repo.branch ?? "HEAD"} (--force deploys them anyway)`);
      warn(`${msg}: deploying them anyway (--force)`);
    }
  }

  // The tag and branch it was asked as win over those found at the commit.
  const tag = named?.kind === "tag" ? named.name : newestTag(names);
  const branch = named?.kind === "branch" ? named.name : exported ? undefined : repo.branch;
  const git: ReleaseGit = {
    ...releaseGit({ ...repo, sha, commit: sha.slice(0, 12), branch, tags: tag ? [tag] : [], dirty: exported ? 0 : repo.dirty }),
    source: ci ? "ci" : exported ? "ref" : "local",
    ...(ci && { ci }),
  };
  if (!exported) return { dir: cwd, git, ...tree };

  // A clean export of the commit, at the same place in the repository as this folder.
  const tmp = tempDir();
  info(c.dim(`exporting ${named!.name} (${sha.slice(0, 12)}): a clean copy of the commit, without uncommitted or ignored files`));
  await exportRef(cwd, sha, tmp);
  // repo.prefix comes from git: a path relative to repo.root breaks on symlinked folders (/var → /private/var).
  const dir = join(tmp, repo.prefix);
  return { dir, git, prepare: installer(dir, () => git.tag ?? git.commit), fromServer: () => false, send: uploadTo };
}

/** --tag latest: the newest tag the rule allows (any version without a tag rule). */
function pickLatest(rule: RefRule | undefined, refs: Ref[]): Resolved {
  const pick = latestTag(rule, refs);
  if (!pick) return fail(`no tag matches ${list(rule?.tag).length ? ruleText(rule) : "any version"} (git fetch --tags fetches them)`);
  info(c.dim(`latest tag: ${pick.name}`));
  return { sha: pick.sha, name: pick.name, kind: "tag" };
}

/** A branch, tag or commit in a list of refs: tags first, as resolveRef. */
function findRef(refs: Ref[], ref: string, sha?: string): Resolved | undefined {
  const { name, kind } = parseRefName(ref);
  const hit = (k: Ref["kind"]) => (kind && kind !== k ? undefined : refs.find((r) => r.kind === k && r.name === name));
  const r = hit("tag") ?? hit("branch");
  if (r) return { sha: r.sha, name, kind: r.kind };
  return !kind && sha ? { sha, name } : undefined;
}

/**
 * --git <url>[#ref]: the server fetches the repository into its mirror and resolves the ref there. This machine
 * gets a copy of the commit to plan the deploy; the release's files come from the mirror unless they were built here.
 */
async function serverSource(cwd: string, project: Partial<ProjectConfig>, environment: string, o: SourceOpts, connect: Connect): Promise<DeploySource> {
  const g: GitUrl = parseGitUrl(o.git!);
  if (g.ref && (o.ref || o.tag)) fail(`--git ${o.git} names the ref already: drop --${o.ref ? "ref" : "tag"}`);
  const ref = g.ref ?? o.ref ?? o["for-ref"];
  const { server, serverName } = await connect();
  await ensureTools(server, [{ cmd: "git" }], "to fetch the repository");
  step(`fetching ${safeRemote(g.url)} on ${serverName}`);
  const { stdout } = await runScript(server, fetchScript(g, { head: !ref && !o.tag, sha: ref && /^[0-9a-f]{4,40}$/i.test(ref) ? ref : undefined }), {
    capture: true,
  });
  const f = parseFetched(stdout);

  let named: Resolved | undefined;
  if (o.tag === "latest") named = pickLatest(project.git, f.refs);
  else if (o.tag) named = findRef(f.refs, `refs/tags/${o.tag}`);
  else if (ref) named = findRef(f.refs, ref, f.sha);
  else if (f.head) named = findRef(f.refs, `refs/heads/${f.head}`);
  else fail(`${safeRemote(g.url)} names no default branch: deploy one with --git ${g.url}#<branch>`);
  if (!named) fail(`no ${o.tag ? "tag" : "branch, tag or commit"} ${o.tag ?? ref ?? f.head} in ${safeRemote(g.url)}`);
  if (o["for-ref"]) {
    const k = parseRefName(o["for-ref"]).kind;
    if (k) named!.kind = k;
  }
  const sha = named!.sha;
  info(c.dim(`${named!.name} is ${sha.slice(0, 12)}`));

  // A copy of the commit here: planning reads the compose file, the Dockerfile, package.json.
  const tmp = tempDir();
  await sshPipe(server, archiveCmd(g, sha), ["tar", "-xf", "-", "-C", tmp], "down");
  if (fs.existsSync(join(tmp, ".gitmodules")))
    fail(`${sha.slice(0, 12)} has git submodules, which landfall does not fetch: deploy a checkout of it with all submodules instead`);
  // No .landfall.json here (the web UI deploys from an empty folder): the commit's settings.
  const own = fs.existsSync(join(cwd, PROJECT_FILE)) ? undefined : loadProject(tmp, environment);
  if (own) info(c.dim(`using ${PROJECT_FILE} of ${named!.name}${environment ? `, environment ${environment}` : ""}`));
  const names = namesAt(sha, f.refs, [named!]);
  checkRule((own ?? project).git, names, `${named!.name} (${sha.slice(0, 12)})`, environment, o.force);

  const tag = named!.kind === "tag" ? named!.name : newestTag(names);
  const ci = ciRun();
  const git: ReleaseGit = {
    ...releaseGit({
      root: tmp,
      prefix: "",
      sha,
      commit: sha.slice(0, 12),
      ...(named!.kind === "branch" && { branch: named!.name }),
      tags: tag ? [tag] : [],
      dirty: 0,
      remote: safeRemote(g.url),
    }),
    source: ci ? "ci" : "server",
    ...(ci && { ci }),
  };

  // Built or changed here (a local build, a hook): those files are uploaded, as from any export.
  let touched = false;
  const install = installer(tmp, () => git.tag ?? git.commit);
  return {
    dir: tmp,
    git,
    name: repoName(g),
    ...(own && { project: own }),
    prepare() {
      touched = true;
      install();
    },
    fromServer: () => !touched,
    async send(s, localDir, remoteDir, files, seed) {
      if (touched) {
        info(c.dim("built here: uploading the files rather than unpacking them from the server's copy"));
        return upload(s, localDir, remoteDir, files, seed);
      }
      const sub = relative(tmp, localDir).split(sep).join("/");
      await runScript(s, unpackScript(g, sha, sub, remoteDir, leftOut(localDir, files)));
      return "git";
    },
  };
}

/** The files and folders under dir that the upload list leaves out (a folder once, not what is in it). */
export function leftOut(dir: string, files: Entry[]): string[] {
  const keep = new Set(files.map((e) => e.path));
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const d of fs.readdirSync(join(dir, rel), { withFileTypes: true })) {
      const path = rel ? `${rel}/${d.name}` : d.name;
      if (!keep.has(path)) out.push(path);
      else if (d.isDirectory()) walk(path);
    }
  };
  walk("");
  return out;
}
