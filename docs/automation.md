# Scripts, CI and AI agents

Everything landfall does is a plain `lf` command. The web UI only runs those commands and prints each one
(`$ lf logs blog -s vps -f`), so a script, a CI job or an AI agent can do everything the UI can.

This page is the contract for running `lf` without a person at the keyboard. For CI specifically, see also
[Deploy from CI](deploy.md#deploy-from-ci).

## The contract

- **No hidden prompts.** Without a terminal, prompts are never shown. A command that would ask **fails** with
  `… Pass -y to confirm (no terminal to ask).` It never silently goes ahead.
- **`-y` accepts and takes defaults.** It answers yes to confirmations, skips "type the name to confirm" checks,
  and takes the default for questions that have one. A question without a default fails with
  `missing value for "…" (no TTY; pass it as a flag)`: pass that value as a flag.
- **`-y` never overrides a safety refusal.** A firewall change that would lock out ssh, a setup step that would
  break a running service, or a key removal that would lock out this machine stays refused. Only `--force`
  does that. Errors that `--force` would override say so in their text.
- **Exit codes:** `0` success, `1` error (the message starts with `error:` on stderr), `2` unknown command.
- **stdout is the result, stderr is progress.** Progress lines, warnings and errors go to stderr, so
  `lf … --json | jq` gets clean JSON.
- **Every change is journaled** on the server with the shell that reverts it. `lf history --json` shows what a
  run changed and `lf undo` reverts it. See [History and undo](history.md).

## Machine-readable output

`--json` works on:

| area | commands |
|---|---|
| sites | `ls` (`--others` adds containers landfall did not deploy: `{sites, others}`), `sites info`, `domains` (the server's addresses under `ips`), `env`, `secret`, `volumes`, `tunnels`, `check` |
| servers | `server list`, `server info`, `server config`, `server domain`, `config` |
| monitoring | `stats`, `disk`, `traffic`, `certs` |
| system | `system`, `services`, `keys`, `users`, `bans`, `swap`, `log-limit`, `security`, `firewall` |
| maintenance | `updates`, `scan`, `prune`, `traefik status`, `history` |
| local CLI | `version` (also `--version` and `-v`) |

Read the installed CLI version without connecting to a server:

```sh
lf version --json                          # returns {"version":"<installed version>"}
```

`lf --version --json` and `lf -v --json` return the same object. Without `--json`, all three forms print only the version string.

The web UI reads the very same JSON, so its shape is stable within a release. `lf env --json` hides values
unless you add `--reveal`. `lf secret --json` never contains secret values.

## Passing secrets

Command lines show up in `ps` and shell history. Keep secrets out of them:

| what | how |
|---|---|
| root / login password for `setup`, `server add`, `deploy --host` | `--password-stdin` or `$LANDFALL_PASSWORD` |
| a site's environment | `lf env --dotenv -` or `lf deploy --dotenv -`, values on stdin |
| a secret file | `lf secret --file NAME=./path` |
| a login for `lf auth` | `lf auth -u anna --password-stdin` |
| any `--…password` option | `$LANDFALL_SECRET_<OPTION>`, e.g. `LANDFALL_SECRET_DASHBOARD_PASSWORD` |

The server journal records `KEY=…` and `--password …`, never the values.

## Choosing the server and site

Be explicit in automation. Defaults come from `./.landfall.json` and the default server, which depend on the
current directory and the machine:

- **site** `[name]`: the argument, else `name` from `./.landfall.json`.
- **server** `-s`: the flag, else `server` from `./.landfall.json`, else the default server (`lf server use`).
- **environment** `-E staging` (or `$LANDFALL_ENV`): works on the environment's site instead of the project's.

`-s` takes anything `ssh` takes: an alias from `~/.ssh/config`, a server landfall registered, or `user@host`.
Isolate a run from the user's setup with `LANDFALL_CONFIG_DIR` (landfall's config) and `LANDFALL_SSH_CONFIG`
(an ssh config file passed as `ssh -F`).

## Look before you change

| question | read-only command |
|---|---|
| what would setup change? | `lf setup <server> --check` |
| what runs where? | `lf ls -s <server> --json`, `lf sites info <site> --json` |
| is a site healthy? | `lf check <site> --json` (exit 1 when it fails), `lf logs <site> -n 200` |
| why no certificate? | `lf certs --json`, `lf traefik logs` |
| what is pending? | `lf updates --json`, `lf scan --json` |
| what would prune remove? | `lf prune --dry-run --json` |
| what did landfall change? | `lf history --json` |
| what can the server do? | `lf server info --json` (OS support, login, init system, Docker) |

## What cannot be undone

Most changes revert with `lf undo`. These do not, so confirm them with the user before running them:

- `lf sites rm` (the site; its volumes stay, or with `--volumes` are backed up first and can be restored)
- `lf release rm`, `lf prune` (all variants), `lf volume backup rm`
- `lf update --packages` / `--security` (package upgrades), `lf reboot`
- `lf users rm`, `lf users passwd`
- `lf swap off`, `lf services restart`, plain restarts
- `lf server uninstall`
- a firewall rule that replaced an existing one

`lf undo` changes only the server. Local `~/.config/landfall` and `.landfall.json` stay as they are.

## Recipes

A server from nothing to a live site:

```sh
printf '%s' "$ROOT_PW" | lf setup box --host 203.0.113.7 --password-stdin -y
lf server domain box example.com -y
lf deploy ./dist -n blog -s box -y          # → https://blog.example.com
lf check blog -s box --json                 # exit 1 if it does not answer over HTTPS
lf ls -s box --json
lf history -s box --json
lf undo -s box -y                           # revert the last run
```

Redeploy and verify:

```sh
lf deploy -y                                # name, server and domains from ./.landfall.json
lf check --json                             # every site on the server, as a visitor sees it
```

A failed start puts the previous release back and exits `1`, so a deploy never leaves a site down.

Diagnose a site that does not answer:

```sh
lf sites info blog --json                   # services, state, domains, live release
lf logs blog -n 200                         # all services; lf logs blog db for one
lf domains blog --json                      # where DNS points, whether HTTPS answers
lf certs --json                             # certificate state and recent ACME errors
lf rollback blog -y                         # back to the previous release (undoable)
```

Change configuration safely:

```sh
echo "API_KEY=$API_KEY" | lf env blog --dotenv - -y   # recreates the services
lf volume backup blog -y                              # before risky data changes
lf history --json                                     # confirm what changed
```

## Errors you will see

| message | meaning |
|---|---|
| `… Pass -y to confirm (no terminal to ask).` | add `-y` once you are sure |
| `missing value for "…" (no TTY; pass it as a flag)` | the command needs a flag that a person would have typed |
| `… (--force to do it anyway)` | a safety check refused. Fix the cause; use `--force` only with the user's consent |
| `another deploy of <site> is running (<who>)` | wait, or check `lf history`; a lock left by a cut-off deploy expires after an hour |
| `cannot connect to <host>: …` | ssh failed; the rest is ssh's own last line |

More in [Troubleshooting](troubleshooting.md).
