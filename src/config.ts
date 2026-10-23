import fs from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { adoptOldConfig, OLD_PROJECT_FILE, oldEnv } from "./legacy";
import { fail } from "./ui";

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
  /**
   * Main domains. The first is the primary: sites default to <site>.<primary>, and a bare
   * name like `blog` means blog.<primary>. The others are listed and DNS-checked too.
   */
  domains?: string[];
  /** Traefik dashboard, remembered so re-running traefik setup keeps it. */
  dashboard?: { host: string; user: string; htpasswd: string };
}

export interface Config {
  default?: string;
  servers: Record<string, Server>;
}

/** $LANDFALL_<name>. */
export const envVar = (name: string) => process.env[`LANDFALL_${name}`] ?? oldEnv(name);

const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
export const configDir = envVar("CONFIG_DIR") ?? join(configHome, "landfall");
export const CONFIG_PATH = join(configDir, "config.json");

if (!envVar("CONFIG_DIR")) adoptOldConfig(configHome, configDir);

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
    // Earlier versions kept a single `domain`.
    for (const s of Object.values(cfg.servers) as (Server & { domain?: string })[]) {
      if (s.domain) s.domains = [...new Set([s.domain, ...(s.domains ?? [])])];
      delete s.domain;
    }
    return cfg;
  } catch (e: any) {
    if (e.code === "ENOENT") return { servers: {} };
    return fail(`cannot read ${CONFIG_PATH}: ${e.message}`);
  }
}

export function saveConfig(cfg: Config) {
  fs.mkdirSync(dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
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
  const server = cfg.servers[name!] ?? { host: name! };
  return { name: name!, server };
}

export const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/** A main domain as typed (`*.example.com` too), lower-cased; fails on anything else. */
export const checkDomain = (d: string) => {
  const domain = d.trim().toLowerCase().replace(/^\*\./, "");
  if (!DOMAIN.test(domain)) fail(`not a domain: ${d}`);
  return domain;
};

/** A Docker image reference; nothing a shell or YAML would read specially. */
export const IMAGE = /^[a-z0-9][a-z0-9._\-/:@]*$/i;

export const checkImage = (image: string) => (IMAGE.test(image) ? image : fail(`not an image: ${image}`));

/** A whole number from a flag or .landfall.json, within [min, max]; fails otherwise. */
export function checkInt(v: unknown, what: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const n = typeof v === "number" ? v : /^\s*\d+\s*$/.test(String(v)) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) fail(`${what} must be a whole number from ${min}${max < Number.MAX_SAFE_INTEGER ? ` to ${max}` : " up"}, got ${v}`);
  return n;
}

/** The main domains with `d` (if given) first. */
export const withPrimary = (domains: string[] | undefined, d?: string) => (d ? [...new Set([d, ...(domains ?? [])])] : domains);

/** The primary main domain, if any. */
export const mainDomain = (s: Server) => s.domains?.[0];

/** `@` → the primary main domain, `blog` → `blog.<primary main domain>`; anything with a dot stays as it is. */
export function expandDomain(d: string, server: Server): string {
  const main = mainDomain(server);
  if (d === "@") return main ?? fail("`@` means the main domain, but none is set: lf server domain <server> <domain>");
  return !d.includes(".") && main ? `${d.toLowerCase()}.${main}` : d.toLowerCase();
}

/** Free wildcard-DNS services: never a main domain. */
const FREE_DNS = new Set(["sslip.io", "nip.io", "traefik.me", "localhost"]);

/** The base domain of a host name: the last two labels, three for `co.uk`-style suffixes. */
export const baseDomain = (host: string) => {
  const l = host.toLowerCase().split(".");
  const n = l.length >= 3 && l.at(-1)!.length === 2 && l.at(-2)!.length <= 3 ? 3 : 2;
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
  dir?: string;
  spa?: boolean;
  static?: boolean;
  image?: string;
  port?: number;
  build?: string;
}

/** The project file in a directory: .landfall.json, or the older one. */
export const projectFile = (cwd: string) => {
  const file = join(cwd, PROJECT_FILE);
  return fs.existsSync(file) || !fs.existsSync(join(cwd, OLD_PROJECT_FILE)) ? file : join(cwd, OLD_PROJECT_FILE);
};

export function loadProject(cwd: string): ProjectConfig | undefined {
  try {
    return JSON.parse(fs.readFileSync(projectFile(cwd), "utf8"));
  } catch {
    return undefined;
  }
}

export function saveProject(cwd: string, p: ProjectConfig) {
  fs.writeFileSync(join(cwd, PROJECT_FILE), JSON.stringify(p, null, 2) + "\n");
  fs.rmSync(join(cwd, OLD_PROJECT_FILE), { force: true });
}
