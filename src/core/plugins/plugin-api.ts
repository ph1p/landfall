// The plugin contract: what a plugin module exports, and what landfall hands its code.
// No node: imports here, so the web page can import the UI block types.
import type { Server } from "../lib/config";

export type { Server };

/** A command-line option of a plugin command, as `lf <plugin> <command> --help` shows it. */
export interface PluginOption {
  type: "string" | "boolean";
  short?: string;
  multiple?: boolean;
  desc: string;
  default?: string | boolean;
}

/** What a plugin's code gets: the server it acts on and landfall's helpers. */
export interface PluginContext {
  /** The plugin's name. */
  plugin: string;
  /** The server's name as the user gave it (-s), or the default server's. "" for a local command. */
  name: string;
  /** The server's resolved ssh settings (host, user, port…). Undefined for a local command: do not read it there. */
  server: Server;
  /**
   * Runs bash on the server over ssh with `set -euo pipefail` and landfall's helpers (`record`, `saved`, `svc`,
   * `pkg_install`, `$SUDO`, `log`…). Returns stdout. capture: false streams stdout instead (default true).
   * admin: why root is needed; the script then runs as root or with passwordless sudo, else the command fails with that reason.
   */
  script(body: string, o?: { capture?: boolean; admin?: string; env?: Record<string, string | boolean | undefined> }): Promise<string>;
  /** Quotes a value for the shell: every value put into a script goes through this. */
  shq(v: string | number): string;
  /** Data the plugin keeps on this computer, per server (a scan's last result…). Not on the server. */
  data: { get<T = unknown>(): T | undefined; set(value: unknown): void };
  /** Output on stderr (progress), never on stdout. */
  log: { step(msg: string): void; ok(msg: string): void; info(msg: string): void; warn(msg: string): void };
  /** Stops the command with `error: <msg>` and exit code 1. */
  fail(msg: string): never;
  /** Asks yes/no in a terminal; -y answers yes; without a terminal it fails with a clear message. */
  confirm(question: string, def?: boolean): Promise<boolean>;
  /**
   * Asks yes/no before something that could lock someone out or break a running service. -y does not answer it,
   * and without a terminal it is no: offer a --force option for scripts instead.
   */
  confirmRisky(question: string): Promise<boolean>;
  /** Asks for a line of text in a terminal. -y or no terminal: def, or the command fails (take the value as an option too). */
  ask(question: string, def?: string): Promise<string>;
  /** Prints rows as aligned columns on stdout. */
  table(rows: string[][]): void;
  /** Prints a value as JSON on stdout (for --json). */
  json(value: unknown): void;
  /** Prints lines of results on stdout (a heading, a summary). Progress goes to log instead. */
  print(...lines: string[]): void;
  /** Prints UI blocks as text on stdout, the way `lf <plugin>` prints a panel: one view for the web UI and the terminal. */
  blocks(blocks: UiBlock[]): void;
  /**
   * Reads a file the plugin ships with (a script it uploads, a template) as text. A folder plugin's files sit in its
   * folder (`file("app/server.mjs")`), a single-file plugin's next to it. Stops the command when the file is missing.
   */
  file(name: string): string;
  /** Terminal colors; plain text when stdout is not a terminal. */
  color: Record<"bold" | "dim" | "red" | "green" | "yellow" | "blue" | "cyan", (s: string) => string>;
  /** Where landfall keeps things on the server. */
  paths: { root: string; sites: string; traefik: string };
  /** Runs another lf command in this process, e.g. ["harden", "fail2ban"]. Same server unless argv says -s. */
  lf(argv: string[]): Promise<number>;
}

/** One command: `lf <plugin>` when name is "", else `lf <plugin> <name>`. */
export interface PluginCommand {
  name: string;
  args?: string;
  summary: string;
  options?: Record<string, PluginOption>;
  /** No server: no -s, ctx.name is "" and ctx.server undefined. */
  local?: boolean;
  /** A tenant login may run it too: its own rootless Docker, its own paths, no root. Admin logins only otherwise. */
  tenant?: boolean;
  /** args: the positional arguments. opts: option values by name, defaults filled in, plus landfall's (server, yes…). */
  run(ctx: PluginContext, args: string[], opts: Record<string, any>): Promise<void | number>;
}

