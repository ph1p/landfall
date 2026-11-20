// The plugin contract: what a plugin module exports, and what landfall hands its code.
// No node: imports here, so the web page can import the UI block types.
import type { Server } from "./config";

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
  /** The server's name as the user gave it (-s), and its resolved ssh settings. Absent for local commands. */
  name: string;
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
  /** Prints rows as aligned columns on stdout. */
  table(rows: string[][]): void;
  /** Prints a value as JSON on stdout (for --json). */
  json(value: unknown): void;
  /** Terminal colors; plain text when stdout is not a terminal. */
  color: Record<"bold" | "dim" | "red" | "green" | "yellow" | "blue" | "cyan", (s: string) => string>;
  /** Where landfall keeps things on the server. */
  paths: { root: string; sites: string };
  /** Runs another lf command in this process, e.g. ["harden", "fail2ban"]. Same server unless argv says -s. */
  lf(argv: string[]): Promise<number>;
}

/** One command: `lf <plugin>` when name is "", else `lf <plugin> <name>`. */
export interface PluginCommand {
  name: string;
  args?: string;
  summary: string;
  options?: Record<string, PluginOption>;
  /** No server: no -s, and ctx has no name or server. */
  local?: boolean;
  run(ctx: PluginContext, args: string[], opts: Record<string, any>): Promise<void | number>;
}

// ---- web UI ------------------------------------------------------------------

export type UiKind = "" | "ok" | "warn" | "bad" | "info";

/** A form field of an action: its value goes into the argv as a positional argument, or after flag. */
export interface UiField {
  name: string;
  label: string;
  /** text (default), select (needs options) or check (adds flag when ticked). */
  type?: "text" | "select" | "check";
  options?: string[];
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

export type UiBlock =
  | { type: "note"; kind?: UiKind; text: string; actions?: UiAction[] }
  | { type: "facts"; title?: string; items: { label: string; value: UiCell }[]; actions?: UiAction[] }
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
  | { type: "actions"; items: UiAction[] };

/** Icons a panel may name; anything else shows a puzzle piece. */
export const PANEL_ICONS = ["puzzle", "shield", "bug", "lock", "scan", "activity", "database", "bell", "key", "box", "ban", "search"] as const;
export type PanelIcon = (typeof PANEL_ICONS)[number];

/** A section of the server page in `lf ui`: the plugin builds its content from the server each time it opens. */
export interface PluginPanel {
  label: string;
  /** The group it sits in: Apps, Monitoring, Network, Machine (default) or one of its own. */
  group?: string;
  icon?: PanelIcon;
  load(ctx: PluginContext): Promise<UiBlock[]>;
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
  panel?: { label: string; group: string; icon: string };
  error?: string;
}

/** The argv an action runs once its fields are filled: positional values in field order, flags after. */
/** The command an action runs, as shown to the user (fields as placeholders, -y left out). */
export function actionCommand(a: UiAction): string {
  const fields = (a.fields ?? []).map((f) => (f.type === "check" ? `[${f.flag}]` : f.flag ? `[${f.flag} <${f.name}>]` : `<${f.name}>`));
  return `lf ${[...a.argv.filter((x) => x !== "-y"), ...fields].join(" ")}`;
}

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
