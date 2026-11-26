// Plugins on the command line: their commands become lf commands, their panels `lf <plugin>`.
import { serverOpt, type Command } from "./cmd";
import { aliases, byName } from "./registry";
import { actionCommand, type Plugin, type PluginCommand, type UiAction, type UiBlock, type UiCell } from "../core/plugins/plugin-api";
import { dropPlugin, pluginContext, plugins } from "../core/plugins/plugins";
import { c, printJson, table } from "../core/lib/term";

type Runner = (argv: string[]) => Promise<number>;

function toCommand(p: Plugin, pc: PluginCommand, lf: Runner): Command {
  return {
    name: pc.name ? `${p.name} ${pc.name}` : p.name,
    args: pc.args,
    summary: pc.summary,
    // checkPlugin refuses options that would shadow landfall's own.
    options: pc.local ? pc.options : { server: serverOpt, ...pc.options },
    run: (pos, opts) => pc.run(pluginContext(p.name, pc.local ? null : opts.server, lf), pos, opts),
  };
}

const paint = (v: UiCell) => {
  if (typeof v !== "object") return String(v);
  return v.kind === "bad" ? c.red(v.text) : v.kind === "warn" ? c.yellow(v.text) : v.kind === "ok" ? c.green(v.text) : v.text;
};

/** A panel's blocks as text: what `lf <plugin>` prints for a plugin without a command of its own for that. */
export function printBlocks(blocks: UiBlock[]) {
  const actions: UiAction[] = [];
  let first = true;
  for (const b of blocks) {
    if (b.type !== "actions" && !first) console.log("");
    if (b.type !== "actions") first = false;
    if (b.type === "note") console.log(paint({ text: b.text, kind: b.kind }));
    else if (b.type === "facts") {
      if (b.title) console.log(c.bold(b.title));
      table(b.items.map((i) => [c.dim(i.label), paint(i.value)]));
    } else if (b.type === "table") {
      if (b.title) console.log(c.bold(b.title) + (b.sub ? c.dim(` · ${b.sub}`) : ""));
      if (!b.rows.length) console.log(c.dim(b.empty ?? "none"));
      else table([b.columns.map(c.dim), ...b.rows.map((r) => r.cells.map(paint))]);
    } else if (b.type === "text") {
      if (b.title) console.log(c.bold(b.title));
      console.log(b.text);
    }
    // A table row's actions once, from the first row: an example of what each row offers.
    if (b.type === "actions") actions.push(...b.items);
    else if (b.type !== "text") actions.push(...(b.actions ?? []), ...(b.type === "table" ? (b.rows[0]?.actions ?? []) : []));
  }
  // What the web UI's buttons run, once each: the way to act on what was shown.
  const lines = [...new Set(actions.map(actionCommand))];
  if (lines.length) process.stderr.write(`\n${lines.map((l) => c.dim(`  ${l}`)).join("\n")}\n`);
}

function panelCommand(p: Plugin, lf: Runner): Command {
  return {
    name: p.name,
    summary: p.summary,
    options: { server: serverOpt, json: { type: "boolean", desc: "the panel's blocks as JSON" } },
    async run(_, opts) {
      const blocks = await p.panel!.load(pluginContext(p.name, opts.server, lf));
      if (opts.json) return void printJson(blocks);
      printBlocks(blocks);
    },
  };
}

/** Every command a plugin adds. */
export function pluginCommands(p: Plugin, lf: Runner): Command[] {
  const cmds = (p.commands ?? []).map((pc) => toCommand(p, pc, lf));
  if (p.panel && !p.commands?.some((x) => x.name === "")) cmds.push(panelCommand(p, lf));
  return cmds;
}

/** Plugin command names, for `lf --help`. */
export const pluginCommandNames = new Set<string>();

/**
 * Adds the loaded plugins' commands and aliases to the registry. A plugin that would take a name landfall or an
 * earlier plugin has is left out whole, with a warning: half a plugin is worse than none.
 */
export function registerPlugins(lf: Runner) {
  // A copy: dropPlugin takes plugins out of the list while this walks it.
  for (const { plugin: p } of plugins().slice()) {
    const cmds = pluginCommands(p, lf);
    const own = new Set(cmds.map((x) => x.name));
    const al = Object.entries(p.aliases ?? {});
    const taken = [...own, ...al.map(([k]) => k)].find((n) => byName.has(n) || n in aliases);
    const stray = al.find(([, to]) => !own.has(to));
    const why = taken ? `"lf ${taken}" is taken` : stray ? `alias ${stray[0]} points to ${stray[1]}, not one of its commands` : "";
    if (why) {
      dropPlugin(p.name, why);
      continue;
    }
    for (const cmd of cmds) {
      byName.set(cmd.name, cmd);
      pluginCommandNames.add(cmd.name);
    }
    for (const [k, to] of al) aliases[k] = to;
  }
}
