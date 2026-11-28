import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineCommand, serverOpt } from "../cmd";
import { serverTarget } from "../target";
import { activeEnvironment, ENV_NAME, gitRules, loadProject, PROJECT_FILE, saveGitRule } from "../../core/lib/config";
import { repoInfo, safeRemote } from "../../core/deploy/git";
import { hasRule, one, ruleText, sameRule, type RefRule } from "../../core/deploy/refs";
import { FORGES, loggedIn } from "../../core/deploy/forge";
import { forgeOf, keyRemoveScript, keyScript, parseGitUrl, type GitUrl } from "../../core/deploy/remote-git";
import { runScript } from "../../core/ssh/ssh";
import { c, canConfirm, confirm, confirmRemoval, fail, info, ok, printJson, step, table, warn } from "../../core/lib/term";

export const gitTrack = defineCommand({
  name: "git track",
  tenant: true,
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

/** Adds the public key as a read-only deploy key through gh or glab: true when it did. */
async function addDeployKey(g: GitUrl, publicKey: string, title: string): Promise<boolean> {
  const forge = forgeOf(g);
  if (!forge) return false;
  const f = FORGES[forge];
  if (!loggedIn(f.cli) || !canConfirm() || !(await confirm(`Add it to ${g.path} as a read-only deploy key (${f.cli})?`))) return false;
  const dir = fs.mkdtempSync(join(tmpdir(), "lf-key-"));
  try {
    const file = join(dir, "key.pub");
    fs.writeFileSync(file, publicKey + "\n");
    const r = spawnSync(f.cli, f.addKey(file, g.path, title), { stdio: ["ignore", 2, "pipe"], encoding: "utf8" });
    if (r.status === 0) return true;
    warn(`${f.cli} could not add the key: ${(r.stderr || `exit ${r.status}`).trim()}`);
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export const gitKey = defineCommand({
  name: "git key",
  tenant: true,
  args: "[url]",
  summary: `Give a server a deploy key for a repository, so it can fetch it (lf deploy --git).

  lf git key                                  # the project's repository (git.url, else origin)
  lf git key git@github.com:acme/shop.git -s web
  lf git key gh:acme/shop --json              # for scripts and the web UI
  lf git key gh:acme/shop --rm                # remove the key

Makes an ed25519 key on the server, once, and prints its public key. With gh or glab
logged in, it offers to add the key to the repository as a read-only deploy key;
otherwise add it by hand. The private key never leaves the server.`,
  options: {
    server: serverOpt,
    rm: { type: "boolean", desc: "remove the server's deploy key for the repository (cannot be undone)" },
    json: { type: "boolean", desc: "print {url, server, publicKey, created, added} as JSON" },
  },
  async run([arg], o) {
    const cwd = process.cwd();
    const url = arg ?? loadProject(cwd, "")?.git?.url ?? (await repoInfo(cwd))?.remote;
    if (!url) fail("which repository? pass its URL (git@host:owner/repo.git, gh:owner/repo), or run inside a checkout with an origin");
    const g = parseGitUrl(url!);
    if (g.ref) fail(`a deploy key is for the whole repository: drop #${g.ref}`);
    if (!g.host) fail(`${g.url} is a path on the server: it needs no deploy key`);
    const { server, name: serverName } = serverTarget(o);
    const shown = safeRemote(g.url);

    if (o.rm) {
      await confirmRemoval(`Remove ${serverName}'s deploy key for ${shown}? It cannot fetch the repository afterwards, and the key cannot be restored.`);
      await runScript(server, keyRemoveScript(g));
      const forge = forgeOf(g);
      if (o.json) return printJson({ url: shown, server: serverName, removed: true });
      ok(`removed ${serverName}'s deploy key for ${shown}`);
      if (forge) info(c.dim(`remove it from the repository's deploy keys too: ${FORGES[forge].keyPage(g.path).replace(/\/new$/, "")}`));
      return;
    }

    step(`deploy key for ${shown} on ${serverName}`);
    const { stdout } = await runScript(server, keyScript(g, `landfall ${serverName}`), { capture: true });
    const created = stdout.includes("@@created");
    const publicKey = stdout
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith("ssh-"));
    if (!publicKey) fail(`${serverName} printed no public key`);
    info(created ? `made a deploy key on ${serverName}` : `${serverName} has a deploy key for ${shown} already`);
    const added = await addDeployKey(g, publicKey!, `landfall ${serverName}`);
    const forge = forgeOf(g);
    if (added) ok(`added it to ${g.path} as a read-only deploy key`);
    else
      info(
        forge
          ? `add it to ${g.path} as a read-only deploy key: ${FORGES[forge].keyPage(g.path)}${loggedIn(FORGES[forge].cli) ? "" : ` (or log in with ${FORGES[forge].cli} auth login and run this again)`}`
          : `add it to ${shown} as a read-only deploy key (the host's repository settings)`,
      );
    if (o.json) return printJson({ url: shown, server: serverName, publicKey, created, added });
    console.log(publicKey);
  },
});
