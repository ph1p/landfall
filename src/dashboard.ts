import { loadConfig, resolveServer } from "./config";
import { effectiveSsh, sshAliases } from "./sshconfig";

/** What the dashboards (terminal and web) share. */

export interface Entry {
  name: string;
  registered: boolean;
  isDefault: boolean;
}

/** ssh config entries for git hosting, not servers. */
const GIT_HOSTS = /^(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org)$/;

export function listServers(): Entry[] {
  const cfg = loadConfig();
  const own = Object.keys(cfg.servers).map((name) => ({ name, registered: true, isDefault: cfg.default === name }));
  const aliases = sshAliases()
    .filter((a) => !cfg.servers[a] && !GIT_HOSTS.test(a))
    .map((name) => ({ name, registered: false, isDefault: false }));
  return [...own, ...aliases];
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
