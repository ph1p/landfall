// lf ci init: a GitHub Actions or GitLab CI job that deploys what the git rules allow, with its own ssh key.
// The job's file is built here from .landfall.json; the key and the secrets are the CLI's part.
import fs from "node:fs";
import { join, relative } from "node:path";
import { activeEnvironment, gitRules, loadConfig, loadProject, PROJECT_FILE, resolveServer, type Server } from "../lib/config";
import { FORGES, loggedIn } from "./forge";
import { git, repoInfo } from "./git";
import { detectForge, globRe, hasRule, list, type Forge, type RefRule } from "./refs";
import { parseGitUrl } from "./remote-git";
import { effectiveSsh } from "../ssh/sshconfig";
import { PRELUDE } from "../ssh/templates";
import { fail } from "../lib/term";
import { VERSION } from "../lib/version";

/** The secrets the job reads: the private key (base64, one line, so GitLab can mask it) and the servers' host keys. */
export const CI_SECRETS = ["LANDFALL_SSH_KEY", "LANDFALL_KNOWN_HOSTS"] as const;

/** The first line of every file lf ci init writes: it may overwrite one that has it. */
export const CI_HEADER = "# Written by lf ci init";

/** A server the job logs in to, as the runner's ~/.ssh/config names it. */
export interface CiServer {
  /** The name .landfall.json (or the default) uses: the Host the job's ssh config defines. */
  name: string;
  hostname: string;
  user: string;
  port: number;
}

/** One environment the job deploys, and which pushes it deploys. */
export interface CiTarget {
  /** "" is the project itself. */
  env: string;
  server: string;
  branches: string[];
  tags: string[];
  prerelease: boolean;
}

/** What lf ci init writes, and where. Stable shape: lf ci init --json and the web UI read it. */
export interface CiPlan {
  forge: Forge;
  cli: "gh" | "glab";
  /** owner/repo as gh and glab take it (-R). */
  repo: string;
  /** The job's file, relative to the repository's root. */
  file: string;
  /** The file is there already: written by lf ci init (ours), or someone else's. */
  exists: false | "ours" | "other";
  yaml: string;
  secrets: string[];
  servers: CiServer[];
  targets: CiTarget[];
  /** The key's comment in authorized_keys: lf ci init and lf ci rm find their key by it. */
  keyComment: string;
  /** Without rules: the branch the job deploys on push (no --for-ref). */
  fallbackBranch?: string;
  /** GitLab, when .gitlab-ci.yml is someone else's: the include it needs. */
  include?: string;
  /** The job's landfall config: the servers' settings a deploy reads (not how to log in: its ssh config says that). */
  config: { servers: Record<string, Partial<Server>>; default?: string };
  /** Not in git: the job would not see .landfall.json. */
  untracked?: boolean;
  /** The project's folder in the repository ("" at its root). */
  prefix: string;
  root: string;
}

const SAFE = /^[A-Za-z0-9._:%@-]+$/;

/** A glob as GitHub's filter reads it: its ? (zero or one) and + differ, so ? widens to * and the rest is escaped. */
export const ghGlob = (g: string) =>
  g
    .replace(/\?/g, "*")
    .replace(/[+[\]]/g, "\\$&")
    .replace(/^!/, "\\!");

/** A GitLab rules regex (RE2) that matches any of the globs, as landfall reads them. */
export const glRegex = (globs: string[]) => `/^(?:${globs.map((g) => globRe(g).source.slice(1, -1).replace(/\\?\//g, "\\/")).join("|")})$/`;

/** Tags with a semver pre-release suffix (v1.2.0-rc.1), as refs.ts's semver reads them. */
const PRERELEASE_RE = String.raw`/\d+\.\d+\.\d+-[0-9A-Za-z.-]+(\+[0-9A-Za-z.-]+)?$/`;

const q = (s: string) => JSON.stringify(s);

