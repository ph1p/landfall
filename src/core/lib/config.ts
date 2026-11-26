import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { expandHost } from "../traefik/redirects";
import { ENVIRONMENT_NAME, type GitConfig, type RefRule } from "../deploy/refs";
import { fail } from "./term";

/**
 * A server is anything `ssh` can reach. `host` may be an alias from ~/.ssh/config
 * (e.g. "vps"), in which case user/port/key are left empty and ssh fills them in.
 */
export interface Server {
  host: string;
  user?: string;
  port?: number;
  key?: string;
  email?: string;
  /** Let's Encrypt staging CA, remembered so re-running setup keeps it. */
  staging?: boolean;
  /** landfall's own traefik, remembered like email/staging. */
  traefikImage?: string;
  hostNetwork?: boolean;
  /** HTTP/3 on 443/udp; on unless false. */
  http3?: boolean;
  /** landfall's traefik writes the access log lf traffic reads; on unless false. */
  accessLog?: boolean;
  /**
   * Main domains. The first is the primary: sites default to <site>.<primary>, and a bare
   * name like `blog` means blog.<primary>. The others are listed and DNS-checked too.
   */
  domains?: string[];
  /** New sites get no domain unless one is given: reached with `lf tunnel` only. Unset: landfall's default. */
  tunnelOnly?: boolean;
  /** The sudo user that bootstrapped the server when root couldn't log in: re-runs and admin tasks use it. */
  admin?: string;
  /** An ssh alias for root work when this login has no sudo: `lf server config --root-login`. Tried before root and admin. */
  rootAlias?: string;
  /** The cloud provider, where the user set it: an id from facts.ts CLOUDS, or "none". Unset: detected on the server. */
  cloud?: string;
  /** Traefik dashboard, remembered so re-running traefik setup keeps it. */
  dashboard?: { host: string; user: string; htpasswd: string };
}

/** landfall's defaults for every server (`lf config`); a server's own setting wins. */
export interface Defaults {
  /** New sites get no domain unless one is given. */
  tunnelOnly?: boolean;
  /** Let's Encrypt contact for servers that set none. */
  email?: string;
  /** Releases a deploy keeps for rollback. */
  keep?: number;
}

export interface Config {
  default?: string;
  defaults?: Defaults;
  servers: Record<string, Server>;
}

export const DEFAULT_KEEP = 5;
export const defaults = (): Defaults => loadConfig().defaults ?? {};
/** Whether new sites on s get no domain: its own setting, else landfall's default. */
export const isTunnelOnly = (s: Server) => s.tunnelOnly ?? defaults().tunnelOnly ?? false;

/** $LANDFALL_<name>. */
export const envVar = (name: string) => process.env[`LANDFALL_${name}`];

const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
export const configDir = envVar("CONFIG_DIR") ?? join(configHome, "landfall");
export const CONFIG_PATH = join(configDir, "config.json");

export const expandHome = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

/** Shorten to ~/… only against the passwd home: that is what ssh expands `~` to, not $HOME. */
export const tildify = (p: string) => {
  const home = homedir();
  return p.startsWith(home + "/") ? "~" + p.slice(home.length) : p;
};

export function loadConfig(): Config {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as Config;
    cfg.servers ??= {};
    return cfg;
  } catch (e: any) {
    if (e.code === "ENOENT") return { servers: {} };
    return fail(`cannot read ${CONFIG_PATH}: ${e.message}`);
  }
}

/**
 * Write to a temporary file, then rename: a reader (another lf job) never sees half a file.
 * A symlinked file (a dotfiles repo) stays a link; an existing file keeps its mode.
 */