/** Options landfall gives every plugin command, with their short forms: a plugin's own must use other names and letters. */
export const RESERVED_OPTIONS: Readonly<Record<string, string>> = { help: "h", yes: "y", environment: "E", "ask-sudo": "K", server: "s" };
const RESERVED_SHORTS = new Set(Object.values(RESERVED_OPTIONS));
/** Whether a plugin may not use this option name (--name) or short form (-x). */
export const reservedOption = (name: string) => Object.hasOwn(RESERVED_OPTIONS, name);
export const reservedShort = (short: string) => RESERVED_SHORTS.has(short);
/** Command and option names. */
export const COMMAND_NAME = /^[a-z][a-z0-9-]*$/;

// ---- web UI ------------------------------------------------------------------

export type UiKind = "" | "ok" | "warn" | "bad" | "info";

/** A form field of an action: its value goes into the argv as a positional argument, or after flag. */
export interface UiField {
  name: string;
  label: string;
  /** text (default), number (whole number, see min and max), select (needs options) or check (adds flag when ticked). */
  type?: "text" | "number" | "select" | "check";
  /** select: the values, or { value, label } to show a label instead. */
  options?: (string | { value: string; label: string })[];
  /** text and number: values offered while typing; any other value is fine too. */
  suggest?: string[];
  /** number: the smallest and largest value accepted. */
  min?: number;
  max?: number;
  value?: string | boolean;
  placeholder?: string;
  hint?: string;
  required?: boolean;
  /** e.g. "--jail": the value goes in as `--jail <value>`. Without it, positional, in field order. */
  flag?: string;
}

/** A button that runs `lf <argv> -s <server>` as a job the user sees; the panel reloads when it succeeds. */
export interface UiAction {
  label: string;
  argv: string[];
  title?: string;
  primary?: boolean;
  danger?: boolean;
  /** Asks first, with this text. */
  confirm?: string;
  /** Asks for these values first; they are appended to argv. */
  fields?: UiField[];
}

export type UiCell = string | number | { text: string; kind?: UiKind; mono?: boolean; title?: string };

/** One bar of a bars or funnel chart. */
export interface UiBar {
  label: string;
  value: number;
  /** Shown instead of the value (e.g. "1.2k · 34%"). */
  text?: string;
  /** Shown on hover. */
  title?: string;
  /** Colors the bar: ok, warn, bad; the accent color without. */
  kind?: UiKind;
  mono?: boolean;
  actions?: UiAction[];
}

/**
 * A chart, drawn by the web UI and as text bars by `lf <plugin>`.
 * line: one or more series over labels (days, hours), as lines with the area under the first filled.
 * bars: horizontal bars, longest first as given (a breakdown: sources, pages, devices).
 * funnel: steps in order; each bar shows its share of the first and what dropped off since the step before.
 */
export type UiChart = { title?: string; sub?: string; actions?: UiAction[] } & (
  | { chart: "line"; labels: string[]; series: { name: string; values: number[] }[]; /** After each value on hover, e.g. "visitors". */ unit?: string }
  | {
      chart: "bars";
      items: UiBar[];
      /** Shown instead of an empty chart. */
      empty?: string;
      /** The web UI shows only the first n bars, with a button for the rest; `lf <plugin>` prints all. */
      show?: number;
    }
  | { chart: "funnel"; items: UiBar[] }
);

/** One number of a stats block: a tile with a big value in the web UI, a line in `lf <plugin>`. */
export interface UiStat {
  label: string;
  value: string | number;
  /** Percent change against the period before; null when there is nothing to compare with (shown as "new"). */
  change?: number | null;
  /** A rise is bad (bounce rate, errors): colors the change red instead of green. */
  lowerIsBetter?: boolean;
  /** A small trend line under the value, oldest first (e.g. visitors per day). */
  spark?: number[];
  /** A quiet line under the value. */
  note?: string;
  /** ok shows a live dot next to the value; warn and bad color the value. */
  kind?: UiKind;
  /** Shown on hover. */
  title?: string;
}

