import { defineCommand, serverOpt } from "../cmd";
import { addKeyFirst, DEFAULT_HARDEN_PARTS, harden, HARDEN_PARTS, lockedOutOn, printAdvice, securityOf, type HardenPart } from "../../core/server/security";
import { effectiveSsh } from "../../core/ssh/sshconfig";
import { adminLogin } from "../../core/ssh/privilege";
import { c, confirm, fail, ok, report, table, printJson } from "../../core/lib/term";
import { limitedNote } from "./system";
import { serverTarget } from "../target";
import { HARDEN_INFO } from "../../core/server/harden-parts";

const partLines = (l: HardenPart[]) => l.map((p) => `  ${p.padEnd(12)} ${HARDEN_INFO[p].what}`).join("\n");

export const securityCmd = defineCommand({
  name: "security",
  summary:
    "Check a server's security (ssh, accounts, firewall, fail2ban, kernel settings, time sync, updates, site secrets, files in releases) and say how to fix what is open.",
  options: { server: serverOpt, json: { type: "boolean", desc: "machine-readable output" } },
  async run(_, o) {
    const { name, server } = serverTarget(o);
    const { advice, ...i } = await securityOf(name, server);
    if (o.json) return void printJson({ ...i.security, fail2ban: i.fail2ban, ntp: i.ntp, advice });
    const s = i.security;
    // A check that could not run (no root, no such tool) shows as unknown.
    const known = <T>(v: T | undefined, f: (v: T) => string) => (v === undefined ? c.dim("unknown") : f(v));
    const kernelLoose = advice.some((a) => a.id === "kernel");
    table([
      [
        c.dim("ssh login"),
        known(s.passwordLogin, (pw) =>
          pw
            ? c.red(s.keyLogin === false ? "passwords only" : "passwords and keys")
            : s.keyLogin === false
              ? c.red("none (keys and passwords off)")
              : c.green("keys only"),
        ),
      ],
      [c.dim("root login"), known(s.rootLogin, (r) => (r === "yes" ? c.yellow("yes") : r === "no" ? "no" : "key only"))],
      [c.dim("firewall"), known(s.firewall, (f) => (f === "active" ? c.green("on") : c.yellow(f === "missing" ? "no ufw" : "off")))],
      [c.dim("fail2ban"), i.fail2ban === "running" ? c.green("running") : c.yellow(i.fail2ban === "missing" ? "not installed" : "stopped")],
      [c.dim("auto updates"), known(s.autoUpdates, (on) => (on ? c.green("on") : c.yellow("off")))],
      [c.dim("security updates"), known(s.securityUpdates, (n) => (n ? c.yellow(`${n} waiting`) : "none"))],
      [c.dim("reboot"), s.reboot ? c.yellow("pending") : "not needed"],
      [
        c.dim("accounts"),
        known(s.emptyPasswordUsers, (empty) => {
          const bad = [empty.length && `${empty.length} without password`, s.uid0?.length && `${s.uid0.length} extra root`].filter(Boolean);
          return bad.length ? c.red(bad.join(", ")) : "ok";
        }),
      ],
      [c.dim("kernel"), known(s.kernel, () => (kernelLoose ? c.yellow("loose") : "ok"))],
      [c.dim("time sync"), known(i.ntp, (on) => (on ? "on" : c.yellow("off")))],
      [c.dim("site secrets"), known(s.openEnv, (l) => (l.length ? c.yellow(`${l.length} readable by others`) : "private"))],
      [c.dim("release files"), known(s.releaseFiles, (l) => (l.length ? c.yellow(`${l.length} to leave out`) : "ok"))],
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
  args: "[part…]",
  summary: `Close the usual holes. Without arguments:
${partLines(DEFAULT_HARDEN_PARTS)}
Only when named:
${partLines(HARDEN_PARTS.filter((p) => !DEFAULT_HARDEN_PARTS.includes(p)))}
Each change is journaled: lf undo takes it back.`,
  options: {
    server: serverOpt,
    force: { type: "boolean", desc: "turn ssh passwords off even if users without a key get locked out" },
  },
  async run(args, o) {
    const bad = args.filter((a) => !(HARDEN_PARTS as string[]).includes(a));
    if (bad.length) fail(`unknown: ${bad.join(", ")} (${HARDEN_PARTS.join(", ")})`);
    const parts = (args.length ? [...new Set(args)] : [...DEFAULT_HARDEN_PARTS]) as HardenPart[];
    const { name, server } = serverTarget(o);
    const admin = await adminLogin(server, "hardening");
    if (parts.includes("ssh")) {
      const { keysOff, locked } = await lockedOutOn(admin, effectiveSsh(server).user);
      if (keysOff)
        fail(
          "sshd refuses keys (PubkeyAuthentication no): keys only would lock everyone out; set PubkeyAuthentication yes in /etc/ssh/sshd_config.d/ and reload ssh first",
        );
      if (locked.length && !o.force) fail(`${addKeyFirst(locked)} Or --force.`);
    }
    if (parts.includes("ssh") && !(await confirm(`Only keys log in to ${name} afterwards (lf undo turns passwords back on). Go on?`))) return;
    await harden(admin, parts);
    ok(`${name}: ${parts.join(", ")} hardened`);
  },
});
