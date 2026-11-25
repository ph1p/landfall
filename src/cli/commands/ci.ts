import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { defineCommand } from "../cmd";
import { ciKeyScript, ciPlan, ciView, knownHosts, type CiPlan } from "../../core/deploy/ci";
import { configDir, PROJECT_FILE, resolveServer } from "../../core/lib/config";
import { FORGES, loggedIn } from "../../core/deploy/forge";
import { onStop } from "../../core/lib/job";
import { adminLogin } from "../../core/ssh/privilege";
import { ruleText } from "../../core/deploy/refs";
import { runScript } from "../../core/ssh/ssh";
import { c, confirm, confirmRemoval, fail, info, ok, printJson, step, warn } from "../../core/lib/term";

/** The servers the job logs in to, as the config names them, beside the job's view of each (same order). */
const logins = (p: CiPlan) => [...new Set(p.targets.map((t) => t.server))].map((name, i) => ({ name, ci: p.servers[i] }));

/** What the job deploys, one line per environment, on stderr. */
function describe(p: CiPlan) {
  for (const t of p.targets) {
    const what = p.fallbackBranch ? `pushes to ${p.fallbackBranch}` : ruleText({ branch: t.branches, tag: t.tags, prerelease: t.prerelease });
    info(`${t.env || c.dim("(project)")}: ${what} ${c.dim("→")} ${t.server}`);
  }
}

/** Adds (or, with an empty key, removes) the login's CI key for the repository; prints the server's host keys. */
async function serverKey(name: string, user: string, key: string, mark: string): Promise<string> {
  const admin = await adminLogin(resolveServer(name).server, key ? "adding the CI key" : "removing the CI key");
  return (await runScript(admin, ciKeyScript(), { capture: true, env: { KEY_USER: user, KEY: key, MARK: mark } })).stdout;
}

/** Runs gh or glab with the value on stdin (never in argv): true when it worked. */
function forgeRun(cli: string, tries: string[][], input?: string): boolean {
  let why = "";
  for (const args of tries) {
    const r = spawnSync(cli, args, { input, stdio: [input === undefined ? "ignore" : "pipe", "ignore", "pipe"], encoding: "utf8" });
    if (r.status === 0) return true;
    why = (r.stderr || `exit ${r.status}`).trim();
  }
  warn(`${cli} ${tries[0].slice(0, 3).join(" ")}: ${why}`);
  return false;
}