export type UiBlock = (
  | { type: "note"; kind?: UiKind; text: string; actions?: UiAction[] }
  | { type: "facts"; title?: string; items: { label: string; value: UiCell }[]; actions?: UiAction[] }
  | { type: "stats"; title?: string; sub?: string; items: UiStat[]; actions?: UiAction[] }
  | {
      type: "table";
      title?: string;
      sub?: string;
      columns: string[];
      rows: { cells: UiCell[]; actions?: UiAction[] }[];
      /** Shown instead of an empty table. */
      empty?: string;
      actions?: UiAction[];
    }
  | { type: "text"; title?: string; text: string; mono?: boolean }
  | { type: "actions"; items: UiAction[] }
  | ({ type: "chart" } & UiChart)
  | { type: "heading"; text: string; sub?: string }
) & {
  /** Half width in the web UI: two half blocks in a row share it. */
  half?: boolean;
};

/** Icons a panel may name; anything else shows a puzzle piece. */
export const PANEL_ICONS = ["puzzle", "shield", "bug", "lock", "scan", "activity", "database", "bell", "key", "box", "ban", "search"] as const;
export type PanelIcon = (typeof PANEL_ICONS)[number];

/** A section of the server page in `lf ui`: the plugin builds its content from the server each time it opens. */
export interface PluginPanel {
  label: string;
  /** The group it sits in: Apps, Monitoring, Network, Machine (default) or one of its own. */
  group?: string;
  icon?: PanelIcon;
  /**
   * Ways to look at the panel, e.g. [{ id: "7d", label: "7 days" }, { id: "30d", label: "30 days" }]. The web UI shows
   * them as a switch, `lf <plugin> --view <id>` picks one. The first is the default.
   */
  views?: { id: string; label: string }[];
  /** A tenant login may open it too (see PluginCommand.tenant). */
  tenant?: boolean;
  /** view: one of views' ids (the first when none was picked); undefined without views. */
  load(ctx: PluginContext, view?: string): Promise<UiBlock[]>;
}

export interface Plugin {
  /** Its command and section name: lowercase letters, digits and dashes. */
  name: string;
  summary: string;
  version?: string;
  commands?: PluginCommand[];
  /** Shorthands → full command names, e.g. { bans: "fail2ban" }. */
  aliases?: Record<string, string>;
  /** Without a "" command, `lf <plugin>` prints the panel as text (and --json its blocks). */
  panel?: PluginPanel;
}

/** Identity, for type checking: `export default definePlugin({ … })`. */
export const definePlugin = (p: Plugin) => p;

export const PLUGIN_NAME = /^[a-z][a-z0-9-]{0,31}$/;
/** The web UI's tab for a plugin's panel. */
export const pluginTab = (name: string) => `plugin-${name}` as const;
export type PluginTab = ReturnType<typeof pluginTab>;

/** What `lf plugins --json` and the web UI know of a plugin. */
export interface PluginInfo {
  name: string;
  summary: string;
  version?: string;
  /** builtin, or the file it came from. */
  source: string;
  commands: string[];
  /** The commands a tenant login may run. */
  tenantCommands: string[];
  panel?: { label: string; group: string; icon: string; tenant?: boolean; views?: { id: string; label: string }[] };
  error?: string;
}

/** The view a panel loads for a request: the asked one when the panel has it, else its first; undefined without views. */
export function panelView(panel: Pick<PluginPanel, "views">, asked?: string | null): string | undefined {
  const v = panel.views ?? [];
  return v.find((x) => x.id === asked)?.id ?? v[0]?.id;
}

/** The command an action runs, as shown to the user (fields as placeholders, -y left out). */
export function actionCommand(a: UiAction): string {
  const fields = (a.fields ?? []).map((f) => (f.type === "check" ? `[${f.flag}]` : f.flag ? `[${f.flag} <${f.name}>]` : `<${f.name}>`));
  return `lf ${[...a.argv.filter((x) => x !== "-y"), ...fields].join(" ")}`;
}

/** The argv an action runs once its fields are filled: positional values in field order, flags after. */
export function actionArgv(a: UiAction, values: Record<string, string | boolean | undefined> = {}): string[] {
  const out = [...a.argv];
  for (const f of a.fields ?? []) {
    const v = values[f.name];
    if (f.type === "check") {
      if (v === true && f.flag) out.push(f.flag);
    } else if (typeof v === "string" && v.trim() !== "") out.push(...(f.flag ? [f.flag, v.trim()] : [v.trim()]));
  }
  return out;
}
