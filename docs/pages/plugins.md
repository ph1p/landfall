# Plugins

A plugin adds commands to `lf` and a section to the server page of `lf ui`. landfall ships `analytics`,
`exposure`, `fail2ban` and `trivy`. Yours are JavaScript files in `~/.config/landfall/plugins`.

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

### analytics

```sh
lf analytics enable blog          # count visitors of blog with a collector on the server
lf analytics report               # visitors, pages, sources, journeys, funnels, events, web vitals
lf analytics disable blog         # stop collecting; --purge also deletes the data
lf analytics uninstall            # remove the collector and its data from the server; --keep-data keeps the data
```

- Off until you enable it for a site. No cookie and no stored IP address by default.
- The web UI section *Analytics* (under Monitoring) shows charts for 7, 30 or 90 days, with buttons to enable, disable, add funnels and uninstall.

[Analytics](analytics.md) explains everything: the script tag, events, funnels, cookie modes and the EU.

### exposure

Finds what a deploy should not show the internet: files that do not belong on a web server, and open ports.
`lf security` checks the same files in the sites already on the server.

```sh
lf exposure check                 # check this project before a deploy; exits 1 on a high or medium finding
lf exposure check --strict        # also exit 1 on low findings (.DS_Store, logs, editor folders)
lf exposure check --allow .claude/ --allow-port 25565   # accept a path (.gitignore syntax) or a port
```

What it flags:

- **high**: `.env` files, `.git`, ssh and private keys, keystores, `.npmrc`, `.netrc`, `.htpasswd`, cloud
  credentials (`.aws`, `.kube`, `credentials.json`), Terraform state, shell history.
- **medium**: AI agent settings (`.claude`, `.cursor`, `.windsurf`, `.aider*`, `settings.local.json`), database
  dumps (`*.sql`, `*.sqlite`, `*.dump`), `.svn`, `.hg`, backup and swap files.
- **low**: `.DS_Store`, `Thumbs.db`, `__MACOSX`, `.vscode`, `.idea`, `*.log`.
- **ports**: a port that Docker publishes on a public address. Docker bypasses ufw, so the port is open even when
  the firewall blocks it. Databases, caches and the Docker API (5432, 3306, 6379, 27017, 2375, …) are high.

- `check` looks only at what `lf deploy` would upload. Files the upload already leaves out (`.env`, `.git`,
  `.DS_Store`, your `exclude` rules) do not count.
- `check` reads ports from the compose file. A plain compose file loses its ports on the server, so it has none.
- `*.pem` and `*.key` count only when they hold a private key. Certificates pass.

To stop a deploy that would upload such files, add a predeploy hook to `.landfall.json`:

```json
{
  "hooks": { "predeploy": "lf exposure check" }
}
```

Remove a finding with an `exclude` rule in `.landfall.json`, or bind the port to `127.0.0.1` in the compose file.

The deploy dialog of `lf ui` shows what `lf exposure check` finds in the folder, beside the form.

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

Read the folder's other files with `ctx.file(name)`, by a path relative to the entry file. A command that uploads a
script or a template keeps it as a real file this way, not as a string in its code:

```js
// my-plugin/index.mjs reads my-plugin/app/server.mjs and uploads it
const server = ctx.file("app/server.mjs");
await ctx.script(`printf '%s' ${ctx.shq(server)} > /opt/my-plugin/server.mjs`, { admin: "writes /opt/my-plugin" });
```

