# landfall

Set up Linux servers and deploy sites to them behind [Traefik](https://traefik.io) with automatic HTTPS, from one CLI.

```sh
npm i -g landfall
lf setup vps --host 203.0.113.7     # fresh Ubuntu/Debian box → Docker, firewall, Traefik, ssh key
cd my-site && lf deploy -s vps      # live at https://my-site.203-0-113-7.sslip.io
```

- **Servers are ssh targets.** Any `~/.ssh/config` alias works. If `ssh vps` works, `lf deploy -s vps` works.
- **No agent on the server.** Every site is a plain Docker Compose project under `/opt/landfall`, so you can read, run and fix it by hand.
- **Your compose.yaml is the site.** App, database, worker: `docker compose up` runs it locally, `lf deploy` runs the same file behind HTTPS.
- **Every change is journaled** on the server and can be undone with `lf undo`.
- **The CLI is the product.** Every feature is an `lf` command first, usable from scripts, CI and agents.
  The web UI (`lf ui`) is a front end for those commands: each button runs one and shows it.

`lf` is short for `landfall`. Both commands are installed.

## Install

You need Node.js 22.4+ plus `ssh`, `ssh-copy-id` and `tar` on your machine (`rsync` makes redeploys faster).

The server needs a login as root or as a user with passwordless sudo. landfall installs Docker itself:

- **Ubuntu and Debian** get the full setup: Docker, ufw and unattended-upgrades. fail2ban only where ssh passwords stay on.
  Behind an AWS, Google Cloud, Azure, Oracle or Alibaba firewall, setup leaves ufw out.
- **Fedora, RHEL-likes, Alpine and SUSE** (dnf, yum, apk, zypper) get Docker and rsync; their base repositories
  lack some of the rest.
- **Systems without a package manager** (Synology DSM, SteamOS) can be deployed to when Docker is already there.
  See [NAS, Steam Deck and other systems](docs/servers.md#nas-steam-deck-and-other-systems-without-a-package-manager).

```sh
npm i -g landfall            # or: pnpm add -g landfall
lf --help                    # all commands
lf <command> --help          # every option of one command
```

## Concepts

| term | meaning |
|---|---|
| **server** | An ssh target: a `~/.ssh/config` alias, or one landfall registered with `lf server add`/`lf setup`. Pass it as `-s <name>`. The first server you add becomes the default. |
| **site** | One Compose project on a server: your `compose.yaml`, or one landfall generates for a static folder, a Dockerfile or a prebuilt image. Services with `x-landfall: { port }` are routed through Traefik. |
| **project file** | `./.landfall.json`, written by the first `lf deploy`: `{ "name", "server", "domains" }`. Commands that take `[name]` default to this site, and `-s` defaults to its server. |
| **main domain** | Optional per-server domain (`lf server domain vps example.com`). Sites then default to `<site>.example.com`, and a bare name like `shop` means `shop.example.com`. Without one, sites get `<site>.<ip-with-dashes>.sslip.io` (e.g. `blog.203-0-113-7.sslip.io`), which resolves without any DNS setup. |
| **release** | Every deploy creates one, with an id like `20260122143005`. The last 5 are kept (`--keep n` for more). `lf rollback` switches between them, back and forth. |
| **run** | One landfall invocation that changed something on a server. Runs are listed by `lf history` and reverted by `lf undo`. |

How defaults resolve, for every command:

- **site** `[name]`: the argument, else `name` from `./.landfall.json`.
- **server** `-s`: the flag, else `server` from `./.landfall.json`, else the default server (`lf server use`).

## A first deploy

```sh
lf setup vps --host 203.0.113.7          # once per server: Docker, firewall, Traefik, an ssh key
lf setup vps --minimal                   # or only Docker: no Traefik, sites are reached with lf tunnel
cd my-site
lf deploy -s vps                         # → https://my-site.203-0-113-7.sslip.io, no DNS needed
lf deploy -s vps -d example.com          # or with your own domain (point its A record at the server first)
lf deploy                                # later: redeploy with the settings saved in ./.landfall.json
```

`lf deploy` works out what the folder is:

| the folder has | landfall |
|---|---|
| a `compose.yaml` | runs it as one Compose project: app, database, worker. See [Compose sites](docs/compose.md). |
| a `Dockerfile` | builds it on the server and routes its `EXPOSE`d port |
| an app (Node.js, Bun, Python, Go, Rust, Java/Kotlin, .NET, Ruby, PHP, Elixir) | writes a Dockerfile for it and builds it on the server |
| static files (or a site generator's build output) | serves them with `nginx:alpine` |
| (any folder) with `--image ghcr.io/me/app:1.2 --port 8080` | pulls and runs a prebuilt image |

Every deploy is a new release. A release whose containers do not start is rolled back automatically, and
`lf rollback` switches between releases by hand.

## Everyday commands

```sh
lf ls                              # sites with status
lf logs -f                         # follow a site's logs
lf env API_KEY=abc                 # set a variable (the services are recreated)
lf domains --add www.example.com   # another domain
lf rollback                        # previous release
lf volume backup                   # back up the site's data
lf updates && lf update            # pending OS and image updates, then apply them
lf history && lf undo              # what landfall changed, and revert the last of it
lf ui                              # the same in a local web UI
```

## Documentation

| guide | covers |
|---|---|
| [Servers](docs/servers.md) | `lf setup` for fresh and existing servers, setup flags, registering servers, NAS and other systems |
| [Deploy a site](docs/deploy.md) | site kinds, env and secrets, CI, what gets uploaded, environments, main domains, running without landfall |
| [Compose sites](docs/compose.md) | `x-landfall`, routes, private ports, IP allowlists, volumes, published ports |
| [Day-to-day](docs/sites.md) | logs, env, secrets, domains, logins, tunnels, restart and removal |
| [Volumes and backups](docs/volumes.md) | volumes, backups, scheduled and offsite backups, push and pull data |
| [Updates](docs/updates.md) | OS packages, images, Docker Compose, vulnerability scans |
| [Traefik](docs/traefik.md) | landfall's Traefik, HTTP/3, the dashboard, using your own Traefik |
| [Server administration](docs/system.md) | firewall, services, SSH keys, users, swap, hardening |
| [Traffic, certificates and checks](docs/monitoring.md) | request stats, certificate state, HTTPS checks |
| [History and undo](docs/history.md) | the server journal and what `lf undo` can revert |
| [Plugins](docs/plugins.md) | fail2ban and Trivy, installing plugins, writing your own commands and web UI sections |
| [Web UI](docs/web-ui.md) | `lf ui`, its pages and their commands, security model |
| [Scripts, CI and AI agents](docs/automation.md) | non-interactive use, `--json`, secrets, exit codes, recipes |
| [Reference](docs/reference.md) | every command, local and remote files, environment variables |
| [Troubleshooting](docs/troubleshooting.md) | error messages and their fixes |

## Scripts, CI and AI agents

The CLI is built to be driven by other programs: no prompts without a terminal (a command that would ask fails
and says to pass `-y`), `--json` on every read command, secrets on stdin, and a journal that `lf undo` reverts.
[docs/automation.md](docs/automation.md) is the full contract. For agents, [llms.txt](llms.txt) indexes the docs.

Working on landfall itself? See [CONTRIBUTING.md](CONTRIBUTING.md); coding agents read [AGENTS.md](AGENTS.md).

## License

MIT
