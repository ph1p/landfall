import fs from "node:fs";
import { extname, join, resolve } from "node:path";
import { defineCommand } from "../cmd";
import { tildify } from "../../core/lib/config";
import { PLUGIN_NAME } from "../../core/plugins/plugin-api";
import { DATA_DIR, importPlugin, installedPath, PLUGIN_DIR, pluginEntry, pluginNamed, pluginsView } from "../../core/plugins/plugins";
import { c, confirmRemoval, fail, info, ok, printJson, table } from "../../core/lib/term";

const json = { type: "boolean", desc: "machine-readable output" } as const;

export const pluginsList = defineCommand({
  name: "plugins",
  summary: `List the plugins: the built-in ones and yours in ${tildify(PLUGIN_DIR)}, with their commands.`,
  options: { json },
  async run(_, o) {
    const all = pluginsView();
    if (o.json) return void printJson(all);
    table([
      ["plugin", "from", "commands", ""].map(c.dim),
      ...all.map((p) => [
        c.bold(p.name) + (p.version ? c.dim(` ${p.version}`) : ""),
        p.source === "builtin" ? c.dim("built in") : tildify(p.source),
        p.error ? c.red(`not loaded: ${p.error}`) : p.commands.map((x) => `lf ${x}`).join(", "),
        p.panel ? c.dim(`ui: ${p.panel.label}`) : "",
      ]),
    ]);
    info(c.dim(`lf plugin new <name> writes a plugin to start from; docs: plugins.md`));
  },
});

export const pluginAdd = defineCommand({
  name: "plugin add",
  args: "<file|folder>",
  summary: `Install a plugin: copy a .mjs/.js file or a folder (index.mjs or package.json "main") to ${tildify(PLUGIN_DIR)}. It is loaded first, to check it.`,
  options: { force: { type: "boolean", desc: "replace an installed plugin of that name" } },
  async run([path], o) {
    if (!path) fail("usage: lf plugin add <file|folder>");
    const src = resolve(path);
    if (!fs.existsSync(src)) fail(`no such file or folder: ${path}`);
    const dir = fs.statSync(src).isDirectory();
    const entry = dir ? pluginEntry(src) : /\.m?js$/.test(src) ? src : undefined;
    if (!entry) fail(dir ? `${path} has no index.mjs, index.js or package.json "main"` : `${path} is not a .mjs or .js file`);
    let name: string;
    try {
      name = (await importPlugin(entry!)).name;
    } catch (e) {
      return fail(`${path} is not a plugin: ${e instanceof Error ? e.message : e}`);
    }
    const loaded = pluginNamed(name);
    if (loaded?.source === "builtin") fail(`${name} is a built-in plugin's name; rename yours`);
    const dest = join(PLUGIN_DIR, dir ? name : `${name}${extname(src)}`);
    const old = installedPath(name);
    if (old && !o.force) fail(`a plugin ${name} is installed already; --force replaces it`);
    fs.mkdirSync(PLUGIN_DIR, { recursive: true });
    if (old) fs.rmSync(old, { recursive: true, force: true });
    fs.cpSync(src, dest, { recursive: true });
    ok(`installed ${name} → ${tildify(dest)}`);
    info(c.dim(`lf ${name} --help, or its section in lf ui`));
  },
});

export const pluginRemove = defineCommand({
  name: "plugin rm",
  args: "<name>",
  summary: `Remove an installed plugin from ${tildify(PLUGIN_DIR)}. What it keeps per server on this computer goes too.`,
  async run([name]) {
    if (!name) fail("usage: lf plugin rm <name>");
    const l = pluginNamed(name);
    if (l?.source === "builtin") fail(`${name} is built in; it cannot be removed`);
    // By its file name too: a plugin that failed to load has no name of its own yet.
    const target = installedPath(name);
    if (!target) fail(l ? `${tildify(l.source)} is not in ${tildify(PLUGIN_DIR)}; remove it there` : `no plugin ${name} in ${tildify(PLUGIN_DIR)}`);
    await confirmRemoval(`Remove plugin ${name} (${tildify(target!)})?`);
    fs.rmSync(target!, { recursive: true, force: true });
    fs.rmSync(join(DATA_DIR, name), { recursive: true, force: true });
    ok(`removed ${name}`);
  },
});

/** A plugin to start from: one command, one panel, every part of the API in use once. */
export const scaffold = (name: string) => `// A landfall plugin. Docs: https://ph1p.github.io/landfall/plugins
// lf ${name} --help lists its commands; lf ui shows its panel on each server's page.
// Types for your editor: npm i -D landfall next to this file (the @type line below then checks it).

/** @type {import("landfall/plugin").Plugin} */
export default {
  name: ${JSON.stringify(name)},
  summary: "Say what ${name} does in one sentence.",
  version: "0.1.0",
  commands: [
    {
      name: "",
      summary: "Show the server's uptime.",
      options: { json: { type: "boolean", desc: "machine-readable output" } },
      async run(ctx, args, opts) {
        // Bash on the server, with set -euo pipefail and landfall's helpers. Quote values with ctx.shq.
        const up = (await ctx.script("uptime -p")).trim();
        if (opts.json) return ctx.json({ uptime: up });
        ctx.table([[ctx.color.dim("uptime"), up]]);
      },
    },
    {
      name: "note",
      args: "<text>",
      summary: "Write a line to /etc/motd. lf undo takes it back.",
      async run(ctx, [text]) {
        if (!text) ctx.fail("usage: lf ${name} note <text>");
        // admin: root or passwordless sudo is needed, and why. saved backs the file up; record journals the change.
        await ctx.script(
          \`undo=$(saved /etc/motd)
printf '%s\\\\n' \${ctx.shq(text)} | $SUDO tee -a /etc/motd >/dev/null
record "added a line to /etc/motd" "$undo"\`,
          { admin: "writing /etc/motd" },
        );
        ctx.log.ok("added");
      },
    },
  ],
  // A section in lf ui: blocks the page draws. Buttons run lf commands as jobs the user sees.
  panel: {
    label: ${JSON.stringify(name)},
    group: "Machine",
    icon: "puzzle",
    async load(ctx) {
      const up = (await ctx.script("uptime -p")).trim();
      return [
        { type: "facts", items: [{ label: "Uptime", value: up }] },
        {
          type: "actions",
          items: [{ label: "Add to motd", argv: [${JSON.stringify(name)}, "note"], fields: [{ name: "text", label: "Text", required: true }] }],
        },
      ];
    },
  },
};
`;

export const pluginNew = defineCommand({
  name: "plugin new",
  args: "<name>",
  summary: `Write a plugin to start from: ${tildify(PLUGIN_DIR)}/<name>.mjs (or --out), with a command and a web UI panel.`,
  options: { out: { type: "string", desc: "where to write it instead (a .mjs file); lf plugin add installs it later" } },
  async run([name], o) {
    if (!name || !PLUGIN_NAME.test(name)) fail("usage: lf plugin new <name>  (lowercase letters, digits and dashes)");
    if (pluginNamed(name)) fail(`a plugin named ${name} exists already`);
    const file = o.out ? resolve(o.out) : join(PLUGIN_DIR, `${name}.mjs`);
    if (fs.existsSync(file)) fail(`${tildify(file)} exists already`);
    fs.mkdirSync(join(file, ".."), { recursive: true });
    fs.writeFileSync(file, scaffold(name));
    ok(`wrote ${tildify(file)}`);
    info(o.out ? c.dim(`lf plugin add ${o.out} installs it`) : c.dim(`lf ${name} runs it; lf ui shows its panel`));
  },
});
