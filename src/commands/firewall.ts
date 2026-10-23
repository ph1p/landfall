import { defineCommand, serverOpt } from "../cmd";
import { resolveServer, type Server } from "../config";
import { enableBlocks, parseRule, probeServer, reachability, ruleFor, type Probe, type Reach, type Rule } from "../inventory";
import { canLogin, runScript, shq } from "../ssh";
import { effectiveSsh } from "../sshconfig";
import { PRELUDE } from "../templates";
import { c, confirm, confirmRemoval, confirmRisky, fail, info, ok, step, table, warn } from "../ui";

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
    const root = { ...server, user: "root" };
    if (effectiveSsh(server).user === "root" || !(await canLogin(root))) {
      fail(`the firewall needs root or passwordless sudo; ${effectiveSsh(server).user} has no sudo and root's key login does not work`);
    }
    login = root;
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

const PORT = /^\d+(:\d+)?(,\d+(:\d+)?)*(\/(tcp|udp))?$/;
const ADDR = /^[0-9a-fA-F.:]+(\/\d+)?$/;

interface NewRule {
  action: Rule["action"];
  port: string;
  from?: string;
  comment?: string;
}

/** ufw arguments for a rule; ufw only takes port lists and ranges with a protocol. */
export function ruleArgs(r: NewRule): string[] {
  if (!PORT.test(r.port)) fail(`not a port: ${r.port} (e.g. 5432, 51820/udp, 6000:6007/tcp)`);
  const [port, proto] = r.port.split("/");
  if (port.split(/[,:]/).some((x) => Number(x) < 1 || Number(x) > 65535)) fail(`ports go from 1 to 65535: ${port}`);
  if (/[,:]/.test(port) && !proto) fail(`ufw needs a protocol for port lists and ranges: ${port}/tcp or ${port}/udp`);
  if (r.from && !ADDR.test(r.from)) fail(`not an address or network: ${r.from} (e.g. 203.0.113.7 or 10.0.0.0/8)`);
  const args = r.from ? [r.action, "from", r.from, "to", "any", "port", port, ...(proto ? ["proto", proto] : [])] : [r.action, r.port];
  return r.comment ? [...args, "comment", r.comment] : args;
}

const ufwAdd = (args: string[]) => `ufw_add ${args.map(shq).join(" ")}`;
/** Adds a rule; a deny goes first so it wins over an allow for the same port (ufw rejects prepend on an empty list). */
const addRule = (args: string[]) => (args[0] === "deny" ? `${ufwAdd(["prepend", ...args])} 2>/dev/null || ${ufwAdd(args)}` : ufwAdd(args));
/** Journals the delete of an existing rule with the shell that adds it back. */
const deleteRule = (r: Rule) =>
  `$SUDO ufw --force delete ${r.spec} >/dev/null
record ${shq(`ufw delete ${r.spec}`)} ${shq(`$SUDO ufw ${r.action === "allow" || r.action === "limit" ? "" : "prepend "}${r.spec} >/dev/null 2>&1 || $SUDO ufw ${r.spec} >/dev/null`)}`;
/** The rule as `ufw show added` would print it. */
const asRule = (args: string[]) => parseRule(args.map((a, i) => (args[i - 1] === "comment" ? `'${a}'` : a)).join(" "));
const NEEDS_UFW = `command -v ufw >/dev/null || { echo "ufw is not installed (lf firewall enable installs it)" >&2; exit 1; }`;

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

function pick(fw: FirewallState, which: string): { rule: Rule; n: number } {
  const n = /^\d+$/.test(which) ? Number(which) : fw.rules.findIndex((r) => r.spec === which) + 1;
  if (!fw.rules[n - 1]) fail(`no rule ${which}; \`lf firewall\` lists them (${fw.rules.length} rules)`);
  return { rule: fw.rules[n - 1], n };
}

const ruleOpts = {
  server: serverOpt,
  from: { type: "string", desc: "only from this address or network (e.g. 10.0.0.0/8)" },
  comment: { type: "string", desc: "note stored with the rule" },
} as const;

