import { loadConfig, resolveServer } from "./config";
import { reach, type Reach } from "./ssh";
import { effectiveSsh, sshAliases } from "./sshconfig";

/** What the dashboards (terminal and web) share. */

export interface Entry {
  name: string;
  registered: boolean;
  isDefault: boolean;
}

/** Git hosting, not servers: github.com, gitlab.example.org, ssh.dev.azure.com … */
const GIT_HOSTS = /(^|\.)(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org|sr\.ht|dev\.azure\.com|visualstudio\.com)$|^(git|gitlab|gitea|forgejo)\./i;

/** An ssh alias for a git host: by its name, the HostName it resolves to, or `User git`. */
function isGitHost(alias: string): boolean {
  if (GIT_HOSTS.test(alias)) return true;
  try {
    const eff = effectiveSsh({ host: alias });
    return eff.user === "git" || GIT_HOSTS.test(eff.hostname);
  } catch {
    return false;
  }
}

const LOOPBACK = /^(localhost|127(\.\d+){3}|::1|0:0:0:0:0:0:0:1)$/i;

/** An ssh alias for this machine (a Colima/Lima/OrbStack VM forwarded to 127.0.0.1): no public IP, not a server. */
function isLocalHost(alias: string): boolean {
  if (LOOPBACK.test(alias)) return true;
  try {
    return LOOPBACK.test(effectiveSsh({ host: alias }).hostname);
  } catch {
    return false;
  }
}

/** Registered servers, then ~/.ssh/config aliases that are neither git hosts nor this machine. */
export function listServers(): Entry[] {
  const cfg = loadConfig();
  const own = Object.keys(cfg.servers).map((name) => ({ name, registered: true, isDefault: cfg.default === name }));
  const aliases = sshAliases()
    .filter((a) => !cfg.servers[a] && !isGitHost(a) && !isLocalHost(a))
    .map((name) => ({ name, registered: false, isDefault: false }));
  return [...own, ...aliases];
}

const reached = new Map<string, { at: number; r: Promise<Reach> }>();
/** Results stay this long, so switching views does not log in again. */
const REACH_TTL = 30_000;

/** Whether each server takes landfall's ssh login: 8 at a time, cached for REACH_TTL unless fresh. */
export async function reachAll(names: string[], fresh = false): Promise<Record<string, Reach>> {
  const out: Record<string, Reach> = {};
  const queue = [...names];
  const worker = async () => {
    for (let n = queue.shift(); n !== undefined; n = queue.shift()) {
      let hit = reached.get(n);
      if (fresh || !hit || Date.now() - hit.at > REACH_TTL) {
        const r = (async () => {
          try {
            return await reach(resolveServer(n).server);
          } catch (e: any) {
            return { state: "down", detail: e.message, ms: 0 } as Reach;
          }
        })();
        reached.set(n, (hit = { at: Date.now(), r }));
      }
      out[n] = await hit.r;
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, names.length) }, worker));
  return out;
}

/** user@host[:port] as ssh would reach it. */
export function target(name: string): string {
  try {
    const eff = effectiveSsh(resolveServer(name).server);
    return `${eff.user}@${eff.hostname}${eff.port !== 22 ? `:${eff.port}` : ""}`;
  } catch {
    return "cannot resolve host";
  }
}

/** Whether a dashboard command changes the server, so its journal run is worth offering to undo. */
export function changes(argv: string[]): boolean {
  const [cmd, sub] = argv;
  if (argv.includes("--check") || argv.includes("--key-only")) return false;
  if (cmd === "firewall") return ["enable", "disable", "allow", "deny", "update", "rm", "remove"].includes(sub);
  if (cmd === "traefik") return sub === "setup" || sub === "use";
  if (cmd === "env") return argv.some((a) => a.includes("=") || a === "-u" || a === "--unset");
  if (cmd === "domains") return argv.some((a) => ["-a", "--add", "--rm", "--set"].includes(a));
  if (cmd === "auth") return argv.some((a) => ["-u", "--user", "--rm-user", "--off"].includes(a));
  if (cmd === "update" || cmd === "upgrade") return true;
  return ["setup", "deploy", "rollback", "stop", "start", "restart", "adopt"].includes(cmd);
}
