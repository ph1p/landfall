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

A plugin is an ES module. Its default export describes the plugin. `lf plugin new <name>` writes a working one
with a command and a web UI section. A smaller example:

```js
// ~/.config/landfall/plugins/disk-alert.mjs
/** @type {import("landfall/plugin").Plugin} */
export default {
  name: "disk-alert",
  summary: "Warn when a disk is fuller than a limit.",
  version: "0.1.0",
  commands: [
    {
      name: "", // lf disk-alert
      summary: "List the filesystems fuller than --limit percent.",
      options: {
        limit: { type: "string", short: "l", desc: "percent", default: "80" },
        json: { type: "boolean", desc: "machine-readable output" },
      },
      async run(ctx, args, opts) {
        const out = await ctx.script(`df -P --output=target,pcent | tail -n +2`);
        const full = out
          .trim()
          .split("\n")
          .map((l) => l.trim().split(/\s+/))
          .filter(([, p]) => parseInt(p) > Number(opts.limit));
        if (opts.json) return ctx.json(full.map(([mount, used]) => ({ mount, used })));
        if (!full.length) return ctx.log.ok("no disk is that full");
        ctx.table(full);
      },
    },
  ],
};
```

Now `lf disk-alert --help` shows its options, `lf disk-alert -s web1` runs it, and `lf --help` lists it under Plugins.

### Develop and test

```sh
lf plugin new disk-alert          # write ~/.config/landfall/plugins/disk-alert.mjs
lf plugins                        # is it loaded? a broken plugin shows its error here
lf disk-alert --help              # its options, as landfall parsed them
lf disk-alert -s web1             # run it against a server
lf disk-alert -s web1 --json | jq # results only on stdout
lf ui                             # its section on each server's page
```

- landfall imports every plugin each time `lf` starts. Edits take effect on the next run.
- Keep the module's top level cheap and free of side effects. Do the work in `run` and `load`.
- A plugin that throws while loading, or fails the checks below, is skipped with a warning. Other commands still work.
- Try changes on a test server. `lf history -s web1` shows what your plugin journaled, `lf undo -s web1` takes it back.

### Types in your editor

The package `landfall` exports the plugin types as `landfall/plugin`. Install it next to your plugin for completion
and type checks:

```sh
# in the folder that holds your plugin
npm i -D landfall
```

```js
/** @type {import("landfall/plugin").Plugin} */
export default { … };
```

The `@type` line is a comment. The plugin runs the same without the package. A folder plugin with `landfall` in its
dependencies can also import the helper, which only adds types:

```js
import { definePlugin } from "landfall/plugin";

export default definePlugin({ … });
```

Write TypeScript if you like, but compile it to `.mjs` first: landfall loads JavaScript only. The same module
exports `UiBlock`, `UiAction`, `PluginContext` and the other types named on this page.

### Folder plugins

A plugin can be a folder with `index.mjs`, `index.js` or a `package.json` whose `main` names the entry file.
Use a folder when the plugin has its own files or npm dependencies: run `npm install` in it before
`lf plugin add ./folder`, since the folder is copied as it is.

### The plugin object

| field | what |
|---|---|
| `name` | command and section name: lowercase letters, digits, dashes; starts with a letter; at most 32 characters |
| `summary` | one sentence, for `lf --help` and `lf plugins` |
| `version` | optional, shown by `lf plugins` |
| `commands` | the commands; see below |
| `aliases` | shorthands for its own commands, e.g. `{ bans: "fail2ban" }` |
| `panel` | its web UI section; see below |

A plugin whose command or alias is already an `lf` command is skipped as a whole.

### Commands

| field | what |
|---|---|
| `name` | `""` makes `lf <plugin>`, else `lf <plugin> <name>`; lowercase letters, digits, dashes |
| `summary` | one sentence, for `--help` |
| `args` | optional, for `--help`, e.g. `"<ip>"` or `"[site...]"` |
| `options` | `{ <name>: { type: "string" \| "boolean", desc, short?, default?, multiple? } }` |
| `local` | `true`: no `-s` and no server; `ctx.name` is `""`, `ctx.server` is undefined |
| `run(ctx, args, opts)` | `args` are the positional arguments, `opts` the option values; returns nothing or an exit code |

- Every command gets `-h`/`--help`, `-y`/`--yes`, `-E`/`--environment` and `-K`/`--ask-sudo`. All but local
  ones get `-s`/`--server`. Your options cannot use these names or short forms: landfall refuses the plugin.
- A `short` is one letter. `multiple: true` lets an option repeat; `opts.<name>` is then an array.
- `opts` has the defaults filled in. Option names keep their dashes: `opts["dry-run"]`.
- Two commands of one plugin cannot share a name.

### The context

`ctx` is what your code gets from landfall:

