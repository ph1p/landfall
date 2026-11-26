import { spawnSync } from "node:child_process";
import type { Release } from "./meta";
import { mainService } from "./routing";
import { packageJson, PROJECT_FILE, type ProjectConfig } from "../lib/config";
import { usesBun } from "../deploy/frameworks";
import { HOOKS, hooksFile, hookWhat, SERVER_HOOKS, type Hook, type LocalHook, type ServerHook } from "./hook-names";
import { packageManager } from "../deploy/node";
import { files } from "../deploy/runtimes";
import { journal, shq } from "../ssh/ssh";
import { c, fail, info, step, warn } from "../lib/term";

/**
 * Lifecycle hooks map a point of a deploy, rollback or removal to what runs there: npm scripts from
 * package.json's `landfall.hooks`, or shell commands from .landfall.json's `hooks` (any language). The ones
 * around the build run here, in the project folder; the ones that need the release's code and the production
 * .env run on the server, in the site's container. No agent: a hook is one more `docker compose run` or
 * `exec` in the deploy's script.
 */

/** Hooks whose failure stops what they guard; the others (post*, onfailure) only report. */
const BLOCKING: readonly Hook[] = ["prebuild", "predeploy", "release", "verify", "prerollback", "predestroy"];
/** Hooks that run before the app (re)starts, or as it goes away: no LANDFALL_URL to test against. */
const NO_URL: readonly ServerHook[] = ["release", "prerollback", "predestroy"];

/** The project's hooks, from package.json or .landfall.json. */
export interface ProjectHooks {
  /** The folder local hooks run in: package.json's, or .landfall.json's. */
  dir: string;
  /** npm, pnpm, yarn or bun, from the lockfile: package.json's hooks (npm scripts). Without it, the hooks are .landfall.json's shell commands. */
  pm?: string;
  /** The compose service server hooks run in (default: the one serving the site's domains). */
  service?: string;
  run: Partial<Record<Hook, string[]>>;
}

/** Saved with each release in site.json: a rollback or `lf sites rm` runs them from anywhere. */
export interface ReleaseHooks {
  /** The package manager of npm script hooks; none for shell commands. */
  pm?: string;
  service: string;
  /** The port the service listens on in its container: LANDFALL_URL of verify and postdeploy. */
  port?: number;
  run: Partial<Record<ServerHook, string[]>>;
}

/** A hooks object as written: hook → a `what` or a list of them. None (or null) is no hooks. */
function hookMap(from: string, key: string, hooks: unknown, what: string): Partial<Record<Hook, string[]>> {
  if (hooks == null) return {};
  if (typeof hooks !== "object" || Array.isArray(hooks)) fail(`${from}: "${key}" must map hooks to a ${what} or a list of them`);
  const run: Partial<Record<Hook, string[]>> = {};
  for (const [name, value] of Object.entries<unknown>(hooks as Record<string, unknown>)) {
    if (!(HOOKS as readonly string[]).includes(name)) fail(`${from}: unknown hook "${name}" in ${key} (hooks: ${HOOKS.join(", ")})`);
    const list = typeof value === "string" ? [value] : value;
    if (!Array.isArray(list) || !list.length || list.some((s) => typeof s !== "string" || !s.trim()))
      fail(`${from}: ${key}.${name} must be a ${what} or a list of them`);
    run[name as Hook] = list as string[];
  }
  return run;
}

const checkService = (from: string, key: string, service: unknown) => {
  if (service !== undefined && (typeof service !== "string" || !service)) fail(`${from}: "${key}" must name a compose service`);
};

/**
 * The project's hooks: package.json's landfall.hooks (npm scripts) in the first of `dirs` that has a
 * package.json, or the `hooks` of `project`, the .landfall.json settings read from `project.dir` (shell
 * commands). Both at once is refused: each hook would be ambiguous. None without hooks.
 */
export function readHooks(dirs: string[], project?: Pick<ProjectConfig, "hooks" | "service"> & { dir: string }): ProjectHooks | undefined {
  // The section's other keys are project settings (see loadProject).
  let pkgDir: string | undefined, read: ReturnType<typeof packageJson>;
  for (const d of dirs)
    if ((read = packageJson(d))) {
      pkgDir = d;
      break;
    }
  checkService("package.json", "landfall.service", read?.section.service);
  checkService(PROJECT_FILE, "service", project?.service);
  const service: string | undefined = project?.service ?? read?.section.service;

  const own = hookMap(PROJECT_FILE, "hooks", project?.hooks, "command");
  const npm = hookMap("package.json", "landfall.hooks", read?.section.hooks, "script name");
  const hasOwn = Object.keys(own).length > 0;
  if (hasOwn && Object.keys(npm).length)
    fail(`hooks in both package.json (landfall.hooks, npm scripts) and ${PROJECT_FILE} (hooks, commands): keep them in one`);

  if (hasOwn) return { dir: project!.dir, ...(service && { service }), run: own };
  if (!Object.keys(npm).length || !read || !pkgDir) return;
  const scripts: Record<string, unknown> = read.pkg.scripts ?? {};
  for (const [name, list] of Object.entries(npm)) {
    const missing = list.filter((s) => !(s in scripts));
    if (missing.length) fail(`package.json: landfall.hooks.${name} runs ${missing.join(", ")}, which "scripts" does not have`);
  }
  const has = files(pkgDir).has;
  const pm = packageManager(has, usesBun({ has, pkg: read.pkg }), read.pkg.packageManager).name;
  return { dir: pkgDir, pm, ...(service && { service }), run: npm };
}

