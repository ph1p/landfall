// Plugins on the command line: their commands become lf commands, their panels `lf <plugin>`.
import { serverOpt, type Command } from "./cmd";
import { aliases, byName } from "./registry";
import type { Plugin, PluginCommand } from "../core/plugins/plugin-api";
import { fail } from "../core/lib/fail";
import { dropPlugin, pluginContext, plugins } from "../core/plugins/plugins";
import { printJson } from "../core/lib/term";
import { printBlocks } from "../core/plugins/print";

type Runner = (argv: string[]) => Promise<number>;

function toCommand(p: Plugin, pc: PluginCommand, lf: Runner): Command {
  return {
    name: pc.name ? `${p.name} ${pc.name}` : p.name,
    args: pc.args,
    summary: pc.summary,
    tenant: pc.tenant,
    // checkPlugin refuses options that would shadow landfall's own.
    options: pc.local ? pc.options : { server: serverOpt, ...pc.options },
    run: (pos, opts) => pc.run(pluginContext(p.name, pc.local ? null : opts.server, lf), pos, opts),
  };
}

function panelCommand(p: Plugin, lf: Runner): Command {
  const views = p.panel!.views ?? [];
  const ids = views.map((v) => v.id);
  return {
    name: p.name,
    summary: p.summary,
    tenant: p.panel!.tenant,
    options: {
      server: serverOpt,
      json: { type: "boolean", desc: "the panel's blocks as JSON" },
      ...(views.length && { view: { type: "string", desc: `what to show: ${views.map((v) => `${v.id} (${v.label})`).join(", ")}`, default: ids[0] } }),
    },
    async run(_, opts) {
      if (views.length && !ids.includes(opts.view)) fail(`--view takes ${ids.join(", ")}, not ${opts.view}`);
      const blocks = await p.panel!.load(pluginContext(p.name, opts.server, lf), views.length ? opts.view : undefined);
      if (opts.json) return void printJson(blocks);
      printBlocks(blocks, { actions: true });
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
