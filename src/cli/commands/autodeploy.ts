import { posix } from "node:path";
import { defineCommand, serverOpt } from "../cmd";
import { activeEnvironment, loadProject, projectServer } from "../../core/lib/config";
import { ago } from "../../core/lib/ago";
import {
  autodeployBlocker,
  autodeployLog,
  autodeployNowScript,
  NOW_NO_SITE,
  readAutodeploy,
  setAutodeploy,
  type AutodeployView,
} from "../../core/deploy/autodeploy";
import { currentRelease, type AutodeploySetting } from "../../core/site/compose";
import { repoInfo, safeRemote } from "../../core/deploy/git";
import { list, ruleText, type RefRule } from "../../core/deploy/refs";
import { parseGitUrl } from "../../core/deploy/remote-git";
import { noSite } from "../../core/site/remote";
import { runScript } from "../../core/ssh/ssh";
import { c, fail, info, ok, printJson, table, warn } from "../../core/lib/term";

/** What the site follows: the environment's rule, the one it has, or the branch its release came from. */
function followRule(
  o: { branch?: string[]; tag?: string[]; prerelease?: boolean },
  rule: RefRule | undefined,
  had: AutodeploySetting["rule"] | undefined,
  branch?: string,
) {
  const r = o.branch?.length || o.tag?.length ? { branch: o.branch, tag: o.tag } : (rule ?? had);
  const branches = list(r?.branch);
  const tags = list(r?.tag);
  if (branches.length && tags.length) fail(`auto-deploy follows branches or tags, not both (${ruleText(r)}): pass --branch or --tag`);
  if (tags.length) return { tag: tags, ...((o.prerelease ?? r?.prerelease) && { prerelease: true }) };
  if (branches.length) return { branch: branches };
  if (branch) return { branch: [branch] };
  return fail("which branch or tags? the release was not deployed from a branch: pass --branch <glob> or --tag <glob>, or set a rule with lf git track");
}

function show(v: AutodeployView) {
  if (!v.enabled) {
    info(`${v.site} does not deploy itself (--every 5m turns it on)`);
    if (v.cron) warn(`the crontab still has a line for it: ${v.cron}`);
    return;
  }
  table([
    [c.dim("site"), `${v.site} on ${v.server}`],
    [c.dim("follows"), `${ruleText(v.rule)} of ${v.url}${v.dir ? ` (${v.dir})` : ""}`],
    [c.dim("every"), v.every ?? ""],
    [c.dim("last seen"), v.last ? `${v.last.ref} ${v.last.sha.slice(0, 12)}: ${v.last.result}, ${ago(v.last.at)}` : c.dim("nothing yet")],
  ]);
  if (!v.cron) warn("the crontab has no line for it: nothing runs (lf autodeploy --every … puts it back)");
  if (v.log.length) {
    info(c.dim("log:"));
    for (const l of v.log) console.error(c.dim(`  ${l}`));
  }
}

export const autodeploy = defineCommand({
  name: "autodeploy",
  args: "[site]",
  summary: `Let a site deploy new commits on its own: the server checks its repository on a schedule.

  lf autodeploy -E test --every 5m            # test follows its branch rule (lf git track)
  lf autodeploy -E prod --every 15m           # prod follows its tag rule: newer versions only
  lf autodeploy -E test                       # what it follows, what it saw last, the log
  lf autodeploy -E test --now                 # check once, now, and show what it did
  lf autodeploy -E test --off                 # stop
  lf autodeploy shop-test -s web --every 1h   # a site by name, outside its folder

A cron line runs sites/<name>/autodeploy.sh: it fetches, picks the newest commit
of the branch (or the newest tag), and deploys it like lf deploy --git would. A
commit that changes the compose files, the environment layer, package.json or
.landfall.json is not deployed: the log says to run lf deploy. Needs a server
that can fetch the repository (lf git key).`,
  options: {
    server: serverOpt,
    every: { type: "string", desc: "how often to check: 1m–59m or 1h–23h (turns it on)" },
    branch: { type: "string", multiple: true, desc: "follow this branch glob instead of the environment's rule" },
    tag: { type: "string", multiple: true, desc: "follow these tags (newest version wins) instead of the rule" },
    prerelease: { type: "boolean", desc: "with tags: pre-releases (v1.2.0-rc.1) deploy too" },
    git: { type: "string", desc: "the repository the server fetches (default: git.url, else the release's remote)" },
    off: { type: "boolean", desc: "stop deploying on its own (undo with lf undo)" },
    now: { type: "boolean", desc: "run the check once now and print what it did" },
    json: { type: "boolean", desc: "print {site, server, enabled, every, rule, url, last, log, cron} as JSON" },
  },
  async run([siteArg], o) {
    const cwd = process.cwd();
    const env = activeEnvironment();
    const project = siteArg ? undefined : loadProject(cwd);
    const name = siteArg ?? project?.name;
    if (!name) fail("which site? run it in a project folder (with -E <env>), or name the site");
    const { server, name: serverName } = projectServer(o.server ?? project?.server);
    const change = o.every !== undefined || o.off || o.branch?.length || o.tag?.length || o.git !== undefined || o.prerelease !== undefined;
    if (o.off && (o.every || o.branch?.length || o.tag?.length || o.git)) fail("--off stops it: give it alone");

    if (change) {
      // The site's folder in the repository: the checkout's place, plus the folder the deploy saved.
      const prefix = project && !o.off ? ((await repoInfo(cwd))?.prefix ?? "") : undefined;
      const meta = await setAutodeploy(server, name!, !o.off, (meta) => {
        const had = meta.autodeploy;
        if (o.off) {
          if (!had) return void info(`${name} does not deploy itself`);
          return { what: `stop auto-deploy of ${name}` };
        }
        const why = autodeployBlocker(meta);
        if (why) fail(why);
        const cur = currentRelease(meta)!;
        const every = o.every ?? had?.every;
        if (!every) fail("how often? --every 5m (1m–59m or 1h–23h)");
        const url = o.git ?? project?.git?.url ?? had?.url ?? cur.git?.remote;
        if (!url) fail("which repository? --git <url> (the release names none)");
        const g = parseGitUrl(url!);
        if (g.ref) fail(`auto-deploy follows a rule, not one ref: drop #${g.ref} (--branch or --tag say what to follow)`);
        const dir = prefix === undefined ? (had?.dir ?? "") : posix.join(prefix, project?.dir ?? ".").replace(/^\.$|\/$/g, "");
        const rule = followRule(o, project?.git, had?.rule, cur.git?.branch);
        return { setting: { env, every: every!, rule, url: g.url, dir }, what: `auto-deploy ${name} every ${every}: ${ruleText(rule)}` };
      });
      const a = meta?.autodeploy;
      if (meta && !a) ok(`${name} no longer deploys itself (lf undo turns it back on)`);
      if (a) {
        ok(`${name} deploys ${ruleText(a.rule)} of ${safeRemote(a.url)} on its own, checked every ${a.every}`);
        info(c.dim(`lf autodeploy${siteArg ? ` ${name}` : env ? ` -E ${env}` : ""} --now checks once now; the log is ${autodeployLog(name!)}`));
      }
    }

    // The script prints what it did to stderr; its exit code is the check's.
    if (o.now && (await runScript(server, autodeployNowScript(name!), { codes: [NOW_NO_SITE] })).code === NOW_NO_SITE) await noSite(server, name!);

    if (change && !o.json && !o.now) return;
    const v = await readAutodeploy(server, serverName, name!);
    if (o.json) return printJson(v);
    show(v);
  },
});
