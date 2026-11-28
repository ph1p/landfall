import { defineCommand, runWith } from "../cmd";
import { activeEnvironment, gitRules, PROJECT_FILE } from "../../core/lib/config";
import { ago } from "../../core/lib/ago";
import { listRefs, resolveRef } from "../../core/deploy/git";
import { allows, gitParts, namesAt, newestTag, ruleText } from "../../core/deploy/refs";
import { c, confirm, fail, info, printJson, table, warn } from "../../core/lib/term";
import { refsView, type EnvRefs } from "../../core/views/views";
import { deploy } from "./deploy";

const envName = (e: string) => e || "(project)";

/** What runs in an environment, in a few words: v1.4.2 (abc123def456), CI, 2 hours ago. */
function runningText(e: EnvRefs): string {
  if (e.error) return c.red("unreachable");
  if (e.running === undefined) return c.dim("never deployed");
  if (e.running === null) return c.dim("no release");
  const g = e.running.git;
  if (!g) return `${e.running.id} ${c.dim("(not from git)")}`;
  const p = gitParts(g);
  return `${p.name}${p.beside ? c.dim(` ${p.beside}`) : ""}${p.dirty ? c.yellow(" dirty") : ""}${p.source ? c.dim(`, ${p.source}`) : ""}${c.dim(`, ${ago(e.running.at)}`)}`;
}

export const refs = defineCommand({
  name: "refs",
  tenant: true,
  summary: `Show what each environment deploys (its git rule), what runs there, and what is newer.

  lf refs              # every environment of the project
  lf refs -E prod      # one
  lf refs --json       # for scripts and the web UI

Read-only: reads this checkout's branches and tags (git fetch --tags first for the
newest) and each environment's server.`,
  options: { json: { type: "boolean", desc: "print the view as JSON" } },
  async run(_pos, o) {
    const cwd = process.cwd();
    const env = activeEnvironment();
    const view = await refsView(cwd, env || undefined);
    if (o.json) return printJson(view);
    if (!view.envs.some((e) => e.rule) && !env)
      info(c.dim(`no git rules in ${PROJECT_FILE}: every environment deploys anything (lf git track -E <env> --branch <glob> sets one)`));
    table([
      ["environment", "deploys", "running", "newest"].map(c.dim),
      ...view.envs.map((e) => [
        envName(e.env),
        e.ruleText,
        runningText(e),
        e.newest ? `${e.newest.name}${e.behind ? c.yellow(` (${e.behind} new)`) : e.behind === 0 ? c.green(" (running)") : ""}` : c.dim("-"),
      ]),
    ]);
    for (const e of view.envs.filter((x) => x.error)) warn(`${envName(e.env)}: ${e.error}`);
  },
});

export const promote = defineCommand({
  name: "promote",
  tenant: true,
  args: "<from-env> <to-env>",
  summary: `Deploy the commit that runs in one environment to another: test → prod.

  lf promote test prod

Reads the commit live in <from-env>, checks it against <to-env>'s git rule (a tag
rule needs a matching tag on that commit), asks, then deploys a clean export of it
(lf deploy -E <to-env> --ref <commit>). --force deploys past the rule.`,
  options: {
    force: { type: "boolean", desc: "deploy even when <to-env>'s git rule does not allow the commit" },
  },
  async run([from, to], o) {
    if (!from || !to) fail("usage: lf promote <from-env> <to-env>");
    if (from === to) fail("promote from one environment to another");
    if (activeEnvironment()) fail("promote names both environments: drop -E (and LANDFALL_ENV)");
    const cwd = process.cwd();
    const rules = gitRules(cwd);
    for (const e of [from, to]) if (!(e in rules)) fail(`no environment ${e} in ${PROJECT_FILE}`);
    const [source] = (await refsView(cwd, from)).envs;
    if (source.error) fail(`could not read ${from}: ${source.error}`);
    const g = source.running?.git;
    if (!g) fail(`${from} runs ${source.running ? "a release not deployed from git" : "nothing"}: nothing to promote`);
    const sha = g!.sha ?? (await resolveRef(cwd, g!.commit))?.sha;
    if (!sha) fail(`commit ${g!.commit} of ${from} is not in this checkout (git fetch fetches it)`);
    // The names it goes by: the branch and tag it was deployed as, and those pointing at it.
    const names = namesAt(sha!, await listRefs(cwd), [
      { name: g!.tag, kind: "tag" },
      { name: g!.branch, kind: "branch" },
    ]);
    // The tag it ran as, else the newest at the commit: tagged after the deploy to test, as a release usually is.
    const tag = g!.tag ?? newestTag(names);
    const what = `${tag ? `${tag} ` : ""}(${sha!.slice(0, 12)})`;
    const rule = rules[to];
    if (!allows(rule, names)) {
      if (!o.force)
        fail(
          `${to} deploys ${ruleText(rule)}; ${what} is not one${rule?.tag ? `: tag it first (git tag <version> ${sha!.slice(0, 12)})` : ""} (--force promotes it anyway)`,
        );
      warn(`${what} is not what ${to} deploys (${ruleText(rule)}): promoting anyway (--force)`);
    }
    if (!(await confirm(`Promote ${what} ${from} → ${to}?`))) fail("cancelled");
    // The -E mechanism (cli.ts sets it the same way): the deploy below reads the active environment from it.
    process.env.LANDFALL_ENV = to;
    // The tag names the export, so the release and the rule check see it.
    const ref = tag && (await resolveRef(cwd, `refs/tags/${tag}`))?.sha === sha ? `refs/tags/${tag}` : sha!;
    return runWith(deploy, [], { ref, force: o.force });
  },
});