/**
 * --skip-hooks and --skip-hook <name>: whether a hook is skipped. Each skip is said where it happens and
 * remembered, so `note()` can put them in the journal line.
 */
export function skipper(o: { "skip-hooks"?: boolean; "skip-hook"?: string[] }) {
  const named = o["skip-hook"] ?? [];
  const bad = named.filter((h) => !(HOOKS as readonly string[]).includes(h));
  if (bad.length) fail(`--skip-hook: no hook ${bad.join(", ")} (hooks: ${HOOKS.join(", ")})`);
  const all = !!o["skip-hooks"];
  const skipped = new Set<Hook>();
  return {
    /** Whether `hook` is skipped; a skipped one is said and remembered. */
    skips(hook: Hook, scripts: string[]) {
      if (!all && !named.includes(hook)) return false;
      warn(`skipping the ${hook} hook (${scripts.join(", ")})`);
      skipped.add(hook);
      return true;
    },
    /** The journal suffix for the hooks skipped so far, said once more in the summary. */
    note() {
      if (!skipped.size) return "";
      const list = [...skipped].join(", ");
      info(c.dim(`skipped hooks: ${list}`));
      return ` (skipped hooks: ${list})`;
    },
  };
}
export type Skipper = ReturnType<typeof skipper>;

/** What LANDFALL_VERSION says of a release: its commit, else its id. */
const releaseVersion = (r?: Release) => r && (r.git?.commit ?? r.id);

/** The LANDFALL_* every hook of a run on `project` gets, from the release it runs for and the one before. */
export function hookVars(project: string, r: { release?: Release; prev?: Release } = {}): Record<string, string | undefined> {
  return {
    LANDFALL_DEPLOYMENT_ID: journal.run,
    LANDFALL_PROJECT: project,
    LANDFALL_RELEASE: r.release?.id,
    LANDFALL_VERSION: releaseVersion(r.release),
    LANDFALL_TAG: r.release?.git?.tag,
    LANDFALL_PREVIOUS_VERSION: releaseVersion(r.prev),
  };
}

/** The variables a hook sees: LANDFALL_HOOK and the known ones of `vars`. */
function hookEnv(hook: Hook, vars: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = { LANDFALL_HOOK: hook };
  for (const [k, v] of Object.entries(vars)) if (v !== undefined && v !== "") env[k] = v;
  return env;
}

/**
 * Runs a local hook's entries in order, output on stderr, until one fails: `<pm> run <script>`, or a shell
 * command. A blocking hook's failure fails the command; the others warn.
 */
export function runLocalHook(h: ProjectHooks | undefined, hook: LocalHook, vars: Record<string, string | undefined>, skip: Skipper) {
  const entries = h?.run[hook];
  if (!h || !entries || skip.skips(hook, entries)) return;
  const env = { ...process.env, ...hookEnv(hook, vars) };
  for (const s of entries) {
    const what = hookWhat(h.pm, [s]);
    step(`hook ${hook}: ${what}`);
    const [cmd, args, shell] = h.pm ? [h.pm, ["run", s], process.platform === "win32"] : [s, [], true];
    // stdin closed: a test runner sees no terminal and runs once instead of watching. stdout is for results.
    const r = spawnSync(cmd, args, { cwd: h.dir, env, stdio: ["ignore", 2, 2], shell });
    if (r.status === 0) continue;
    const why = r.error ? r.error.message : `exit ${r.status ?? r.signal}`;
    if (BLOCKING.includes(hook)) fail(`hook ${hook} failed: ${what} (${why}); --skip-hook ${hook} deploys without it`);
    return void warn(`hook ${hook} failed: ${what} (${why})`);
  }
}

/** A static site's container is nginx, without the project's package.json: its npm script server hooks are refused. */
export function refuseStaticServerHooks(h: ProjectHooks | undefined, kind: string) {
  const server = SERVER_HOOKS.filter((k) => h?.run[k]);
  if (kind === "static" && h?.pm && server.length)
    fail(
      `package.json: ${server.join(", ")} run in the site's container, and a static site's (nginx) has no package.json; use prebuild, postbuild or predeploy, or shell commands in ${PROJECT_FILE}'s hooks`,
    );
}

