#!/usr/bin/env node
import { journalCmd, parse, usage, type Command } from "./cmd";
import { auth, domains, open } from "./commands/access";
import { config } from "./commands/config";
import { deploy } from "./commands/deploy";
import { init } from "./commands/init";
import { serverAdd, serverConfig, serverDomain, serverInfo, serverList, serverRemove, serverSsh, serverUninstall, serverUse } from "./commands/server";
import { firewallAllow, firewallDeny, firewallDisable, firewallEnable, firewallRemove, firewallStatus, firewallUpdate } from "./commands/firewall";
import { historyLog, historyUndo } from "./commands/history";
import { keygen, setup } from "./commands/setup";
import {
  sitesEnv,
  sitesSecret,
  sitesInfo,
  sitesList,
  sitesLogs,
  sitesRemove,
  sitesAdopt,
  sitesRestart,
  sitesRollback,
  sitesStart,
  sitesStop,
  sitesTunnel,
} from "./commands/sites";
import { diskCmd, statsCmd } from "./commands/stats";
import { certsCmd, checkCmd, trafficCmd } from "./commands/traffic";
import { pruneCmd, rebootCmd } from "./commands/manage";
import {
  bansList,
  hostnameCmd,
  keysAdd,
  keysList,
  keysRemove,
  logLimitCmd,
  servicesList,
  servicesLogs,
  servicesRestart,
  servicesStart,
  servicesStop,
  swapCmd,
  systemCmd,
  timezoneCmd,
  unbanCmd,
} from "./commands/system";
import { hardenCmd, securityCmd } from "./commands/security";
import { usersAdd, usersList, usersPasswd, usersRemove, usersSudo } from "./commands/users";
import { ui } from "./commands/ui";
import { volumeBackup, volumeList, volumePull, volumePush, volumeRestore } from "./commands/volume";
import { update, updatesList } from "./commands/updates";
import { traefikDashboard, traefikLogs, traefikRemove, traefikRestart, traefikSetup, traefikStatus, traefikUse } from "./commands/traefik";
import { exitWithParent } from "./job";
import { journal } from "./ssh";
import { c, CliError, report, setAssumeYes } from "./ui";
import pkg from "../package.json";

const commands: Command[] = [
  setup,
  init,
  deploy,
  sitesList,
  sitesInfo,
  sitesLogs,
  sitesEnv,
  sitesSecret,
  sitesRollback,
  sitesRestart,
  sitesStop,
  sitesStart,
  sitesRemove,
  sitesAdopt,
  sitesTunnel,
  volumeList,
  volumeBackup,
  volumePull,
  volumePush,
  volumeRestore,
  domains,
  auth,
  open,
  updatesList,
  update,
  serverAdd,
  serverList,
  serverInfo,
  statsCmd,
  diskCmd,
  trafficCmd,
  certsCmd,
  checkCmd,
  pruneCmd,
  rebootCmd,
  systemCmd,
  securityCmd,
  hardenCmd,
  servicesList,
  servicesRestart,
  servicesStart,
  servicesStop,
  servicesLogs,
  keysList,
  keysAdd,
  keysRemove,
  usersList,
  usersAdd,
  usersRemove,
  usersPasswd,
  usersSudo,
  bansList,
  unbanCmd,
  swapCmd,
  hostnameCmd,
  timezoneCmd,
  logLimitCmd,
  serverConfig,
  serverDomain,
  serverUse,
  serverRemove,
  serverUninstall,
  serverSsh,
  traefikSetup,
  traefikUse,
  traefikStatus,
  traefikLogs,
  traefikRestart,
  traefikRemove,
  traefikDashboard,
  firewallStatus,
  firewallEnable,
  firewallDisable,
  firewallAllow,
  firewallDeny,
  firewallUpdate,
  firewallRemove,
  historyLog,
  historyUndo,
  keygen,
  config,
  ui,
];

/** Shorthands → canonical command names. */
const aliases: Record<string, string> = {
  ls: "sites list",
  sites: "sites list",
  servers: "server list",
  "server ls": "server list",
  "server ssh": "ssh",
  "sites logs": "logs",
  "sites env": "env",
  "sites secret": "secret",
  "sites rollback": "rollback",
  "sites restart": "restart",
  "sites stop": "stop",
  "sites start": "start",
  "sites ls": "sites list",
  "sites remove": "sites rm",
  "server remove": "server rm",
  uninstall: "server uninstall",
  "traefik remove": "traefik rm",
  traefik: "traefik status",
  firewall: "firewall status",
  "firewall remove": "firewall rm",
  log: "history",
  revert: "undo",
  web: "ui",
  info: "server info",
  "sites domains": "domains",
  "sites auth": "auth",
  "sites open": "open",
  "sites tunnel": "tunnel",
  upgrade: "update",
  "server stats": "stats",
  "server disk": "disk",
  "server traffic": "traffic",
  "server certs": "certs",
  "sites check": "check",
  volume: "volumes",
  "volume ls": "volumes",
  "volume list": "volumes",
  "volumes ls": "volumes",
  "server prune": "prune",
  "server reboot": "reboot",
  "server system": "system",
  "services ls": "services",
  "services list": "services",
  "keys ls": "keys",
  "keys list": "keys",
  "keys remove": "keys rm",
  "users ls": "users",
  "users list": "users",
  "users remove": "users rm",
  "users password": "users passwd",
  "bans unban": "unban",
  "server swap": "swap",
  "server hostname": "hostname",
  "server timezone": "timezone",
};

