import { defineCommand, serverOpt } from "../cmd";
import { addKeyFirst, harden, HARDEN_PARTS, lockedOut, printAdvice, securityOf, type HardenPart } from "../security";
import { effectiveSsh } from "../sshconfig";
import { system } from "../system";
import { adminLogin } from "../updates";
import { c, confirm, fail, ok, report, table } from "../ui";
import { limitedNote, target } from "./system";

export const securityCmd = defineCommand({
  name: "security",
  summary: "Check a server's security (ssh passwords, firewall, fail2ban, automatic updates, pending reboot) and say how to fix what is open.",
  options: { server: serverOpt, json: { type: "boolean", desc: "machine-readable output" } },
  async run(_, o) {
    const { name, server } = target(o);
    const { advice, ...i } = await securityOf(name, server);
    if (o.json) return void console.log(JSON.stringify({ ...i.security, fail2ban: i.fail2ban, advice }, null, 2));
    const s = i.security;
    table([
      [c.dim("ssh login"), s.passwordLogin === undefined ? c.dim("unknown") : s.passwordLogin ? c.red("passwords and keys") : c.green("keys only")],
      [c.dim("root login"), s.rootLogin === undefined ? c.dim("unknown") : s.rootLogin === "yes" ? c.yellow("yes") : s.rootLogin === "no" ? "no" : "key only"],
      [c.dim("firewall"), s.firewall === undefined ? c.dim("unknown") : s.firewall === "active" ? c.green("on") : c.yellow(s.firewall === "missing" ? "no ufw" : "off")],
      [c.dim("fail2ban"), i.fail2ban === "running" ? c.green("running") : c.yellow(i.fail2ban === "missing" ? "not installed" : "stopped")],
      [c.dim("auto updates"), s.autoUpdates === undefined ? c.dim("unknown") : s.autoUpdates ? c.green("on") : c.yellow("off")],
      [c.dim("reboot"), s.reboot ? c.yellow("pending") : "not needed"],
    ]);
    report({ advice });
    console.log();
    if (advice.length) printAdvice(advice);
    else ok("nothing to fix");
    limitedNote(i);
  },
});

export const hardenCmd = defineCommand({
  name: "harden",
  args: "[ssh|fail2ban|updates…]",
  summary: `Close the usual holes; all three without arguments:
  ssh        keys only: no passwords, root by key only
  fail2ban   install and start it: bans addresses that keep failing to log in
  updates    install security updates automatically (apt, dnf)
Each change is journaled: lf undo takes it back.`,
  options: {
    server: serverOpt,
    force: { type: "boolean", desc: "turn ssh passwords off even if users without a key get locked out" },
  },
  async run(args, o) {
    const bad = args.filter((a) => !(HARDEN_PARTS as readonly string[]).includes(a));
    if (bad.length) fail(`unknown: ${bad.join(", ")} (ssh, fail2ban or updates)`);
    const parts = (args.length ? args : [...HARDEN_PARTS]) as HardenPart[];
    const { name, server } = target(o);
    const admin = await adminLogin(server, "hardening");
    if (parts.includes("ssh") && !o.force) {
      const locked = lockedOut(await system(admin), effectiveSsh(server).user);
      if (locked.length) {
        fail(`${addKeyFirst(locked)} Or --force.`);
      }
    }
    if (parts.includes("ssh") && !(await confirm(`Only keys log in to ${name} afterwards (lf undo turns passwords back on). Go on?`))) return;
    await harden(admin, parts);
    ok(`${name}: ${parts.join(", ")} hardened`);
  },
});
