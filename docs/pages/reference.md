# Reference

Every command, every local and remote file landfall uses, and its environment variables. `lf <command> --help` prints the options of one command.

## Command reference

`[name]` is a site or server and is optional (see [Concepts](index.md#concepts)). Most site and server commands take `-s <server>`. Every command takes `-y` and `--help`.

**Servers**

| command | what it does |
|---|---|
| `lf setup <name> [--host ip]` | Turns a box into a deploy target: ssh key, Docker, ufw, deploy user, ssh hardening and Traefik. Idempotent. Installs fail2ban only where ssh passwords stay on (`--no-harden`). No ufw where the cloud provider's firewall is always in front, unless `--firewall`. `--cloud <provider>` sets the provider where detection is wrong. |
| `lf setup <name> --minimal` | Only Docker and `/opt/landfall`: no Traefik, deploy user, packages, firewall or ssh hardening. Sites then deploy with no domain; `lf tunnel` reaches them. |
| `lf setup <name> --check` | Reports what is set up and what setup would change. Changes nothing. |
| `lf setup <name> --key-only` | Only installs landfall's ssh key. |
| `lf server add <name> [--host ip] [-u user] [-p port] [-i key] [--password-stdin] [--domain d] [--cloud provider] [--default]` | Registers a server without installing anything on it. Writes `Host <name>` to `~/.ssh/config`. |
| `lf server list [--all] [--check] [--json]` | Lists registered servers. `--all` adds every ssh alias except git hosts (github.com, `gitlab.*`, `User git` …). `--check` tries a key login to each: `ok`, `login` (sshd refuses the key) or `down`. Alias: `servers`. |
| `lf server info [name] [--json]` | Shows OS and release support, kernel, uptime, CPU, RAM, disk, addresses and containers. Alias: `info`. |
| `lf stats [site] [-w] [--interval s] [--json]` | Shows live CPU, memory, swap, disks, network, the busiest processes and each container's CPU, memory, network and restarts. With a site, only its containers. `-w` refreshes until Ctrl-C. Alias: `server stats`. |
| `lf disk [--json]` | Shows where disk space goes: filesystems, Docker images, containers, volumes and build cache (with what is reclaimable), each site and its releases, the largest volumes and container logs, the systemd journal. Alias: `server disk`. |
| `lf traffic [site] [--since 24h] [--json]` | Shows requests, 4xx/5xx, median and 95% response time and bytes per site from Traefik's access log; with a site or host, requests per minute or hour, busiest paths, failing requests and clients. Alias: `server traffic`. |
| `lf certs [--since 7d] [--json]` | Shows each site domain's certificate (days left, expiry, issuer, staging), other certificates Traefik has, and its recent certificate errors. Alias: `server certs`. |
| `lf check [site\|domain…] [--resolve ip[:port]] [--json]` | Requests sites over HTTPS from this machine: status, response time, certificate trust and days left. Exits 1 when one fails. Domains need no server. Alias: `sites check`. |
| `lf prune [--all] [--logs] [--volumes] [--dry-run] [--json]` | Removes unused Docker images, the build cache and unused networks. Keeps images in use (stopped containers too), release images for rollback and images undo needs. `--all` also removes unused tagged images (pulled again when needed) and all build cache. `--logs` also empties container logs and shrinks the systemd journal to 100M (needs root). `--volumes` also deletes volumes no container mounts and no existing site owns, and the backups `lf sites rm` kept of removed sites. Journaled, not reversible. Alias: `server prune`. |
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
| `lf users [--json]` | Lists root and the accounts with a uid from 1000: sudo (and whether without a password), password set/locked/none, SSH keys, shell. ★ marks the user landfall logs in as. Alias: `users ls`. |
| `lf users add <name> [--key k\|file.pub] [--generate-key] [--password p] [--sudo [--nopasswd]] [--shell s]` | Adds an account with a home; it needs a key, a new pair or a password. Undoable. |
| `lf users rm <name> [--keep-home]` | Removes an account and (unless `--keep-home`) its home. Refuses root, landfall's login and the admin login. Not undoable. |
| `lf users passwd <name> [--password p \| --password-stdin \| --generate \| --remove]` | Sets (asked twice in a terminal), makes up or removes a password. Not undoable. Alias: `users password`. |
| `lf users sudo <name> [--nopasswd \| --off]` | Grants sudo through `/etc/sudoers.d/landfall-<name>`, or takes it away (that file and the sudo/wheel groups). Undoable. |
| `lf swap [size\|off]` | Shows swap, adds a swap file at `/swapfile` (at least 64M, keeps 2 GB of disk free) or removes it. Adding is undoable. Alias: `server swap`. |
| `lf hostname [name]` | Shows or sets the host name (and its `/etc/hosts` line). Undoable. Alias: `server hostname`. |
| `lf timezone [zone]` | Shows or sets the time zone, e.g. `Europe/Berlin`. Undoable. Alias: `server timezone`. |
| `lf log-limit [size\|off] [--files n] [--restart]` | Shows or sets Docker's json-file log limit per container in `daemon.json` (default 3 files). `--restart` restarts Docker so it applies now. Undoable. |
| `lf server config [name] [--json]` | Shows everything landfall and ssh use for a server. Does not connect. |
| `lf server config [name] --cloud <provider\|none\|auto>` | Remembers the server's cloud provider. `none` means no provider. `auto` forgets it and detects again. |
| `lf server config [name] --root-login <ssh-alias\|auto>` | Names a Host from `~/.ssh/config` for root work when the server's login has no passwordless sudo. The Host must reach the same machine. `auto` forgets it. |
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
| `lf deploy [dir] [-d domain...] [-n name] [-f file] [-b cmd] [--start cmd] [--volume path...] [--worker] [--spa] [--image img] [--port n] [-e K=V] [--dotenv f] [--local-env] [--fill-volumes] [--build-local] [--static] [--gitignore] [--keep n] [--host ip [-u user] [--ssh-port p] [--password-stdin]]` | Deploys a Compose project, app (Node.js, Bun, Python, Go, Rust, Java, .NET, Ruby, PHP, Elixir), static folder, Dockerfile app or image. Sets up a server that isn't yet. |
| `lf ls [--json] [--others]` | Lists sites on the server with their status, plus containers Traefik routes that landfall did not deploy (read only; `--json --others` gives `{sites, others}`). Alias: `sites list`. |
| `lf sites info [name] [--json]` | Shows services, domains and release history. |
| `lf domains [name] [--add d] [--rm d] [--set d] [--json]` | Lists domains with their DNS and HTTPS state, or changes them. Removing the last one leaves the site unrouted. |
| `lf auth [name] [-r route] -u user [-p pw \| --password-stdin]` / `--rm-user u` / `--off` / `-r route --public` | Puts basic-auth login in front of a site, or gives one route its own login or none. |
| `lf open [name]` | Opens the site in the browser. |
| `lf logs [name] [service] [-f] [-n lines]` | Shows logs of all services, or one. |
| `lf env [name] [K=V...] [--dotenv f\|-] [-u K] [--reveal] [--keys] [--json] [--pull f]` | Shows the site's `.env` (values hidden unless `--reveal`), copies it to a local file, or changes it. A change recreates the services. |
| `lf secret [name] [K=V...] [--file K=path] [--dotenv f\|-] [-u K] [--json] [--force]` | Lists the site's secret files (names and sizes) or changes them; services read them at `/run/secrets/<K>`. Changing one restarts the services that use it. |
| `lf rollback [name] [--to id]` | Switches to the previous release, or to the given one. |
| `lf release rm [name] [id…] [--keep n]` | Deletes old releases and the images built for them: the given ones, else all but the live one (`--keep n` keeps the n newest). The live release always stays. Journaled, not reversible. |
| `lf restart` / `stop` / `start [name] [service]` | Restarts, stops or starts the site, or one service. |
| `lf tunnel [name] [service] [--port p] [-l local] [--lan]` | Opens a site, one of its services or any container on localhost through an SSH tunnel. |
| `lf tunnels [--json]` | Lists the tunnels open on this machine. |
| `lf sites rm <name> [--volumes]` | Deletes the site and its files. Named volumes and their backups stay; `--volumes` deletes the volumes, each backed up first (`lf undo` brings them back). |
| `lf volumes [name] [--json]` | Lists a site's volumes: size, mounts, backups. Alias: `volume ls`. |
| `lf volume add [name] [service:]<path> [--as key]` | Keeps a container folder in a named volume: edits compose.yaml or `.landfall.json`; `lf deploy` applies it. |
| `lf volume rm [name] <volume> [--data]` | Unmounts a volume in the project; `--data` deletes an unused one on the server (backed up first; undoable). |
| `lf volume backup [name] [volume] [--schedule hourly\|daily\|weekly\|off] [--keep n] [--offsite host:path]` | Saves a volume (default: all) as a `.tar.gz` in the site's `backups/` folder, a database using it paused meanwhile. `--schedule` does it from cron; `--offsite` mirrors the backups to another host. |
| `lf volume backup rm [name] <backup...>` | Deletes backups from the site's `backups/` folder. Not undoable. |
| `lf volume pull [name] [volume] [--into dir] [-o file] [--backup file\|latest]` | Downloads a volume or one of its backups, as an archive or unpacked. |
| `lf volume push [name] <volume> <folder\|file.tar.gz>` | Replaces a volume's contents with local files. Backs up first; undoable. |
| `lf volume restore [name] [volume] [backup]` | Replaces a volume's contents with a backup (default: the newest). Backs up first; undoable. |
| `lf eject [name] [--network n] [--entrypoint e] [--resolver r]` | Writes the live release's Traefik labels, logins and proxy network into the project as `compose.traefik.yaml`, to run it behind your own Traefik. Changes nothing on the server. |
| `lf adopt <project> [--name n]` | Makes a Compose project you started yourself a site, so `ls`, logs, restart and rm work for it. |

**Traefik, firewall, updates, history**

| command | what it does |
|---|---|
| `lf traefik setup [--email e] [--dashboard host\|traefik\|off] [--staging] [--image img] [--host-network] [--no-http3] [--force]` | Installs or reconfigures landfall's Traefik. `--force` overwrites hand edits. |
| `lf traefik use [container] [--network n --entrypoint e --resolver r]` | Routes sites through a Traefik you already run. |
| `lf traefik rm [--certs]` | Removes landfall's Traefik (undoable), or stops using yours after `traefik use`. |
| `lf traefik dashboard [-l local] [--lan] [--port p]` | Opens Traefik's dashboard on localhost through an SSH tunnel. |
| `lf traefik status [--json]` / `logs [-f]` / `restart` | Inspects or restarts Traefik: its container and every route it serves. `lf traefik` alone means `status`. |
| `lf firewall [--json]` | Lists ufw rules and, for each listening port, whether it is reachable. |
| `lf firewall allow` / `deny <port[/proto]> [--from ip] [--comment c]` | Adds a rule. A deny goes first, so it wins. |
| `lf firewall update <n> [--port p] [--from ip] [--action allow\|deny\|limit]` | Changes a rule. |
| `lf firewall rm <n>` / `enable` / `disable` | Removes a rule, or turns ufw on or off. |
| `lf updates [--no-refresh] [--all] [--json]` | Shows pending OS packages, newer images, and Docker/compose versions. Changes nothing. |
| `lf update [site...] [--packages] [--security] [--reboot] [--images] [--compose]` | Applies updates. Image and compose updates can be undone. |
| `lf scan [site...] [--all] [--fixable] [--no-others] [--json] [--remove]` | Scans the running images for known vulnerabilities (Trivy) and says what fixes them. Changes nothing. |
| `lf history [-n 20] [--json]` | Lists what landfall changed on the server, run by run. Alias: `log`. |
| `lf undo [n \| n.m] [--all] [--force]` | Reverts the latest run, run `n`, step `n.m`, or everything. Refuses a run when a later one changed the same site or file, unless `--force`. Alias: `revert`. |

**Web UI**

| command | what it does |
|---|---|
| `lf ui [--port 4777] [--no-open]` | Starts the web UI on 127.0.0.1 and prints a login link. Alias: `web`. |

**Plugins** (see [Plugins](plugins.md))

| command | what it does |
|---|---|
| `lf plugins [--json]` | Lists the plugins, built in and in `~/.config/landfall/plugins`, with their commands, web UI section and load errors. |
| `lf plugin add <file\|folder> [--force]` | Installs a plugin: a `.mjs`/`.js` file, or a folder with `index.mjs` or package.json `main`. Loads it first to check it. `--force` replaces one of that name. |
| `lf plugin rm <name>` | Removes an installed plugin and what it keeps in `~/.config/landfall/plugin-data/<name>`. Built-in plugins stay. |
| `lf plugin new <name> [--out file]` | Writes a plugin to start from, with a command and a web UI section. |
| `lf fail2ban [--json]` | Shows fail2ban's jails, their ban time, find time and max retries, and the banned IPs. Alias: `bans`. |
| `lf fail2ban ban <ip> [--jail j]` | Bans an IP now, in `sshd` unless `--jail`. Undo unbans it. |
| `lf fail2ban unban <ip>` | Unbans an IP in every jail that bans it. Undo bans it again. Alias: `unban`. |
| `lf fail2ban config <jail> [--bantime t] [--findtime t] [--maxretry n]` | Writes a jail's settings to `/etc/fail2ban/jail.d/50-landfall-<jail>.local` and reloads fail2ban. Undo restores the file. |
| `lf fail2ban install` | Installs and starts fail2ban with an sshd jail, as `lf harden fail2ban`. |
| `lf trivy [--json]` | Shows Trivy's image and databases on the server and the summaries of the last scans. |
| `lf trivy images [site...] [--json]` | Scans the running images for vulnerabilities and keeps a summary. `lf scan` lists every vulnerability. Alias: `trivy scan`. |
| `lf trivy files [site...] [--json]` | Scans the sites' current releases for secrets and misconfigurations. Skips `.env` files, `node_modules` and `.git`. Changes nothing. |
| `lf trivy rm` | Removes Trivy's image and databases from the server. Not undoable; the next scan downloads them again. Alias: `trivy remove`. |
| `lf <plugin> [--json]` | A plugin with a web UI section and no command of its own prints that section as text; `--json` prints its blocks. |

## Files and config

| local file | content |
|---|---|
| `~/.config/landfall/config.json` | registered servers, default server, per-server settings, landfall defaults (`lf config`) |
| `~/.config/landfall/projects.json` | folders deployed from this machine (web UI *Recent*/*Redeploy*) |
| `~/.config/landfall/ui-token` | web UI login token |
| `~/.config/landfall/uploads/` | folders dropped into the web UI, removed after a day |
| `~/.config/landfall/plugins/` | your plugins (`lf plugin add`) |
| `~/.config/landfall/plugin-data/` | what plugins keep per server, e.g. Trivy's last scan summaries |
| `~/.ssh/landfall_<name>` | generated keys |
| `~/.ssh/config` | `Host <name>` blocks between `# >>> landfall:<name>` markers |
| `./.landfall.json` | per-project deploy settings (keys below) |

| env var | effect |
|---|---|
| `LANDFALL_CONFIG_DIR` | use another directory than `~/.config/landfall` |
| `XDG_CONFIG_HOME` | without `LANDFALL_CONFIG_DIR`: the config lives in `$XDG_CONFIG_HOME/landfall` |
| `LANDFALL_NO_PLUGINS` | `1` skips your plugins (the built-in ones still load) |
| `LANDFALL_ENV` | the environment of `.landfall.json` to work on, as `-E` |
| `LANDFALL_SSH_CONFIG` | use another ssh config file (`ssh -F`) |
| `LANDFALL_PASSWORD` | login password for `setup`/`server add`/`deploy --host` |
| `LANDFALL_SECRET_<OPTION>` | value of a `--…password` option, e.g. `LANDFALL_SECRET_PASSWORD` for `lf auth` |

### `.landfall.json`

The first `lf deploy` writes it; later deploys update it from their flags. Every key but `name` and `domains` is
optional.

| key | meaning |
|---|---|
| `name` | the site name |
| `server` | the server to deploy to (`-s`) |
| `domains` | the site's domains; empty means the default (`<site>.<main domain>` or sslip.io) |
| `compose` | the compose file to deploy (default: `compose.yaml`, or the one `docker compose` would pick) |
| `dir` | without a compose file: the static folder or Dockerfile folder to deploy |
| `static` / `spa` | serve the folder as static files / with an SPA fallback to `index.html` |
| `image` / `port` | run a prebuilt image / the port Traefik routes to |
| `build` | static: runs locally before the upload. An app: runs on the server, in its image |
| `start` | an app without a Dockerfile: its start command (default: the framework's) |
| `volumes` | app, Dockerfile or image: folders in the container that outlive deploys |
| `worker` | app, Dockerfile or image: runs without a port or a domain |
| `gitignore` | leave out of the upload what the folder's `.gitignore` files ignore |
| `exclude` / `include` | more to leave out / to send anyway, in `.gitignore` syntax |
| `buildLocal` | build images on this machine and send them; the server only runs them |
| `environments` | named targets like `staging`: any of the keys above that differ. The name defaults to `<name>-<env>`; domains are never inherited. Pick one with `-E` or `$LANDFALL_ENV` |

```json
{
  "name": "blog",
  "server": "vps",
  "domains": ["blog.example.com"],
  "environments": { "staging": { "domains": ["staging.blog.example.com"] } }
}
```

### On the server

```
/opt/landfall/
  traefik/docker-compose.yml        Traefik, ports 80/443 (+443/udp for HTTP/3), Let's Encrypt (HTTP-01)
  traefik/letsencrypt/acme.json
  proxy.env                         only with `lf traefik use`
  README                            how to run sites by hand
  sites/<name>/
    site.json                       metadata + release history
    .env                            the site's variables (0600)
    .secrets/<NAME>                 secret files from `lf secret` (folder 0700)
    releases/<id>/                  last 5 kept
      compose.yaml                  yours, or generated for static/Dockerfile/image
      compose.override.yaml         written by landfall: project name, Traefik labels, networks
      .env -> ../../.env
      .secrets -> ../../.secrets
    current -> releases/<id>
    volumes/<volume>/               volumes kept as folders (see Volumes and backups)
    backups/                        `lf volume backup` archives and backup.log
    backup.sh                       only with `lf volume backup --schedule`
  journal.log                       every change, with the shell that reverts it
/etc/ssh/sshd_config.d/00-landfall.conf   ssh hardening from `lf setup`
```

`lf setup` also installs Docker with the compose plugin, rsync, ufw (only where setup turns it on), fail2ban (only where ssh passwords stay on) and unattended-upgrades, and creates the
`deploy` user (group docker). Before changing a file, landfall keeps a backup next to it as
`.<file>.landfall-<run>` (the newest 10). `lf config` and the web UI's *Overview* list all of these places.

`cd -P /opt/landfall/sites/blog/current && docker compose ps` works as usual.
