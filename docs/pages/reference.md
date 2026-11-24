# Reference

Every command, file and environment variable. `lf <command> --help` prints one command's options.

## Command reference

- `[name]`: an optional site or server, defaulting as in [Concepts](index.md#concepts).
- Most site and server commands take `-s <server>`.
- Every command takes `-y` (yes to prompts), `-h`, `-E <env>` (a `.landfall.json` environment) and `-K` (ask for the sudo password once).
- Boolean options have a `--no-` form (`--no-harden`).
- *Undoable*: `lf undo` reverts it.

**Servers** (see [Servers](servers.md), [Server administration](system.md))

| command | what it does |
|---|---|
| `lf setup <name> [--host ip] [-u user] [-p port] [-i key] [--password-stdin]` | Makes a deploy target: ssh key, Docker, ufw, deploy user, ssh hardening, Traefik. Idempotent. fail2ban only where ssh passwords stay on (`--no-harden`). No ufw behind a cloud firewall unless `--firewall`; `--cloud <provider>` fixes detection. |
| `lf setup <name> [--deploy-user u] [--email e] [--domain d] [--no-harden] [--no-firewall] [--no-traefik] [--no-ssh-config] [--staging] [--dashboard host] [--image img] [--host-network] [--no-http3] [--force]` | `--deploy-user`: default `deploy`, empty keeps the login. `--domain`: main domain. Traefik options as `lf traefik setup`. `--force`: firewall and hardening despite conflicts. |
| `lf setup <name> --minimal` | Only Docker and `/opt/landfall`. Sites get no domain; `lf tunnel` reaches them. |
| `lf setup <name> --check` | Reports what setup would change. Changes nothing. |
| `lf setup <name> --key-only` | Only installs landfall's ssh key. |
| `lf server add <name> [--host ip] [-u user] [-p port] [-i key] [--password-stdin] [--domain d] [--email e] [--cloud provider] [--no-ssh-config] [--default]` | Registers a server, installs nothing. Writes `Host <name>` to `~/.ssh/config`. |
| `lf server list [-a] [-c] [--json]` | Registered servers. `--all` adds ssh aliases except git hosts (github.com, `gitlab.*`, `User git` …). `--check` tries a key login: `ok`, `login` (key refused) or `down`. Alias: `servers`. |
| `lf server info [name] [--json]` | OS and release support, kernel, uptime, CPU, RAM, disk, addresses, containers. Alias: `info`. |
| `lf stats [site] [-w] [--interval 5] [--json]` | Live CPU, memory, swap, disks, network, top processes, per-container usage and restarts. A site limits it to its containers. `-w` refreshes every `--interval` seconds. Alias: `server stats`. |
| `lf disk [--json]` | Disk use: filesystems, Docker images, containers, volumes, build cache (reclaimable), sites and releases, largest volumes and logs, systemd journal. Alias: `server disk`. |
| `lf traffic [site] [--since 24h] [--json]` | Requests, 4xx/5xx, median and 95% response time, bytes per site, from Traefik's access log. A site or host adds requests per minute/hour, top paths, failures, clients. Alias: `server traffic`. |
| `lf certs [--since 7d] [--json]` | Certificates per domain (days left, expiry, issuer, staging), Traefik's others, recent certificate errors. Alias: `server certs`. |
| `lf check [site\|domain…] [--resolve ip[:port]] [--json]` | HTTPS request from here: status, response time, certificate trust, days left. Exits 1 on failure. Domains need no server. Alias: `sites check`. |
| `lf prune [--all] [--logs] [--volumes] [--dry-run] [--json]` | Removes unused images, build cache and networks. Keeps images in use (stopped containers too), for rollback, and for undo. `--all`: also unused tagged images (pulled again when needed) and all build cache. `--logs`: empties container logs, shrinks the journal to 100M (root). `--volumes`: volumes no container or site uses, and backups of removed sites. Journaled, not undoable. Alias: `server prune`. |
| `lf reboot [--timeout 300]` | Reboots (root or passwordless sudo), waits `--timeout` seconds for ssh, checks containers came back. Alias: `server reboot`. |
| `lf system [--json]` | Host name, time zone, clock sync, swap, Docker log limit, services, SSH keys, fail2ban bans, with hints (no swap, unlimited logs). Alias: `server system`. |
| `lf services [--all] [--json]` | Services landfall needs, and failed ones; `--all` every one. systemd or OpenRC. Alias: `services ls`. |
| `lf services restart\|start\|stop <service> [--force]` | ssh needs `--force`; docker asks first. Start and stop are undoable. |
| `lf services logs <service> [-f] [-n 100]` | journald, else the log file. |
| `lf keys [--json]` | Keys in `authorized_keys` of root and `/home/*`. ★ marks this machine's key. Alias: `keys ls`. |
| `lf keys add [key\|file.pub] [-u user] [--generate]` | Adds a public key (default: login user). `--generate` makes a pair at `~/.ssh/<server>_<user>`. Undoable. |
| `lf keys rm <fingerprint\|comment> [-u user] [--force]` | By comment or fingerprint prefix. This machine's key needs `--force`. Undoable. |
| `lf security [--json]` | Checks ssh password/root login, firewall, fail2ban, auto updates, pending reboot; names each fix. |
| `lf harden [ssh\|fail2ban\|updates…] [--force]` | ssh passwords off, fail2ban on, automatic security updates on; all three by default. Locking out password-only users needs `--force`. Undoable. |
| `lf users [--json]` | Root and uid 1000+ accounts: sudo (passwordless?), password set/locked/none, keys, shell. ★ marks landfall's login. Alias: `users ls`. |
| `lf users add <name> [-k key\|file.pub] [--generate-key] [-p pw \| --password-stdin] [--sudo [--nopasswd]] [--shell s]` | Adds an account with a home, given a key, new pair or password. Undoable. |
| `lf users rm <name> [--keep-home]` | Removes an account and its home. Refuses root, landfall's and the admin login. Not undoable. |
| `lf users passwd <name> [-p pw \| --password-stdin \| --generate \| --remove]` | Sets (asked twice), generates or removes a password. Not undoable. Alias: `users password`. |
| `lf users sudo <name> [--nopasswd \| --off]` | Grants sudo via `/etc/sudoers.d/landfall-<name>`; `--off` removes it and the sudo/wheel groups. Undoable. |
| `lf swap [size\|off] [--json]` | Shows, adds (`/swapfile`, min 64M, keeps 2 GB disk free) or removes swap. Adding is undoable. Alias: `server swap`. |
| `lf hostname [name]` | Shows or sets it (and `/etc/hosts`). Undoable. Alias: `server hostname`. |
| `lf timezone [zone]` | Shows or sets it, e.g. `Europe/Berlin`. Undoable. Alias: `server timezone`. |
| `lf log-limit [size\|off] [--files 3] [--restart] [--json]` | Docker's per-container log limit in `daemon.json`. `--restart` applies it now. Undoable. |
| `lf server config [name] [--json]` | All landfall and ssh settings for a server. Does not connect. |
| `lf server config [name] --cloud <provider\|none\|auto>` | Remembers the cloud provider. `none`: none. `auto`: detect again. |
| `lf server config [name] --root-login <ssh-alias\|auto>` | An `~/.ssh/config` Host to the same machine for root work, when the login lacks passwordless sudo. `auto` forgets it. |
| `lf server domain [name] [domain...] [-a d] [--primary d] [--rm d] [--clear] [--tunnel-only] [--json]` | Main domains (first is primary), DNS-checked. `--tunnel-only`: new sites get no domain. |
| `lf server use <name>` | Sets the default server. |
| `lf config [--tunnel-only] [--email e] [--keep n] [--default name] [--unset key] [--json]` | Defaults for all servers (a server's own wins), and every place landfall writes. |
| `lf server rm <name> [--ssh-config]` | Forgets a server locally. `--ssh-config` also removes its `Host` block. |
| `lf server uninstall <name> [--volumes] [--keep-setup] [--force]` | Deletes sites, Traefik and `/opt/landfall`, reverts setup (deploy user, hardening, firewall), forgets the server. Docker, packages, root's key and adopted sites stay. Alias: `uninstall`. |
| `lf ssh [name] [-- cmd]` | Shell, or one command. |
| `lf keygen <name>` | Creates `~/.ssh/landfall_<name>` and prints the public key. |

**Sites** (see [Deploy a site](deploy.md), [Day-to-day](sites.md), [Volumes and backups](volumes.md))

| command | what it does |
|---|---|
| `lf init [dir] [--postgres] [--port n]` | Writes `compose.yaml` and `compose.override.yaml` to run locally and deploy. |
| `lf deploy [dir] [-d domain...] [--no-domain] [-n name] [-f file] [-b cmd] [--start cmd] [--volume path...] [--worker] [--spa] [--image img [--send-image]] [--port n] [-e K=V] [--dotenv f\|-] [--local-env] [--fill-volumes] [--build-local] [--static] [--gitignore] [--keep n] [--redirect host...] [--no-redirect] [--no-save] [--auth-user u] [--auth-password p] [--host ip [-u user] [--ssh-port p] [--password-stdin]] [--skip-hook name...] [--skip-hooks]` | Deploys a Compose project, app (Node.js, Bun, Deno, Python, Go, Rust, Java, .NET, Ruby, PHP, Elixir), static folder, Dockerfile or image. Sets the server up if needed. Runs [hooks](hooks.md). `--no-save`: no `.landfall.json`. `--redirect`: the site's redirect hosts, as `lf domains --redirect`; `--no-redirect` removes them. `--auth-user`: a login, as `lf auth`. |
| `lf ls [--json] [--others]` | Sites and status, plus other containers Traefik routes (read only). `--json --others` gives `{sites, others}`. Alias: `sites list`. |
| `lf sites info [name] [--json]` | Services, domains, release history. |
| `lf domains [name] [-a d] [--rm d] [--set d] [--redirect d] [--json]` | Domains and redirects with DNS and HTTPS state, or changes them. No domains: unrouted. `--redirect www`: www.<first domain> redirects to the first domain. |
| `lf auth [name] [-r route] -u user [-p pw \| --password-stdin]` / `--rm-user u` / `--off` / `-r route --public` | Basic-auth login for a site; `-r` for one route, or none. |
| `lf open [name]` | In the browser. |
| `lf logs [name] [service] [-f] [-n 100]` | All services, or one. |
| `lf env [name] [K=V...] [--dotenv f\|-] [-u K] [--reveal] [--keys] [--json] [--pull f]` | Shows `.env` (values hidden unless `--reveal`), `--pull`s it to a file, or changes it. Changes recreate services. |
| `lf secret [name] [K=V...] [--file K=path] [--dotenv f\|-] [-u K] [--json] [--force]` | Lists or changes secret files, read at `/run/secrets/<K>`. Changes restart services using them. |
| `lf rollback [name] [--to id] [--skip-hook name...] [--skip-hooks]` | Previous release, or `--to` one. Runs `prerollback`/`postrollback` [hooks](hooks.md). |
| `lf release rm [name] [id…] [--keep n]` | Deletes the given releases and their images, else all but `--keep n` newest. The live one stays. Journaled, not undoable. Alias: `releases rm`. |
| `lf restart` / `stop` / `start [name] [service]` | The site, or one service. |
| `lf tunnel [name] [service\|private] [--port p] [-l local] [--lan]` | SSH tunnel to localhost: a site, service, private port or any container. |
| `lf tunnels [--json]` | Open tunnels here. |
| `lf sites rm <name> [--volumes] [--skip-hook name...] [--skip-hooks]` | Deletes the site. Volumes and backups stay; `--volumes` deletes volumes after a backup (undoable). A failing `predestroy` [hook](hooks.md) stops it. |
| `lf volumes [name] [--json]` | Size, mounts, backups. Alias: `volume ls`. |
| `lf volume add [name] [service:]<path> [--as key]` | Keeps a container folder in a named volume, via `compose.yaml` or `.landfall.json`; `lf deploy` applies it. |
| `lf volume rm [name] <volume> [--service s] [--data]` | Unmounts it (`--service`: from one). `--data` deletes it on the server after a backup (undoable). |
| `lf volume backup [name] [volume] [--schedule hourly\|daily\|weekly\|off] [--keep n] [--offsite host:path]` | `.tar.gz` of a volume (default: all) in `backups/`; a database on it pauses. `--schedule`: cron. `--offsite`: mirror to another host. |
| `lf volume backup rm [name] <backup...>` | Not undoable. |
| `lf volume pull [name] [volume] [--into dir] [-o file] [-b file\|latest]` | Downloads a volume or backup, archived or unpacked. |
| `lf volume push [name] <volume> <folder\|file.tar.gz>` | Replaces contents with local files, after a backup. Undoable. |
| `lf volume restore [name] [volume] [backup]` | Replaces contents with a backup (default: newest), after a backup. Undoable. |
| `lf eject [name] [--network n] [--entrypoint e] [--resolver r]` | Writes Traefik labels, logins and network to `compose.traefik.yaml` for your own Traefik. Server untouched. |
| `lf adopt <project> [--name n]` | Makes your own Compose project a site. |
| `lf registries [--json]` | Registries Docker is logged in to. |
| `lf registry login <host> -u user [-p pw \| --password-stdin]` | For private images. Password: asked, `-p`, stdin or `$LANDFALL_SECRET_PASSWORD`. Undoable. |
| `lf registry logout <host>` | Not undoable. |

**Traefik, firewall, updates, history** (see [Traefik](traefik.md), [Updates](updates.md), [History and undo](history.md))

| command | what it does |
|---|---|
| `lf traefik setup [--email e] [--dashboard host\|traefik\|off] [--dashboard-user admin] [--dashboard-password p] [--staging] [--image img] [--host-network] [--no-http3] [--force]` | Installs or reconfigures Traefik. Dashboard password default: generated. `--force` overwrites hand edits. |
| `lf traefik use [container] [--network n --entrypoint e --resolver r]` | Use your own Traefik. |
| `lf traefik rm [--certs]` | Removes landfall's Traefik (undoable), or stops using yours. |
| `lf traefik dashboard [-l local] [--lan] [--port p]` | Dashboard on localhost via SSH tunnel. |
| `lf traefik status [--json]` / `logs [-f] [-n 100] [--access]` / `restart` | Container and routes, logs (`--access`: with requests), restart. `lf traefik` = `status`. |
| `lf redirects [--json]` | Server redirects with DNS and HTTPS state. Alias: `redirect ls`. |
| `lf redirect add <host> <url> [--temporary] [--no-path]` | Redirects a host to a URL, with no site behind it. Path and query are appended; `--no-path` drops them. `--temporary`: 302/307. Adding a host again changes it. Needs landfall's Traefik. Undoable. |
| `lf redirect rm <host...>` | Removes server redirects. Undoable. |
| `lf firewall [--json]` | ufw rules; reachability per listening port. |
| `lf firewall allow` / `deny <port[/proto]> [--from ip] [--comment c] [--force]` | Adds a rule. Denies go first and win. |
| `lf firewall update <n\|rule> [--port p] [--from ip] [--comment c] [--action allow\|deny\|limit] [--force]` | Changes a rule. |
| `lf firewall rm <n\|rule> [--force]` / `enable [--force]` / `disable` | Removes a rule; ufw on/off. `--force`: even if it blocks ssh (enable: ports in use). |
| `lf updates [--no-refresh] [--all] [--json]` | Pending packages, newer images, Docker/compose versions. |
| `lf update [site...] [--packages] [--security] [--reboot] [--images] [--compose]` | Image and compose updates are undoable. Alias: `upgrade`. |
| `lf scan [site...] [--all] [--fixable] [--no-others] [--json] [--remove]` | Trivy vulnerability scan of running images, with fixes. |
| `lf history [-n 20] [--json]` | Changes, run by run. Alias: `log`. |
| `lf undo [n \| n.m] [--all] [--force]` | The latest run, run `n`, step `n.m`, or all. Refuses when a later run changed the same site or file, unless `--force`. Alias: `revert`. |

**Web UI** (see [Web UI](web-ui.md))

| command | what it does |
|---|---|
| `lf ui [-p 4777] [--no-open]` | On 127.0.0.1 (next free port if taken); prints a login link. Alias: `web`. |

**Plugins** (see [Plugins](plugins.md))

| command | what it does |
|---|---|
| `lf plugins [--json]` | Built-in and `~/.config/landfall/plugins`: commands, UI section, load errors. |
| `lf plugin add <file\|folder> [--force]` | A `.mjs`/`.js` file, or folder with `index.mjs` or package.json `main`. Checked by loading. `--force` replaces one. |
| `lf plugin rm <name>` | Also `~/.config/landfall/plugin-data/<name>`. Built-ins stay. |
| `lf plugin new <name> [--out file]` | Starter plugin: a command and a UI section. |
| `lf fail2ban [--json]` | Jails (ban time, find time, max retries), banned IPs. Alias: `bans`. |
| `lf fail2ban ban <ip> [--jail sshd]` | Bans an IP now. Undo unbans it. |
| `lf fail2ban unban <ip>` | In every jail. Undo bans it again. Alias: `unban`. |
| `lf fail2ban config <jail> [--bantime t] [--findtime t] [--maxretry n]` | Writes `/etc/fail2ban/jail.d/50-landfall-<jail>.local`, reloads. Undo restores it. |
| `lf fail2ban install` | With an sshd jail, as `lf harden fail2ban`. |
| `lf trivy [--json]` | Trivy's image, databases, last scan summaries. |
| `lf trivy images [site...] [--no-others] [--json]` | Scans running images, keeps a summary (`lf scan` for details). Alias: `trivy scan`. |
| `lf trivy files [site...] [--json]` | Current releases: secrets, misconfigurations. Skips `.env`, `node_modules`, `.git`. |
| `lf trivy rm` | Removes image and databases (next scan refetches). Not undoable. Alias: `trivy remove`. |
| `lf <plugin> [--json]` | A plugin's UI section as text (`--json`: blocks), if it has no command. |

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
| `LANDFALL_CONFIG_DIR` | config directory instead of `~/.config/landfall` |
| `XDG_CONFIG_HOME` | without `LANDFALL_CONFIG_DIR`: config in `$XDG_CONFIG_HOME/landfall` |
| `LANDFALL_NO_PLUGINS` | `1` skips your plugins; built-in ones still load |
| `LANDFALL_ENV` | the `.landfall.json` environment to work on, as `-E` |
| `LANDFALL_SSH_CONFIG` | another ssh config file (`ssh -F`) |
| `LANDFALL_PASSWORD` | login password for `setup`, `server add`, `deploy --host` |
| `LANDFALL_SUDO_PASSWORD` | the login's sudo password for root work, as `-K`; kept in memory only |
| `LANDFALL_SECRET_<OPTION>` | value of a `--…password` option, e.g. `LANDFALL_SECRET_PASSWORD` for `lf auth`, `LANDFALL_SECRET_DASHBOARD_PASSWORD` for `lf traefik setup` |
| `NO_COLOR` | any value turns off colored output |

### `.landfall.json`

- The first `lf deploy` writes it. Later deploys update it from their flags.
- Every key but `name` and `domains` is optional.
- Any key can also live in `package.json` under `"landfall"`, next to the [hooks](hooks.md).
- `.landfall.json` wins for a key both files set.
- A deploy writes to `.landfall.json` only the keys that differ from `package.json`, and no file when none do.

| key | meaning |
|---|---|
| `name` | the site name |
| `server` | the server to deploy to (`-s`) |
| `domains` | the site's domains; empty means the default (`<site>.<main domain>` or sslip.io) |
| `redirects` | hosts that redirect permanently to the first domain (`www` = www.<first domain>); not inherited by environments |
| `compose` | the compose file to deploy (default: `compose.yaml`, or the one `docker compose` would pick) |
| `dir` | without a compose file: the static folder or Dockerfile folder to deploy |
| `static` / `spa` | serve the folder as static files / with an SPA fallback to `index.html` |
| `image` / `port` | run a prebuilt image / the port Traefik routes to |
| `sendImage` | image: send it from this machine's Docker on each deploy, not pull it from a registry |
| `build` | static: runs locally before the upload. An app: runs on the server, in its image |
| `start` | an app without a Dockerfile: its start command (default: the framework's) |
| `volumes` | app, Dockerfile or image: folders in the container that outlive deploys |
| `worker` | app, Dockerfile or image: runs without a port or a domain |
| `gitignore` | leave out of the upload what the folder's `.gitignore` files ignore |
| `exclude` / `include` | more to leave out / to send anyway, in `.gitignore` syntax |
| `buildLocal` | build images on this machine and send them; the server only runs them |
| `environments` | named targets like `staging`: any keys above that differ. The name defaults to `<name>-<env>`. Domains are never inherited. Pick one with `-E` or `$LANDFALL_ENV` |

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

- `lf setup` also installs Docker with the compose plugin, rsync, ufw (only where setup turns it on), fail2ban (only where ssh passwords stay on) and unattended-upgrades.
- It creates the `deploy` user (group docker).
- Before changing a file, landfall keeps a backup next to it as `.<file>.landfall-<run>-<n>` (the newest 10).
- `lf config` and the web UI's *Overview* list all of these places.

```sh
cd -P /opt/landfall/sites/blog/current && docker compose ps   # plain Compose works as usual
```
