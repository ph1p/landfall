import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineCommand } from "../cmd";
import { activeEnvironment, ENV_NAME, gitRules, loadProject, PROJECT_FILE, saveGitRule, type ProjectConfig } from "../../core/config";
import type { ReleaseGit } from "../../core/compose";
import { ciRun, exportRef, listRefs, releaseGit, repoInfo, resolveRef } from "../../core/git";
import { onStop } from "../../core/job";
import {
  allows,
  envsForRef,
  hasRule,
  latestTag,
  list,
  namesAt,
  newestTag,
  one,
  parseRefName,
  ruleText,
  sameRule,
  type RefKind,
  type RefRule,
} from "../../core/refs";
import { c, fail, info, printJson, table, warn } from "../../core/term";

export interface DeploySource {
  /** The folder to deploy from: the working tree, or a clean export of a commit. */
  dir: string;
  git?: ReleaseGit;
  /** A clean export: its dependencies are installed before a local build. */
  exported: boolean;
}

type SourceOpts = { ref?: string; tag?: string; "for-ref"?: string; force?: boolean };

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

/**
 * What a deploy sends: the working tree, as always, or with --ref/--tag/--for-ref a commit. Checks the
 * environment's git rule when it has one; --force deploys anyway, -y never does.
 */
export async function deploySource(cwd: string, project: Partial<ProjectConfig>, environment: string, o: SourceOpts): Promise<DeploySource> {
  const given = (["ref", "tag", "for-ref"] as const).filter((k) => o[k]);
  if (given.length > 1) fail(`--${given.join(" and --")} exclude each other`);
  const rule = project.git;
  const repo = await repoInfo(cwd);
  const ci = ciRun();
  const where = environment ? `environment ${environment}` : "the project";
  if (!repo) {
    if (given.length) fail(`--${given[0]} needs a git checkout: ${cwd} is not in one`);
    if (hasRule(rule)) {
      if (!o.force) fail(`${where} deploys ${ruleText(rule)}, but ${cwd} is not a git checkout (--force deploys it anyway)`);
      warn(`not a git checkout: deploying past the git rule of ${where} (--force)`);
    }
    return { dir: cwd, exported: false };
  }

  // The commit asked for, if any.
  const refs = await listRefs(cwd);
  let named: { sha: string; name: string; kind?: RefKind } | undefined;
  if (o.tag === "latest") {
    const pick = latestTag(rule, refs);
    if (!pick) return fail(`no tag here matches ${list(rule?.tag).length ? ruleText(rule) : "any version"} (git fetch --tags fetches them)`);
    named = { sha: pick.sha, name: pick.name, kind: "tag" };
    info(c.dim(`latest tag: ${pick.name}`));
  } else if (o.tag) named = await resolveRef(cwd, `refs/tags/${o.tag}`);
  else if (o.ref ?? o["for-ref"]) named = await resolveRef(cwd, (o.ref ?? o["for-ref"])!);
  const asked = o.tag ?? o.ref ?? o["for-ref"];
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
    const what = named ? `${named.name} (${sha.slice(0, 12)})` : repo.branch ? `HEAD on ${repo.branch}` : `HEAD (${repo.commit})`;
    if (!allows(rule, names)) {
      const hint = list(rule.tag).length
        ? `deploy a tag: lf deploy${envFlag(environment)} --tag latest`
        : `deploy one: lf deploy${envFlag(environment)} --ref ${list(rule.branch)[0].replace(/\*.*$/, "") || "<branch>"}`;
      if (!o.force) fail(`${where} deploys ${ruleText(rule)}; ${what} is not one. ${hint} (--force deploys it anyway)`);
      warn(`${what} is not what ${where} deploys (${ruleText(rule)}): deploying anyway (--force)`);
    }
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
  if (!exported) return { dir: cwd, exported: false, git };

  // A clean export of the commit, at the same place in the repository as this folder.
  const tmp = fs.mkdtempSync(join(tmpdir(), "lf-src-"));
  const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
  const off = onStop(async () => cleanup());
  process.once("exit", () => {
    off();
    cleanup();
  });
  info(c.dim(`exporting ${named!.name} (${sha.slice(0, 12)}): a clean copy of the commit, without uncommitted or ignored files`));
  await exportRef(cwd, sha, tmp);
  // repo.prefix comes from git: a path relative to repo.root breaks on symlinked folders (/var → /private/var).
  return { dir: join(tmp, repo.prefix), exported: true, git };
}