| member | what |
|---|---|
| `ctx.script(body, { admin?, env?, capture? })` | runs bash on the server, returns stdout; `capture: false` streams it instead |
| `ctx.shq(value)` | quotes a value for the shell |
| `ctx.plugin` | the plugin's name |
| `ctx.name`, `ctx.server` | the server as `-s` named it (or the default server), and its ssh settings |
| `ctx.paths.root`, `.sites`, `.traefik` | `/opt/landfall`, its `sites` folder and landfall's Traefik folder |
| `ctx.log.step/ok/info/warn(msg)` | progress on stderr |
| `ctx.fail(msg)` | stops with `error: <msg>` and exit code 1 |
| `ctx.confirm(question, default?)` | asks yes/no; `-y` answers yes; fails without a terminal |
| `ctx.confirmRisky(question)` | asks yes/no before a risky change; `-y` does not answer it; no terminal means no |
| `ctx.ask(question, default?)` | asks for text; `-y` or no terminal takes the default, or fails without one |
| `ctx.table(rows)` | rows as aligned columns on stdout |
| `ctx.json(value)` | a value as JSON on stdout |
| `ctx.print(...lines)` | lines of results on stdout, e.g. a heading between tables |
| `ctx.color.bold/dim/red/green/yellow/blue/cyan` | colors, plain when stdout is not a terminal |
| `ctx.data.get()`, `ctx.data.set(value)` | JSON the plugin keeps on this computer, per server |
| `ctx.lf(argv)` | runs another `lf` command on the same server (unless `argv` has `-s`), e.g. `["harden", "fail2ban"]` |

- `ctx.data` lives in `~/.config/landfall/plugin-data/<plugin>/<server>.json`. A local command has no server:
  `get()` returns `undefined`, `set()` fails.
- `ctx.lf` works in commands only, not in a panel's `load`.
- For a risky change, refuse when `ctx.confirmRisky` says no, and offer a `--force` option for scripts.

### Server scripts

`ctx.script` runs bash with `set -euo pipefail` and landfall's shell helpers in front:

| helper | what |
|---|---|
| `$SUDO` | `sudo` when the login is not root, else empty |
| `record "<what>" "<undo shell>"` | journals a change for `lf history` and `lf undo` |
| `saved <file>` | backs a file up; prints the shell that restores it |
| `svc <action> <service>` | `start`, `stop`, `restart`, `enable` or `disable` a service, with systemd or OpenRC |
| `pkg_install <pkg>…` | installs packages with apt, dnf, yum, apk or zypper |
| `dc …` | `docker compose`, or `docker-compose` where the plugin is missing |

The full list is `PRELUDE` in `src/core/ssh/templates.ts`.

- Put every value into a script through `ctx.shq`, or pass it in `env` and read `$NAME`.
- `env` values do not show in the process list on the server. Use it for secrets.
- `admin` says why the script needs root. It then runs as root or with passwordless sudo, or fails with that reason.
- `capture: false` streams the script's stdout to the user. `ctx.script` then returns `""`.

### Rules your plugin should keep

- **Results on stdout, everything else on stderr.** `ctx.table`, `ctx.json` and `ctx.print` for results,
  `ctx.log` for progress, so `lf <plugin> --json | jq` works.
- **Journal every change.** After each server change, call `record "<what>" "<shell that undoes it>"`. Before
  changing a file, run `undo=$(saved <file>)`; `$undo` restores it. `lf history` shows the change, `lf undo`
  reverts it. No undo shell means it cannot be undone.
- **Ask only through `ctx.confirm`, `ctx.confirmRisky` or `ctx.ask`.** They work with `-y` and without a terminal.
- **`-y` never skips a safety check.** Use `ctx.confirmRisky` or a `--force` option for those.
- **Keep secrets out of argv and the journal.** Pass them in `env`; write `KEY=…` in `record`.
- **No daemon on the server.** Leave plain files, cron lines and Compose projects that work without landfall.

```js
await ctx.script(
  `undo=$(saved /etc/motd)
printf '%s\n' ${ctx.shq(text)} | $SUDO tee -a /etc/motd >/dev/null
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

- `load` runs each time the section opens. Keep it read-only and quick: no prompts, no changes.
- It gets the same `ctx` as a command, except `ctx.lf`.
- An unknown `icon` shows a puzzle piece.

`load` returns blocks:

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
- A job has no terminal. Ask with `confirm` instead, and put `-y` in `argv` so the command's own question is answered.
- `confirm` asks first, with this text.
- `fields` asks for values first: `{ name, label, type?: "text" | "select" | "check", options?, value?, placeholder?, hint?, required?, flag? }`.
  Each value goes in after its `flag`, or as a positional argument, in field order. A ticked `check` adds its flag.

A plugin with a panel and no `""` command gets `lf <plugin>` for free: it prints the panel as text, or its
blocks with `--json`.

### More examples

The built-in plugins in [`src/plugins/`](https://github.com/ph1p/landfall/tree/main/src/plugins) use the same API.
`fail2ban.ts` changes a server and journals it. `trivy.ts` keeps data per server and asks before a large download.
