import { parseArgs } from "node:util";
import { statusKind } from "../core/site/status";
import { secretEnv } from "../core/lib/job";
import { c, fail } from "../core/lib/term";

type OptSpec = {
  type: "string" | "boolean";
  short?: string;
  multiple?: boolean;
  desc: string;
  default?: string | boolean;
  /** A string option's --no-<name>, as help describes it: run sees `"no-<name>": true`. */
  no?: string;
};

export interface Command<O extends Record<string, OptSpec> = Record<string, OptSpec>> {
  /** e.g. "sites logs" */
  name: string;
  args?: string;
  summary: string;
  options?: O;
  /** A tenant login may run it: it touches only the tenant's own sites, Docker and files. Admin logins only otherwise. */
  tenant?: boolean;
  /** Everything after `--` is handed to run untouched. */
  passthrough?: boolean;
  run(pos: string[], opts: Record<string, any>, rest: string[]): Promise<void | number>;
}

export const defineCommand = <O extends Record<string, OptSpec>>(cmd: Command<O>) => cmd;

/** Runs a command from another one, with its option defaults for what `o` leaves out. */
export function runWith(cmd: Command, pos: string[], o: Record<string, unknown>) {
  const defaults = Object.fromEntries(Object.entries(cmd.options ?? {}).flatMap(([k, v]) => ("default" in v ? [[k, v.default]] : [])));
  return cmd.run(pos, { ...defaults, ...o }, []);
}

export const serverOpt = { type: "string", short: "s", desc: "server name or ssh alias" } as const;

/** Accepted by every command. */
export const GLOBAL_OPTS: Record<string, OptSpec> = {
  help: { type: "boolean", short: "h", desc: "show this help" },
  yes: { type: "boolean", short: "y", desc: "assume yes / defaults for prompts" },
  environment: { type: "string", short: "E", desc: "an environment of .landfall.json (staging…), deployed as its own site; or LANDFALL_ENV" },
  "ask-sudo": { type: "boolean", short: "K", desc: "ask once for the login's sudo password (or $LANDFALL_SUDO_PASSWORD); kept in memory only" },
};

/** Shared by execution and dashboard argument masking; Node owns the accepted flag syntax. */
export function tokenize(cmd: Command, argv: string[]) {
  const dd = argv.indexOf("--");
  const own = cmd.passthrough && dd >= 0 ? argv.slice(0, dd) : argv;
  const rest = cmd.passthrough && dd >= 0 ? argv.slice(dd + 1) : [];
  const options: Record<string, Omit<OptSpec, "desc">> = {};
  for (const [k, { desc, no, ...spec }] of Object.entries({ ...GLOBAL_OPTS, ...cmd.options })) {
    options[k] = spec;
    // Node accepts --no-<name> only for an option it knows as a boolean: declaring one lets it through.
    if (no) options[`no-${k}`] = { type: "boolean" };
  }
  const parsed = parseArgs({ args: own, options, allowPositionals: true, allowNegative: true, tokens: true });
  const values = parsed.values as Record<string, unknown>;
  // With allowNegative, parseArgs reads --no-<name> as a false among the option's values: every caller gets no-<name> instead.
  for (const [k, o] of Object.entries(cmd.options ?? {})) {
    const vals = [values[k]].flat().filter((v) => v !== undefined);
    if (!o.no || !vals.includes(false)) continue;
    if (vals.some((v) => v !== false)) throw new Error(`--no-${k} and --${k} exclude each other`);
    delete values[k];
    values[`no-${k}`] = true;
  }
  return { ...parsed, rest };
}

export function parse(cmd: Command, argv: string[]) {
  try {
    const { values, positionals, rest } = tokenize(cmd, argv);
    // Passwords may come from the environment instead: argv shows in `ps`.
    for (const k of Object.keys(cmd.options ?? {})) {
      if (/(^|-)password$/.test(k) && values[k] === undefined && process.env[secretEnv(k)]) values[k] = process.env[secretEnv(k)];
    }
    return { values: values as Record<string, any>, positionals, rest };
  } catch (e: any) {
    return fail(`${e.message}\n\n${usage(cmd)}`);
  }
}

export function usage(cmd: Command): string {
  const lines = [`${c.bold("Usage:")} lf ${cmd.name}${cmd.args ? " " + cmd.args : ""} [options]`, "", cmd.summary];
  lines.push("", c.bold("Options:"));
  const rows = Object.entries({ ...cmd.options, yes: GLOBAL_OPTS.yes, "ask-sudo": GLOBAL_OPTS["ask-sudo"] }).flatMap(([k, o]) => {
    const flag = `${o.short ? `-${o.short}, ` : "    "}--${k}${o.type === "string" ? ` <${k}>` : ""}`;
    const def = o.default !== undefined && o.default !== false ? c.dim(` (default: ${o.default})`) : "";
    return [[flag, o.desc + (o.multiple ? c.dim(" (repeatable)") : "") + def], ...(o.no ? [[`    --no-${k}`, o.no]] : [])];
  });
  const w = Math.max(...rows.map((r) => r[0].length));
  for (const [f, d] of rows) lines.push(`  ${f.padEnd(w)}  ${d}`);
  return lines.join("\n");
}

/** The command as the server journal shows it: flags too, but never values that may be secrets. */
export function journalCmd(cmd: Pick<Command, "name" | "options">, positionals: string[], values: Record<string, unknown>): string {
  // KEY=value arguments (lf env, lf secret, deploy -e) can be secrets: only the key is kept.
  const mask = (v: string) => v.replace(/^([A-Za-z0-9_][A-Za-z0-9_.-]*)=.*/s, "$1=…").replace(/(:\/\/)[^/@\s]+@/, "$1…@");
  const flags = Object.entries(values).flatMap(([k, v]): string[] => {
    if (k === "server" || k === "yes" || k === "help" || k === "environment" || v === undefined || v === cmd.options?.[k]?.default) return [];
    if (v === false) return [`--no-${k}`];
    if (v === true) return [`--${k}`];
    return (Array.isArray(v) ? v : [v]).map((x) => (/pass|secret|token/i.test(k) ? `--${k} …` : `--${k} ${mask(String(x))}`));
  });
  return [cmd.name, ...positionals.map(mask), ...flags].join(" ");
}

/** --follow/--tail, shared by `logs` and `traefik logs`. */
export const logOpts = {
  follow: { type: "boolean", short: "f", desc: "follow" },
  tail: { type: "string", short: "n", desc: "lines", default: "100" },
} as const;

const STATUS_COLOR = { up: c.green, warn: c.yellow, done: c.dim, down: c.red };
/** A container status in its color: green up, yellow unhealthy or restarting, dim finished, red down. */
export const paintStatus = (status: string) => STATUS_COLOR[statusKind(status)](status);