/** The environments the job deploys and their servers: those with a rule, else the project on the current branch. */
export async function ciPlan(cwd: string, forgeArg?: string): Promise<CiPlan> {
  if (activeEnvironment()) fail("lf ci init writes one job for every environment: drop -E (and LANDFALL_ENV)");
  const project = loadProject(cwd, "");
  if (!project) fail(`no ${PROJECT_FILE} here: deploy once (lf deploy), then set up CI`);
  const repo = await repoInfo(cwd);
  if (!repo) fail("not a git checkout: CI deploys from a repository");
  const remote = project!.git?.url ?? repo!.remote;
  if (forgeArg && forgeArg !== "github" && forgeArg !== "gitlab") fail(`lf ci init github|gitlab: not ${forgeArg}`);
  const forge = (forgeArg ?? detectForge(remote)) as Forge | undefined;
  if (!forge) fail(`which forge? ${remote ? `${remote} is neither GitHub nor GitLab` : "no origin"}: lf ci init github|gitlab`);
  if (!remote) fail("no repository URL: add an origin (git remote add origin …) or git.url (lf git track --url)");
  const g = parseGitUrl(remote!);
  if (!g.host) fail(`${remote} is a path, not a GitHub or GitLab repository`);
  const repoPath = g.host === "github.com" || g.host === "gitlab.com" ? g.path : `${g.host}/${g.path}`;

  const rules = gitRules(cwd);
  const ruled = Object.entries(rules).filter((e): e is [string, RefRule] => hasRule(e[1]));
  let fallbackBranch: string | undefined;
  if (!ruled.length) {
    if (!repo!.branch) fail("no git rules and no branch checked out: say what deploys (lf git track -E <env> --branch <glob>)");
    fallbackBranch = repo!.branch;
  }
  // A missing server falls back to the default, as a deploy here does; the job's config gets the same default.
  let defaultServer: string | undefined;
  const serverOf = (env: string) => loadProject(cwd, env)?.server ?? (defaultServer = resolveServer().name);
  const targets: CiTarget[] = fallbackBranch
    ? [{ env: "", server: serverOf(""), branches: [fallbackBranch], tags: [], prerelease: false }]
    : ruled.map(([env, r]) => ({ env, server: serverOf(env), branches: list(r.branch), tags: list(r.tag), prerelease: !!r.prerelease }));

  const names = [...new Set(targets.map((t) => t.server))];
  const known = loadConfig().servers;
  const alias = (name: string) => name.replace(/^[^@]*@/, "");
  const config: CiPlan["config"] = {
    // Logins, keys and the admin's ways to root stay here; domains and the like decide what a deploy does.
    servers: Object.fromEntries(
      names
        .filter((n) => known[n])
        .map((n) => {
          const { host: _h, user: _u, port: _p, key: _k, admin: _a, rootAlias: _r, dashboard: _d, ...keep } = known[n];
          return [n, { host: alias(n), ...keep }];
        }),
    ),
    ...(defaultServer && { default: defaultServer }),
  };
  const servers = names.map((name): CiServer => {
    const e = effectiveSsh(resolveServer(name).server);
    for (const v of [name, e.hostname, e.user]) if (!SAFE.test(v)) fail(`${v} cannot go into the job's ssh config`);
    return { name: alias(name), hostname: e.hostname, user: e.user, port: e.port };
  });

  const root = repo!.root;
  const prefix = repo!.prefix.replace(/\/$/, "");
  let file = forge === "github" ? ".github/workflows/landfall.yml" : ".gitlab-ci.yml";
  let exists = existing(join(root, file));
  let include: string | undefined;
  if (forge === "gitlab" && exists === "other") {
    file = ".gitlab/landfall.yml";
    exists = existing(join(root, file));
    include = `include:\n  - local: ${file}`;
  }
  const tracked = await git(cwd, "ls-files", "--", PROJECT_FILE);
  const plan = {
    forge: forge!,
    cli: FORGES[forge!].cli,
    repo: repoPath,
    file,
    exists,
    secrets: [...CI_SECRETS],
    servers,
    targets,
    keyComment: `landfall ci ${repoPath}`,
    config,
    ...(fallbackBranch && { fallbackBranch }),
    ...(include && { include }),
    ...(!tracked && { untracked: true }),
    prefix,
    root,
  };
  return { ...plan, yaml: (forge === "github" ? githubYaml : gitlabYaml)(plan) };
}

function existing(path: string): CiPlan["exists"] {
  if (!fs.existsSync(path)) return false;
  return fs.readFileSync(path, "utf8").startsWith(CI_HEADER) ? "ours" : "other";
}