export const ciInit = defineCommand({
  name: "ci init",
  args: "[github|gitlab]",
  summary: `Set up GitHub Actions or GitLab CI to deploy what the git rules allow.

  lf ci init                          # the forge of origin (GitHub or GitLab)
  lf ci init gitlab --dry-run         # show the job's file, change nothing
  lf ci init github --json            # for scripts and the web UI

Writes .github/workflows/landfall.yml (or .gitlab-ci.yml) from the rules in
${PROJECT_FILE}: a push of a branch or tag an environment deploys runs
lf deploy --for-ref, which picks the environment. Without rules, pushes to
the current branch deploy the project. Makes an ssh key for the job, adds it to
the deploy login on each server (restricted: no shell, no forwarding) and sets
the secrets LANDFALL_SSH_KEY and LANDFALL_KNOWN_HOSTS with gh or glab. Without
them, it writes the values to files for you to add. Commit and push the file.`,
  options: {
    "dry-run": { type: "boolean", desc: "only show the job's file and what it deploys" },
    force: { type: "boolean", desc: "replace a workflow file lf ci init did not write" },
    json: { type: "boolean", desc: "print the plan as JSON: {forge, file, yaml, targets, servers, secrets, …}" },
  },
  async run([forgeArg], o) {
    const p = await ciView(process.cwd(), forgeArg);
    const f = FORGES[p.forge];
    const cli = p.loggedIn;
    if (o["dry-run"]) {
      if (o.json) return printJson(p);
      describe(p);
      return void process.stdout.write(p.yaml);
    }
    if (p.exists === "other" && !o.force) fail(`${p.file} was not written by lf ci init: --force replaces it`);
    if (p.untracked) warn(`${PROJECT_FILE} is not in git: commit it too, or the job cannot read it`);
    describe(p);
    const names = logins(p).map((l) => l.name);
    const secrets = p.secrets.join(" and ");
    const where = cli ? `set ${secrets} on ${p.repo} (${f.cli})` : `write ${secrets} to files for you to add`;
    if (!(await confirm(`Add a CI ssh key to ${names.join(", ")}, ${where}, and write ${p.file}?`))) return info("nothing changed");

    // The private key lives only in this folder, then in the forge's secret.
    const dir = fs.mkdtempSync(join(tmpdir(), "lf-ci-"));
    const clean = async () => fs.rmSync(dir, { recursive: true, force: true });
    const unhook = onStop(clean);
    const values: Record<string, string> = {};
    try {
      const file = join(dir, "key");
      if (spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", p.keyComment, "-f", file], { stdio: "ignore" }).status !== 0)
        fail("ssh-keygen could not make a key (is OpenSSH installed?)");
      const publicKey = fs.readFileSync(`${file}.pub`, "utf8").trim();
      values.LANDFALL_SSH_KEY = fs.readFileSync(file).toString("base64");
      const hosts: string[] = [];
      for (const { name, ci } of logins(p)) {
        step(`CI key for ${ci.user} on ${name}`);
        // restrict: no pty, no forwarding; the job only runs landfall's scripts.
        const known = knownHosts(ci, await serverKey(name, ci.user, `restrict ${publicKey}`, p.keyComment));
        if (!known.length) warn(`${name} showed no host keys (/etc/ssh/ssh_host_*_key.pub): add them to LANDFALL_KNOWN_HOSTS by hand`);
        hosts.push(...known);
      }
      values.LANDFALL_KNOWN_HOSTS = hosts.join("\n");
    } finally {
      await clean();
      unhook();
    }

    let secretsSet = false;
    let secretFiles: Record<string, string> | undefined;
    if (cli) {
      step(`secrets on ${p.repo}`);
      // GitLab masks a value only when it is one line of base64-like characters: the key is, the host keys are not.
      secretsSet = p.secrets.map((s) => forgeRun(f.cli, f.setSecret(s, p.repo, s === "LANDFALL_SSH_KEY"), values[s])).every(Boolean);
    }
    if (!secretsSet) {
      const out = join(configDir, "ci", p.repo.replace(/[^A-Za-z0-9._-]+/g, "-"));
      fs.mkdirSync(out, { recursive: true, mode: 0o700 });
      secretFiles = Object.fromEntries(p.secrets.map((s) => [s, join(out, s)]));
      for (const s of p.secrets) fs.writeFileSync(secretFiles[s], values[s], { mode: 0o600 });
      info(`add these as secrets of ${p.repo} (${p.secretsPage}), then delete the files:`);
      for (const s of p.secrets) info(`  ${s}  ${c.dim(secretFiles[s])}`);
    } else ok(`set ${secrets} on ${p.repo}`);

    const target = join(p.root, p.file);
    fs.mkdirSync(dirname(target), { recursive: true });
    fs.writeFileSync(target, p.yaml);
    ok(`wrote ${p.file}`);
    if (p.include) info(`your .gitlab-ci.yml needs it: ${c.bold(p.include.replace(/\n\s*/g, " "))}`);
    info(`commit and push it: git add ${p.here}${p.untracked ? ` ${PROJECT_FILE}` : ""} && git commit -m "ci: deploy with landfall" && git push`);
    info(c.dim(`runs: ${p.runsPage}`));
    if (o.json) printJson({ ...p, secretsSet, ...(secretFiles && { secretFiles }) });
  },
});

export const ciRm = defineCommand({
  name: "ci rm",
  args: "[github|gitlab]",
  summary: `Undo lf ci init: remove the CI key from the servers and the secrets from the forge.

  lf ci rm                            # then delete the workflow file and push

The servers' key removal is journaled (lf undo restores it); deleting the
forge's secrets cannot be undone. The workflow file stays: delete it in git.`,
  options: {
    json: { type: "boolean", desc: "print {repo, servers, secretsRemoved} as JSON" },
  },
  async run([forgeArg], o) {
    const p = await ciPlan(process.cwd(), forgeArg);
    const f = FORGES[p.forge];
    const names = logins(p).map((l) => l.name);
    await confirmRemoval(`Remove the CI key for ${p.repo} from ${names.join(", ")} and its secrets? CI cannot deploy afterwards.`);
    for (const { name, ci } of logins(p)) {
      step(`CI key for ${ci.user} on ${name}`);
      await serverKey(name, ci.user, "", p.keyComment);
    }
    const cli = loggedIn(f.cli);
    const secretsRemoved = cli && p.secrets.map((s) => forgeRun(f.cli, [f.deleteSecret(s, p.repo)])).every(Boolean);
    if (secretsRemoved) ok(`removed ${p.secrets.join(" and ")} from ${p.repo}`);
    else info(`remove ${p.secrets.join(" and ")} from ${p.repo}: ${f.secretsPage(p.repo)}`);
    if (p.exists === "ours")
      info(`delete the job too: git rm ${relative(process.cwd(), join(p.root, p.file))} && git commit -m "ci: stop deploying with landfall" && git push`);
    if (o.json) printJson({ repo: p.repo, servers: names, secretsRemoved });
  },
});
