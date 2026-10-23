# landfall

Set up Linux servers and deploy sites to them behind [Traefik](https://traefik.io) with automatic HTTPS, from one CLI.

```sh
npm i -g landfall
lf setup vps --host 203.0.113.7     # fresh Ubuntu/Debian box → Docker, firewall, Traefik, ssh key
cd my-site && lf deploy -s vps      # live at https://my-site.203-0-113-7.sslip.io
```

- **Servers are ssh targets.** Any `~/.ssh/config` alias works. If `ssh vps` works, `lf deploy -s vps` works.
- **No agent on the server.** Everything is plain Docker Compose under `/opt/srv`, so you can read and fix it by hand.
- **Every change is journaled** on the server and can be undone with `lf undo`.
- **Three ways in:** plain commands for scripts, CI and agents; a web dashboard (`lf`); a terminal dashboard (`lf tui`).

`lf` is short for `landfall`. Both commands are installed.

## Contents

- [Install](#install)
- [Concepts](#concepts)
- [Using landfall from scripts and agents](#using-landfall-from-scripts-and-agents)
- [Command reference](#command-reference)
- [Prepare a server](#prepare-a-server)
- [Deploy a site](#deploy-a-site)
- [Day-to-day](#day-to-day)
- [Updates](#updates)
- [Traefik](#traefik)
- [Firewall](#firewall)
- [History and undo](#history-and-undo)
- [Managing servers](#managing-servers)
- [Dashboards](#dashboards)
- [Files and config](#files-and-config)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## Install

You need Node.js 22+ plus `ssh`, `ssh-copy-id` and `tar` on your machine. The server must run Ubuntu or Debian
and accept a login as root or as a user with passwordless sudo. landfall installs Docker itself.

```sh
npm i -g landfall            # or: pnpm add -g landfall
lf --help                    # all commands
lf <command> --help          # every option of one command
```

## Concepts

| term | meaning |
|---|---|
| **server** | An ssh target: a `~/.ssh/config` alias, or one landfall registered with `lf server add`/`lf setup`. Pass it as `-s <name>`. The first server you add becomes the default. |
| **site** | One deployed thing on a server: a static folder, a Dockerfile app or a prebuilt image. It runs as container `srv-<name>` and Traefik routes its domains to it. |
| **project file** | `./srv.json`, written by the first `lf deploy`: `{ "name", "server", "domains" }`. Commands that take `[name]` default to this site, and `-s` defaults to its server. |
| **main domain** | Optional per-server domain (`lf server domain vps example.com`). Sites then default to `<site>.example.com`, and a bare name like `shop` means `shop.example.com`. Without one, sites get `<site>.<ip-with-dashes>.sslip.io` (e.g. `blog.203-0-113-7.sslip.io`), which resolves without any DNS setup. |
| **release** | Every deploy creates one, with an id like `20260122143005`. The last 5 are kept. `lf rollback` switches between them. |
| **run** | One landfall invocation that changed something on a server. Runs are listed by `lf history` and reverted by `lf undo`. |

How defaults resolve, for every command:

- **site** `[name]`: the argument, else `name` from `./srv.json`.
- **server** `-s`: the flag, else `server` from `./srv.json`, else the default server (`lf server use`).

## Using landfall from scripts and agents

Every dashboard action is a plain command, and both dashboards print the command they run (`$ lf logs blog -s vps -f`).

- **No prompts:** `-y` accepts confirmations and takes defaults. Without a terminal, prompts are never shown. A
  command that would ask then **fails** and tells you to pass `-y`. It never silently goes ahead.
- **Passwords:** pass them with `--password-stdin` or `$SRV_PASSWORD` (`setup`, `server add`). For `lf auth`, use `-p`.
- **JSON output:** `--json` works on `ls`, `info`, `server config`, `server domain`, `domains`, `firewall`,
  `updates` and `history`.
- **Dry runs:** `lf setup <name> --check` changes nothing. `lf updates` only reports.
- **Exit codes:** `0` means success, `1` means error (the message starts with `error:` on stderr), and `2` means unknown command.
- **Safety rails:** `-y` never overrides a safety refusal, for example a firewall change that would lock out ssh, or
  setup steps that would break running services. Only `--force` does.

A typical unattended flow:

```sh
printf '%s' "$ROOT_PW" | lf setup box --host 203.0.113.7 --password-stdin -y
lf server domain box example.com -y
lf deploy ./dist -n blog -s box -y          # → https://blog.example.com
lf ls -s box --json
lf history -s box --json
lf undo -s box -y                           # revert the last run
```

## Command reference

`[name]` is a site or server and is optional (see [Concepts](#concepts)). Most site and server commands take `-s <server>`. Every command takes `-y` and `--help`.

**Servers**

| command | what it does |
|---|---|
| `lf setup <name> [--host ip]` | Turns a box into a deploy target: ssh key, Docker, ufw, fail2ban, deploy user, ssh hardening and Traefik. Idempotent. |
| `lf setup <name> --check` | Reports what is set up and what setup would change. Changes nothing. |
| `lf setup <name> --key-only` | Only installs landfall's ssh key. |
| `lf server add <name> [--host ip] [-u user] [-p port] [-i key] [--password-stdin] [--domain d] [--default]` | Registers a server without installing anything on it. Writes `Host <name>` to `~/.ssh/config`. |
| `lf server list [--all]` | Lists registered servers. `--all` adds every ssh alias. Alias: `servers`. |
| `lf server info [name] [--json]` | Shows OS and release support, kernel, uptime, CPU, RAM, disk, addresses and containers. Alias: `info`. |
| `lf server config [name] [--json]` | Shows everything landfall and ssh use for a server. Does not connect. |
| `lf server domain [name] [domain...] [--add d] [--primary d] [--rm d] [--clear] [--json]` | Manages main domains (the first is primary) and checks their DNS. |
| `lf server use <name>` | Sets the default server. |
| `lf server rm <name>` | Forgets a server locally. The server is untouched. |
| `lf ssh [name] [-- cmd]` | Opens a shell or runs a one-off command. |
| `lf keygen <name>` | Creates `~/.ssh/srv_<name>` and prints the public key. |

**Sites**

| command | what it does |
|---|---|
| `lf deploy [dir] [-d domain...] [-n name] [-b cmd] [--spa] [--image img] [--port n] [-e K=V] [--env-file f] [--static] [--keep n]` | Deploys a static folder, a Dockerfile app or an image. |
| `lf ls [--json]` | Lists sites on the server with their status. Alias: `sites list`. |
| `lf sites info [name]` | Shows domains, container and release history. |
| `lf domains [name] [--add d] [--rm d] [--set d] [--json]` | Lists domains with their DNS and HTTPS state, or changes them. |
| `lf auth [name] -u user [-p pw]` / `--rm-user u` / `--off` | Puts basic-auth login in front of a site. |
| `lf open [name]` | Opens the site in the browser. |
| `lf logs [name] [-f] [-n lines]` | Shows container logs. |
| `lf env [name] [K=V...] [-u K]` | Shows or changes env vars. Recreates the container. |
| `lf rollback [name] [--to id]` | Switches to the previous release, or to the given one. |
| `lf restart` / `stop` / `start [name]` | Restarts, stops or starts the site. |
| `lf sites rm <name>` | Deletes the site and its files. |

**Traefik, firewall, updates, history**

| command | what it does |
|---|---|
| `lf traefik setup [--email e] [--dashboard host\|traefik\|off] [--staging] [--image img] [--host-network]` | Installs or reconfigures landfall's Traefik. |
| `lf traefik use [container] [--network n --entrypoint e --resolver r]` | Routes sites through a Traefik you already run. |
| `lf traefik status` / `logs [-f]` / `restart` | Inspects or restarts Traefik. `lf traefik` alone means `status`. |
| `lf firewall [--json]` | Lists ufw rules and, for each listening port, whether it is reachable. |
| `lf firewall allow` / `deny <port[/proto]> [--from ip] [--comment c]` | Adds a rule. A deny goes first, so it wins. |
| `lf firewall update <n> [--port p] [--from ip] [--action allow\|deny\|limit]` | Changes a rule. |
| `lf firewall rm <n>` / `enable` / `disable` | Removes a rule, or turns ufw on or off. |
| `lf updates [--no-refresh] [--all] [--json]` | Shows pending OS packages, newer images, and Docker/compose versions. Changes nothing. |
| `lf update [site...] [--packages] [--security] [--reboot] [--images] [--compose]` | Applies updates. Image and compose updates can be undone. |
| `lf history [-n 20] [--json]` | Lists what landfall changed on the server, run by run. Alias: `log`. |
| `lf undo [n \| n.m] [--all] [--force]` | Reverts the latest run, run `n`, step `n.m`, or everything. Alias: `revert`. |

**Dashboards**

| command | what it does |
|---|---|
| `lf` / `lf ui [--port 4777] [--no-open]` | Starts the web dashboard on 127.0.0.1 and prints a login link. |
| `lf tui` | Starts the terminal dashboard. |

## Prepare a server

### A fresh server (only a root password)

```sh
lf setup vps --host 203.0.113.7
```

1. Creates `~/.ssh/srv_vps` and installs it with `ssh-copy-id`. You type the root password once.
2. Installs Docker, ufw (allowing ssh, 80 and 443), fail2ban and unattended-upgrades.
3. Creates the user `deploy` in the docker group and disables ssh password login. Root keeps key-only access.
4. Writes `Host vps` to `~/.ssh/config`, creating the file if needed. `ssh vps` now logs in as `deploy`.
5. Starts Traefik, which gets Let's Encrypt certificates for every site.

Setup shows what it is about to change and asks once (`-y` skips the question). Key login is checked **before**
password login is turned off, so a failed key setup can't lock you out.

### A server you already reach with `ssh vps`

```sh
lf setup vps --check        # what is there, what would change
lf setup vps
```

landfall reads host, user, port and key from your ssh config (`ssh -G`) and keeps a key that works. It inspects
first and prints what is done (`✓`), what it will do (`→`) and what it refuses to touch (`!`):

| step | skipped when |
|---|---|
| firewall | ufw is off and enabling it would block a public port that something listens on (Postgres on 5432, WireGuard on 51820/udp, …). Docker-published ports stay reachable because Docker's NAT bypasses ufw. If Docker uses nftables or has no IPv6 NAT, they would be blocked, so setup skips the firewall. |
| ssh hardening | other users still log in with a password |
| traefik | 80/443 are held by something that is not Traefik, or by a `traefik` that landfall didn't create. If it is your own Traefik, setup offers `lf traefik use` instead. |

Docker that is installed but stopped gets started. A missing compose, or the old v1 `docker-compose`, is replaced
with the newest release. An existing Docker is never reinstalled. In a terminal, setup asks about each conflict
(the default is no). `-y` never accepts a conflict. Only `--force` does. Existing sites are never touched.

### Setup flags

| flag | effect |
|---|---|
| `-u admin` / `-p 2222` | log in as `admin` (needs passwordless sudo) / ssh port |
| `-i ~/.ssh/id_ed25519` | use an existing key instead of generating one |
| `--password-stdin` | read the login password from stdin (or set `$SRV_PASSWORD`) |
| `--deploy-user ""` | deploy as the login user instead of creating `deploy` |
| `--domain example.com` | primary main domain |
| `--staging` / `--no-staging` | use Let's Encrypt's staging CA while testing (remembered) |
| `--dashboard traefik.example.com` | Traefik dashboard behind basic auth (`traefik` alone means `traefik.<main domain>`) |
| `--image traefik:v3.5` | Traefik image (remembered, default `traefik:v3`) |
| `--host-network` | run Traefik on the host network (remembered), see [Traefik](#traefik) |
| `--no-firewall` / `--no-harden` / `--no-traefik` / `--no-ssh-config` | skip a step |
| `--check` / `--key-only` / `--force` | report only / install only the key / apply despite conflicts |

On a first Traefik install, setup asks for the image, host network, e-mail and dashboard in a terminal. `-y`
takes the defaults. The e-mail is optional, because Let's Encrypt no longer sends expiry mails.

## Deploy a site

Point the domain's A/AAAA record at the server first. Let's Encrypt needs to reach ports 80 and 443.
No domain yet? Leave out `-d`. landfall offers `<name>.<ip-with-dashes>.sslip.io` (`-y` accepts it) and the site has HTTPS right away.

| kind | when | how |
|---|---|---|
| **static** | default | Uploads the folder and serves it with `nginx:alpine` (gzip, long cache headers for assets). The folder is `.` if it has an `index.html`, else the first of `dist/ build/ out/ public/ _site/ site/`. `--spa` sends unknown paths to `index.html`. |
| **dockerfile** | the folder has a `Dockerfile` | Uploads the folder and builds it on the server. The port comes from `EXPOSE`, else `--port` (default 3000). `--static` forces static. |
| **image** | `--image ghcr.io/me/app:1.2` | Pulls the image and runs it. Needs `--port`. For private registries: `lf ssh vps -- docker login ghcr.io`. |

```sh
cd my-site
lf deploy -d example.com -d www.example.com -s vps      # static, name = folder name (-n to override)
lf deploy -b "npm run build"                            # build locally first
lf deploy -d app.example.com -e DATABASE_URL=postgres://… --env-file .env.production   # Dockerfile app
lf deploy -n api --image ghcr.io/me/api:1.4 --port 8080 -d api.example.com            # image
lf deploy                                               # later: redeploy using ./srv.json
```

The first deploy writes `srv.json`. Commit it:

```json
{ "name": "my-site", "server": "vps", "domains": ["example.com", "www.example.com"] }
```

Local `.env*` files are never uploaded. Pass variables with `-e`/`--env-file`, or later with `lf env`.
Switching a static release only reloads nginx, so there is no downtime. `--keep 10` keeps more releases.

### Main domains

```sh
lf server domain vps example.com            # checks DNS for example.com and *.example.com
lf deploy                                   # site "blog" → blog.example.com
lf deploy -d shop                           # no dot → shop.example.com
lf domains blog --add www                   # www.example.com
lf server domain vps --add other.org        # more main domains; the first stays primary
lf server domain vps --primary other.org    # switch the primary
lf server domain vps --rm other.org         # drop one; --clear drops all (back to sslip.io)
```

`server domain` prints the A records to add: one for the domain and a wildcard `*.example.com`. With those in
place, every new site resolves without touching DNS again. For non-primary main domains, write the full name (`-d shop.other.org`).

## Day-to-day

```sh
lf ls                              # sites with status
lf sites info                      # domains, container, releases
lf logs -f                         # follow logs (-n 500 for more lines)
lf rollback                        # previous release (--to <id> for a specific one)
lf env API_KEY=abc                 # set env (container is recreated); -u KEY removes one
lf restart | stop | start
lf domains                         # where DNS points, whether HTTPS answers
lf domains --add www.example.com   # also --rm, --set (updates srv.json)
lf auth -u anna                    # login in front of the site (asks for the password, -p passes it)
lf auth --rm-user anna | --off
lf open
lf sites rm blog                   # delete the site (asks you to type the name)
lf logs api -s vps                 # another site on another server
```

Commands that remove something ask first: `sites rm`, `domains --rm/--set`, `server domain --rm/--clear`,
`auth --rm-user/--off`, `firewall rm`, `undo` and `server rm`. `sites rm` and `undo --all` want the name typed
back. Domain and login changes are journaled, so `lf undo` reverts them.

## Updates

```sh
lf updates                         # packages (security marked, reboot needed), images, Docker/compose versions
lf update                          # upgrade packages and pull newer images (asks first)
lf update --packages --security    # only security updates (apt, dnf)
lf update --packages --reboot      # reboot afterwards if needed
lf update --images                 # Traefik and image sites: pull, recreate
lf update blog --images            # one site
lf update --compose                # newest compose, where landfall installed it
```

Package upgrades (apt-get, dnf/yum, apk) cannot be undone. Image and compose updates record the previous version,
so `lf undo` restores it. Landfall never touches images pinned by digest, Dockerfile sites or foreign containers.
Version-pinned tags show the newest tag of the same shape (`traefik:v3.6` → `traefik:v3.7`).

## Traefik

```sh
lf traefik status                              # container state, routes, mode
lf traefik logs -f                             # certificate errors show up here
lf traefik setup --email you@example.com       # reconfigure (safe to re-run)
lf traefik setup --dashboard traefik           # dashboard at traefik.<main domain>; `off` removes it
lf traefik setup --host-network                # bind 80/443 on the host
```

landfall's Traefik is the container `traefik` from `/opt/srv/traefik/docker-compose.yml`. By default Docker
publishes 80/443 to it. Sites work the same in both modes:

| | ports published (default) | `--host-network` |
|---|---|---|
| client IP in logs / `X-Forwarded-For` | real IPv4; IPv6 may show Docker's gateway | always real |
| ufw | Docker's NAT bypasses ufw for 80/443 | ufw applies |

The dashboard password is generated and printed once (`--dashboard-password` sets your own). Image, network mode,
e-mail, staging and dashboard are remembered per server.

**Using a Traefik you already run.** If 80/443 belong to your own Traefik container, landfall does not install a second one:

```sh
lf traefik use -s vps                          # finds the container on :80/:443
lf traefik use traefik-reverseproxy-1 -s vps   # or name it
```

landfall reads the network, HTTPS entrypoint and cert resolver from the container's flags. If your Traefik is
configured by a file, pass `--network proxy --entrypoint websecure --resolver letsencrypt`. The choice is stored
in `/opt/srv/proxy.env`. landfall never changes that Traefik.

## Firewall

```sh
lf firewall -s vps                       # rules + each listening port: open, limited, blocked, localhost only
lf firewall allow 51820/udp
lf firewall allow 5432 --from 10.0.0.0/8 --comment "db, lan only"
lf firewall deny 8080                    # goes before the allow rules, so it wins
lf firewall update 3 --action deny       # numbers as `lf firewall` prints them
lf firewall rm 3                         # or by text: lf firewall rm "allow 8080"
lf firewall enable | disable             # enable installs ufw if needed and allows ssh first
```

- Changes run as root or with sudo. If the user has neither (like `deploy`), landfall uses root's key login.
- A change that would block the ssh port, or `enable` while ports in use have no rule, is refused. `--force` overrides.
- Docker-published ports bypass ufw, so a deny rule doesn't close them. Bind them to `127.0.0.1` in their compose file instead.
- `update` replaces the rule. If ufw rejects the new rule, the old one is put back.

## History and undo

Every change landfall makes is appended to `/opt/srv/journal.log` on the server: when, which local user and
command, what changed and the shell that reverts it.

```sh
lf history -s vps       # newest first; ↺ undoable, · not undoable, ✓ already undone
lf undo -s vps          # revert the latest run with something left to undo
lf undo 4               # run #4
lf undo 4.2             # only its second step
lf undo --all           # everything, newest first
```

- **Undoable:** setup (packages and Docker stay installed), firewall rules and on/off, deploys and rollbacks
  (previous release and env), env changes, stop/start, domains, logins, Traefik setup and `traefik use`, image and
  compose updates.
- **Not undoable:** `sites rm`, restarts, package upgrades, and a firewall rule that replaced an existing one.
- Steps revert newest first, each as the user that made it. The first failure stops the rest.
- Undo changes the server only. Local `~/.config/srv` and `srv.json` stay as they are.
- Overwritten files are backed up as `.<name>.srv-<run>-<n>`, and the newest 10 are kept per file.

## Managing servers

```sh
lf server add vps                                       # register an existing ssh alias
lf server add box --host 1.2.3.4 -u ubuntu -i ~/.ssh/box --default
lf server add web --host 1.2.3.4 -u admin               # asks the password once, installs ~/.ssh/srv_web
lf server config vps                                    # landfall entry, Traefik settings, ssh login, keys, Host block
lf server list --all
lf server use vps
lf server rm vps                                        # forget locally
lf ssh vps -- docker ps
```

`server add` installs nothing on the server. It writes a `Host <name>` block between `# >>> srv:<name>` markers
(`--no-ssh-config` keeps the details in landfall's config instead). In a Host block you wrote yourself, landfall
only steps in when the key does not work. It then puts the working `IdentityFile` first, drops lines whose file is
gone, and keeps a backup as `~/.ssh/config.srv-bak`.

## Dashboards

**Web (`lf` or `lf ui`).** The dashboard listens on `127.0.0.1` and opens your browser. Servers are on the left
(★ marks the default). A server tab has Sites, Updates, Firewall, History and Settings. **Deploy folder…** browses
local folders or takes a dropped folder or `.zip`. Every action streams the output of its plain command into a side
panel. Destructive actions ask first. Login works through the printed `/login?t=…` link. The token is kept in
`~/.config/srv/ui-token`, and you can delete that file to rotate it. Requests with a foreign `Host` or `Origin`
are refused. Running `lf` again while the dashboard is running just opens the page.

**Terminal (`lf tui`).**

```
landfall 0.1.0                              this folder: blog → vps · blog.example.com
╭ Servers ──────────╮╭ Sites on vps  traefik Up 3 days ─────────────────────╮
│ › ● vps  default  │ │ › ● blog   static      blog.example.com      2h ago │
│   ● box           │ │   ● api    dockerfile  api.example.com       5d ago │
│   ○ nas ssh config│ │                                                      │
│   + add a server  │ │                                                      │
╰───────────────────╯╰──────────────────────────────────────────────────────╯
? help   q quit   ↑↓ server   ↵ sites   u check & set up   d deploy here …
```

Keys: `↵` connect/open, `d` deploy this folder, `u` check and set up, `a` add a server, `f` firewall, `h` history,
`z` undo, `x` shell, `esc` stop/back, `?` all keys. Dot colors: green ready, yellow not set up, red unreachable, ○ not connected.

## Files and config

| local file | content |
|---|---|
| `~/.config/srv/config.json` | registered servers, default server, per-server settings |
| `~/.config/srv/projects.json` | folders deployed from this machine (dashboard *Recent*/*Redeploy*) |
| `~/.config/srv/ui-token` | web dashboard login token |
| `~/.config/srv/uploads/` | folders dropped into the dashboard, removed after a day |
| `~/.ssh/srv_<name>` | generated keys |
| `~/.ssh/config` | `Host <name>` blocks between `# >>> srv:<name>` markers |
| `./srv.json` | per-project deploy settings |

| env var | effect |
|---|---|
| `SRV_CONFIG_DIR` | use another directory than `~/.config/srv` |
| `SRV_SSH_CONFIG` | use another ssh config file (`ssh -F`) |
| `SRV_PASSWORD` | login password for `setup`/`server add` |

On the server:

```
/opt/srv/
  traefik/docker-compose.yml        Traefik, ports 80/443, Let's Encrypt (HTTP-01)
  traefik/letsencrypt/acme.json
  proxy.env                         only with `lf traefik use`
  sites/<name>/
    site.json                       metadata + release history
    docker-compose.yml              container srv-<name> on network "web" with Traefik labels
    nginx.conf                      static sites
    .env                            app sites (0600)
    releases/<id>/                  last 5 kept
    current -> releases/<id>
  journal.log                       every change, with the shell that reverts it
```

`cd /opt/srv/sites/blog && docker compose ps` works as usual.

## Troubleshooting

| symptom | fix |
|---|---|
| `setup needs root or passwordless sudo` | use `-u root`, or give your user passwordless sudo |
| certificate warning in the browser | you used `--staging`: `lf setup <name> --no-staging` |
| no certificate at all | DNS must point at the server and 80/443 must be open; see `lf traefik logs` |
| 404 from Traefik | the domain isn't in the site's list: `lf domains --add …` |
| site container keeps restarting | `lf logs`; for apps check `--port` and env |
| `skipping firewall/ssh hardening: …` | setup protected something running there. Fix it, or re-run with `--force` |
| `skipping traefik: port 80 is in use by …` | free the port, then `lf traefik setup`. If it's a Traefik, `lf traefik use` |
| `… blocks ssh port 22 … (--force to do it anyway)` | `lf firewall allow 22/tcp` first, or force if you have another way in |
| `ssh cannot resolve <name>` | not in your ssh config: `lf server add <name> --host …` |
| `… Pass -y to confirm (no terminal to ask)` | non-interactive run of a command that asks: add `-y` |

## Development

```sh
pnpm install
pnpm dev <command>     # run from source (tsx)
pnpm test              # unit tests (vitest)
pnpm typecheck
pnpm build             # tsdown → dist/cli.mjs, copies the web page next to it
pnpm e2e               # full run against a throwaway sshd+dockerd container (needs Docker)
```
