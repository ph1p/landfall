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
- **Two ways in:** plain commands for scripts, CI and agents; a web dashboard (`lf ui`).

`lf` is short for `landfall`. Both commands are installed.

## Contents

- [Install](#install)
- [Concepts](#concepts)
- [Prepare a server](#prepare-a-server)
- [Deploy a site](#deploy-a-site)
- [Day-to-day](#day-to-day)
- [Updates](#updates)
- [Traefik](#traefik)
- [Firewall](#firewall)
- [History and undo](#history-and-undo)
- [Managing servers](#managing-servers)
- [Dashboard](#dashboard)
- [Using landfall from scripts and agents](#using-landfall-from-scripts-and-agents)
- [Command reference](#command-reference)
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
| **site** | One Compose project on a server: your `compose.yaml`, or one landfall generates for a static folder, a Dockerfile or a prebuilt image. Services with `x-landfall: { port }` are routed through Traefik. |
| **project file** | `./.landfall.json`, written by the first `lf deploy`: `{ "name", "server", "domains" }`. Commands that take `[name]` default to this site, and `-s` defaults to its server. |
| **main domain** | Optional per-server domain (`lf server domain vps example.com`). Sites then default to `<site>.example.com`, and a bare name like `shop` means `shop.example.com`. Without one, sites get `<site>.<ip-with-dashes>.sslip.io` (e.g. `blog.203-0-113-7.sslip.io`), which resolves without any DNS setup. |
| **release** | Every deploy creates one, with an id like `20260122143005`. The last 5 are kept. `lf rollback` switches between them. |
| **run** | One landfall invocation that changed something on a server. Runs are listed by `lf history` and reverted by `lf undo`. |

How defaults resolve, for every command:

- **site** `[name]`: the argument, else `name` from `./.landfall.json`.
- **server** `-s`: the flag, else `server` from `./.landfall.json`, else the default server (`lf server use`).

## Prepare a server

### A fresh server (only a root password)

```sh
lf setup vps --host 203.0.113.7
```

1. Creates `~/.ssh/landfall_vps` and installs it with `ssh-copy-id`. You type the root password once.
2. Installs Docker, ufw (allowing ssh, 80 and 443), fail2ban and unattended-upgrades.
3. Creates the user `deploy` in the docker group and disables ssh password login. Root keeps key-only access.
4. Writes `Host vps` to `~/.ssh/config`, creating the file if needed. `ssh vps` now logs in as `deploy`.
5. Starts Traefik, which gets Let's Encrypt certificates for every site.

Setup shows what it is about to change and asks once (`-y` skips the question). Key login is checked **before**
password login is turned off, so a failed key setup can't lock you out.

Or deploy right away: a server landfall has not set up yet is set up first, then the site goes up.

```sh
lf deploy -s vps --host 203.0.113.7     # asks the root password once (--password-stdin, $LANDFALL_PASSWORD)
```

Without `--host`, `lf deploy` notices a configured server that isn't set up (or takes no key yet) and asks to
run setup first.

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
| `--password-stdin` | read the login password from stdin (or set `$LANDFALL_PASSWORD`) |
| `--deploy-user ""` | deploy as the login user instead of creating `deploy` |
| `--domain example.com` | primary main domain |
| `--staging` / `--no-staging` | use Let's Encrypt's staging CA while testing (remembered) |
| `--dashboard traefik.example.com` | Traefik dashboard behind basic auth (`traefik` alone means `traefik.<main domain>`) |
| `--image traefik:v3.5` | Traefik image (remembered, default `traefik:v3`) |
| `--host-network` | run Traefik on the host network (remembered), see [Traefik](#traefik) |
| `--no-http3` | Traefik without HTTP/3 on 443/udp (remembered), see [Traefik](#traefik) |
| `--no-firewall` / `--no-harden` / `--no-traefik` / `--no-ssh-config` | skip a step |
| `--check` / `--key-only` / `--force` | report only / install only the key / apply despite conflicts |

On a first Traefik install, setup asks for the image, host network, e-mail and dashboard in a terminal. `-y`
takes the defaults. The e-mail is optional, because Let's Encrypt no longer sends expiry mails.

## Deploy a site

Point the domain's A/AAAA record at the server first. Let's Encrypt needs to reach ports 80 and 443.
No domain yet? Leave out `-d`. landfall offers `<name>.<ip-with-dashes>.sslip.io` (`-y` accepts it) and the site has HTTPS right away.

| kind | when | how |
|---|---|---|
| **compose** | the folder has a `compose.yaml` | Uploads the folder and runs it as one Compose project. See [Compose sites](#compose-sites). |
| **static** | no compose file, no Dockerfile | Uploads the folder and serves it with `nginx:alpine` (gzip, long cache headers for assets). The folder is where the site generator builds to, even before the first build (Vite/Astro `dist/` or its `outDir`, SvelteKit/CRA/Docusaurus `build/`, Next `out/`, Gatsby/Hugo `public/`, Eleventy/Jekyll `_site/`, Nuxt `.output/public/`, Angular, MkDocs `site/`), else `.` if it has an `index.html`, else the first of `dist/ build/ out/ public/ _site/ site/` with one. `lf deploy <dir>` picks another. `--spa` sends unknown paths to `index.html`. |
| **dockerfile** | the folder has a `Dockerfile` | Uploads the folder and builds it on the server. The port comes from `EXPOSE`, else `--port` (default 3000). `--static` forces static. |
| **image** | `--image ghcr.io/me/app:1.2` | Pulls the image and runs it. Needs `--port`. For private registries: `lf ssh vps -- docker login ghcr.io`. |

```sh
cd my-site
lf deploy -d example.com -d www.example.com -s vps      # static, name = folder name (-n to override)
lf deploy -b "npm run build"                            # build locally first
lf deploy -d app.example.com -e DATABASE_URL=postgres://… --env-file .env.production   # Dockerfile app
lf deploy -n api --image ghcr.io/me/api:1.4 --port 8080 -d api.example.com            # image
lf deploy --no-domain                                   # no domain yet: reach it with lf tunnel, add one later with lf domains --add
lf deploy                                               # later: redeploy using ./.landfall.json
```

The first deploy writes `.landfall.json`. Commit it:

```json
{ "name": "my-site", "server": "vps", "domains": ["example.com", "www.example.com"] }
```

Local `.env*` files are never used on the server: each site has its own `.env` there. Pass variables with
`-e`/`--env-file`, or later with `lf env`. `--keep 10` keeps more releases.

### Compose sites

A site can be a whole Compose project: the app, its database, a worker. The same `compose.yaml` runs locally
with `docker compose up` and on the server with `lf deploy`. `lf init` writes one for an existing project:

```sh
lf init --postgres                 # compose.yaml (app + db + volume) and compose.override.yaml (local ports)
echo POSTGRES_PASSWORD=dev > .env  # local only
docker compose up --build          # http://localhost:3000
lf deploy -e POSTGRES_PASSWORD=$(openssl rand -hex 16)   # the first time; later just lf deploy
```

```yaml
services:
  app:
    build: .
    env_file: [{ path: .env, required: false }]
    environment:
      DATABASE_URL: postgres://app:${POSTGRES_PASSWORD}@db:5432/app
    depends_on: { db: { condition: service_healthy } }
    x-landfall:
      port: 3000                       # Traefik serves the site's domains from here
  admin:
    image: adminer
    x-landfall: { port: 8080, domains: [db.example.com] }   # its own domains
  db:
    image: postgres:17-alpine
    environment: { POSTGRES_USER: app, POSTGRES_DB: app, POSTGRES_PASSWORD: "${POSTGRES_PASSWORD:?}" }
    volumes: [db:/var/lib/postgresql/data]
    healthcheck: { test: pg_isready -U app, interval: 5s }
volumes:
  db:
```

- **`x-landfall`** on a service routes it: `port` is where Traefik sends requests, `domains` gives it its own
  (a bare name or `@` works as in `-d`). One routed service without `domains` serves the site's domains, which
  `-d` and `lf domains` manage. Services without `x-landfall` (the database) stay off Traefik's network.
- **`ports:` is refused**, since a published port bypasses Traefik and the firewall. Put local ports in
  `compose.override.yaml`: `docker compose` merges it locally, `lf deploy` leaves it out. To publish a port on
  the server anyway, add `x-landfall: { publish: true }` to that service.
- **Named volumes keep your data** across deploys and rollbacks. `lf sites rm` keeps them, so deploying the
  site again finds its data; `lf sites rm --volumes` deletes them. Each deploy gets a new release folder, so
  a writable bind mount like `./data` is refused: write data to a named volume (read-only `./dist:…:ro` is fine).
- **Images built on the server** are tagged `<site>-<service>:<release>`, so a rollback runs the exact image again.
- Variables in `compose.yaml` come from the site's `.env` on the server (`-e`, `--env-file`, `lf env`).
  `${VAR:?}` makes a missing one fail the deploy before anything changes.
- Your own `traefik.*` labels win: a service with its own router keeps them and landfall adds only the network.
- `-f other.yaml` deploys another file; it is saved in `.landfall.json`. Sites need Docker Compose 2.24 or newer
  on the server (`lf update --compose`).

The static, Dockerfile and image kinds are Compose sites too: landfall writes their `compose.yaml` for you.

### Running without landfall

Nothing on the server depends on the CLI. Each site is a folder you can drive with plain `docker compose`:

```sh
cd -P /opt/landfall/sites/blog/current          # -P: into the release folder itself
docker compose ps                               # or logs -f, restart, up -d, down
cd /opt/landfall/sites/blog                     # roll back by hand: point current at an older release …
ln -sfn releases/20260122143005 current
cd -P current && docker compose up -d           # … and bring it up
```

`/opt/landfall/README` on the server explains the same. A project you started yourself behind landfall's
Traefik shows up in `lf sites` as not deployed by landfall; `lf adopt <project>` makes it a site that `lf` can
list, show logs for, restart and remove, while it keeps running from its own folder.

### Main domains

```sh
lf server domain vps example.com            # checks DNS for example.com and *.example.com
lf deploy                                   # site "blog" → blog.example.com
lf deploy -d shop                           # no dot → shop.example.com
lf domains blog --add www                   # www.example.com
lf deploy -d @                              # @ → example.com itself
lf domains blog --add @                     # blog also serves example.com
lf server domain vps --add other.org        # more main domains; the first stays primary
lf server domain vps --primary other.org    # switch the primary
lf server domain vps --rm other.org         # drop one; --clear drops all (back to sslip.io)
```

`server domain` prints the A records to add: one for the domain and a wildcard `*.example.com`. With those in
place, every new site resolves without touching DNS again. For non-primary main domains, write the full name (`-d shop.other.org`).

A domain belongs to one site. Giving it to another one (`lf deploy -d @`, `lf domains shop --add example.com`)
asks, then moves it: the old site keeps its other domains. A move that would leave a site with none is refused,
and so is a redeploy whose domain comes only from `.landfall.json` (pass `-d` to move it on purpose).

## Day-to-day

```sh
lf ls                              # sites with status, and your own containers behind Traefik
lf sites info                      # services, domains, releases
lf logs -f                         # follow logs (-n 500 for more lines)
lf logs blog db                    # one service
lf rollback                        # previous release (--to <id> for a specific one)
lf env API_KEY=abc                 # set env (container is recreated); -u KEY removes one
lf restart | stop | start
lf domains                         # where DNS points, whether HTTPS answers
lf domains --add www.example.com   # also --rm, --set (updates .landfall.json)
lf domains --rm @                  # take the main domain off; the last one leaves the site running, unrouted
lf auth -u anna                    # login in front of the site (asks for the password, -p passes it)
lf auth -p '…'                     # the same for user admin
lf auth --rm-user anna | --off
lf open
lf tunnel blog                     # http://localhost:<port> straight to its container: test it without a domain
lf tunnel my-compose-app -s vps    # also any Compose project or container landfall did not deploy
lf tunnel my-app db                # a database: postgresql://localhost:5432 (the port its image exposes; --port picks another)
lf tunnel blog -l 3000 --lan       # local port 3000, also on this machine's network: open it from a phone on the same Wi-Fi
lf sites rm blog                   # delete the site (asks you to type the name)
lf logs api -s vps                 # another site on another server
```

Commands that remove something ask first: `sites rm`, `domains --rm/--set`, `server domain --rm/--clear`,
`auth --rm-user/--off`, `firewall rm`, `undo`, `traefik rm`, `server rm` and `server uninstall`. `sites rm` and `undo --all` want the name typed
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
so `lf undo` restores it. landfall never touches images pinned by digest, Dockerfile sites or foreign containers.
Version-pinned tags show the newest tag of the same shape (`traefik:v3.6` → `traefik:v3.7`).

## Traefik

```sh
lf traefik status                              # container state, routes, mode
lf traefik logs -f                             # certificate errors show up here
lf traefik setup --email you@example.com       # reconfigure (safe to re-run)
lf traefik setup --dashboard traefik           # dashboard at traefik.<main domain> behind a login; `off` removes it
lf traefik dashboard                           # the dashboard on localhost through an SSH tunnel, no domain needed
lf traefik setup --host-network                # bind 80/443 on the host
lf traefik setup --no-http3                    # turn HTTP/3 off (on by default)
```

landfall's Traefik is the container `traefik` from `/opt/landfall/traefik/docker-compose.yml`. By default Docker
publishes 80/443 to it. Sites work the same in both modes:

| | ports published (default) | `--host-network` |
|---|---|---|
| client IP in logs / `X-Forwarded-For` | real IPv4; IPv6 may show Docker's gateway | always real |
| ufw | Docker's NAT bypasses ufw for 80/443 | ufw applies |

HTTP/3 (QUIC) is on by default: Traefik also listens on 443/udp, and browsers switch to it after their first
HTTP/2 request. Setup's firewall opens 443/udp; with `--host-network` on a server whose ufw is already active,
`lf traefik setup` adds the rule. `--no-http3` turns it off (remembered). In the web UI (`lf ui`)
these options are in a server's settings under Traefik → Settings….

Traefik only answers hosts it has a certificate for (`sniStrict`). A domain pointed at the server but served
by no site fails the TLS handshake, as if nothing listened there, instead of showing a 404 or Traefik's own
certificate; plain HTTP to it redirects to HTTPS and fails the same way. A new site's domain fails the same way
for the seconds until Let's Encrypt issues its certificate. Your own certificates and Traefik config go into
`/opt/landfall/traefik/dynamic/`: landfall rewrites only `landfall.yml` there. If you edit
`docker-compose.yml` by hand, `lf traefik setup` shows the diff and stops; `--force` overwrites your edits.

The dashboard password is generated and printed once (`--dashboard-password` sets your own, `--dashboard-user` the user, default `admin`).
The dashboard is always reachable through `lf traefik dashboard`: Traefik serves it on port 8080 to the server itself only
(loopback and the `web` network's gateway), never published. A Traefik set up before this needs `lf traefik setup` once.
With your own Traefik, `lf traefik dashboard` tunnels to the entrypoint of the router that serves the dashboard on a domain and sends that domain along (TLS name and Host), so its login still applies; without such a router, `--port 8080` tunnels to its API port (api.insecure). The web UI shows the domains its dashboard is on. Image, network mode,
e-mail, staging and dashboard are remembered per server.

**Using a Traefik you already run.** If 80/443 belong to your own Traefik container, landfall does not install a second one:

```sh
lf traefik use -s vps                          # finds the container on :80/:443
lf traefik use proxy-traefik-1 -s vps   # or name it
```

Containers you run yourself behind that Traefik (compose projects with `traefik.http.routers.*.rule` labels)
show up in `lf ls` and the dashboard as "not deployed by landfall", with their domains and folder. landfall
never touches them; deploying one of their domains warns, since Traefik would send visitors to only one.
`lf adopt <project>` turns one into a site (see [Running without landfall](#running-without-landfall)).

**Removing Traefik.** `lf traefik rm` stops landfall's Traefik and takes out its config; sites stay but are
unreachable until `lf undo` or `lf traefik setup`. Certificates stay unless `--certs`. With `traefik use`, it only
makes sites stop using your Traefik, which keeps running.

landfall reads the network, HTTPS entrypoint and cert resolver from the container's flags. If your Traefik is
configured by a file, pass `--network proxy --entrypoint websecure --resolver letsencrypt`. The choice is stored
in `/opt/landfall/proxy.env`. landfall never changes that Traefik.

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

Every change landfall makes is appended to `/opt/landfall/journal.log` on the server: when, which local user and
command, what changed and the shell that reverts it.

```sh
lf history -s vps       # newest first; ↺ undoable, · not undoable, ✓ already undone
lf undo -s vps          # revert the latest run with something left to undo
lf undo 4               # run #4
lf undo 4.2             # only its second step
lf undo --all           # everything, newest first
```

- **Undoable:** setup (packages and Docker stay installed), firewall rules and on/off, deploys and rollbacks
  (previous release and env), env changes, stop/start, domains, logins, Traefik setup, `traefik use` and `traefik rm`, image and
  compose updates.
- **Not undoable:** `sites rm`, restarts, package upgrades, and a firewall rule that replaced an existing one.
- Steps revert newest first, each as the user that made it. The first failure stops the rest.
- Undo changes the server only. Local `~/.config/landfall` and `.landfall.json` stay as they are.
- Overwritten files are backed up as `.<name>.landfall-<run>-<n>`, and the newest 10 are kept per file.

## Managing servers

```sh
lf server add vps                                       # register an existing ssh alias
lf server add box --host 198.51.100.4 -u ubuntu -i ~/.ssh/box --default
lf server add web --host 198.51.100.5 -u admin               # asks the password once, installs ~/.ssh/landfall_web
lf server config vps                                    # landfall entry, Traefik settings, ssh login, keys, Host block
lf server list --all
lf server use vps
lf server rm vps                                        # forget locally
lf server uninstall vps                                 # remove landfall from the server (type the name back)
lf ssh vps -- docker ps
```

`server add` installs nothing on the server. It writes a `Host <name>` block between `# >>> landfall:<name>` markers
(`--no-ssh-config` keeps the details in landfall's config instead). In a Host block you wrote yourself, landfall
only steps in when the key does not work. It then puts the working `IdentityFile` first, drops lines whose file is
gone, and keeps a backup as `~/.ssh/config.landfall-bak`.

## Dashboard

The web dashboard (`lf ui`) listens on `127.0.0.1` and opens your browser. Servers are on the left
(★ marks the default). A server tab has Sites, Updates, Firewall, History and Settings. **Deploy folder…** browses
local folders or takes a dropped folder or `.zip`. Every action streams the output of its plain command into a side
panel. Destructive actions ask first. Login works through the printed `/login?t=…` link. The token is kept in
`~/.config/landfall/ui-token`, and you can delete that file to rotate it. Requests with a foreign `Host` or `Origin`
are refused. Running `lf ui` again while the dashboard is running just opens the page.

## Using landfall from scripts and agents

Every dashboard action is a plain command, and the dashboard prints the command it runs (`$ lf logs blog -s vps -f`).

- **No prompts:** `-y` accepts confirmations and takes defaults. Without a terminal, prompts are never shown. A
  command that would ask then **fails** and tells you to pass `-y`. It never silently goes ahead.
- **Passwords:** pass them with `--password-stdin` or `$LANDFALL_PASSWORD` (`setup`, `server add`). For `lf auth`, use `-p`.
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
| `lf server uninstall <name> [--volumes] [--keep-setup] [--force]` | Deletes landfall's sites, Traefik and `/opt/landfall`, reverts setup (deploy user, ssh hardening, firewall), and forgets the server. Docker, packages and root's landfall key stay; adopted sites keep running. Alias: `uninstall`. |
| `lf ssh [name] [-- cmd]` | Opens a shell or runs a one-off command. |
| `lf keygen <name>` | Creates `~/.ssh/landfall_<name>` and prints the public key. |

**Sites**

| command | what it does |
|---|---|
| `lf init [dir] [--postgres] [--port n]` | Writes `compose.yaml` and `compose.override.yaml` for the project, to run it locally and deploy it. |
| `lf deploy [dir] [-d domain...] [-n name] [-f file] [-b cmd] [--spa] [--image img] [--port n] [-e K=V] [--env-file f] [--static] [--keep n] [--host ip [-u user] [--ssh-port p] [--password-stdin]]` | Deploys a Compose project, static folder, Dockerfile app or image. Sets up a server that isn't yet. |
| `lf ls [--json] [--others]` | Lists sites on the server with their status, plus containers Traefik routes that landfall did not deploy (read only; `--json --others` gives `{sites, others}`). Alias: `sites list`. |
| `lf sites info [name]` | Shows services, domains and release history. |
| `lf domains [name] [--add d] [--rm d] [--set d] [--json]` | Lists domains with their DNS and HTTPS state, or changes them. Removing the last one leaves the site unrouted. |
| `lf auth [name] -u user [-p pw]` / `--rm-user u` / `--off` | Puts basic-auth login in front of a site. |
| `lf open [name]` | Opens the site in the browser. |
| `lf logs [name] [service] [-f] [-n lines]` | Shows logs of all services, or one. |
| `lf env [name] [K=V...] [-u K]` | Shows or changes the site's `.env`. Recreates the services. |
| `lf rollback [name] [--to id]` | Switches to the previous release, or to the given one. |
| `lf restart` / `stop` / `start [name] [service]` | Restarts, stops or starts the site, or one service. |
| `lf sites rm <name> [--volumes]` | Deletes the site and its files. Named volumes stay unless `--volumes`. |
| `lf adopt <project> [--name n]` | Makes a Compose project you started yourself a site, so `ls`, logs, restart and rm work for it. |

**Traefik, firewall, updates, history**

| command | what it does |
|---|---|
| `lf traefik setup [--email e] [--dashboard host\|traefik\|off] [--staging] [--image img] [--host-network] [--no-http3] [--force]` | Installs or reconfigures landfall's Traefik. `--force` overwrites hand edits. |
| `lf traefik use [container] [--network n --entrypoint e --resolver r]` | Routes sites through a Traefik you already run. |
| `lf traefik rm [--certs]` | Removes landfall's Traefik (undoable), or stops using yours after `traefik use`. |
| `lf traefik status` / `logs [-f]` / `restart` | Inspects or restarts Traefik. `lf traefik` alone means `status`. |
| `lf firewall [--json]` | Lists ufw rules and, for each listening port, whether it is reachable. |
| `lf firewall allow` / `deny <port[/proto]> [--from ip] [--comment c]` | Adds a rule. A deny goes first, so it wins. |
| `lf firewall update <n> [--port p] [--from ip] [--action allow\|deny\|limit]` | Changes a rule. |
| `lf firewall rm <n>` / `enable` / `disable` | Removes a rule, or turns ufw on or off. |
| `lf updates [--no-refresh] [--all] [--json]` | Shows pending OS packages, newer images, and Docker/compose versions. Changes nothing. |
| `lf update [site...] [--packages] [--security] [--reboot] [--images] [--compose]` | Applies updates. Image and compose updates can be undone. |
| `lf history [-n 20] [--json]` | Lists what landfall changed on the server, run by run. Alias: `log`. |
| `lf undo [n \| n.m] [--all] [--force]` | Reverts the latest run, run `n`, step `n.m`, or everything. Alias: `revert`. |

**Dashboard**

| command | what it does |
|---|---|
| `lf ui [--port 4777] [--no-open]` | Starts the web dashboard on 127.0.0.1 and prints a login link. |

## Files and config

| local file | content |
|---|---|
| `~/.config/landfall/config.json` | registered servers, default server, per-server settings |
| `~/.config/landfall/projects.json` | folders deployed from this machine (dashboard *Recent*/*Redeploy*) |
| `~/.config/landfall/ui-token` | web dashboard login token |
| `~/.config/landfall/uploads/` | folders dropped into the dashboard, removed after a day |
| `~/.ssh/landfall_<name>` | generated keys |
| `~/.ssh/config` | `Host <name>` blocks between `# >>> landfall:<name>` markers |
| `./.landfall.json` | per-project deploy settings |

| env var | effect |
|---|---|
| `LANDFALL_CONFIG_DIR` | use another directory than `~/.config/landfall` |
| `LANDFALL_SSH_CONFIG` | use another ssh config file (`ssh -F`) |
| `LANDFALL_PASSWORD` | login password for `setup`/`server add`/`deploy --host` |

On the server:

```
/opt/landfall/
  traefik/docker-compose.yml        Traefik, ports 80/443, Let's Encrypt (HTTP-01)
  traefik/letsencrypt/acme.json
  proxy.env                         only with `lf traefik use`
  README                            how to run sites by hand
  sites/<name>/
    site.json                       metadata + release history
    .env                            the site's variables (0600)
    releases/<id>/                  last 5 kept
      compose.yaml                  yours, or generated for static/Dockerfile/image
      compose.override.yaml         written by landfall: project name, Traefik labels, networks
      .env -> ../../.env
    current -> releases/<id>
  journal.log                       every change, with the shell that reverts it
```

`cd -P /opt/landfall/sites/blog/current && docker compose ps` works as usual.

## Troubleshooting

| symptom | fix |
|---|---|
| `setup needs root or passwordless sudo` | use `-u root`, or give your user passwordless sudo |
| certificate warning in the browser | you used `--staging`: `lf setup <name> --no-staging` |
| no certificate at all | DNS must point at the server and 80/443 must be open; see `lf traefik logs` |
| TLS handshake fails | no site serves the domain (`lf domains --add …`), or its certificate isn't issued yet: `lf traefik logs` |
| site container keeps restarting | `lf logs`; for apps check `--port` / `x-landfall.port` and env |
| `… publishes 5432 on the server, past Traefik and the firewall` | move `ports:` to `compose.override.yaml`, or allow it with `x-landfall: { publish: true }` |
| `sites need docker compose 2.24 or newer` | `lf update --compose` |
| `required variable … is missing` | set it on the server: `lf env KEY=…` or `lf deploy -e KEY=…` |
| `… was edited by hand` (traefik setup) | move your change to `dynamic/` or flags, or `lf traefik setup --force` |
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

## License

MIT
