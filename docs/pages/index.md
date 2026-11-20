# landfall

Set up Linux servers and deploy sites to them behind [Traefik](https://traefik.io) with automatic HTTPS, from one CLI.

```sh
npm i -g landfall
lf setup vps --host 203.0.113.7     # fresh Ubuntu/Debian box → Docker, firewall, Traefik, ssh key
cd my-site && lf deploy -s vps      # live at https://my-site.203-0-113-7.sslip.io
```

- **Servers are ssh targets.** Any `~/.ssh/config` alias works. If `ssh vps` works, `lf deploy -s vps` works.
- **No agent on the server.** Every site is a plain Docker Compose project under `/opt/landfall`, so you can read, run and fix it by hand.
- **Your compose.yaml is the site.** `docker compose up` runs it locally, `lf deploy` runs the same file behind HTTPS.
- **Every change is journaled** on the server and can be undone with `lf undo`.
- **The CLI is the product.** Every feature is an `lf` command first, usable from scripts, CI and agents. The web UI
  (`lf ui`) is a front end for those commands.

`lf` is short for `landfall`. Both commands are installed.

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

## Where to start

| guide | covers |
|---|---|
| [Servers](servers.md) | `lf setup` for fresh and existing servers, setup flags, registering servers, NAS and other systems |
| [Deploy a site](deploy.md) | site kinds, env and secrets, CI, what gets uploaded, environments, main domains |
| [Compose sites](compose.md) | `x-landfall`, routes, private ports, IP allowlists, volumes, published ports |
| [Day-to-day](sites.md) | logs, env, secrets, domains, logins, tunnels, restart and removal |
| [Volumes and backups](volumes.md) | volumes, backups, scheduled and offsite backups, push and pull data |
| [Updates](updates.md) | OS packages, images, Docker Compose, vulnerability scans |
| [Traefik](traefik.md) | landfall's Traefik, HTTP/3, the dashboard, using your own Traefik |
| [Server administration](system.md) | firewall, services, SSH keys, users, swap, hardening |
| [Traffic, certificates and checks](monitoring.md) | request stats, certificate state, HTTPS checks |
| [History and undo](history.md) | the server journal and what `lf undo` can revert |
| [Plugins](plugins.md) | fail2ban and Trivy, installing plugins, writing your own commands and web UI sections |
| [Web UI](web-ui.md) | `lf ui`, its pages and their commands, security model |
| [Scripts, CI and AI agents](automation.md) | non-interactive use, `--json`, secrets, exit codes, recipes |
| [Reference](reference.md) | every command, local and remote files, environment variables |
| [Troubleshooting](troubleshooting.md) | error messages and their fixes |
