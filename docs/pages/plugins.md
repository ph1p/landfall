# Plugins

A plugin adds commands to `lf` and a section to the server page of `lf ui`. landfall ships `fail2ban` and
`trivy`. Yours are JavaScript files in `~/.config/landfall/plugins`.

A plugin runs bash over ssh, like landfall: no agent on the server. Every button in its web UI section runs an
`lf` command, shown as a job.

## Using plugins

```sh
lf plugins                        # every plugin, its commands and web UI section
lf plugin add ./disk-alert.mjs    # install a file, or a folder with index.mjs or package.json "main"
lf plugin add ./disk-alert.mjs --force   # replace an installed plugin of that name
lf plugin rm disk-alert           # remove it; says what it keeps on this computer
lf plugin new disk-alert          # write a starter to ~/.config/landfall/plugins/disk-alert.mjs
lf plugin new disk-alert --out ./disk-alert.mjs   # write it elsewhere; install later with lf plugin add
```

- `lf plugin add` loads the plugin first and refuses a broken one, or one with a built-in plugin's name.
- A plugin that fails to load is skipped with a warning. `lf plugins` shows the error.
- A plugin whose command or alias is already an `lf` command is skipped as a whole.
- `LANDFALL_NO_PLUGINS=1` skips your plugins for one run. Built-in ones still load.

Plugins run with your user's rights on this computer. Install only plugins you trust.

## Built-in plugins

### fail2ban

```sh
lf fail2ban                       # jails, their settings and banned IPs (alias: lf bans)
lf fail2ban ban 203.0.113.9       # ban in the sshd jail; --jail for another
lf fail2ban unban 203.0.113.9     # unban in every jail (alias: lf unban)
lf fail2ban config sshd --bantime 1h --maxretry 3   # also --findtime; -1 bans for good
lf fail2ban install               # same as lf harden fail2ban
```

