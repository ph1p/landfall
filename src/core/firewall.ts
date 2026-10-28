import type { Server } from "./config";
import { enableBlocks, parseRule, probeServer, reachability, ruleFor, type Probe, type Reach, type Rule } from "./inventory";
import { effectiveSsh } from "./sshconfig";
import { rootLogin } from "./privilege";
import { confirmRisky, fail } from "./term";

export interface FirewallState {
  /** The login that may change the firewall: the server's own if it has sudo, else root. */
  login: Server;
  ufw: "active" | "inactive" | "missing";
  /** Default for incoming traffic: DROP, REJECT or ACCEPT. */
  policy: string;
  sshPort: number;
  rules: Rule[];
  ports: Reach[];
  /** What `firewall enable` would cut off. */
  blocked: string[];
  probe: Probe;
}

/** Reads the firewall as root or with sudo; a deploy user without sudo falls back to root's key login. */
export async function firewallState(server: Server): Promise<FirewallState> {
  let login = server;
  let probe = await probeServer(login);
  if (probe.values.sudo !== "1") {
    // The probe already showed no sudo: straight to the logins that may have it.
    login = (await rootLogin(server)) ?? fail("the firewall needs root or passwordless sudo, and root's key login does not work");
    probe = await probeServer(login);
  }
  const v = probe.values;
  const sshPort = Number(v.ssh_port) || effectiveSsh(server).port;
  return {
    login,
    ufw: v.ufw === "active" ? "active" : v.ufw === "missing" ? "missing" : "inactive",
    policy: v.ufw_in || "DROP",
    sshPort,
    rules: probe.rules.map(parseRule),
    ports: reachability(probe),
    blocked: enableBlocks(probe, [sshPort]).blocked,
    probe,
  };
}

/** Refuses a change that leaves ssh blocked while ufw is on, unless --force or the user says so. */
export async function guardSsh(fw: FirewallState, after: Rule[], force?: boolean) {
  if (fw.ufw !== "active") return;
  const ssh = { proto: "tcp" as const, port: fw.sshPort };
  const r = ruleFor(after, ssh)?.rule;
  if (r && (r.action === "allow" || r.action === "limit") && !r.from) return;
  const why = r?.from ? `only ${r.from} could still reach ssh port ${fw.sshPort}` : `this blocks ssh port ${fw.sshPort} and can lock you out`;
  if (force || (await confirmRisky(`${why}. Do it anyway?`))) return;
  fail(`${why} (--force to do it anyway)`);
}