export function writeAtomic(file: string, data: string, mode?: number) {
  // stat follows a symlink: the mode is the target's, and the target is what gets replaced.
  const st = fs.statSync(file, { throwIfNoEntry: false });
  const real = st ? fs.realpathSync(file) : file;
  const tmp = `${real}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: st ? st.mode & 0o777 : (mode ?? 0o644) });
  fs.renameSync(tmp, real);
}

/** Serialize the entire read-modify-write, not just the final rename. Never await in the mutator. */
export async function updateConfig(mutate: (cfg: Config) => unknown, timeout = 5000): Promise<Config> {
  fs.mkdirSync(dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
  const real = fs.existsSync(CONFIG_PATH) ? fs.realpathSync(CONFIG_PATH) : join(fs.realpathSync(dirname(CONFIG_PATH)), basename(CONFIG_PATH));
  const lock = real + ".lock";
  const owner = JSON.stringify({ id: randomUUID(), pid: process.pid, at: new Date().toISOString() });
  const until = Date.now() + timeout;
  for (;;) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      break;
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
      if (Date.now() >= until)
        fail(`local config is locked: ${lock}. Check that no landfall writer is active before removing an abandoned lock; config was not saved.`);
      await delay(25);
    }
  }
  try {
    fs.writeFileSync(join(lock, "owner.json"), owner, { mode: 0o600 });
    const cfg = loadConfig();
    const result = mutate(cfg);
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      // Also consume rejected async callbacks: refusing one must not cause an unhandled rejection.
      void Promise.resolve(result).catch(() => {});
      fail("config mutations must be synchronous");
    }
    writeAtomic(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", 0o600);
    return cfg;
  } finally {
    // A manually removed/replaced lock is no longer ours to release.
    let stillOurs = false;
    try {
      stillOurs = fs.readFileSync(join(lock, "owner.json"), "utf8") === owner;
    } catch {}
    if (stillOurs) fs.rmSync(lock, { recursive: true, force: true });
  }
}

/** Commit only fields changed by a long operation; refuse overlapping edits or a removed entry. */
export function patchServer(cfg: Config, name: string, before: Server | undefined, next: Server): Server {
  const current = cfg.servers[name];
  const conflict = () =>
    fail(`local configuration for ${name} changed during this command; not saved. Review it before retrying; remote work was not reverted.`);
  if (before && !current) conflict();
  if (!before && current && !isDeepStrictEqual(current, next)) conflict();
  const merged = { ...current } as Server;
  for (const key of new Set([...Object.keys(before ?? {}), ...Object.keys(next)]) as Set<keyof Server>) {
    if (isDeepStrictEqual(before?.[key], next[key])) continue;
    if (!isDeepStrictEqual(current?.[key], before?.[key]) && !isDeepStrictEqual(current?.[key], next[key])) conflict();
    if (next[key] === undefined) delete merged[key];
    else Object.assign(merged, { [key]: next[key] });
  }
  cfg.servers[name] = merged;
  return merged;
}

/** Drop a server from the config (and as the default). */
export async function forgetServer(name: string) {
  await updateConfig((cfg) => {
    delete cfg.servers[name];
    if (cfg.default === name) delete cfg.default;
  });
}

/** Make a server the default, registering an ssh alias as it is. */
export async function useServer(name: string) {
  await updateConfig((cfg) => {
    cfg.servers[name] ??= { host: name };
    cfg.default = name;
  });
}

/**
 * Resolve a server by name: landfall config first, then any ~/.ssh/config alias.
 * With no name: the default server, or the only one configured.
 */
export function resolveServer(name?: string): { name: string; server: Server } {
  const cfg = loadConfig();
  name ??= cfg.default;
  if (!name) {
    const names = Object.keys(cfg.servers);
    if (names.length === 1) name = names[0];
    else if (names.length === 0) fail("no server given. Use --server <ssh-alias> or `lf server add`");
    else fail(`several servers configured (${names.join(", ")}); pick one with --server or \`lf server use\``);
  }
  if (!/^[A-Za-z0-9._@:[\]-]+$/.test(name!) || name!.startsWith("-")) fail(`not a server name: ${name}`);
  const server = cfg.servers[name!] ?? { host: name! };
  return { name: name!, server };
}

/** A name landfall writes into ~/.ssh: a `Host` line and the key file `landfall_<name>`. */
export const checkAlias = (name: string) => {
  if (!/^[A-Za-z0-9_@:[\]][A-Za-z0-9._@:[\]-]*$/.test(name)) fail(`not a server name: ${name} (letters, digits and . _ - @ : only)`);
  return name;
};

export const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/** Basic-auth and dashboard logins: the web UI checks its forms with these too. */
export const LOGIN_NAME = /^[A-Za-z0-9._@-]{1,64}$/;
export const MIN_PASSWORD = 8;

export const checkLoginName = (user: string, flag = "user") => {
  if (!LOGIN_NAME.test(user)) fail(`${flag} may only have letters, digits and . _ @ -`);
  return user;
};

