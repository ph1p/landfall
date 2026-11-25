import { defineCommand, serverOpt } from "../cmd";
import { checkInt, projectServer, tildify, type Server } from "../../core/lib/config";
import { generateKey } from "../../core/server/security";
import { bytes } from "../../core/server/facts";
import { sshExec } from "../../core/ssh/ssh";
import { effectiveSsh } from "../../core/ssh/sshconfig";
import {
  KEY_SERVICES,
  LOG_SIZE,
  UNIT,
  addKey,
  addSwap,
  parseKeyLine,
  parseSwapSize,
  readKey,
  removeKey,
  removeSwap,
  serviceAction,
  serviceLogs,
  serviceName,
  setDaemon,
  setHostname,
  setTimezone,
  fullSystem,
  system,
  withLogLimit,
  type Service,
  type SystemInfo,
} from "../../core/server/system";
import { adminLogin } from "../../core/ssh/privilege";
import { c, confirm, confirmRemoval, confirmRisky, fail, info, ok, report, step, table, warn, printJson } from "../../core/lib/term";

export const target = (o: Record<string, any>) => projectServer(o.server);
/** The target server's name and everything `lf system` knows about it. */
const inspect = async (o: Record<string, any>) => {
  const { name, server } = target(o);
  return { name, server, i: await fullSystem(server) };
};
const json = { type: "boolean", desc: "machine-readable output" } as const;

const failed = (s: Service) => s.active === "failed" || s.active === "crashed";
const running = (s: Service) => s.active === "active" || s.active === "started";
const isKey = (s: Service) => KEY_SERVICES.includes(serviceName(s.unit));

function stateColor(s: Service) {
  return failed(s) ? c.red(s.sub || s.active) : running(s) ? c.green(s.sub || s.active) : c.dim(s.sub || s.active);
}

export function limitedNote(i: SystemInfo) {
  if (!i.root) info(c.dim(`${i.user} has no passwordless sudo: other users' keys, bans and daemon.json may be missing`));
}

export const systemCmd = defineCommand({
  name: "system",
  summary: "Show a server's basics: host name, time zone, swap, Docker log limits, failed services, SSH keys and bans.",
  options: { server: serverOpt, json },
  async run(_, o) {
    const { name, i } = await inspect(o);
    if (o.json) return void printJson(i);
    const swap = i.swap.reduce((n, s) => n + s.size, 0);
    const d = i.docker;
    table([
      [c.dim("host name"), i.hostname],
      [c.dim("time zone"), `${i.timezone}${i.ntp === false ? c.yellow(" · clock not synced") : i.ntp ? c.dim(" · synced") : ""}`],
      [c.dim("swap"), swap ? `${bytes(swap)}${c.dim(` (${i.swap.map((s) => s.file).join(", ")})`)}` : c.yellow("none")],
      [
        c.dim("docker logs"),
        !d
          ? c.dim("no docker")
          : d.maxSize
            ? `${d.driver}, ${d.maxSize} × ${d.maxFile ?? 1} per container`
            : d.driver === "json-file"
              ? c.yellow(`${d.driver}, unlimited`)
              : d.driver,
      ],
      [
        c.dim("services"),
        i.init === "other"
          ? c.dim("no systemd or OpenRC")
          : `${i.services.filter(running).length} running${i.services.some(failed) ? c.red(` · ${i.services.filter(failed).length} failed`) : ""}`,
      ],
      [c.dim("ssh keys"), `${i.keys.length}`],
      [c.dim("fail2ban"), i.fail2ban === "running" ? `running ${c.dim("· lf fail2ban")}` : c.dim(i.fail2ban === "missing" ? "not installed" : "stopped")],
    ]);
    if (d?.daemonError) warn(d.daemonError);
    for (const s of i.services.filter(failed)) warn(`${serviceName(s.unit)} failed: lf services logs ${serviceName(s.unit)} -s ${name}`);
    if (!swap && i.mem && i.mem < 4 * 1024 ** 3) info(c.dim(`little memory and no swap: lf swap 2G adds some`));
    if (d && !d.maxSize && d.driver === "json-file") info(c.dim("container logs grow without limit: lf log-limit 10m caps them"));
    limitedNote(i);
  },
});