type YamlIn = Omit<CiPlan, "yaml" | "exists" | "root">;

/** The shell that gives the runner the key, the servers' host keys and a Host block per server. */
function sshSetup(p: YamlIn): string[] {
  const hosts = p.servers.flatMap((s) => [
    `Host ${s.name}`,
    `  HostName ${s.hostname}`,
    `  User ${s.user}`,
    `  Port ${s.port}`,
    "  IdentityFile ~/.ssh/landfall_ci",
    "  IdentitiesOnly yes",
    "  StrictHostKeyChecking yes",
  ]);
  return [
    "mkdir -p ~/.ssh && chmod 700 ~/.ssh",
    `printf '%s' "$LANDFALL_SSH_KEY" | base64 -d > ~/.ssh/landfall_ci`,
    "chmod 600 ~/.ssh/landfall_ci",
    `printf '%s\\n' "$LANDFALL_KNOWN_HOSTS" >> ~/.ssh/known_hosts`,
    "cat >> ~/.ssh/config <<'EOF'",
    ...hosts,
    "EOF",
    'mkdir -p "$LANDFALL_CONFIG_DIR"',
    `cat > "$LANDFALL_CONFIG_DIR/config.json" <<'EOF'`,
    JSON.stringify(p.config),
    "EOF",
  ];
}

const npx = `npx -y landfall@^${VERSION}`;
const comment = (p: YamlIn) => [
  `${CI_HEADER}: deploys the pushes the git rules in ${PROJECT_FILE} allow.`,
  `# Needs the secrets ${p.secrets.join(" and ")} (lf ci init sets them). lf ci rm undoes it.`,
];
const indent = (n: number, lines: string[]) => lines.map((l) => (l ? " ".repeat(n) + l : l));

/** The plan, with the forge's name, whether gh or glab is logged in, and its pages: what lf ci init --dry-run --json prints. */
export async function ciView(cwd: string, forgeArg?: string) {
  const p = await ciPlan(cwd, forgeArg);
  const f = FORGES[p.forge];
  // here: the file as seen from cwd, for git add.
  return {
    ...p,
    here: relative(cwd, join(p.root, p.file)),
    name: f.name,
    loggedIn: loggedIn(f.cli),
    runsPage: f.runsPage(p.repo),
    secretsPage: f.secretsPage(p.repo),
  };
}

export function githubYaml(p: YamlIn): string {
  const branches = [...new Set(p.targets.flatMap((t) => t.branches))].map(ghGlob);
  const tags = [...new Set(p.targets.flatMap((t) => t.tags))].map(ghGlob);
  // Pre-releases deploy only where a tag rule allows them: elsewhere the push starts no run.
  if (tags.length && !p.targets.some((t) => t.tags.length && t.prerelease)) tags.push("!**[0-9]+.[0-9]+.[0-9]+-**");
  const deploy = p.fallbackBranch ? `${npx} deploy -y` : `${npx} deploy --for-ref "$GITHUB_REF" -y`;
  return [
    ...comment(p),
    "name: landfall",
    "on:",
    "  push:",
    ...(branches.length ? [`    branches: [${branches.map(q).join(", ")}]`] : []),
    ...(tags.length ? [`    tags: [${tags.map(q).join(", ")}]`] : []),
    "concurrency:",
    "  group: landfall-${{ github.ref }}",
    "  cancel-in-progress: false",
    "jobs:",
    "  deploy:",
    "    runs-on: ubuntu-latest",
    "    env:",
    '      LANDFALL_NO_UPDATE_CHECK: "1"',
    "      LANDFALL_CONFIG_DIR: ${{ runner.temp }}/landfall",
    "    steps:",
    "      - uses: actions/checkout@v4",
    // All branches and tags: --for-ref finds the pushed ref by name.
    "        with: { fetch-depth: 0 }",
    "      - uses: actions/setup-node@v4",
    "        with: { node-version: 22 }",
    "      - name: ssh",
    "        env:",
    ...p.secrets.map((s) => `          ${s}: \${{ secrets.${s} }}`),
    "        run: |",
    ...indent(10, sshSetup(p)),
    "      - name: deploy",
    ...(p.prefix ? [`        working-directory: ${q(p.prefix)}`] : []),
    `        run: ${deploy}`,
    "",
  ].join("\n");
}