const byName = new Map(commands.map((cmd) => [cmd.name, cmd]));

function find(argv: string[]): { cmd?: Command; rest: string[] } {
  for (const n of [2, 1]) {
    const key = argv.slice(0, n).join(" ");
    const cmd = byName.get(aliases[key] ?? key);
    if (cmd && argv.length >= n) return { cmd, rest: argv.slice(n) };
  }
  return { rest: argv };
}

function help() {
  const groups: [string, string[]][] = [
    ["Servers", ["setup", "server add", "server list", "server info", "stats", "disk", "prune", "reboot", "server config", "server domain", "server use", "server rm", "server uninstall", "ssh", "keygen"]],
    ["System", ["system", "services", "services restart", "services start", "services stop", "services logs", "keys", "keys add", "keys rm", "bans", "unban", "swap", "hostname", "timezone", "log-limit"]],
    ["Users", ["users", "users add", "users rm", "users passwd", "users sudo"]],
    ["Traefik", ["traefik setup", "traefik status", "traefik dashboard", "traefik logs", "traefik restart", "traefik rm"]],
    ["Firewall", ["firewall status", "firewall enable", "firewall disable", "firewall allow", "firewall deny", "firewall update", "firewall rm"]],
    ["Sites", ["deploy", "sites list", "sites info", "domains", "auth", "open", "tunnel", "logs", "env", "secret", "rollback", "restart", "stop", "start", "sites rm"]],
    ["Volumes", ["volumes", "volume backup", "volume pull", "volume push", "volume restore"]],
    ["Monitoring", ["traffic", "certs", "check"]],
    ["Updates", ["updates", "update"]],
    ["History", ["history", "undo"]],
    ["landfall", ["config", "ui"]],
  ];
  const lines = [
    `${c.bold("landfall")} ${c.dim(pkg.version)} — set up servers and deploy sites behind Traefik + HTTPS`,
    "",
    `${c.bold("Usage:")} lf <command> [options]       ${c.dim("lf <command> --help for details")}`,
    `       lf ui                        ${c.dim("web dashboard in your browser")}`,
  ];
  for (const [title, names] of groups) {
    lines.push("", c.bold(title));
    for (const n of names) {
      const cmd = byName.get(n)!;
      lines.push(`  ${(n + (cmd.args ? " " + cmd.args : "")).padEnd(32)} ${cmd.summary.split("\n")[0]}`);
    }
  }
  lines.push(
    "",
    c.bold("Quick start"),
    `  lf setup vps --check                                 ${c.dim("# what is on vps, what setup would change")}`,
    `  lf setup vps                                         ${c.dim("# docker + traefik on a server you reach with `ssh vps`")}`,
    `  lf setup box --host 203.0.113.7                      ${c.dim("# fresh box (root password once) → `ssh box` works")}`,
    `  lf deploy ./dist -d example.com -s vps               ${c.dim("# publish a static site with HTTPS")}`,
    `  lf deploy                                            ${c.dim("# redeploy using ./.landfall.json")}`,
    `  lf deploy ./dist -y                                  ${c.dim("# no domain yet: serve at <name>.<ip>.sslip.io")}`,
    `  lf auth my-site --user anna                          ${c.dim("# put a password in front of a site")}`,
    `  lf updates -s vps && lf update -s vps                ${c.dim("# pending OS/image updates, then apply them")}`,
    `  lf ls                                                ${c.dim("# what runs where")}`,
    `  lf history -s vps && lf undo -s vps                  ${c.dim("# what landfall changed, and revert the last of it")}`,
    "",
    c.dim("Servers are ssh targets: any ~/.ssh/config alias works as --server."),
  );
  console.log(lines.join("\n"));
}

async function main(argv: string[]): Promise<number> {
  if (!argv.length || argv[0] === "help" || argv[0] === "-h" || argv[0] === "--help") {
    help();
    return 0;
  }
  if (argv[0] === "-v" || argv[0] === "--version" || argv[0] === "version") {
    console.log(pkg.version);
    return 0;
  }
  const { cmd, rest } = find(argv);
  if (!cmd) {
    console.error(`${c.red("error:")} unknown command "${argv.join(" ")}"\n`);
    help();
    return 2;
  }
  const { values, positionals, rest: passthrough } = parse(cmd, rest);
  if (values.help) {
    console.log(usage(cmd));
    return 0;
  }
  setAssumeYes(!!values.yes);
  if (values.environment !== undefined) process.env.LANDFALL_ENV = values.environment;
  journal.cmd = journalCmd(cmd, positionals, values);
  const code = await cmd.run(positionals, values, passthrough);
  return typeof code === "number" ? code : 0;
}

/** One command, errors printed. */
async function run(argv: string[]): Promise<number> {
  try {
    return await main(argv);
  } catch (e) {
    if (e instanceof CliError) {
      console.error(`${c.red("error:")} ${e.message}`);
      // A safety check refused: the web UI offers to run it again with --force.
      if (/--force\b/.test(e.message)) report({ force: e.message });
    }
    else console.error(e);
    return 1;
  }
}

exitWithParent();
// Exit once stdout drained: a pipe takes writes asynchronously, so exiting at once cuts long output (e.g. --json) at 64 KiB.
run(process.argv.slice(2)).then((code) => process.stdout.write("", () => process.exit(code)));