export const servicesList = defineCommand({
  name: "services",
  summary: "List services: the ones landfall relies on and failed ones; --all for every one.",
  options: { server: serverOpt, all: { type: "boolean", desc: "every service, inactive ones too" }, json },
  async run(_, o) {
    const { name, server } = target(o);
    const i = await system(server);
    if (o.json) return void printJson(i.services);
    if (i.init === "other") fail(`no systemd or OpenRC on ${name}`);
    const shown = o.all ? i.services : i.services.filter((s) => failed(s) || isKey(s) || (running(s) && i.init === "openrc"));
    const rank = (s: Service) => (failed(s) ? 0 : isKey(s) ? 1 : 2);
    shown.sort((a, b) => rank(a) - rank(b) || a.unit.localeCompare(b.unit));
    table([
      ["service", "state", ...(i.init === "systemd" ? ["boot"] : []), "description"].map(c.dim),
      ...shown.map((s) => [serviceName(s.unit), stateColor(s), ...(i.init === "systemd" ? [c.dim(s.enabled ?? "")] : []), c.dim(s.description)]),
    ]);
    if (!o.all) info(c.dim(`${i.services.length - shown.length} more: lf services --all`));
  },
});

function serviceCommand(verb: "restart" | "start" | "stop") {
  return defineCommand({
    name: `services ${verb}`,
    args: "<service>",
    summary: `${verb[0].toUpperCase()}${verb.slice(1)} a service (systemd or OpenRC).${verb === "restart" ? "" : ` Undo ${verb === "stop" ? "starts" : "stops"} it again.`}`,
    options: { server: serverOpt, force: { type: "boolean", desc: "even ssh" } },
    async run([unit], o) {
      if (!unit) fail(`usage: lf services ${verb} <service>`);
      if (!UNIT.test(unit)) fail(`not a service name: ${unit}`);
      const { name, server } = target(o);
      const svc = serviceName(unit);
      if (verb === "stop" && /^sshd?$/.test(svc) && !o.force && !(await confirmRisky(`Stopping ${svc} can lock you out of ${name}. Do it anyway?`)))
        fail(`stopping ${svc} can lock you out (--force to do it anyway)`);
      if (
        /^(docker|containerd)$/.test(svc) &&
        verb !== "start" &&
        !(await confirm(`${verb} ${svc} on ${name}? Every site goes down${verb === "stop" ? " until it is started again" : " for a moment"}.`, false))
      )
        return;
      const admin = await adminLogin(server, `${verb}ing a service`);
      step(`${verb} ${svc} on ${name}`);
      await serviceAction(admin, verb, unit);
      ok(`${svc}: ${verb === "stop" ? "stopped" : verb === "start" ? "started" : "restarted"}`);
    },
  });
}

export const servicesRestart = serviceCommand("restart");
export const servicesStart = serviceCommand("start");
export const servicesStop = serviceCommand("stop");

export const servicesLogs = defineCommand({
  name: "services logs",
  args: "<service>",
  summary: "Show a service's log (journald, else its log file).",
  options: {
    server: serverOpt,
    follow: { type: "boolean", short: "f", desc: "follow" },
    tail: { type: "string", short: "n", desc: "lines", default: "100" },
  },
  async run([unit], o) {
    if (!unit) fail("usage: lf services logs <service>");
    const { server } = target(o);
    return sshExec(server, [serviceLogs(unit, { lines: checkInt(o.tail, "--tail", 1, 100000), follow: o.follow })]);
  },
});

const shortFp = (k: { fingerprint: string }) => k.fingerprint.replace(/^SHA256:/, "").slice(0, 12);

export const keysList = defineCommand({
  name: "keys",
  summary: "List the SSH keys that may log in, per user. ★ marks the key this machine uses.",
  options: { server: serverOpt, json },
  async run(_, o) {
    const { i } = await inspect(o);
    if (o.json) return void printJson(i.keys);
    if (!i.keys.length) info(c.dim("no authorized keys found"));
    table([
      ["", "user", "key", "comment"].map(c.dim),
      ...i.keys.map((k) => [
        k.mine ? c.green("★") : "",
        k.user,
        `${k.type.replace(/^ssh-/, "")} ${c.dim(shortFp(k))}`,
        `${k.comment || c.dim("(no comment)")}${k.options ? c.dim(` [${k.options}]`) : ""}`,
      ]),
    ]);
    limitedNote(i);
  },
});

