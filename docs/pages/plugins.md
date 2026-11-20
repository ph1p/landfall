# Plugins

A plugin adds commands to `lf` and a section to the server page of `lf ui`. landfall ships two: `fail2ban` and
`trivy`. Your own plugins are JavaScript files in `~/.config/landfall/plugins`.

Plugins follow landfall's rules. There is no agent on the server: a plugin runs bash over ssh, like landfall
itself. Every button in its web UI section runs an `lf` command, which the page shows as a job.

## Using plugins

```sh
lf plugins                        # every plugin: built in or yours, its commands, its web UI section
lf plugin add ./disk-alert.mjs    # install a file, or a folder with index.mjs or package.json "main"
lf plugin add ./disk-alert.mjs --force   # replace an installed plugin of that name
lf plugin rm disk-alert           # remove it, with what it keeps on this computer
lf plugin new disk-alert          # write a plugin to start from, to ~/.config/landfall/plugins/disk-alert.mjs
lf plugin new disk-alert --out ./disk-alert.mjs   # write it elsewhere; lf plugin add installs it later
```

`lf plugin add` loads the plugin first and refuses it if it is broken. A plugin cannot take a built-in plugin's name.

A plugin that fails to load does not break landfall. `lf` warns, skips it, and `lf plugins` shows the error. A
plugin whose command or alias is already an `lf` command is skipped as a whole.

`LANDFALL_NO_PLUGINS=1` skips your plugins for one run. The built-in ones still load.

Plugins run with your user's rights on this computer, like any script you run. Install only plugins you trust.

## Built-in plugins

### fail2ban

```sh
lf fail2ban                       # jails, their settings and the banned IPs (alias: lf bans)
lf fail2ban ban 203.0.113.9       # ban an IP in the sshd jail; --jail for another
lf fail2ban unban 203.0.113.9     # let it in again, in every jail that bans it (alias: lf unban)
lf fail2ban config sshd --bantime 1h --maxretry 3   # also --findtime; -1 bans for good
lf fail2ban install               # install and start fail2ban: lf harden fail2ban
```

`config` writes `/etc/fail2ban/jail.d/50-landfall-<jail>.local` and reloads fail2ban. It keeps the settings you do
not give. `ban`, `unban` and `config` are journaled, and `lf undo` takes them back. fail2ban answers root only, so every
command needs root or passwordless sudo. Without either, landfall uses the server's [root login](servers.md#root-login).

The web UI section *fail2ban* (under Machine) shows the same. It has buttons to ban, unban and change a jail.

### trivy

```sh
lf trivy                          # what Trivy keeps on the server and what the last scans found
lf trivy images                   # scan the running images; keeps a summary (lf scan lists every vulnerability)
lf trivy files                    # scan the sites' current releases for secrets and misconfigurations
lf trivy files blog               # only some sites
lf trivy rm                       # remove Trivy's image and databases from the server
```

The first scan downloads Trivy and its databases (several GB), so landfall asks first. `files` skips `.env` files,
`node_modules` and `.git`. Scans change nothing on the server. The summaries of the last full scans stay on this
computer, in `~/.config/landfall/plugin-data/trivy/`.

The web UI section *Trivy* (under Machine) shows the summaries, with buttons to scan again.

## Writing a plugin

A plugin is an ES module whose default export describes it. `lf plugin new <name>` writes a working one. This is a
smaller example:

```js
// ~/.config/landfall/plugins/disk-alert.mjs
export default {
  name: "disk-alert",
  summary: "Warn when a disk is fuller than a limit.",
  version: "0.1.0",
  commands: [
    {
      name: "", // lf disk-alert
      summary: "List the filesystems fuller than --limit percent.",
      options: { limit: { type: "string", desc: "percent", default: "80" }, json: { type: "boolean", desc: "machine-readable output" } },
      async run(ctx, args, opts) {
        const out = await ctx.script(`df -P --output=target,pcent | tail -n +2`);
        const full = out.trim().split("\n").map((l) => l.trim().split(/\s+/)).filter(([, p]) => parseInt(p) > Number(opts.limit));
        if (opts.json) return ctx.json(full.map(([mount, used]) => ({ mount, used })));
        if (!full.length) return ctx.log.ok("no disk is that full");
        ctx.table(full);
      },
    },
  ],
};
```

`lf disk-alert --help` then shows its options, `lf disk-alert -s web1` runs it, and `lf --help` lists it under
Plugins.

### The plugin object

| field | what |
|---|---|
| `name` | the command and section name: lowercase letters, digits and dashes |
| `summary` | one sentence, for `lf --help` and `lf plugins` |
| `version` | optional, shown by `lf plugins` |
| `commands` | the commands; see below |
| `aliases` | shorthands for its commands, e.g. `{ bans: "fail2ban" }`. They must point to its own commands |
| `panel` | its section in the web UI; see below |