/** The Let's Encrypt contact; it lands in Traefik's command line, so no spaces or quotes. */
export const checkEmail = (e: string) => {
  if (!/^[^\s@"'`$\\]+@[^\s@"'`$\\]+\.[^\s@"'`$\\]+$/.test(e)) fail(`not an e-mail address: ${e}`);
  return e;
};

/** A main domain as typed (`*.example.com` too), lower-cased; fails on anything else. */
export const checkDomain = (d: string) => {
  const domain = d.trim().toLowerCase().replace(/^\*\./, "");
  if (!DOMAIN.test(domain)) fail(`not a domain: ${d}`);
  return domain;
};

/** A Docker image reference; nothing a shell or YAML would read specially. */
const IMAGE = /^[a-z0-9][a-z0-9._\-/:@]*$/i;

export const checkImage = (image: string) => (IMAGE.test(image) ? image : fail(`not an image: ${image}`));

/** A whole number from a flag or .landfall.json, within [min, max]; fails otherwise. */
export function checkInt(v: unknown, what: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const n = typeof v === "number" ? v : /^\s*\d+\s*$/.test(String(v)) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < min || n > max)
    fail(`${what} must be a whole number from ${min}${max < Number.MAX_SAFE_INTEGER ? ` to ${max}` : " up"}, got ${v}`);
  return n;
}

/** list with add appended and rm taken out, without duplicates. */
export const editList = (list: string[], add: string[], rm: string[]) => [...new Set([...list, ...add])].filter((d) => !rm.includes(d));
/** The main domains with `d` (if given) first. */
export const withPrimary = (domains: string[] | undefined, d?: string) => (d ? [...new Set([d, ...(domains ?? [])])] : domains);

/** The primary main domain, if any. */
export const mainDomain = (s: Server) => s.domains?.[0];

/** `@` → the primary main domain, `blog` → `blog.<primary main domain>`; anything with a dot stays as it is. */
export function expandDomain(d: string, server: Server): string {
  return expandHost(d, mainDomain(server)) ?? fail("`@` means the main domain, but none is set: lf server domain <server> <domain>");
}

/** Free wildcard-DNS services: never a main domain. */
const FREE_DNS = new Set(["sslip.io", "nip.io", "traefik.me", "localhost"]);

const SECOND_LEVEL = new Set(["ac", "co", "com", "edu", "go", "gob", "gov", "ltd", "mil", "ne", "net", "nom", "or", "org", "plc", "sch"]);

/** The base domain of a host name: the last two labels, three for `co.uk`-style suffixes. */
export const baseDomain = (host: string) => {
  const l = host.toLowerCase().split(".");
  const n = l.length >= 3 && l.at(-1)!.length === 2 && SECOND_LEVEL.has(l.at(-2)!) ? 3 : 2;
  return l.slice(-n).join(".");
};

/** Base domains that at least two routed hosts share, most used first: main-domain suggestions. */
export function guessDomains(hosts: string[]): { domain: string; hosts: number }[] {
  const count = new Map<string, number>();
  for (const h of new Set(hosts.map((h) => h.toLowerCase()))) {
    if (!DOMAIN.test(h)) continue;
    const base = baseDomain(h);
    if (!FREE_DNS.has(base)) count.set(base, (count.get(base) ?? 0) + 1);
  }
  return [...count]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([domain, hosts]) => ({ domain, hosts }));
}

/** Project file that remembers how a directory was deployed, so `lf deploy` alone redeploys. */
export const PROJECT_FILE = ".landfall.json";

export interface ProjectConfig {
  name: string;
  server?: string;
  domains: string[];
  /** Hosts that redirect permanently to the first of `domains` (www.example.com); never inherited by environments. */
  redirects?: string[];
  /** The compose file to deploy (default: compose.yaml, or the one `docker compose` would pick). */
  compose?: string;
  /** Without a compose file: the static folder or Dockerfile folder to deploy. */
  dir?: string;
  spa?: boolean;
  static?: boolean;
  image?: string;
  /** Image: sent from this machine's Docker on each deploy, not pulled from a registry. */
  sendImage?: boolean;
  port?: number;
  /** Static: runs locally before the upload. A Node.js app: runs on the server, in its image. */
  build?: string;
  /** A Node.js app without a Dockerfile: its start command (default: the framework's). */
  start?: string;
  /** App, Dockerfile or image: folders in the container that outlive deploys (named volumes). */
  volumes?: string[];
  /** App, Dockerfile or image: runs without a port or a domain (a bot, a queue consumer). */
  worker?: boolean;
  /** Upload: also leave out what the folder's .gitignore files ignore. */
  gitignore?: boolean;
  /** Upload: what else to leave out, in .gitignore's syntax relative to this folder (dist/, *.log, /content). */
  exclude?: string[];
  /** Upload: what to send though the defaults, exclude or .gitignore leave it out. A folder left out is not looked into: include it, not a file in it. */
  include?: string[];
  /** Images are built on this machine and sent to the server, which then only runs them. */
  buildLocal?: boolean;
  /** Lifecycle hooks as shell commands: hook name → a command or a list of them (package.json's landfall.hooks name npm scripts instead). */
  hooks?: Record<string, string | string[]>;
  /** The compose service `hooks` run in on the server (default: the one serving the site's domains); package.json's landfall.service is its hooks'. */
  hookService?: string;
  /** Which git refs may deploy (branch/tag globs), and the repository's URL. An environment's rule is its own: never inherited. */
  git?: GitConfig;
  /** Named targets (staging…): the same project deployed again as its own site, with what differs here. */
  environments?: Record<string, EnvironmentConfig>;
}

/** An environment: its name (default <name>-<env>), server, domains and redirects (never inherited) and any other setting. */
export type EnvironmentConfig = Partial<Omit<ProjectConfig, "environments">>;

export const ENV_NAME = ENVIRONMENT_NAME;

/** The environment picked with -E/--environment or LANDFALL_ENV; "" is the project itself. */
export function activeEnvironment(): string {
  const e = process.env.LANDFALL_ENV?.trim() ?? "";
  if (e && !ENV_NAME.test(e)) fail(`"${e}" cannot name an environment: use lowercase letters, digits and -`);
  return e;
}

/** A site name in an environment. */
export const envSiteName = (name: string, env = activeEnvironment()) => (env ? `${name}-${env}` : name);

/** The project file in a directory. */
const projectFile = (cwd: string) => join(cwd, PROJECT_FILE);

const packages = new Map<string, { stamp: string; read: PackageRead }>();
type PackageRead = { text: string; pkg?: any; error?: string };

/**
 * The package.json in `cwd`, parsed (or why not), undefined without one. A deploy reads it for its settings,
 * its kind and its hooks: it is parsed again only when the file changed. Shared: never change what it returns.
 */
export function readPackage(cwd: string): PackageRead | undefined {
  const file = resolve(cwd, "package.json");
  let stamp: string;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return undefined;
    stamp = `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    return undefined;
  }
  const hit = packages.get(file);
  if (hit?.stamp === stamp) return hit.read;
  let read: PackageRead;
  try {
    const text = fs.readFileSync(file, "utf8");
    try {
      read = { text, pkg: JSON.parse(text) };
    } catch (e: any) {
      read = { text, error: String(e?.message ?? e) };
    }
  } catch {
    return undefined;
  }
  packages.set(file, { stamp, read });
  return read;
}

/**
 * package.json's "landfall" section, if it has one. It holds any key of .landfall.json; its hooks name npm
 * scripts, where .landfall.json's are shell commands. A broken package.json without the section is the build's business, not landfall's.
 * Returns package.json, parsed, with its "landfall" section checked; undefined without that section.
 */
export function packageJson(cwd: string): { pkg: any; section: Record<string, any> } | undefined {
  const read = readPackage(cwd);
  if (!read) return undefined;
  if (read.error !== undefined) return read.text.includes('"landfall"') ? fail(`could not read package.json: ${read.error}`) : undefined;
  const pkg = read.pkg;
  const section = pkg?.landfall;
  if (section === undefined) return undefined;
  if (!section || typeof section !== "object" || Array.isArray(section))
    fail('package.json: "landfall" must be an object, like { "name": "blog", "hooks": { "predeploy": "test" } }');
  return { pkg, section };
}

/** The project settings in package.json's "landfall" section: all of it but the hooks (npm scripts) and their service, read by readHooks. */
function packageProject(cwd: string): Partial<ProjectConfig> | undefined {
  const { hooks: _h, service: _s, ...rest } = packageJson(cwd)?.section ?? {};
  return Object.keys(rest).length ? rest : undefined;
}

function readFile(cwd: string): ProjectConfig | undefined {
  try {
    return JSON.parse(fs.readFileSync(projectFile(cwd), "utf8"));
  } catch (e: any) {
    // A broken file must not look like none: deploy would pick another name and overwrite it.
    if (e.code === "ENOENT") return undefined;
    return fail(`cannot read ${projectFile(cwd)}: ${e.message}`);
  }
}

/** package.json's "landfall" settings with .landfall.json's on top, key by key: both files, read once. */
export function readProjectFiles(cwd: string): ProjectConfig | undefined {
  const [pkg, file] = [packageProject(cwd), readFile(cwd)];
  return pkg || file ? ({ ...pkg, ...file } as ProjectConfig) : undefined;
}

/** Where a folder's project settings come from: .landfall.json, package.json, or both. */
export const projectSources = (cwd: string) =>
  [fs.existsSync(projectFile(cwd)) && PROJECT_FILE, packageProject(cwd) && "package.json"].filter((f): f is string => !!f);

/** The settings of a project folder, or of one of its environments: the project's with the environment's on top. */
export function loadProject(cwd: string, env = activeEnvironment()): ProjectConfig | undefined {
  return projectFor(readProjectFiles(cwd), env);
}

/** The settings of one environment ("" the project) from what readProjectFiles read: no file read. */
export function projectFor(raw: ProjectConfig | undefined, env: string): ProjectConfig | undefined {
  if (!env || !raw) return raw;
  const { environments, ...base } = raw;
  const own = environments?.[env] ?? {};
  // The repository is the project's; the rule is the environment's own.
  const url = own.git?.url ?? base.git?.url;
  const git = own.git || url ? { ...own.git, ...(url && { url }) } : undefined;
  return { ...base, domains: [], redirects: undefined, ...own, git, name: own.name ?? envSiteName(base.name, env) };
}

/** Every environment's git rule, the project's own under "". */
export function gitRules(cwd: string, raw = readProjectFiles(cwd)): Record<string, GitConfig | undefined> {
  if (!raw) return {};
  const { url: _, ...base } = raw.git ?? {};
  return { "": Object.keys(base).length ? base : undefined, ...Object.fromEntries(Object.entries(raw.environments ?? {}).map(([e, c]) => [e, c.git])) };
}

/** Sets (or with undefined, drops) the git rule of the project ("") or of one environment, keeping the URL and everything else. */
export function saveGitRule(cwd: string, env: string, rule: RefRule | undefined, url?: string) {
  const file = readFile(cwd) ?? ({} as Partial<ProjectConfig>);
  if (!readProjectFiles(cwd)) fail(`no ${PROJECT_FILE} here: deploy once (lf deploy), or lf init, first`);
  const keep = (g: GitConfig | undefined, setUrl: boolean): GitConfig | undefined => {
    const next: GitConfig = { ...(g?.url && { url: g.url }), ...rule };
    if (setUrl && url) next.url = url;
    return Object.keys(next).length ? next : undefined;
  };
  if (!env) {
    file.git = keep(file.git, true);
    if (!file.git) delete file.git;
  } else {
    if (url) file.git = { ...file.git, url };
    const envs = { ...file.environments };
    const own: EnvironmentConfig = { ...envs[env] };
    own.git = keep(own.git, false);
    if (!own.git) delete own.git;
    envs[env] = own;
    file.environments = envs;
  }
  writeAtomic(projectFile(cwd), JSON.stringify(file, null, 2) + "\n");
}

/** The environment of a project folder that deploys this site ("" the project itself), if any. */
export function environmentOf(cwd: string, site: string): string | undefined {
  const raw = readProjectFiles(cwd);
  if (!raw) return undefined;
  if (raw.name === site) return "";
  return Object.keys(raw.environments ?? {}).find((e) => loadProject(cwd, e)?.name === site);
}

/** The server from --server, else the one in ./.landfall.json, else the default. */
export const projectServer = (server?: string) => resolveServer(server ?? loadProject(process.cwd())?.server);

/** Writes a project's settings; in an environment only what differs from the project goes in its block. */
export function saveProject(cwd: string, p: ProjectConfig, env = activeEnvironment()) {
  const raw = readProjectFiles(cwd);
  // git is written by hand or by lf git track: a deploy keeps it as it is.
  const { environments: _, git: _g, ...next } = p;
  let out: ProjectConfig;
  if (!env) out = { ...next, ...(raw?.git && { git: raw.git }), ...(raw?.environments ? { environments: raw.environments } : {}) };
  else {
    // First deploy of the folder is an environment's: the project itself gets the name without the suffix.
    const { environments, ...base } = raw ?? { name: p.name.replace(new RegExp(`-${env}$`), ""), server: p.server, domains: [] };
    const own: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(next)) if (k === "domains" || k === "redirects" || JSON.stringify(v) !== JSON.stringify((base as any)[k])) own[k] = v;
    if (own.name === envSiteName(base.name, env)) delete own.name;
    if (environments?.[env]?.git) own.git = environments[env].git;
    out = { ...base, environments: { ...environments, [env]: own } };
  }
  // What package.json's "landfall" already says stays there; .landfall.json gets the rest.
  const pkg: Record<string, unknown> = packageProject(cwd) ?? {};
  const own = Object.fromEntries(Object.entries(out).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(pkg[k])));
  if (!Object.keys(own).length && !fs.existsSync(projectFile(cwd))) return;
  writeAtomic(projectFile(cwd), JSON.stringify(own, null, 2) + "\n");
}
