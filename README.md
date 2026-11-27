# landfall

**Deploy any folder to your own Linux server, with HTTPS, in two commands.**

landfall (`lf`) is a CLI. It sets up a server over ssh and runs your sites on it as Docker Compose projects behind
[Traefik](https://traefik.io). Certificates are automatic. Nothing of landfall's runs on the server.

📖 **Documentation: [ph1p.github.io/landfall](https://ph1p.github.io/landfall/)**

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/public/landfall-dark.png">
  <img alt="landfall: a laptop terminal runs lf setup, lf deploy, lf domains and lf env over ssh; the server runs a firewall, Traefik with four sites and a journal of every change; browsers reach the sites over HTTPS" src="docs/public/landfall.png">
</picture>

## Quickstart

```sh
npm i -g landfall                        # installs both `landfall` and its short name `lf`
lf setup vps --host 203.0.113.7          # a fresh Ubuntu/Debian box gets Docker, a firewall, Traefik and your ssh key
cd my-site && lf deploy -s vps           # live at https://my-site.203-0-113-7.sslip.io
```

No DNS is needed for the first deploy. Add your own domain later with `-d example.com`.

## How it works

- **A server is an ssh target.** If `ssh vps` works, `lf deploy -s vps` works.
- **A site is a Compose project.** `docker compose up` runs it on your laptop. `lf deploy` runs the same file behind HTTPS.
- **No agent on the server.** Everything lives as plain files under `/opt/landfall`. You can fix it by hand.
- **Every change is journaled.** `lf history` shows what landfall changed. `lf undo` reverts most of it.
- **Failed deploys roll back.** A release whose containers do not start is replaced by the previous one.
- **The CLI is the product.** Scripts, CI jobs, AI agents and the web UI (`lf ui`) all run the same `lf` commands.

## Made for AI agents

landfall is a good tool to hand to an AI coding agent such as Claude Code, Codex or Cursor.
The agent can set up a server, deploy, read logs and fix problems on its own, and you can check every step.

- **No hidden prompts.** Without a terminal, `lf` never waits for input. A command that would ask fails and says to pass `-y`.
- **Clean JSON.** Read commands support `--json`. Results go to stdout, progress and errors to stderr.
- **Clear exit codes.** `0` success, `1` error, `2` unknown command. `lf check <site>` exits `1` when the site is down.
- **Safe by default.** `-y` never overrides a safety check, such as a firewall rule that would lock out ssh. Only `--force` does.
- **Secrets stay out of the command line.** Passwords and env values come from stdin or environment variables, never from argv or the journal.
- **Every action is reviewable and undoable.** `lf history --json` shows what a run changed. `lf undo` reverts it.
- **Docs for machines.** [llms.txt](llms.txt) indexes the docs. [Scripts, CI and AI agents](https://ph1p.github.io/landfall/automation) is the full contract.

Give your agent this prompt to start:

```text
Use the landfall CLI (`lf`) to deploy this project. Read https://ph1p.github.io/landfall/automation first.
Pass -y, use --json for reads, and run `lf check` after deploying.
```

## Why landfall

- **Setting up a VPS by hand takes many steps.** `lf setup` installs Docker, a firewall, Traefik and an ssh key in one command.
- **Certificates and DNS slow down the first deploy.** A new site gets HTTPS on sslip.io right away.
- **Many deploy tools run a control plane on your server.** landfall installs none. It leaves plain Compose projects behind.
- **Deploys should follow git.** Rules say which branches and tags each environment takes. `lf promote`, `lf ci init` and `lf autodeploy` keep to them.
- **Day-to-day work is spread over many tools.** Logs, env and secrets, domains, backups, updates, firewall and scans are all `lf` commands.

## Install

```sh
npm i -g landfall            # or: pnpm add -g landfall
lf --help                    # all commands
lf <command> --help          # one command's options
```

**Your machine** needs Node.js 22.4+, `ssh`, `ssh-copy-id` and `tar`. `rsync` makes redeploys faster.

**The server** needs a root login, or a user with passwordless sudo. landfall installs Docker itself:

- **Ubuntu and Debian**: Docker, ufw, unattended-upgrades, and fail2ban when ssh passwords stay on.
  No ufw behind an AWS, Google Cloud, Azure, Oracle or Alibaba firewall.
- **Fedora, RHEL-likes, Alpine, SUSE** (dnf, yum, apk, zypper): Docker and rsync.
- **No package manager** (Synology DSM, SteamOS): works when Docker is already there.
  See [NAS, Steam Deck and other systems](https://ph1p.github.io/landfall/servers#nas-steam-deck-and-other-systems-without-a-package-manager).

## Your first deploy

```sh
lf setup vps --host 203.0.113.7          # once per server: Docker, firewall, Traefik, an ssh key
cd my-site
lf deploy -s vps                         # → https://my-site.203-0-113-7.sslip.io
lf deploy -s vps -d example.com          # or your own domain (point its A record at the server first)
lf deploy                                # later: redeploy; settings come from ./.landfall.json
```

`lf deploy` looks at the folder and picks what to do:

| the folder has | landfall |
|---|---|
| a `compose.yaml` | runs it as one Compose project ([Compose sites](https://ph1p.github.io/landfall/compose)) |
| a `Dockerfile` | builds it on the server and routes its `EXPOSE`d port |
| an app (Node.js, Bun, Deno, Python, Go, Rust, Java/Kotlin, .NET, Ruby, PHP, Elixir) | writes a Dockerfile and builds it on the server |
| static files (or a site generator's output) | serves them with `nginx:alpine` |
| anything, with `--image ghcr.io/me/app:1.2 --port 8080` | pulls and runs a prebuilt image |

## Everyday commands

```sh
lf ls                              # sites with status
lf logs -f                         # follow a site's logs
lf env API_KEY=abc                 # set a variable (recreates the services)
lf domains --add www.example.com   # add a domain
lf rollback                        # go back to the previous release
lf deploy -E prod --tag latest     # deploy the newest tag the prod git rule allows
lf volume backup                   # back up the site's data
lf updates && lf update            # list, then apply OS and image updates
lf history && lf undo              # what landfall changed; revert the last run
lf ui                              # all of this in a local web UI
```

## Concepts

| term | meaning |
|---|---|
| **server** | An ssh target: a `~/.ssh/config` alias, or one added with `lf server add` or `lf setup`. Pass it as `-s <name>`. The first one added is the default. |
| **site** | One Compose project on a server. It is your `compose.yaml`, or one landfall generates for a static folder, Dockerfile or image. |
| **project file** | `./.landfall.json`, written by the first `lf deploy`: `{ "name", "server", "domains" }`. |
| **main domain** | Optional, per server (`lf server domain vps example.com`). Sites then default to `<site>.example.com`. Without one, sites get `<site>.<ip-with-dashes>.sslip.io`. |
| **release** | One per deploy. The last 5 stay (`--keep n`). `lf rollback` switches between them. |
| **run** | One `lf` invocation that changed a server. `lf history` lists runs. `lf undo` reverts them. |

The site comes from the argument, else from `./.landfall.json`.
The server comes from `-s`, else from `./.landfall.json`, else the default server (`lf server use`).

## Documentation

Everything is at **[ph1p.github.io/landfall](https://ph1p.github.io/landfall/)**.

| guide | covers |
|---|---|
| [Servers](https://ph1p.github.io/landfall/servers) | `lf setup`, its flags, registering servers, NAS and other systems |
| [Deploy a site](https://ph1p.github.io/landfall/deploy) | site kinds, env and secrets, CI, uploads, environments, main domains |
| [Git deploys](https://ph1p.github.io/landfall/git) | branch and tag rules, `--ref`/`--tag`, promote, CI, auto-deploy |
| [Compose sites](https://ph1p.github.io/landfall/compose) | `x-landfall`, routes, private ports, IP allowlists, volumes |
| [Day-to-day](https://ph1p.github.io/landfall/sites) | logs, env, secrets, domains, logins, tunnels, restart, removal |
| [Scaling and load balancing](https://ph1p.github.io/landfall/scaling) | replicas, rolling deploys, traffic split |
| [Lifecycle hooks](https://ph1p.github.io/landfall/hooks) | commands or npm scripts around build, deploy, rollback and removal |
| [Volumes and backups](https://ph1p.github.io/landfall/volumes) | scheduled and offsite backups, push and pull data |
| [Updates](https://ph1p.github.io/landfall/updates) | OS packages, images, Docker Compose, vulnerability scans |
| [Traefik](https://ph1p.github.io/landfall/traefik) | landfall's Traefik, HTTP/3, the dashboard, your own Traefik |
| [Server administration](https://ph1p.github.io/landfall/system) | firewall, services, SSH keys, users, swap, hardening |
| [Traffic, certificates and checks](https://ph1p.github.io/landfall/monitoring) | request stats, certificate state, HTTPS checks |
| [Analytics](https://ph1p.github.io/landfall/analytics) | visitors, funnels, events and web vitals on your own server, cookieless by default |
| [History and undo](https://ph1p.github.io/landfall/history) | the server journal, what `lf undo` reverts |
| [Plugins](https://ph1p.github.io/landfall/plugins) | exposure checks, fail2ban, Trivy, installing and writing plugins |
| [Web UI](https://ph1p.github.io/landfall/web-ui) | `lf ui`, its pages, its security model |
| [Scripts, CI and AI agents](https://ph1p.github.io/landfall/automation) | non-interactive use, `--json`, secrets, exit codes, recipes |
| [Reference](https://ph1p.github.io/landfall/reference) | every command, file and environment variable |
| [Troubleshooting](https://ph1p.github.io/landfall/troubleshooting) | error messages and fixes |

## Contributing

Working on landfall itself? Read [CONTRIBUTING.md](CONTRIBUTING.md). Coding agents read [AGENTS.md](AGENTS.md).

## License

MIT