export function gitlabYaml(p: YamlIn): string {
  const branches = [...new Set(p.targets.flatMap((t) => t.branches))];
  const tags = [...new Set(p.targets.flatMap((t) => t.tags))];
  const pre = tags.length && !p.targets.some((t) => t.tags.length && t.prerelease);
  const ref = 'if [ -n "${CI_COMMIT_TAG:-}" ]; then REF="refs/tags/$CI_COMMIT_TAG"; else REF="refs/heads/$CI_COMMIT_BRANCH"; fi';
  const deploy = p.fallbackBranch ? [`${npx} deploy -y`] : [ref, `${npx} deploy --for-ref "$REF" -y`];
  const script = [...sshSetup(p), ...(p.prefix ? [`cd ${q(p.prefix)}`] : []), ...deploy];
  return [
    ...comment(p),
    "landfall:",
    "  image: node:22",
    "  resource_group: landfall-$CI_COMMIT_REF_NAME",
    "  variables:",
    '    LANDFALL_NO_UPDATE_CHECK: "1"',
    "    LANDFALL_CONFIG_DIR: /tmp/landfall",
    '    GIT_DEPTH: "0"',
    "  rules:",
    ...(pre ? [`    - if: $CI_COMMIT_TAG =~ ${PRERELEASE_RE}`, "      when: never"] : []),
    ...(branches.length ? [`    - if: $CI_COMMIT_BRANCH =~ ${glRegex(branches)}`] : []),
    ...(tags.length ? [`    - if: $CI_COMMIT_TAG =~ ${glRegex(tags)}`] : []),
    "  script:",
    // One block scalar: the heredoc spans lines, and the runner would split separate items apart.
    "    - |",
    ...indent(6, script),
    "",
  ].join("\n");
}

/**
 * The server's side, in one script: drop the login's earlier CI keys for this repository (by their comment), add the
 * new one (when given), each change journaled; then print the server's host keys for the job's known_hosts.
 */
export function ciKeyScript(): string {
  return (
    PRELUDE +
    String.raw`
home=$(home_of "$KEY_USER")
[ -n "$home" ] || { log "no user $KEY_USER"; exit 1; }
f="$home/.ssh/authorized_keys"
old=$($SUDO grep -F -- " $MARK" "$f" 2>/dev/null || true)
while IFS= read -r line; do
  case "$line" in *" $MARK") ;; *) continue ;; esac
  [ "$line" != "$KEY" ] || continue
  drop_line "$f" "$line"
  record "removed the CI key $MARK of $KEY_USER" "printf '%s\n' $(printf %q "$line") | \$SUDO tee -a $(printf %q "$f") >/dev/null"
done <<<"$old"
if [ -n "$KEY" ] && ! $SUDO grep -qxF -- "$KEY" "$f" 2>/dev/null; then
  $SUDO mkdir -p "$home/.ssh"; $SUDO chmod 700 "$home/.ssh"
  printf '%s\n' "$KEY" | $SUDO tee -a "$f" >/dev/null
  g=$(id -gn "$KEY_USER" 2>/dev/null || echo "$KEY_USER")
  $SUDO chown "$KEY_USER:$g" "$home/.ssh" "$f"; $SUDO chmod 600 "$f"
  record "authorized key $MARK for $KEY_USER" "drop_line $(printf %q "$f") $(printf %q "$KEY")"
fi
echo @@hostkeys
cat /etc/ssh/ssh_host_*_key.pub 2>/dev/null || true
`
  );
}

/** known_hosts lines for a server from the host keys the script printed: [host]:port when the port is not 22. */
export function knownHosts(s: CiServer, out: string): string[] {
  const host = s.port === 22 ? s.hostname : `[${s.hostname}]:${s.port}`;
  return out
    .slice(out.indexOf("@@hostkeys") + "@@hostkeys".length)
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .filter(([t, k]) => /^(ssh-|ecdsa-)/.test(t ?? "") && k)
    .map(([t, k]) => `${host} ${t} ${k}`);
}