/** How to log in as user: with keyFile, or with whatever key ssh offers. */
export function loginHint(server: Server, user: string, keyFile?: string) {
  const eff = effectiveSsh(server);
  return `ssh${keyFile ? ` -i ${tildify(keyFile)}` : ""}${eff.port !== 22 ? ` -p ${eff.port}` : ""} ${user}@${eff.hostname}`;
}

export const keysAdd = defineCommand({
  name: "keys add",
  args: "[key|file.pub]",
  summary: `Let another SSH key log in (to the login user, or --user).

With --generate lf makes a new pair at ~/.ssh/<server>_<user> (asking for a
passphrase in a terminal) and adds its public key: hand the private key to
whoever logs in as that user, or keep it if that is you.`,
  options: {
    server: serverOpt,
    user: { type: "string", short: "u", desc: "whose authorized_keys (default: the login user)" },
    generate: { type: "boolean", desc: "make a new key pair here instead of passing one" },
  },
  async run([arg], o) {
    if (!arg && !o.generate) fail("usage: lf keys add <key|file.pub>, or --generate");
    const { name, server } = target(o);
    const eff = effectiveSsh(server);
    const user = o.user ?? eff.user;
    const made = o.generate ? generateKey(name, user) : undefined;
    const line = made ? made.pub : readKey(arg);
    const admin = await adminLogin(server, "adding a key");
    await addKey(admin, user, line);
    const k = parseKeyLine(line)!;
    ok(`${k.comment || shortFp(k)} may log in to ${name} as ${user}`);
    if (made) {
      info(`${made.created ? "private key" : "used the existing key"}: ${tildify(made.path)}`);
      info(`log in: ${loginHint(server, user, made.path)}`);
      if (made.created && !made.passphrase) info(c.dim(`it has no passphrase; add one with ssh-keygen -p -f ${tildify(made.path)}`));
      report({ keyFile: made.path });
    }
  },
});

export const keysRemove = defineCommand({
  name: "keys rm",
  args: "<fingerprint|comment>",
  summary: "Remove an SSH key: by (part of) its fingerprint or its comment, as `lf keys` shows them.",
  options: {
    server: serverOpt,
    user: { type: "string", short: "u", desc: "only this user's keys" },
    force: { type: "boolean", desc: "even the key this machine logs in with" },
  },
  async run([which], o) {
    if (!which) fail("usage: lf keys rm <fingerprint|comment>");
    const { name, server, i } = await inspect(o);
    const w = which.replace(/^SHA256:/, "");
    const hits = i.keys.filter((k) => (!o.user || k.user === o.user) && (k.comment === which || (w.length >= 6 && k.fingerprint.slice(7).startsWith(w))));
    if (!hits.length) fail(`no key ${which}${o.user ? ` for ${o.user}` : ""} on ${name}: see lf keys`);
    if (hits.length > 1)
      fail(`${which} matches ${hits.length} keys (${hits.map((k) => `${k.user} ${shortFp(k)}`).join(", ")}): give more of the fingerprint or --user`);
    const k = hits[0];
    if (
      k.mine &&
      !o.force &&
      !(await confirmRisky(`${k.comment || shortFp(k)} is the key this machine logs in with: removing it can lock you out. Do it anyway?`))
    )
      fail("that is the key this machine logs in with (--force to remove it anyway)");
    await confirmRemoval(`Remove key ${k.comment || shortFp(k)} of ${k.user} on ${name}?`);
    const admin = await adminLogin(server, "removing a key");
    await removeKey(admin, k);
    ok(`removed ${k.comment || shortFp(k)} from ${k.user}`);
  },
});

export const swapCmd = defineCommand({
  name: "swap",
  args: "[size|off]",
  summary: "Show swap, add a swap file (e.g. 2G) or remove the one landfall made (off).",
  options: { server: serverOpt, json },
  async run([arg], o) {
    const { name, server } = target(o);
    const i = await system(server);
    if (!arg) {
      if (o.json) return void printJson({ swap: i.swap, swappiness: i.swappiness, mem: i.mem });
      if (!i.swap.length) return info(`no swap on ${name}${c.dim(` · ${bytes(i.mem)} memory · lf swap 2G adds a swap file`)}`);
      table([["file", "size", "used"].map(c.dim), ...i.swap.map((s) => [s.file, bytes(s.size), bytes(s.used)])]);
      return;
    }
    if (i.managed) fail(i.managed);
    const admin = await adminLogin(server, "changing swap");
    if (arg === "off") {
      const f = i.swap.find((s) => s.file === "/swapfile");
      if (f?.used) warn(`${bytes(f.used)} of it is in use: it moves back to memory`);
      await confirmRemoval(`Remove the swap file /swapfile on ${name}?`);
      step("turning swap off");
      await removeSwap(admin);
      return ok("removed /swapfile");
    }
    const size = parseSwapSize(arg);
    if (size < 64 * 1024 ** 2) fail("at least 64M");
    // Keep room for images and logs: a full disk breaks far more than missing swap.
    if (i.diskFree && size > i.diskFree - 2 * 1024 ** 3) fail(`only ${bytes(i.diskFree)} free on /: keep 2 GB besides the swap file`);
    step(`adding ${bytes(size)} swap at /swapfile`);
    await addSwap(admin, size);
    ok(`${bytes(size)} swap on ${name}`);
  },
});

