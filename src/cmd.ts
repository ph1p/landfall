import { parseArgs } from "node:util";
import { c, fail } from "./ui";

type OptSpec = {
  type: "string" | "boolean";
  short?: string;
  multiple?: boolean;
  desc: string;
  default?: string | boolean;
};

export interface Command<O extends Record<string, OptSpec> = Record<string, OptSpec>> {
  /** e.g. "sites logs" */
  name: string;
  args?: string;
  summary: string;
  options?: O;
  /** Everything after `--` is handed to run untouched. */
  passthrough?: boolean;
  run(pos: string[], opts: Record<string, any>, rest: string[]): Promise<void | number>;
}

export const defineCommand = <O extends Record<string, OptSpec>>(cmd: Command<O>) => cmd;

export const serverOpt = { type: "string", short: "s", desc: "server name or ssh alias" } as const;

/** Accepted by every command. */
const GLOBAL_OPTS: Record<string, OptSpec> = {
  help: { type: "boolean", short: "h", desc: "show this help" },
  yes: { type: "boolean", short: "y", desc: "assume yes / defaults for prompts" },
};

/** `--dashboard-password` → `LANDFALL_SECRET_DASHBOARD_PASSWORD`. */
export const secretEnv = (flag: string) => `LANDFALL_SECRET_${flag.toUpperCase().replace(/-/g, "_")}`;

export function parse(cmd: Command, argv: string[]) {
  const dd = argv.indexOf("--");
  const own = cmd.passthrough && dd >= 0 ? argv.slice(0, dd) : argv;
  const rest = cmd.passthrough && dd >= 0 ? argv.slice(dd + 1) : [];
  const options: Record<string, Omit<OptSpec, "desc">> = {};
  for (const [k, { desc, ...spec }] of Object.entries({ ...GLOBAL_OPTS, ...cmd.options })) options[k] = spec;
  try {
    const { values, positionals } = parseArgs({ args: own, options, allowPositionals: true, allowNegative: true });
    // Passwords may come from the environment instead (the web UI passes them so): argv shows in `ps`.
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
  const rows = Object.entries({ ...cmd.options, yes: GLOBAL_OPTS.yes }).map(([k, o]) => {
    const flag = `${o.short ? `-${o.short}, ` : "    "}--${k}${o.type === "string" ? ` <${k}>` : ""}`;
    const def = o.default !== undefined && o.default !== false ? c.dim(` (default: ${o.default})`) : "";
    return [flag, o.desc + (o.multiple ? c.dim(" (repeatable)") : "") + def];
  });
  const w = Math.max(...rows.map((r) => r[0].length));
  for (const [f, d] of rows) lines.push(`  ${f.padEnd(w)}  ${d}`);
  return lines.join("\n");
}

/** The command as the server journal shows it: flags too, but never values that may be secrets. */
export function journalCmd(cmd: Pick<Command, "name" | "options">, positionals: string[], values: Record<string, unknown>): string {
  // KEY=value arguments (lf env, deploy -e) can be secrets: only the key is kept.
  const mask = (v: string) => v.replace(/^([A-Za-z_][A-Za-z0-9_]*)=.*/s, "$1=…");
  const flags = Object.entries(values).flatMap(([k, v]): string[] => {
    if (k === "server" || k === "yes" || k === "help" || v === undefined || v === cmd.options?.[k]?.default) return [];
    if (v === false) return [`--no-${k}`];
    if (v === true) return [`--${k}`];
    return (Array.isArray(v) ? v : [v]).map((x) => (/pass|secret|token/i.test(k) ? `--${k} …` : `--${k} ${mask(String(x))}`));
  });
  return [cmd.name, ...positionals.map(mask), ...flags].join(" ");
}