A command has a `name` (`""` makes it `lf <plugin>`, else `lf <plugin> <name>`), a `summary`, optional `args`
(for help, e.g. `"<ip>"`), `options` and `run(ctx, args, opts)`. Options are
`{ type: "string" | "boolean", desc, short?, default?, multiple? }`. Every command gets `-s <server>`, `-y` and
`--help`. A command with `local: true` gets no `-s` and no server.

`run` returns nothing, or an exit code.

### The context

`ctx` is what your code gets from landfall:

| member | what |
|---|---|
| `ctx.script(body, { admin?, env?, capture? })` | runs bash on the server and returns its stdout |
| `ctx.shq(value)` | quotes a value for the shell |
| `ctx.name`, `ctx.server` | the server as `-s` named it, and its ssh settings |
| `ctx.paths.root`, `ctx.paths.sites` | `/opt/landfall` and its `sites` folder |
| `ctx.log.step/ok/info/warn(msg)` | progress on stderr |
| `ctx.fail(msg)` | stops with `error: <msg>` and exit code 1 |
| `ctx.confirm(question, default?)` | asks yes/no; `-y` answers yes; fails without a terminal |
| `ctx.table(rows)`, `ctx.json(value)` | results on stdout |
| `ctx.color.bold/dim/red/green/yellow/blue/cyan` | colors, plain when stdout is not a terminal |
| `ctx.data.get()`, `ctx.data.set(value)` | JSON the plugin keeps on this computer, per server |
| `ctx.lf(argv)` | runs another `lf` command on the same server, e.g. `["harden", "fail2ban"]` |

Scripts run with `set -euo pipefail` and landfall's shell helpers: `$SUDO`, `svc`, `pkg_install`, `dc` and more
(see `PRELUDE` in `src/core/templates.ts`). Put every value into a script through `ctx.shq`, or pass it in `env`.

`admin` says why the script needs root. It then runs as root or with passwordless sudo, or the command fails with
that reason.

### Rules your plugin should keep

- **Results on stdout, everything else on stderr.** Use `ctx.table` and `ctx.json` for results and `ctx.log` for
  progress, so `lf <plugin> --json | jq` works.
- **Journal every change.** After each change on the server, call `record "<what>" "<shell that undoes it>"`.
  Back a file up with `undo=$(saved <file>)` before you change it; `$undo` restores it. `lf history` then shows the
  change and `lf undo` reverts it. Without an undo shell, the change counts as one that cannot be undone.
- **Ask only through `ctx.confirm`.** It works with `-y` and without a terminal.
- **Keep secrets out of argv and the journal.** Pass them in `env`, and write `KEY=…` in `record`.

```js
await ctx.script(
  `undo=$(saved /etc/motd)
printf '%s\\n' ${ctx.shq(text)} | $SUDO tee -a /etc/motd >/dev/null
record "added a line to /etc/motd" "$undo"`,
  { admin: "writing /etc/motd" },
);
```

### A web UI section

`panel` adds a section to each server's page in `lf ui`:

```js
panel: {
  label: "Disk alert",
  group: "Monitoring",     // Apps, Monitoring, Network, Machine (default) or a group of its own
  icon: "database",        // puzzle, shield, bug, lock, scan, activity, database, bell, key, box, ban, search
  async load(ctx) {
    const out = await ctx.script(`df -P --output=target,pcent | tail -n +2`);
    return [
      { type: "note", kind: "info", text: "Filesystems and how full they are." },
      {
        type: "table",
        title: "Filesystems",
        columns: ["Mount", "Used"],
        rows: out.trim().split("\n").map((l) => ({ cells: l.trim().split(/\s+/) })),
        actions: [{ label: "Check", argv: ["disk-alert", "--limit", "90"] }],
      },
    ];
  },
},
```

`load` runs each time the section opens, with the same `ctx` as a command, except `ctx.lf`. It returns blocks:

| block | fields |
|---|---|
| `note` | `text`, `kind` (`ok`, `info`, `warn`, `bad`), `actions` |
| `facts` | `title`, `items: [{ label, value }]`, `actions` |
| `table` | `title`, `sub`, `columns`, `rows: [{ cells, actions }]`, `empty` (text for no rows), `actions` |
| `text` | `title`, `text`, `mono` |
| `actions` | `items` |

A cell or fact value is a string, a number or `{ text, kind?, mono?, title? }`. A `kind` draws it as a badge.

An action is a button: `{ label, argv, primary?, danger?, confirm?, fields? }`. It runs `lf <argv> -s <server>`
as a job and reloads the section when the job succeeds. `confirm` asks first. `fields` asks for values first:
`{ name, label, type?: "text" | "select" | "check", options?, value?, placeholder?, hint?, required?, flag? }`.
A value goes into the argv after its `flag`, or as a positional argument, in field order. A ticked `check` adds
its flag.

A plugin with a panel and no `""` command gets `lf <plugin>` for free. It prints the panel as text, and
`--json` prints its blocks.

### Types

The types (`Plugin`, `PluginContext`, `UiBlock`) are in `src/core/plugin-api.ts` of the landfall repository. The
built-in plugins in `src/plugins/` use the same API and are fuller examples.