/** The server hooks of a release: which service they run in and on what port it listens. */
export function releaseHooks(h: ProjectHooks | undefined, services: Release["services"], kind: string): ReleaseHooks | undefined {
  if (!h) return;
  const run = Object.fromEntries(SERVER_HOOKS.filter((k) => h.run[k]).map((k) => [k, h.run[k]!])) as ReleaseHooks["run"];
  if (!Object.keys(run).length) return;
  refuseStaticServerHooks(h, kind);
  const names = services.map((s) => s.name).join(", ");
  const named = h.service ? services.find((s) => s.name === h.service) : undefined;
  if (h.service && !named) fail(`${hooksFile(h.pm)}: the hooks' service is ${h.service}, which is not a service of the release (${names})`);
  const svc = named ?? mainService({ id: "", at: "", services }) ?? services.find((s) => s.build) ?? (services.length === 1 ? services[0] : undefined);
  if (!svc) fail(`${hooksFile(h.pm)}: which service do the server hooks run in? Name it with "service": "<name>" (services: ${names})`);
  return { ...(h.pm && { pm: h.pm }), service: svc!.name, ...(svc!.port && { port: svc!.port }), run };
}

/** A server hook to run in a remote script: where, its scripts, and the LANDFALL_* it gets. */
export interface HookCall {
  hook: ServerHook;
  /** None: `scripts` are shell commands. */
  pm?: string;
  service: string;
  scripts: string[];
  env: Record<string, string>;
}

/** A server hook of a release to run, with its LANDFALL_*; none when it is not configured or skipped (said). */
export function serverCall(hooks: ReleaseHooks | undefined, hook: ServerHook, skip: Skipper, vars: Record<string, string | undefined>): HookCall | undefined {
  const scripts = hooks?.run[hook];
  if (!hooks || !scripts || skip.skips(hook, scripts)) return;
  // Inside the container, the app listens on its own port: no domain, DNS or certificate in the way.
  const url = NO_URL.includes(hook) || !hooks.port ? undefined : `http://127.0.0.1:${hooks.port}`;
  return { hook, ...(hooks.pm && { pm: hooks.pm }), service: hooks.service, scripts, env: hookEnv(hook, { ...vars, LANDFALL_URL: url }) };
}

/**
 * In the container: each script in turn with the project's package manager, or npm when the image lacks it,
 * until one fails ($0 = pm, the arguments = scripts).
 */
const IN_CONTAINER = [
  `p=; for c in "$0" npm; do if command -v "$c" >/dev/null 2>&1; then p=$c; break; fi; done`,
  `[ -n "$p" ] || { echo "neither $0 nor npm is in the container" >&2; exit 127; }`,
  `for s; do "$p" run "$s" || { echo "$p run $s failed" >&2; exit 1; }; done`,
].join("\n");

/** In the container: each shell command in turn, until one fails (the arguments = commands). */
const COMMANDS_IN_CONTAINER = `for s; do sh -c "$s" || { echo "failed: $s" >&2; exit 1; }; done`;

/**
 * Shell for a hook, from the site folder: one container for all its scripts, from `dir` (a release folder
 * or `current`). `run`: a one-off container of the new release (Traefik never routes to it; its depends_on
 * start first). `exec`: the running container. A failure runs `onFail` (blocking hooks) or is logged.
 */
export function hookLines(call: HookCall | undefined, mode: "run" | "exec", dir: string, onFail: string[] = []): string[] {
  if (!call) return [];
  const e = Object.entries(call.env)
    .map(([k, v]) => `-e ${shq(`${k}=${v}`)}`)
    .join(" ");
  const how =
    mode === "run" ? `dc run --rm -T --label traefik.enable=false --entrypoint sh ${e} ${shq(call.service)}` : `dc exec -T ${e} ${shq(call.service)} sh`;
  const what = hookWhat(call.pm, call.scripts);
  const [inner, zero] = call.pm ? [IN_CONTAINER, call.pm] : [COMMANDS_IN_CONTAINER, "sh"];
  const failed = `hook ${call.hook} failed: ${what}`;
  return [
    `log ${shq(`hook ${call.hook}: ${what}`)}`,
    `if ! (cd -P ${dir} && ${how} -c ${shq(inner)} ${[zero, ...call.scripts].map(shq).join(" ")} </dev/null >&2); then`,
    ...(BLOCKING.includes(call.hook)
      ? [...onFail, `echo ${shq(`${failed}; --skip-hook ${call.hook} goes on without it`)} >&2`, "exit 1"]
      : [`log ${shq(`${failed} (not undone: ${call.hook} only reports)`)}`]),
    "fi",
  ];
}

/** The hook a remote error names: `hook verify failed: …`. */
export const failedHook = (msg: string) => msg.match(/\bhook (\w+) failed\b/)?.[1];

/** --skip-hooks and --skip-hook, for the commands that run hooks. */
export const SKIP_OPTIONS = {
  "skip-hooks": { type: "boolean", desc: "run none of the lifecycle hooks (said, and noted in lf history)" },
  "skip-hook": { type: "string", multiple: true, desc: "do not run this hook (e.g. verify)" },
} as const;
