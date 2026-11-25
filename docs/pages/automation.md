# Scripts, CI and AI agents

Everything landfall does is a plain `lf` command. The web UI runs those commands and prints each one
(`$ lf logs blog -s vps -f`), so a script, CI job or AI agent can do everything the UI can.

This page is the contract for running `lf` unattended. For CI, see also [Deploy from CI](deploy.md#deploy-from-ci).

## The contract

- **No hidden prompts.** Without a terminal, a command that would ask **fails** with
  `… Pass -y to confirm (no terminal to ask).` It never goes ahead silently.
- **`-y` accepts and takes defaults.** It answers yes, skips "type the name to confirm" checks, and takes each
  question's default. A question without a default fails with `missing value for "…" (no TTY; pass it as a flag)`.
  Pass that value as a flag.
- **`-y` never overrides a safety refusal**: a firewall change that locks out ssh, a setup step that breaks a
  running service, a key removal that locks out this machine. Only `--force` does, and the error says so.
- **Exit codes:** `0` success, `1` error (message starts with `error:` on stderr), `2` unknown command.
- **stdout is the result, stderr is progress**, warnings and errors. `lf … --json | jq` gets clean JSON.
- **Every change is journaled** on the server with the shell that reverts it. `lf history --json` shows what a
  run changed; `lf undo` reverts it. See [History and undo](history.md).

## Machine-readable output

`--json` works on:

| area | commands |
|---|---|
| sites | `ls`, `sites info`, `domains`, `env`, `secret`, `volumes`, `tunnels`, `check`, `scale`, `weight`, `refs`, `git track`, `git key`, `ci init`, `ci rm`, `autodeploy` |
| servers | `server list`, `server info`, `server upgrade`, `server config`, `server domain`, `config` |
| monitoring | `stats`, `disk`, `traffic`, `certs` |
| system | `system`, `services`, `keys`, `users`, `swap`, `log-limit`, `security`, `firewall` |
| maintenance | `updates`, `scan`, `prune`, `traefik status`, `traefik access-log`, `traefik strict-tls`, `redirects`, `history` |
| plugins | `plugins`, `fail2ban` (alias `bans`), `trivy`, `trivy images`, `trivy files`, and `lf <plugin>` for a plugin that prints its web UI section |

- `ls --others` adds containers landfall did not deploy: `{sites, others}`.
- `domains` lists the server's addresses under `ips`, and redirect hosts under `redirects`, each with `to`.
- `redirects` lists `{server, ips, redirects}`, and `error` when the redirects file is not landfall's; each redirect has `host`, `to`, `permanent`, `path` and its DNS and HTTPS state.
- `certs` lists each domain under `domains` with its `site`. A server redirect's host has no `site`; its `redirect` is the target.
- `scale` and `weight` print `{site, services}`; each service has `replicas`, `source`, `update`, and `weight` and `split` in a traffic split, and `match` when it has one.
- `git key` prints `{url, server, publicKey, created, added}`; with `--rm`, `{url, server, removed}`. It never prints the private key.
- `ci init --dry-run` prints the plan: `forge`, `cli`, `name`, `repo`, `file` (from the repository's root), `here` (from this folder), `exists` (`false`, `ours` or `other`), `yaml`, `secrets` (names only), `servers`, `targets`, `loggedIn`, `runsPage`, `secretsPage`, and `fallbackBranch`, `include` and `untracked` when they apply. `ci init` prints the same, plus `secretsSet`, and `secretFiles` when it wrote the secrets to files. It never prints the private key.
- `ci rm` prints `{repo, servers, secretsRemoved}`.
- `weight --stats` prints `{site, since, format, services}`. `since` is in seconds; `format` is `json`, `common` (plain-text log, no counts) or `none`. Each service has `service`, `split`, `weight`, `match`, `requests`, `matched`, `classes` (`2xx` to `5xx`) and `p50` and `p95` in milliseconds.
- `traffic` and `traffic <site>` include `accessLog`: how the proxy's flags configure its access log. It is `json`, `common` (plain text), `off`, `file` (written inside the container) or `unknown` (a config file landfall does not read). `lf traefik access-log on` fixes `off` and `common`. `log` is the proxy's container log: `driver`, `maxSize` and `maxFile` (its cap, missing when there is none) and `bytes` (on disk, only when the login can read it).
- `traefik status` includes `unknownHosts` when there is a container: what port 443 answers for a made-up hostname. `state` is `refused`, `default-cert` (browsers warn), `cert` (with `subject`) or `unreachable` (with `error`).
- `traefik strict-tls` prints `{container, own, unknownHosts}`, with `unknownHosts` as in `traefik status`.
- `traefik access-log` prints `{container, own, accessLog, log}`. `log` is as in `traffic`, or `null` without a proxy.
- `ls` and `sites info` add `scale` to a site that uses replicas, rolling deploys or a split: per service, its `replicas` wanted and `running`.
- `autodeploy` prints `{site, server, enabled, every, env, rule, url, dir, last, log, cron}`. `last` is the last commit it looked at: `{sha, result, at, ref}`, `result` one of `deployed`, `deploying`, `failed`, `running`, `older`, `skipped-config`. `cron` is missing when the crontab has no line for it.
- `refs` prints `{repo, url, envs}`. Each environment has `env`, `site`, `server`, `rule`, `ruleText`, `matching` (tags newest first, then branches), `running` (`null`: no release; missing: never deployed), `newest`, `behind` (commits), `auto` (the interval, when it [deploys itself](git.md#auto-deploy-the-server-deploys-new-commits)) and `error` when its server cannot be read.
- `git track` prints `{url, rules}`, keyed by environment; `""` is the project itself.
- `env` hides values unless you add `--reveal`. `secret` never contains secret values.

The web UI reads the same JSON, so its shape is stable within a release.

## Passing secrets

Command lines show up in `ps` and shell history. Keep secrets out of them:

| what | how |
|---|---|
| root / login password for `setup`, `server add`, `deploy --host` | `--password-stdin` or `$LANDFALL_PASSWORD` |
| the login's sudo password, for root work | `$LANDFALL_SUDO_PASSWORD` (`-K` asks in a terminal) |
| a site's environment | `lf env --dotenv -` or `lf deploy --dotenv -`, values on stdin |
| a secret file | `lf secret --file NAME=./path` |
| a login for `lf auth` | `lf auth -u anna --password-stdin` |
| any `--…password` option | `$LANDFALL_SECRET_<OPTION>`, e.g. `LANDFALL_SECRET_DASHBOARD_PASSWORD` |

The server journal records `KEY=…` and `--password …`, never the values.

## Choosing the server and site

Be explicit. Defaults depend on the current directory and the machine:

- **site** `[name]`: the argument, else `name` from `./.landfall.json`.
- **server** `-s`: the flag, else `server` from `./.landfall.json`, else the default server (`lf server use`).
- **environment** `-E staging` (or `$LANDFALL_ENV`): the environment's site instead of the project's.

`-s` takes anything `ssh` takes: an alias from `~/.ssh/config`, a registered server, or `user@host`.
Isolate a run from the user's setup with `LANDFALL_CONFIG_DIR` (landfall's config) and `LANDFALL_SSH_CONFIG`
(an ssh config file, passed as `ssh -F`).
Without a terminal landfall does not check for a newer version of itself; `LANDFALL_NO_UPDATE_CHECK=1` turns the check off everywhere.

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
| which registries can the server pull from? | `lf registries --json` |
| which landfall changed the server, what upgrades are pending? | `lf server upgrade --json` (changes nothing) |
| what runs in each environment, what is newer? | `lf refs --json` (see [Git deploys](git.md)) |
| what can the server do? | `lf server info --json` (OS support, cloud provider as `cloud`, login, init system, Docker) |

## What cannot be undone

`lf undo` cannot revert these. Confirm them with the user first:

- `lf sites rm` (its volumes stay; with `--volumes` they are backed up first and can be restored)
- `lf release rm`, `lf prune` (all variants), `lf volume backup rm`
- `lf update --packages` / `--security` (package upgrades), `lf reboot`
- `lf users rm`, `lf users passwd`
- `lf swap off`, `lf services restart`, plain restarts
- `lf traefik access-log clear` (the emptied log is gone)
- `lf server uninstall`
- `lf trivy rm` (the next scan downloads Trivy again)
- `lf registry logout` (log in again with `lf registry login`)
- `lf git key --rm` (the private key is gone: make a new one and add it to the repository again)
- installing git or jq on the server (`lf deploy --git`, `lf autodeploy`)
- the forge secrets `lf ci init` sets (it overwrites earlier values), and `lf ci rm` deleting them
- whatever a plugin does without journaling it; `lf plugin add` and `lf plugin rm` change only this computer
- a firewall rule that replaced an existing one
- what a [lifecycle hook](hooks.md) did (a migration, a notification)

`lf undo` changes only the server, never local `~/.config/landfall` or `.landfall.json`.

## Recipes

A server from nothing to a live site:

```sh
printf '%s' "$ROOT_PW" | lf setup box --host 203.0.113.7 --password-stdin -y
lf server domain box example.com -y         # new sites get <site>.example.com
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
| `missing value for "…" (no TTY; pass it as a flag)` | pass as a flag what a person would have typed |
| `… (--force to do it anyway)` | a safety check refused. Fix the cause; `--force` only with the user's consent |
| `another deploy or change of <site> is running (<who>): …` | wait, or check `lf history`. A lock from a cut-off run expires after an hour |
| `cannot connect to <host>: …` | ssh failed; the rest is ssh's last line |
| `installing … needs root: …` | the login is not root and has no passwordless sudo. Give the sudo password (`$LANDFALL_SUDO_PASSWORD`), add a root key login (`lf server config --root-login`), or install it as root with the command the message names |
| `hook <name> failed: <pm> run <script>` | a [lifecycle hook](hooks.md) from `package.json` failed. Fix it, or `--skip-hook <name>` with the user's consent |

More in [Troubleshooting](troubleshooting.md).
