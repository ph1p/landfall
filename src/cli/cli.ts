#!/usr/bin/env node
import { journalCmd, parse, usage } from "./cmd";
import { byName, find } from "./registry";
import { validateJobArgs } from "./job-args";
import { JOB_INPUT, readJobInput } from "../core/job-input";
import { exitWithParent } from "../core/job";
import { journal } from "../core/ssh";
import { c, CliError, report, setAssumeYes } from "../core/term";
import pkg from "../../package.json";

function help() {
  const groups: [string, string[]][] = [
    [
      "Servers",
      [
        "setup",
        "server add",
        "server list",
        "server info",
        "stats",
        "disk",
        "prune",
        "reboot",
        "server config",
        "server domain",
        "server use",
        "server rm",
        "server uninstall",
        "ssh",
        "keygen",
      ],
    ],
    [
      "System",
      [
        "system",
        "services",
        "services restart",
        "services start",
        "services stop",
        "services logs",
        "keys",
        "keys add",
        "keys rm",
        "bans",
        "unban",
        "swap",
        "hostname",
        "timezone",
        "log-limit",
        "security",
        "harden",
      ],
    ],
    ["Users", ["users", "users add", "users rm", "users passwd", "users sudo"]],
    ["Traefik", ["traefik setup", "traefik use", "traefik status", "traefik dashboard", "traefik logs", "traefik restart", "traefik rm"]],
    ["Firewall", ["firewall status", "firewall enable", "firewall disable", "firewall allow", "firewall deny", "firewall update", "firewall rm"]],
    [
      "Sites",
      [
        "init",
        "deploy",
        "sites list",
        "sites info",
        "domains",
        "auth",
        "open",
        "tunnel",
        "tunnels",
        "logs",
        "env",
        "secret",
        "rollback",
        "release rm",
        "restart",
        "stop",
        "start",
        "sites rm",
        "adopt",
        "eject",
      ],
    ],
    ["Volumes", ["volumes", "volume add", "volume rm", "volume backup", "volume backup rm", "volume pull", "volume push", "volume restore"]],
    ["Monitoring", ["traffic", "certs", "check"]],
    ["Updates", ["updates", "update", "scan"]],
    ["History", ["history", "undo"]],
    ["landfall", ["config", "ui"]],
  ];
  // A command left out above still shows up.
  const listed = new Set(groups.flatMap(([, names]) => names));
  const rest = [...byName.keys()].filter((n) => !listed.has(n));
  if (rest.length) groups.push(["More", rest]);
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
    if (argv.includes("--json")) {
      console.log(JSON.stringify({ version: pkg.version }));
    } else {
      console.log(pkg.version);
    }
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
    if (argv.length === 1 && argv[0] === JOB_INPUT) {
      argv = await readJobInput();
      validateJobArgs(argv);
    }
    return await main(argv);
  } catch (e) {
    if (e instanceof CliError) {
      console.error(`${c.red("error:")} ${e.message}`);
      // A safety check refused: the web UI offers to run it again with --force.
      if (/--force\b/.test(e.message)) report({ force: e.message });
    } else console.error(e);
    return 1;
  }
}

exitWithParent();
// Exit once stdout drained: a pipe takes writes asynchronously, so exiting at once cuts long output (e.g. --json) at 64 KiB.
run(process.argv.slice(2)).then((code) => process.stdout.write("", () => process.exit(code)));