function addCommand(action: "allow" | "deny") {
  return defineCommand({
    name: `firewall ${action}`,
    args: "<port[/proto]>",
    summary:
      action === "allow"
        ? "Open a port in ufw, e.g. `lf firewall allow 5432 --from 10.0.0.0/8` or `lf firewall allow 51820/udp`."
        : "Block a port in ufw, e.g. `lf firewall deny 5432`. Goes before the other rules, so it wins over an allow.",
    options: { ...ruleOpts, force: { type: "boolean", desc: "even if it blocks ssh" } },
    async run([port], o) {
      if (!port) fail(`usage: lf firewall ${action} <port[/proto]> [--from ip]`);
      const args = ruleArgs({ action, port, from: o.from, comment: o.comment });
      const fw = await firewallState(resolveServer(o.server).server);
      if (action === "deny") await guardSsh(fw, [asRule(args), ...fw.rules], o.force);
      await runScript(fw.login, `${PRELUDE}\n${NEEDS_UFW}\n${addRule(args)}`);
      ok(`${args.join(" ")}${fw.ufw === "active" ? "" : c.dim(" (takes effect once the firewall is on: lf firewall enable)")}`);
    },
  });
}

export const firewallAllow = addCommand("allow");
export const firewallDeny = addCommand("deny");

export const firewallStatus = defineCommand({
  name: "firewall status",
  summary: "Show the firewall (ufw): on or off, its rules, and who can reach each listening port.",
  options: { server: serverOpt, json: { type: "boolean", desc: "machine-readable output" } },
  async run(_, o) {
    const { name, server } = resolveServer(o.server);
    const fw = await firewallState(server);
    if (o.json) {
      const { ufw, policy, sshPort, rules, ports, blocked } = fw;
      console.log(JSON.stringify({ ufw, policy, sshPort, rules: rules.map((r, i) => ({ n: i + 1, ...r })), ports, blocked }, null, 2));
      return;
    }
    const state = fw.ufw === "active" ? c.green("on") : fw.ufw === "missing" ? c.yellow("not installed") : c.yellow("off");
    step(`firewall on ${name}: ${state}${fw.ufw === "active" ? c.dim(` · incoming default ${fw.policy.toLowerCase()}`) : ""}`);
    console.log(`\n${c.bold("Rules")}`);
    if (!fw.rules.length) info(c.dim("none"));
    table(fw.rules.map((r, i) => [`  ${i + 1}`, r.action === "allow" || r.action === "limit" ? c.green(r.action) : c.red(r.action), r.spec.replace(/^\S+\s+/, "")]));
    console.log(`\n${c.bold("Listening ports")}`);
    const color = { open: c.green, limited: c.yellow, blocked: c.red, local: c.dim };
    table(fw.ports.map((p) => [`  ${p.port}`, p.proc, color[p.state](p.why)]));
    if (fw.ufw !== "active") {
      console.log();
      if (fw.blocked.length) warn(`enabling would block ${fw.blocked.join(", ")}: allow them first`);
      else info(c.dim(`lf firewall enable turns it on (ssh port ${fw.sshPort} stays open)`));
    }
  },
});

export const firewallEnable = defineCommand({
  name: "firewall enable",
  summary: "Turn ufw on (installs it if missing). Always allows the ssh port first; refuses if it would block a port in use.",
  options: { server: serverOpt, force: { type: "boolean", desc: "turn it on even if it blocks ports in use" } },
  async run(_, o) {
    const { name, server } = resolveServer(o.server);
    const fw = await firewallState(server);
    if (fw.ufw === "active") return ok(`firewall on ${name} is already on`);
    if (fw.blocked.length) {
      const why = `turning the firewall on would block ${fw.blocked.join(", ")}`;
      if (!(o.force || (await confirmRisky(`${why}. Turn it on anyway?`)))) fail(`${why}. Allow them first (lf firewall allow <port>), or --force`);
    }
    // The ssh allow is appended, so a deny added while ufw was off would still win once it is on.
    await guardSsh({ ...fw, ufw: "active" }, [...fw.rules, asRule(["allow", `${fw.sshPort}/tcp`])], o.force);
    await runScript(
      fw.login,
      `${PRELUDE}
command -v ufw >/dev/null || { log "installing ufw"; pkg_install ufw; record "installed ufw"; }
${ufwAdd(["allow", `${fw.sshPort}/tcp`])}
ufw_enable`,
    );
    ok(`firewall on ${name} is on; ssh port ${fw.sshPort} allowed`);
  },
});