- `ctx.file` returns the file as text. It stops the command when the file is missing.
- A single-file plugin reads files next to its `.mjs` file.

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
| `ctx.blocks(blocks)` | UI blocks as text on stdout, the way `lf <plugin>` prints a panel |
| `ctx.file(name)` | a file the plugin ships with, as text (see [Folder plugins](#folder-plugins)) |
| `ctx.color.bold/dim/red/green/yellow/blue/cyan` | colors, plain when stdout is not a terminal |
| `ctx.data.get()`, `ctx.data.set(value)` | JSON the plugin keeps on this computer, per server |
| `ctx.lf(argv)` | runs another `lf` command on the same server (unless `argv` has `-s`), e.g. `["harden", "fail2ban"]` |

- `ctx.data` lives in `~/.config/landfall/plugin-data/<plugin>/<server>.json`. A local command has no server:
  `get()` returns `undefined`, `set()` fails.
- `ctx.lf` works in commands only, not in a panel's `load`.
- `ctx.blocks` lets a command print the same blocks its panel shows: one view for the web UI and the terminal.
  It does not list the actions' commands; `lf <plugin>` does.
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

- **Results on stdout, everything else on stderr.** `ctx.table`, `ctx.json`, `ctx.print` and `ctx.blocks` for results,
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
| `stats` | `title`, `sub`, `items` (below), `actions`: key numbers as tiles |
| `table` | `title`, `sub`, `columns`, `rows: [{ cells, actions }]`, `empty` (text for no rows), `actions` |
| `text` | `title`, `text`, `mono` |
| `actions` | `items` |
| `heading` | `text`, `sub`: a title that starts a group of blocks |
| `chart` | `chart` (`line`, `bars`, `funnel`), `title`, `sub`, `actions`, and the chart's data (below) |

Every block takes `half: true`. The web UI then draws it half as wide, and two half blocks in a row share the line.
`lf <plugin>` ignores it.

A chart is drawn as SVG in the web UI and as text bars by `lf <plugin>`:

- `line`: `labels` (e.g. days) and `series: [{ name, values }]`, one value per label. `unit` is shown on hover.
- `bars`: `items: [{ label, value, text?, title?, kind?, mono?, actions? }]`, drawn in the given order. `empty` is shown for no items.
  `show: n` makes the web UI show the first n bars and a button for the rest. `lf <plugin>` prints all.
- `funnel`: `items` as for `bars`, in step order. Each bar shows its share of the first step and the drop since the step before.

A `stats` block shows each item as a tile with a big number. `lf <plugin>` prints one line per item.

- `label` and `value` are required.
- `change` is the change against the period before, in percent. `null` shows "new".
- A rise shows green, a fall red. `lowerIsBetter: true` turns that around, for example for a bounce rate.
- `spark` is a list of numbers, oldest first. It draws a small trend line under the value.
- `note` is a quiet line under the value. `title` is shown on hover.
- `kind: "ok"` adds a live dot. `warn` and `bad` color the value.

```ts
// two tiles: visitors with their trend, and a bounce rate that went down
{ type: "stats", title: "Last 7 days", items: [
  { label: "Visitors", value: 1200, change: 12, spark: [140, 180, 160, 200, 170, 190, 160] },
  { label: "Bounce rate", value: "41%", change: -5, lowerIsBetter: true },
] }
```

```js
{ type: "chart", chart: "bars", title: "Sources", half: true,
  items: [{ label: "news.example", value: 120 }, { label: "direct", value: 80 }] }
```

A cell or fact value is a string, a number or `{ text, kind?, mono?, title? }`. A `kind` draws a badge.

An action is a button: `{ label, argv, title?, primary?, danger?, confirm?, fields? }`.

- It runs `lf <argv> -s <server>` as a job and reloads the section on success.
- A job has no terminal. Ask with `confirm` instead, and put `-y` in `argv` so the command's own question is answered.
- `confirm` asks first, with this text.
- `fields` asks for values first: `{ name, label, type?, options?, suggest?, min?, max?, value?, placeholder?, hint?, required?, flag? }`.
  Each value goes in after its `flag`, or as a positional argument, in field order. A ticked `check` adds its flag.
- `type` is `"text"` (the default), `"number"`, `"select"` or `"check"`.
- A `select` offers its `options`. An option is a value, or `{ value, label }` to show a label instead.
- A `number` takes whole numbers between `min` and `max`. The dialog refuses anything else.
- `suggest` lists values a text or number field offers while typing. Other values are still accepted.

```js
fields: [
  // a pick list that shows labels and passes the values
  { name: "days", label: "Keep", type: "select", flag: "--keep-days", options: [{ value: "30", label: "30 days" }, { value: "365", label: "1 year" }] },
  // a number from 1 to 10
  { name: "retries", label: "Retries", type: "number", min: 1, max: 10, flag: "--retries" },
  // free text with common values offered
  { name: "ban", label: "Ban for", flag: "--bantime", suggest: ["10m", "1h", "1d"] },
],
```

`views` adds a switch to the section, for example a time range:

```js
panel: {
  label: "Visits",
  views: [{ id: "7", label: "7 days" }, { id: "30", label: "30 days" }],
  async load(ctx, view) {
    // view is "7" or "30": the first one when nothing was picked
  },
},
```

- An `id` has lowercase letters, digits and dashes. Ids differ.
- `lf <plugin> --view 30` picks a view on the command line.

A plugin with a panel and no `""` command gets `lf <plugin>` for free: it prints the panel as text, or its
blocks with `--json`.

### More examples

The built-in plugins in [`src/plugins/`](https://github.com/ph1p/landfall/tree/main/src/plugins) use the same API.
`fail2ban.ts` changes a server and journals it. `trivy.ts` keeps data per server and asks before a large download.
