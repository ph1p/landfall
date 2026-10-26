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
- [Traffic, certificates and checks](#traffic-certificates-and-checks)
- [Server system](#server-system)
- [Security](#security)
- [Web UI](#web-ui)
- [Using landfall from scripts and agents](#using-landfall-from-scripts-and-agents)
- [Command reference](#command-reference)
- [Files and config](#files-and-config)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## Install

You need Node.js 22.4+ plus `ssh`, `ssh-copy-id` and `tar` on your machine (`rsync` makes redeploys faster). The server must run Ubuntu or Debian
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
| **release** | Every deploy creates one, with an id like `20260122143005`. The last 5 are kept (`--keep n` for more). `lf rollback` switches between them, back and forth. |
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
2. Installs Docker, rsync, ufw (allowing ssh, 80 and 443, plus 443/udp for HTTP/3), fail2ban and unattended-upgrades.
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
| ssh hardening | other users still log in with a password. Afterwards setup checks the effective config with `sshd -T`, so a drop-in that turns passwords back on is reported. |
| traefik | 80/443 are held by something that is not Traefik, or by a `traefik` that landfall didn't create. If it is your own Traefik, setup offers `lf traefik use` instead. |

Docker that is installed but stopped gets started. A missing compose, or the old v1 `docker-compose`, is replaced
with the newest release. An existing Docker is never reinstalled. In a terminal, setup asks about each conflict
(the default is no). `-y` never accepts a conflict. Only `--force` does. Existing sites are never touched.

Running setup again is safe. If root's key login is gone after hardening, setup logs in as the sudo user it
remembered from the first run (`--dashboard-user` and `--email` are checked before anything changes).

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
`-e`/`--env-file`, or later with `lf env`. `--env-file -` reads the lines from stdin, so secrets stay out of `ps`.
Changed something locally? Run `lf deploy` again (or **Redeploy** in `lf ui`). When both sides have `rsync`, a redeploy sends
only the files that changed and copies the rest from the live release on the server (files you removed stay
removed); otherwise it uploads the whole folder. Either way it becomes a new release, so `lf rollback` still goes back.
`--keep 10` keeps more releases. A deploy is refused when another Compose project on the server already uses the
site's project name, since `docker compose` would otherwise take over its containers.

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
- `-f other.yaml` deploys another file from the project folder; it is saved in `.landfall.json`. Sites need Docker Compose 2.24 or newer
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
lf server domain vps --tunnel-only          # new sites get no domain unless -d: reach them with lf tunnel (--no-tunnel-only undoes)
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
lf env --env-file -  < .env.prod   # the same from a file or stdin, values never in ps
lf restart | stop | start
lf domains                         # where DNS points, whether HTTPS answers
lf domains --add www.example.com   # also --rm, --set (updates .landfall.json)
lf domains --rm @                  # take the main domain off; the last one leaves the site running, unrouted
lf auth -u anna                    # login in front of the site (asks for the password, -p passes it)
lf auth --password-stdin < pw.txt  # the same for user admin, password from stdin
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
lf update --security              # only security updates (apt, dnf/yum); images stay
lf update --packages --reboot      # reboot afterwards if needed
lf update --images                 # Traefik and image sites: pull, recreate
lf update blog --images            # one site
lf update --compose                # newest compose, where landfall installed it
```

Package upgrades (apt-get, dnf/yum, apk, zypper) cannot be undone. `--security` and `--reboot` imply `--packages`. Image and compose updates record the previous version,
so `lf undo` restores it. landfall never touches images pinned by digest, Dockerfile sites or foreign containers.
Version-pinned tags show the newest tag of the same shape (`traefik:v3.6` → `traefik:v3.7`).

## Traefik

```sh
lf traefik status                              # container state, routes, mode
lf traefik logs -f                             # certificate errors show up here (--access adds requests)
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
HTTP/2 request. Setup's firewall opens 443/udp (only with HTTP/3 on); with `--host-network` on a server whose ufw is active,
`lf traefik setup` opens 80/tcp, 443/tcp and 443/udp. `--no-http3` turns it off (remembered). In the web UI (`lf ui`)
these options are in a server's settings under Traefik → Settings….

Traefik only answers hosts it has a certificate for (`sniStrict`). A domain pointed at the server but served
by no site fails the TLS handshake, as if nothing listened there, instead of showing a 404 or Traefik's own
certificate; plain HTTP to it redirects to HTTPS and fails the same way. A new site's domain fails the same way
for the seconds until Let's Encrypt issues its certificate. Your own certificates and Traefik config go into
`/opt/landfall/traefik/dynamic/`: landfall rewrites only `landfall.yml` there. If you edit
`docker-compose.yml` by hand, `lf traefik setup` shows the diff and stops; `--force` overwrites your edits.

**Traefik's dashboard.** `lf traefik dashboard` always reaches it through an SSH tunnel: Traefik serves it on
port 8080 to the server itself only (loopback and the `web` network's gateway), never published. A Traefik set
up before this needs `lf traefik setup` once. `--dashboard <domain>` also serves it on a domain behind a login;
the password is generated and printed once (`--dashboard-password` sets your own, `--dashboard-user` the user,
default `admin`).

With your own Traefik, `lf traefik dashboard` tunnels to the entrypoint of the router that serves the dashboard
on a domain and sends that domain along (TLS name and Host), so its login still applies. Without such a router,
`--port 8080` tunnels to its API port (api.insecure).

Image, network mode, HTTP/3, e-mail, staging and dashboard are remembered per server, so re-running
`lf traefik setup` keeps them.

**Using a Traefik you already run.** If 80/443 belong to your own Traefik container, landfall does not install a second one:

```sh
lf traefik use -s vps                          # finds the container on :80/:443
lf traefik use proxy-traefik-1 -s vps   # or name it
```

Containers you run yourself behind that Traefik (compose projects with `traefik.http.routers.*.rule` labels)
show up in `lf ls` and the web UI as "not deployed by landfall", with their domains and folder. landfall
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
- `update` replaces the rule in the same place, since ufw stops at the first match. If ufw rejects the new rule,
  the old one is put back. `rm` and its undo also keep the rule's position.

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
- Undoing an older run is refused while a later run still changed the same site, Traefik or file: undo the
  later one first, or pass `--force`.
- Undo changes the server only. Local `~/.config/landfall` and `.landfall.json` stay as they are.
- Overwritten files are backed up as `.<name>.landfall-<run>-<n>`, and the newest 10 are kept per file.
- Two undos at once on the same server wait for each other, and a step already undone is skipped.

## Managing servers

```sh
lf server add vps                                       # register an existing ssh alias
lf server add box --host 198.51.100.4 -u ubuntu -i ~/.ssh/box --default
lf server add web --host 198.51.100.5 -u admin               # asks the password once, installs ~/.ssh/landfall_web
lf server config vps                                    # landfall entry, Traefik settings, ssh login, keys, Host block
lf server list --all --check                            # which servers landfall can log in to right now
lf server use vps
lf config --tunnel-only --keep 3                        # defaults for every server; also lists where landfall puts things
lf server rm vps                                        # forget locally
lf server uninstall vps                                 # remove landfall from the server (type the name back)
lf ssh vps -- docker ps
lf stats                                                # CPU, memory, disks, network, busiest processes, every container's usage
lf stats blog -w                                        # only the containers of one site, refreshed every 5s (--interval)
lf disk                                                 # where the space goes: images, volumes, build cache, sites, container logs
lf prune                                                # remove unused images and the build cache (--all: unused tagged images too)
lf reboot                                               # reboot, wait until it is back, check its containers run again
```

`stats` samples the server for one second over ssh; nothing runs on the server between calls. CPU of a
process counts one core as 100%. `disk` adds up folders, so it takes a few seconds on a full disk; without
root or passwordless sudo, root-owned folders and container logs may be missing.

`prune` keeps images any container uses (stopped ones too), images built for a site release (rollback runs
them without rebuilding) and images an undo in the journal puts back. Containers and volumes stay. `--dry-run`
shows what would go.

### NAS, Steam Deck and other systems without a package manager

Synology DSM, SteamOS and other systems without apt, dnf, yum, apk or zypper install software their own way.
`lf setup` refuses on them (`--check` and `--key-only` still work). Register them with `lf server add` and deploy
to them as they are. `lf server info` shows what landfall can do on a server and why not:

```
login    root · root or sudo
init     systemd
docker   24.0.2 · compose 2.20.1
firewall DSM has its own firewall: Control Panel → Security → Firewall
```

On Synology, Docker comes from Container Manager in Package Center, so `lf update --compose` leaves it alone.
DSM's Control Panel keeps the host name, time zone, swap and Docker's settings, and its own firewall replaces
ufw, so landfall refuses those changes there. On SteamOS, install Docker in your home directory (landfall does not run podman). A
login without passwordless sudo can still deploy but not change the system. The web UI shows only the tabs and
actions that work on the server.

Non-interactive ssh sessions often lack `/usr/local/bin` (where DSM keeps `docker`), so landfall adds
`/usr/local/sbin` and `/usr/local/bin` to `PATH` for every command it runs.

`server add` installs nothing on the server. It writes a `Host <name>` block between `# >>> landfall:<name>` markers
(`--no-ssh-config` keeps the details in landfall's config instead). In a Host block you wrote yourself, landfall
only steps in when the key does not work. It then puts the working `IdentityFile` first, drops lines whose file is
gone, and keeps a backup as `~/.ssh/config.landfall-bak`.

## Traffic, certificates and checks

```sh
lf traffic                          # last 24h per site: requests, 4xx/5xx, median and 95% response time, bytes sent
lf traffic blog --since 1h          # one site (or a host): requests per minute, busiest paths, failing requests, clients
lf certs                            # each site domain's certificate: days left, issuer, why getting one failed
lf check                            # request every site over HTTPS from this machine; exits 1 when one fails
lf check example.com --resolve 198.51.100.4   # one domain, against an address before DNS points there
```

`traffic` reads Traefik's access log (JSON lines on its stdout, written by `lf traefik setup`) and adds it up
on the server with awk, so only the counts cross ssh. It reaches back as far as the container log does:
`lf log-limit` caps it, `--since` takes up to 30d. Spans up to 6h count per minute, longer ones per hour;
response times come from a histogram and are within about 20%. Traefik installed before this version logs
plain text: `lf traefik setup` switches it to JSON (Traefik restarts for a moment). A server's own Traefik
(`lf traefik use`) needs `--accesslog=true --accesslog.format=json` in its command.

`certs` reads certificates from what Traefik mounts: `acme.json` (Let's Encrypt; needs root or passwordless
sudo when it is root-owned) and certificate files in `dynamic/`. Only certificates leave the server, never
keys. Errors come from Traefik's log of the last 7 days (`--since`). Let's Encrypt renews 30 days ahead, so
under 30 days means renewal is due, under 7 that it is failing.

`check` runs on your machine, the way a visitor sees a site: status, time to the response, and whether the
certificate is trusted and valid for at least 7 more days. Give it domains and it needs no server, so it
works from cron or CI. The web UI checks a server's domains each minute while its Sites tab is open (the
dot on each domain; hover for the details).

## Server system

```sh
lf system                         # host name, time zone, clock, swap, Docker log limit, services, keys, bans
lf services                       # what landfall relies on (docker, ssh, fail2ban …) and failed ones; --all for every one
lf services restart docker        # also start, stop; asks first for docker, refuses ssh without --force
lf services logs fail2ban -f      # journald, else the service's log file; -n lines
lf keys                           # who may log in, per user; ★ is the key this machine uses
lf keys add ~/.ssh/anna.pub       # to the login user; --user root for another
lf keys rm anna@laptop            # by comment or (part of) the fingerprint
lf bans                           # what fail2ban blocks, per jail
lf unban 203.0.113.9
lf swap 2G                        # a swap file at /swapfile, on at boot; lf swap off removes it
lf hostname web-1
lf timezone Europe/Berlin
lf log-limit 10m --files 3        # cap Docker's json-file logs per container; --restart applies it now
```

Every change is journaled, and all but `swap off` and `services restart` can be undone: `lf undo` stops a
started service, puts a removed key back, bans an unbanned IP again or restores the old name, zone or
`daemon.json`. These commands need root or passwordless sudo, else landfall uses root's key login like the
firewall does. Services work with systemd and OpenRC. The Docker log limit applies to containers created
afterwards (and Docker restarts only with `--restart`), so redeploy or restart sites to apply it to them.

## Security

```sh
lf security                       # ssh passwords, root login, firewall, fail2ban, automatic updates, pending reboot
lf harden                         # all of: ssh (keys only), fail2ban, updates; or name the parts
lf harden ssh                     # asks first; refuses while a user logs in with a password only (--force)
lf keys add --generate -u anna    # new pair at ~/.ssh/<server>_anna, its public key on the server
```

`lf setup` and `lf server add` end with the same advice, and the web UI shows it on the system tab with a
button per fix. Each fix is journaled, so `lf undo` takes it back. Automatic updates know apt
(unattended-upgrades), dnf (dnf-automatic) and apk (a daily `apk upgrade` from cron). Without root or sudo landfall only checks sshd's settings.

## Web UI

```sh
lf ui                 # starts on 127.0.0.1:4777 and opens your browser
lf ui --no-open       # only print the login link
```

The web UI is a front end for the CLI. Every action runs a plain `lf` command as a subprocess, streams its
output into a side panel and shows the command (`$ lf rollback blog -s vps --to 20260122143005 -y`), so
anything you do there you can repeat in a terminal or a script. Runs started there are journaled like any
other and show up in `lf history`. The pages read the same data the `--json` commands print:

| page | commands |
|---|---|
| Overview | `lf server list --check`, recent deploys, `lf config` (defaults, and where landfall puts things) |
| Sites | `lf ls`, `sites info`, `deploy`, `rollback`, `logs`, `restart`/`stop`/`start`, `env`, `domains`, `auth`, `tunnel`, `sites rm` |
| Stats | `lf stats` (a new sample every 5s while the tab is open), `lf disk` on request, Clean up… (`lf prune`) |
| Traffic | `lf traffic --since 1h/24h/7d`, `lf certs`; the Sites tab shows failing requests of the last 24h and `lf check` on each domain |
| Updates | `lf updates`, `lf update` |
| Firewall | `lf firewall` and its subcommands |
| System | `lf system`, `services`, `keys`, `unban`, `swap`, `hostname`, `timezone`, `log-limit` |
| History | `lf history`, `lf undo` |
| Settings | `lf server config`, `server domain`, `traefik setup` (Settings…, Dashboard…), `traefik dashboard` |

Servers are on the left (★ marks the default). The dot next to each says whether landfall's key login works
(green), sshd refuses it (yellow) or ssh does not answer (red); hover for the reason. It checks on load, every
minute while the page is open, and on **Check** at the foot of the list (like `lf server list --check`).
Reachable servers come first; unreachable ones move to a closed **Unreachable** group. Git hosts and aliases
for this machine (`localhost`, `127.0.0.1`, e.g. a Colima VM) from `~/.ssh/config` are not listed. **Deploy folder…** browses local folders, or takes a dropped
folder or `.zip` (up to 512 MiB; archives with symlinks or hard links are refused). Destructive actions ask first.

- **Login:** through the printed `/login?t=…` link. The token is kept in `~/.config/landfall/ui-token`; delete
  that file to rotate it.
- **Local only:** it listens on `127.0.0.1` and refuses requests with a foreign `Host` or `Origin`.
- Running `lf ui` again while it runs just opens the page. If another program has port 4777, it takes the next
  free one (an explicit `--port` fails instead).
- **Limits:** at most 20 commands run at once. Passwords and env values are handed to the `lf` subprocess
  through env vars and stdin, never on its command line.
- **No screen scraping:** commands report results the UI needs (deploy URL, tunnel address, setup checks, a
  refusal that `--force` would override) on a separate channel, so the UI never parses CLI text.

## Using landfall from scripts and agents

Everything is a plain command; the web UI only runs those and prints each one (`$ lf logs blog -s vps -f`).

- **No prompts:** `-y` accepts confirmations and takes defaults. Without a terminal, prompts are never shown. A
  command that would ask then **fails** and tells you to pass `-y`. It never silently goes ahead.
- **Passwords:** pass them with `--password-stdin` or `$LANDFALL_PASSWORD` (`setup`, `server add`), and
  `lf auth --password-stdin`. Any `--…password` option also falls back to `$LANDFALL_SECRET_<NAME>`, e.g.
  `LANDFALL_SECRET_DASHBOARD_PASSWORD`.
  Env values: `lf env --env-file -` / `lf deploy --env-file -` read them from stdin.
- **JSON output:** `--json` works on `ls`, `info`, `server list`, `server config`, `server domain`, `domains`,
  `firewall`, `updates` and `history`. The web UI reads the very same JSON. `ls --json --others` gives the full
  overview; `domains --json` lists the server's addresses under `ips`.
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
| `lf server list [--all] [--check] [--json]` | Lists registered servers. `--all` adds every ssh alias except git hosts (github.com, `gitlab.*`, `User git` …). `--check` tries a key login to each: `ok`, `login` (sshd refuses the key) or `down`. Alias: `servers`. |
| `lf server info [name] [--json]` | Shows OS and release support, kernel, uptime, CPU, RAM, disk, addresses and containers. Alias: `info`. |
| `lf stats [site] [-w] [--interval s] [--json]` | Shows live CPU, memory, swap, disks, network, the busiest processes and each container's CPU, memory, network and restarts. With a site, only its containers. `-w` refreshes until Ctrl-C. Alias: `server stats`. |
| `lf disk [--json]` | Shows where disk space goes: filesystems, Docker images, containers, volumes and build cache (with what is reclaimable), each site and its releases, the largest volumes and container logs, the systemd journal. Alias: `server disk`. |
| `lf traffic [site] [--since 24h] [--json]` | Shows requests, 4xx/5xx, median and 95% response time and bytes per site from Traefik's access log; with a site or host, requests per minute or hour, busiest paths, failing requests and clients. Alias: `server traffic`. |
| `lf certs [--since 7d] [--json]` | Shows each site domain's certificate (days left, expiry, issuer, staging), other certificates Traefik has, and its recent certificate errors. Alias: `server certs`. |
| `lf check [site\|domain…] [--resolve ip[:port]] [--json]` | Requests sites over HTTPS from this machine: status, response time, certificate trust and days left. Exits 1 when one fails. Domains need no server. Alias: `sites check`. |
| `lf prune [--all] [--dry-run] [--json]` | Removes unused Docker images and the build cache. Keeps images in use (stopped containers too), release images for rollback and images undo needs. `--all` also removes unused tagged images (pulled again when needed) and all build cache. Journaled, not reversible. Alias: `server prune`. |
| `lf reboot [--timeout s]` | Reboots the server (needs root or passwordless sudo), waits until ssh answers again (default 300s) and checks that the containers that ran before run again. Alias: `server reboot`. |
| `lf system [--json]` | Shows the host name, time zone, clock sync, swap, Docker's log driver and limit, services, SSH keys and fail2ban bans, with hints (no swap on a small server, unlimited Docker logs). Alias: `server system`. |
| `lf services [--all] [--json]` | Lists services landfall relies on and failed ones; `--all` lists every one. systemd or OpenRC. Alias: `services ls`. |
| `lf services restart\|start\|stop <service>` | Controls a service. Stopping ssh needs `--force`; stopping or restarting docker asks first. Start and stop can be undone. |
| `lf services logs <service> [-f] [-n lines]` | Shows a service's log: journald, else its log file. |
| `lf keys [--json]` | Lists the SSH keys in each user's `authorized_keys` (root and `/home/*`). ★ marks the key this machine logs in with. Alias: `keys ls`. |
| `lf keys add <key\|file.pub> [--user u] [--generate]` | Adds a public key, to the login user by default. `--generate` makes a new pair at `~/.ssh/<server>_<user>` instead. Undoable. |
| `lf security [--json]` | Checks ssh password and root login, firewall, fail2ban, automatic updates and a pending reboot, and names the command that fixes each. |
| `lf harden [ssh\|fail2ban\|updates…] [--force]` | Turns ssh passwords off, installs and starts fail2ban, turns on automatic security updates; all three without arguments. `ssh` refuses to lock out password-only users without `--force`. Undoable. |
| `lf keys rm <fingerprint\|comment> [--user u]` | Removes a key by comment or fingerprint prefix. Refuses the key this machine uses without `--force`. Undoable. |
| `lf bans [--json]` | Shows banned IPs per fail2ban jail. |
| `lf unban <ip>` | Unbans an IP in every jail that bans it. Undo bans it again. |
| `lf swap [size\|off]` | Shows swap, adds a swap file at `/swapfile` (at least 64M, keeps 2 GB of disk free) or removes it. Adding is undoable. Alias: `server swap`. |
| `lf hostname [name]` | Shows or sets the host name (and its `/etc/hosts` line). Undoable. Alias: `server hostname`. |
| `lf timezone [zone]` | Shows or sets the time zone, e.g. `Europe/Berlin`. Undoable. Alias: `server timezone`. |
| `lf log-limit [size\|off] [--files n] [--restart]` | Shows or sets Docker's json-file log limit per container in `daemon.json` (default 3 files). `--restart` restarts Docker so it applies now. Undoable. |
| `lf server config [name] [--json]` | Shows everything landfall and ssh use for a server. Does not connect. |
| `lf server domain [name] [domain...] [--add d] [--primary d] [--rm d] [--clear] [--tunnel-only] [--json]` | Manages main domains (the first is primary) and checks their DNS; `--tunnel-only` makes new sites deploy with no domain. |
| `lf server use <name>` | Sets the default server. |
| `lf config [--tunnel-only] [--email e] [--keep n] [--default name] [--unset key] [--json]` | Shows or changes landfall's defaults for every server, and lists every place landfall writes to. A server's own setting wins. |
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
| `lf auth [name] -u user [-p pw \| --password-stdin]` / `--rm-user u` / `--off` | Puts basic-auth login in front of a site. |
| `lf open [name]` | Opens the site in the browser. |
| `lf logs [name] [service] [-f] [-n lines]` | Shows logs of all services, or one. |
| `lf env [name] [K=V...] [--env-file f\|-] [-u K]` | Shows or changes the site's `.env`. Recreates the services. |
| `lf rollback [name] [--to id]` | Switches to the previous release, or to the given one. |
| `lf restart` / `stop` / `start [name] [service]` | Restarts, stops or starts the site, or one service. |
| `lf tunnel [name] [service] [--port p] [-l local] [--lan]` | Opens a site, one of its services or any container on localhost through an SSH tunnel. |
| `lf sites rm <name> [--volumes]` | Deletes the site and its files. Named volumes stay unless `--volumes`. |
| `lf adopt <project> [--name n]` | Makes a Compose project you started yourself a site, so `ls`, logs, restart and rm work for it. |

**Traefik, firewall, updates, history**

| command | what it does |
|---|---|
| `lf traefik setup [--email e] [--dashboard host\|traefik\|off] [--staging] [--image img] [--host-network] [--no-http3] [--force]` | Installs or reconfigures landfall's Traefik. `--force` overwrites hand edits. |
| `lf traefik use [container] [--network n --entrypoint e --resolver r]` | Routes sites through a Traefik you already run. |
| `lf traefik rm [--certs]` | Removes landfall's Traefik (undoable), or stops using yours after `traefik use`. |
| `lf traefik dashboard [-l local] [--lan] [--port p]` | Opens Traefik's dashboard on localhost through an SSH tunnel. |
| `lf traefik status` / `logs [-f]` / `restart` | Inspects or restarts Traefik. `lf traefik` alone means `status`. |
| `lf firewall [--json]` | Lists ufw rules and, for each listening port, whether it is reachable. |
| `lf firewall allow` / `deny <port[/proto]> [--from ip] [--comment c]` | Adds a rule. A deny goes first, so it wins. |
| `lf firewall update <n> [--port p] [--from ip] [--action allow\|deny\|limit]` | Changes a rule. |
| `lf firewall rm <n>` / `enable` / `disable` | Removes a rule, or turns ufw on or off. |
| `lf updates [--no-refresh] [--all] [--json]` | Shows pending OS packages, newer images, and Docker/compose versions. Changes nothing. |
| `lf update [site...] [--packages] [--security] [--reboot] [--images] [--compose]` | Applies updates. Image and compose updates can be undone. |
| `lf history [-n 20] [--json]` | Lists what landfall changed on the server, run by run. Alias: `log`. |
| `lf undo [n \| n.m] [--all] [--force]` | Reverts the latest run, run `n`, step `n.m`, or everything. Refuses a run when a later one changed the same site or file, unless `--force`. Alias: `revert`. |

**Web UI**

| command | what it does |
|---|---|
| `lf ui [--port 4777] [--no-open]` | Starts the web UI on 127.0.0.1 and prints a login link. Alias: `web`. |

## Files and config

| local file | content |
|---|---|
| `~/.config/landfall/config.json` | registered servers, default server, per-server settings, landfall defaults (`lf config`) |
| `~/.config/landfall/projects.json` | folders deployed from this machine (web UI *Recent*/*Redeploy*) |
| `~/.config/landfall/ui-token` | web UI login token |
| `~/.config/landfall/uploads/` | folders dropped into the web UI, removed after a day |
| `~/.ssh/landfall_<name>` | generated keys |
| `~/.ssh/config` | `Host <name>` blocks between `# >>> landfall:<name>` markers |
| `./.landfall.json` | per-project deploy settings |

| env var | effect |
|---|---|
| `LANDFALL_CONFIG_DIR` | use another directory than `~/.config/landfall` |
| `LANDFALL_SSH_CONFIG` | use another ssh config file (`ssh -F`) |
| `LANDFALL_PASSWORD` | login password for `setup`/`server add`/`deploy --host` |
| `LANDFALL_SECRET_<OPTION>` | value of a `--…password` option, e.g. `LANDFALL_SECRET_PASSWORD` for `lf auth` |

On the server:

```
/opt/landfall/
  traefik/docker-compose.yml        Traefik, ports 80/443 (+443/udp for HTTP/3), Let's Encrypt (HTTP-01)
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
/etc/ssh/sshd_config.d/00-landfall.conf   ssh hardening from `lf setup`
```

`lf setup` also installs Docker with the compose plugin, rsync, ufw, fail2ban and unattended-upgrades, and creates the
`deploy` user (group docker). Before changing a file, landfall keeps a backup next to it as
`.<file>.landfall-<run>` (the newest 10). `lf config` and the web UI's *Overview* list all of these places.

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