- `config` writes `/etc/fail2ban/jail.d/50-landfall-<jail>.local`, keeps settings you do not give, and reloads fail2ban.
- `ban`, `unban` and `config` are journaled; `lf undo` reverts them.
- fail2ban answers root only, so every command needs root or passwordless sudo, else the server's
  [root login](servers.md#root-login).

The web UI section *fail2ban* (under Machine) shows the same, with buttons to ban, unban and change a jail.

### trivy

```sh
lf trivy                          # what Trivy keeps on the server, what the last scans found
lf trivy images                   # scan running images, keep a summary (lf scan lists every vulnerability)
lf trivy files                    # scan sites' current releases for secrets and misconfigurations
lf trivy files blog               # only some sites
lf trivy rm                       # remove Trivy's image and databases from the server
```

- The first scan downloads Trivy and its databases (several GB). landfall asks first.
- `files` skips `.env` files, `node_modules` and `.git`.
- Scans change nothing on the server. Summaries of the last full scans stay in `~/.config/landfall/plugin-data/trivy/`.

The web UI section *Trivy* (under Machine) shows the summaries, with buttons to scan again.

## Writing a plugin

A plugin is an ES module whose default export describes it. `lf plugin new <name>` writes a working one. A
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

Now `lf disk-alert --help` shows its options, `lf disk-alert -s web1` runs it, and `lf --help` lists it under Plugins.

### The plugin object

| field | what |
|---|---|
| `name` | command and section name: lowercase letters, digits, dashes; starts with a letter; at most 32 characters |
| `summary` | one sentence, for `lf --help` and `lf plugins` |
| `version` | optional, shown by `lf plugins` |
| `commands` | the commands; see below |
| `aliases` | shorthands for its own commands, e.g. `{ bans: "fail2ban" }` |
| `panel` | its web UI section; see below |

A command has:

- `name`: `""` makes `lf <plugin>`, else `lf <plugin> <name>`
- `summary`
- `args`: optional, for help, e.g. `"<ip>"`
- `options`: each `{ type: "string" | "boolean", desc, short?, default?, multiple? }`
- `local: true`: no `-s` and no server (`ctx.name` and `ctx.server` are absent)
- `run(ctx, args, opts)`: returns nothing or an exit code

Every other command gets `-s <server>`; all get `-y` and `--help`.

### The context

`ctx` is what your code gets from landfall:

| member | what |
|---|---|
| `ctx.script(body, { admin?, env?, capture? })` | runs bash on the server, returns stdout; `capture: false` streams it instead |
| `ctx.shq(value)` | quotes a value for the shell |
| `ctx.plugin` | the plugin's name |
| `ctx.name`, `ctx.server` | the server as `-s` named it, and its ssh settings |
| `ctx.paths.root`, `ctx.paths.sites` | `/opt/landfall` and its `sites` folder |
| `ctx.log.step/ok/info/warn(msg)` | progress on stderr |
| `ctx.fail(msg)` | stops with `error: <msg>` and exit code 1 |
| `ctx.confirm(question, default?)` | asks yes/no; `-y` answers yes; fails without a terminal |
| `ctx.table(rows)`, `ctx.json(value)` | results on stdout |
| `ctx.color.bold/dim/red/green/yellow/blue/cyan` | colors, plain when stdout is not a terminal |
| `ctx.data.get()`, `ctx.data.set(value)` | JSON the plugin keeps on this computer, per server |
| `ctx.lf(argv)` | runs another `lf` command on the same server (unless `argv` has `-s`), e.g. `["harden", "fail2ban"]` |

Scripts run with `set -euo pipefail` and landfall's shell helpers: `$SUDO`, `svc`, `pkg_install`, `dc` and more
(see `PRELUDE` in `src/core/ssh/templates.ts`). Put every value in through `ctx.shq`, or pass it in `env`.

`admin` says why the script needs root. It then runs as root or with passwordless sudo, or fails with that reason.

### Rules your plugin should keep

- **Results on stdout, everything else on stderr.** `ctx.table` and `ctx.json` for results, `ctx.log` for
  progress, so `lf <plugin> --json | jq` works.
- **Journal every change.** After each server change, call `record "<what>" "<shell that undoes it>"`. Before
  changing a file, run `undo=$(saved <file>)`; `$undo` restores it. `lf history` shows the change, `lf undo`
  reverts it. No undo shell means it cannot be undone.
- **Ask only through `ctx.confirm`.** It works with `-y` and without a terminal.
- **Keep secrets out of argv and the journal.** Pass them in `env`; write `KEY=…` in `record`.

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

An unknown `icon` shows a puzzle piece. `load` runs each time the section opens, with the same `ctx` as a
command except `ctx.lf`. It returns blocks:

| block | fields |
|---|---|
| `note` | `text`, `kind` (`ok`, `info`, `warn`, `bad`), `actions` |
| `facts` | `title`, `items: [{ label, value }]`, `actions` |
| `table` | `title`, `sub`, `columns`, `rows: [{ cells, actions }]`, `empty` (text for no rows), `actions` |
| `text` | `title`, `text`, `mono` |
| `actions` | `items` |

A cell or fact value is a string, a number or `{ text, kind?, mono?, title? }`. A `kind` draws a badge.

An action is a button: `{ label, argv, title?, primary?, danger?, confirm?, fields? }`.

- It runs `lf <argv> -s <server>` as a job and reloads the section on success.
- `confirm` asks first.
- `fields` asks for values first: `{ name, label, type?: "text" | "select" | "check", options?, value?, placeholder?, hint?, required?, flag? }`.
  Each value goes in after its `flag`, or as a positional argument, in field order. A ticked `check` adds its flag.

A plugin with a panel and no `""` command gets `lf <plugin>` for free: it prints the panel as text, or its
blocks with `--json`.

### Types

`Plugin`, `PluginContext` and `UiBlock` are in `src/core/plugins/plugin-api.ts` of the landfall repository. The built-in
plugins in `src/plugins/` use the same API and are fuller examples.
