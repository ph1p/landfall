// Loading plugins, and the context their code runs with.
import fs from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { configDir, resolveServer, writeAtomic, type Server } from "./config";
import { adminLogin } from "./privilege";
import { runScript, shq } from "./ssh";
import { PRELUDE, ROOT, SITES } from "./templates";
import { c, confirm, fail, info, ok, printJson, step, table, warn } from "./term";
import { PLUGIN_NAME, type Plugin, type PluginContext, type PluginInfo } from "./plugin-api";

/** Your plugins: each a .mjs/.js file, or a folder with index.mjs/index.js (or package.json "main"). */
export const PLUGIN_DIR = join(configDir, "plugins");
/** What plugins keep on this computer, per plugin and server. */
export const DATA_DIR = join(configDir, "plugin-data");

export interface Loaded {
  plugin: Plugin;
  source: string;
}

let loaded: Loaded[] = [];
let failed: { name: string; source: string; error: string }[] = [];

/** The plugins loaded so far: none until loadPlugins ran. */
export const plugins = () => loaded;
export const pluginNamed = (name: string) => loaded.find((l) => l.plugin.name === name);

/** Entry files in PLUGIN_DIR, one per plugin. */
export function pluginFiles(dir = PLUGIN_DIR): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => !e.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isFile() || e.isSymbolicLink()) return /\.m?js$/.test(e.name) ? [p] : [];
      if (!e.isDirectory()) return [];
      return [pluginEntry(p)].filter((x): x is string => !!x);
    });
}

/** The file or folder in PLUGIN_DIR that holds a plugin: the loaded plugin of that name, or name.mjs, name.js, name/. */
export function installedPath(name: string, dir = PLUGIN_DIR): string | undefined {
  const src = pluginNamed(name)?.source ?? "";
  if (src.startsWith(dir + "/")) return join(dir, src.slice(dir.length + 1).split("/")[0]);
  return [`${name}.mjs`, `${name}.js`, name].map((f) => join(dir, f)).find((f) => fs.existsSync(f));
}

/** A plugin folder's entry file. */
export function pluginEntry(dir: string): string | undefined {
  try {
    const main = JSON.parse(fs.readFileSync(join(dir, "package.json"), "utf8")).main;
    if (typeof main === "string" && fs.existsSync(join(dir, main))) return join(dir, main);
  } catch {}
  return ["index.mjs", "index.js"].map((f) => join(dir, f)).find((f) => fs.existsSync(f));
}

/** What is wrong with a module's export, or "" when it is a plugin. */
export function checkPlugin(p: unknown): string {
  if (!p || typeof p !== "object") return "exports no plugin (export default definePlugin({ … }))";
  const x = p as Plugin;
  if (typeof x.name !== "string" || !PLUGIN_NAME.test(x.name)) return `name must be lowercase letters, digits and dashes, not ${JSON.stringify(x.name)}`;
  if (typeof x.summary !== "string" || !x.summary) return "needs a summary";
  for (const cmd of x.commands ?? []) {
    if (typeof cmd?.name !== "string" || (cmd.name && !/^[a-z][a-z0-9-]*$/.test(cmd.name))) return `command name ${JSON.stringify(cmd?.name)} is not valid`;
    if (typeof cmd.run !== "function") return `command ${JSON.stringify(cmd.name)} has no run()`;
    if (typeof cmd.summary !== "string") return `command ${JSON.stringify(cmd.name)} has no summary`;
  }
  if (x.panel && (typeof x.panel.label !== "string" || typeof x.panel.load !== "function")) return "panel needs a label and load()";
  return "";
}

/** Imports one plugin file. */
export async function importPlugin(file: string): Promise<Plugin> {
  const mod = await import(pathToFileURL(file).href);
  const p = mod.default ?? mod.plugin;
  const why = checkPlugin(p);
  if (why) throw new Error(why);
  return p;
}

/**
 * Loads the built-in plugins and those in PLUGIN_DIR, once. A plugin that fails to load is skipped with a warning:
 * a broken plugin must not break every other command. LANDFALL_NO_PLUGINS=1 skips yours (not the built-in ones).
 */