export const hostnameCmd = defineCommand({
  name: "hostname",
  args: "[name]",
  summary: "Show or change the host name.",
  options: { server: serverOpt },
  async run([nw], o) {
    const { name, server } = target(o);
    const i = await system(server);
    if (!nw) return void console.log(i.hostname);
    if (nw === i.hostname) return ok(`already ${nw}`);
    if (i.managed) fail(i.managed);
    const admin = await adminLogin(server, "renaming the host");
    await setHostname(admin, i.hostname, nw);
    ok(`${name} is now called ${nw}${c.dim(" (the shell prompt shows it on the next login)")}`);
  },
});

export const timezoneCmd = defineCommand({
  name: "timezone",
  args: "[zone]",
  summary: "Show or change the time zone (e.g. Europe/Berlin, UTC). Cron jobs and logs follow it.",
  options: { server: serverOpt },
  async run([tz], o) {
    const { name, server } = target(o);
    const i = await system(server);
    if (!tz) return void console.log(`${i.timezone}${c.dim(` · ${i.time}`)}`);
    if (tz === i.timezone) return ok(`already ${tz}`);
    if (i.managed) fail(i.managed);
    const admin = await adminLogin(server, "changing the time zone");
    await setTimezone(admin, i.timezone, tz);
    ok(`${name}: time zone ${tz}`);
  },
});

export const logLimitCmd = defineCommand({
  name: "log-limit",
  args: "[size|off]",
  summary:
    "Show or cap how much log Docker keeps per container (e.g. 10m, with --files 3 rotated files).\n" +
    "Applies to containers created afterwards: redeploy (or lf restart) sites to pick it up.",
  options: {
    server: serverOpt,
    files: { type: "string", desc: "rotated files per container", default: "3" },
    restart: { type: "boolean", desc: "restart docker now (sites go down for a moment); without, it applies on its next start" },
    json,
  },
  async run([arg], o) {
    const { name, server } = target(o);
    const i = await system(server);
    const d = i.docker;
    if (!d) fail(`no docker on ${name}`);
    if (!arg) {
      if (o.json) return void printJson({ driver: d!.driver, maxSize: d!.maxSize, maxFile: d!.maxFile });
      return void console.log(d!.maxSize ? `${d!.driver}: ${d!.maxSize} × ${d!.maxFile ?? 1} per container` : `${d!.driver}: ${c.yellow("no limit")}`);
    }
    if (i.managed) fail(i.managed);
    if (d!.daemonError) fail(`${d!.daemonError}: fix it first`);
    const size = arg === "off" ? undefined : arg.toLowerCase();
    if (size && !LOG_SIZE.test(size)) fail(`not a size: ${arg} (e.g. 10m, 500k, 1g)`);
    const files = checkInt(o.files, "--files", 1, 100);
    if (!["json-file", "local"].includes(d!.driver)) warn(`docker logs to ${d!.driver}: the limit only takes effect for json-file and local`);
    const restart = !!o.restart && (await confirm(`Restart docker on ${name}? Every site goes down for a moment.`, false));
    const admin = await adminLogin(server, "changing docker's log limit");
    await setDaemon(admin, withLogLimit(d!.daemon, size, files), size ? `docker log limit ${size} × ${files}` : "docker log limit off", restart);
    ok(size ? `docker keeps at most ${size} × ${files} log per container` : "docker log limit removed");
    info(
      c.dim(
        restart
          ? "new containers get it: redeploy or lf restart sites to apply it to them"
          : "takes effect when docker restarts (--restart, or a reboot), for containers created after that",
      ),
    );
  },
});