export const firewallDisable = defineCommand({
  name: "firewall disable",
  summary: "Turn ufw off. Rules are kept and apply again after `lf firewall enable`.",
  options: { server: serverOpt },
  async run(_, o) {
    const { name, server } = resolveServer(o.server);
    const fw = await firewallState(server);
    if (fw.ufw !== "active") return ok(`firewall on ${name} is already off`);
    if (!(await confirm(`Turn the firewall on ${name} off? Every listening port becomes reachable.`, false))) fail("cancelled");
    await runScript(fw.login, `${PRELUDE}\n$SUDO ufw disable\nrecord "disabled ufw" '$SUDO ufw --force enable >/dev/null'`);
    ok(`firewall on ${name} is off (${fw.rules.length} rules kept)`);
  },
});

export const firewallRemove = defineCommand({
  name: "firewall rm",
  args: "<number|rule>",
  summary: "Remove a rule by its number in `lf firewall`, or by its text (e.g. 'allow 5432').",
  options: { server: serverOpt, force: { type: "boolean", desc: "even if it blocks ssh" } },
  async run([which], o) {
    if (!which) fail("usage: lf firewall rm <number|rule>");
    const { name, server } = resolveServer(o.server);
    const fw = await firewallState(server);
    const { rule, n } = pick(fw, which);
    await guardSsh(fw, fw.rules.filter((r) => r !== rule), o.force);
    await confirmRemoval(`Remove rule ${n} (${rule.spec}) on ${name}?`);
    await runScript(fw.login, `${PRELUDE}\n${NEEDS_UFW}\n${deleteRule(rule)}`);
    ok(`removed rule ${n}: ${rule.spec}`);
  },
});

export const firewallUpdate = defineCommand({
  name: "firewall update",
  args: "<number|rule>",
  summary: "Change a rule: what you pass replaces that part, the rest stays. If ufw rejects the new rule, the old one is restored.",
  options: {
    ...ruleOpts,
    port: { type: "string", desc: "port[/proto], e.g. 5432 or 51820/udp" },
    from: { type: "string", desc: "only from this address or network; 'any' for everyone" },
    action: { type: "string", desc: "allow, deny or limit" },
    force: { type: "boolean", desc: "even if it blocks ssh" },
  },
  async run([which], o) {
    if (!which) fail("usage: lf firewall update <number|rule> [--port p] [--from ip|any] [--action allow|deny|limit]");
    const fw = await firewallState(resolveServer(o.server).server);
    const { rule, n } = pick(fw, which);
    const action = o.action ?? rule.action;
    if (!["allow", "deny", "limit"].includes(action)) fail(`--action must be allow, deny or limit, not ${action}`);
    const port = o.port ?? (rule.port && (rule.proto ? `${rule.port}/${rule.proto}` : rule.port));
    if (!port) fail(`rule ${n} (${rule.spec}) names no port; pass --port`);
    const from = o.from === "any" ? undefined : (o.from ?? rule.from);
    const args = ruleArgs({ action, port, from, comment: o.comment ?? rule.comment });
    const others = fw.rules.filter((r) => r !== rule);
    await guardSsh(fw, action === "deny" ? [asRule(args), ...others] : [...others, asRule(args)], o.force);
    // Removing first keeps ufw from skipping the new rule as a duplicate; open connections (this ssh) survive it.
    await runScript(
      fw.login,
      `${PRELUDE}
${NEEDS_UFW}
${deleteRule(rule)}
${addRule(args)} || { $SUDO ufw ${rule.spec} >/dev/null; record "restored ufw ${rule.spec}"; echo "kept rule ${n}" >&2; exit 1; }`,
    );
    ok(`rule ${n}: ${rule.spec} → ${args.join(" ")}`);
  },
});