export const gitTrack = defineCommand({
  name: "git track",
  summary: `Say which git refs an environment deploys, in ${PROJECT_FILE}.

  lf git track -E prod --tag 'v*'                 # prod deploys tags v1.2.0, v2.0.0 …
  lf git track -E test --branch main --branch 'release/*'
  lf git track -E dev --branch develop
  lf git track                                    # every environment's rule
  lf git track -E prod --off                      # prod deploys anything again

Globs: * stays within a /, ** crosses it. A deploy of something else is refused;
--force deploys it anyway. Environments without a rule deploy anything. Nothing
changes on a server.`,
  options: {
    branch: { type: "string", multiple: true, desc: "a branch glob this environment deploys" },
    tag: { type: "string", multiple: true, desc: "a tag glob this environment deploys (deploy --tag latest picks the newest)" },
    prerelease: { type: "boolean", desc: "tags with a pre-release suffix (v1.2.0-rc.1) match too" },
    "require-clean": { type: "boolean", desc: "refuse to deploy a working tree with uncommitted changes" },
    url: { type: "string", desc: "the repository's URL (default: origin's)" },
    off: { type: "boolean", desc: "drop the rule: the environment deploys anything" },
    json: { type: "boolean", desc: "print the rules as JSON" },
  },
  async run(_pos, o) {
    const cwd = process.cwd();
    const env = activeEnvironment();
    if (env && !ENV_NAME.test(env)) fail(`"${env}" cannot name an environment`);
    const setting = o.branch?.length || o.tag?.length || o.off || o.prerelease !== undefined || o["require-clean"] !== undefined || o.url;
    if (setting) {
      if (o.off && (o.branch?.length || o.tag?.length)) fail("--off drops the rule: give it without --branch and --tag");
      const before = env ? loadProject(cwd)?.git : gitRules(cwd)[""];
      const rule: RefRule | undefined = o.off
        ? undefined
        : {
            // A new --branch or --tag replaces the globs; without either, the old ones stay.
            ...((o.branch?.length || (!o.tag?.length && before?.branch)) && { branch: o.branch?.length ? one(o.branch) : before!.branch }),
            ...((o.tag?.length || (!o.branch?.length && before?.tag)) && { tag: o.tag?.length ? one(o.tag) : before!.tag }),
            ...((o.prerelease ?? before?.prerelease) && { prerelease: true }),
            ...((o["require-clean"] ?? before?.requireClean) && { requireClean: true }),
          };
      if (rule && !hasRule(rule)) fail("say what it deploys: --branch <glob> or --tag <glob>");
      const known = loadProject(cwd, "")?.git?.url;
      const url = o.url ?? (!known ? (await repoInfo(cwd))?.remote : undefined);
      const where = env ? `environment ${env}` : "the project";
      if (sameRule(before, rule) && (!url || url === known)) info(`nothing changed: ${where} deploys ${rule ? ruleText(rule) : "anything"}`);
      else {
        saveGitRule(cwd, env, rule, url);
        info(rule ? `${where} deploys ${ruleText(rule)}` : `${where} deploys anything`);
      }
    }
    const rules = gitRules(cwd);
    const rows = Object.entries(rules).filter(([, r]) => hasRule(r));
    if (o.json) return printJson({ url: loadProject(cwd, "")?.git?.url ?? null, rules: Object.fromEntries(rows) });
    if (setting) return;
    if (!rows.length) return info(`no git rules: every environment deploys anything (lf git track -E <env> --branch <glob> sets one)`);
    table([["environment", "deploys"].map(c.dim), ...rows.map(([e, r]) => [e || c.dim("(project)"), ruleText(r)])]);
  },
});