export async function loadPlugins(builtin: Plugin[], dir = PLUGIN_DIR): Promise<Loaded[]> {
  loaded = builtin.map((plugin) => ({ plugin, source: "builtin" }));
  failed = [];
  if (process.env.LANDFALL_NO_PLUGINS === "1") return loaded;
  // Imported side by side, then added in file order, so which of two same-named plugins wins does not depend on timing.
  const files = pluginFiles(dir);
  const results = await Promise.allSettled(files.map(importPlugin));
  results.forEach((r, i) => {
    const file = files[i];
    // A folder plugin's entry is index.mjs: name it by its folder.
    const name = file
      .slice(dir.length + 1)
      .split("/")[0]
      .replace(/\.m?js$/, "");
    const error =
      r.status === "rejected"
        ? r.reason instanceof Error
          ? r.reason.message
          : String(r.reason)
        : pluginNamed(r.value.name)
          ? `a plugin named ${r.value.name} is already loaded`
          : "";
    if (r.status === "fulfilled" && !error) return void loaded.push({ plugin: r.value, source: file });
    failed.push({ name, source: file, error });
    warn(`plugin ${file} not loaded: ${error}`);
  });
  return loaded;
}

/** Keeps a plugin out after loading: its commands would clash with landfall's own. */
export function dropPlugin(name: string, error: string) {
  const l = pluginNamed(name);
  if (!l) return;
  loaded = loaded.filter((x) => x !== l);
  failed.push({ name, source: l.source, error });
  warn(`plugin ${name} not loaded: ${error}`);
}

/** `lf plugins --json`, and the web UI's list. */
export function pluginsView(): PluginInfo[] {
  return [
    ...loaded.map(({ plugin: p, source }) => ({
      name: p.name,
      summary: p.summary,
      ...(p.version && { version: p.version }),
      source,
      // A panel without a "" command is `lf <plugin>` too (src/cli/plugins.ts).
      commands: [
        ...(p.commands ?? []).map((x) => (x.name ? `${p.name} ${x.name}` : p.name)),
        ...(p.panel && !p.commands?.some((x) => x.name === "") ? [p.name] : []),
      ],
      ...(p.panel && { panel: { label: p.panel.label, group: p.panel.group ?? "Machine", icon: p.panel.icon ?? "puzzle" } }),
    })),
    ...failed.map((f) => ({ name: f.name, summary: "", source: f.source, commands: [], error: f.error })),
  ];
}

const dataFile = (plugin: string, server: string) => join(DATA_DIR, plugin, `${encodeURIComponent(server)}.json`);

/**
 * The context a plugin's code runs with. on: the server as -s gave it (undefined: the default server), or null for
 * a local command. runLf runs another lf command (the CLI passes its dispatcher; the web UI's panels have none).
 */
export function pluginContext(plugin: string, on: string | undefined | null, runLf?: (argv: string[]) => Promise<number>): PluginContext {
  const resolved = on === null ? undefined : resolveServer(on);
  const name = resolved?.name;
  const server: Server | undefined = resolved?.server;
  const need = () => server ?? fail(`plugin ${plugin}: this command has no server`);
  let admin: Promise<Server> | undefined;
  return {
    plugin,
    name: name ?? "",
    server: server as Server,
    async script(body, o = {}) {
      const s = o.admin ? await (admin ??= adminLogin(need(), o.admin)) : need();
      const res = await runScript(s, `${PRELUDE}\n${body}`, { capture: o.capture ?? true, env: o.env });
      return res.stdout ?? "";
    },
    shq: (v) => shq(v),
    data: {
      get<T>() {
        if (name === undefined) return undefined;
        try {
          return JSON.parse(fs.readFileSync(dataFile(plugin, name), "utf8")) as T;
        } catch {
          return undefined;
        }
      },
      set(value) {
        if (name === undefined) fail(`plugin ${plugin}: data needs a server`);
        const f = dataFile(plugin, name!);
        fs.mkdirSync(join(f, ".."), { recursive: true, mode: 0o700 });
        writeAtomic(f, JSON.stringify(value, null, 2) + "\n");
      },
    },
    log: { step, ok, info, warn },
    fail,
    confirm,
    table,
    json: printJson,
    color: c,
    paths: { root: ROOT, sites: SITES },
    lf: (argv) => (runLf ? runLf(name !== undefined && !argv.includes("-s") ? [...argv, "-s", name] : argv) : fail("lf() runs only in a command")),
  };
}
