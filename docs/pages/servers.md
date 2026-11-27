# Servers

Prepare servers, register existing ones, and look after them.

## Prepare a server

### A fresh server (only a root password)

```sh
lf setup vps --host 203.0.113.7   # asks the root password once
```

1. Creates `~/.ssh/landfall_vps` and installs it with `ssh-copy-id`.
2. Installs packages (see [Packages by system](#packages-by-system)).
3. Creates user `deploy` (docker group) and disables ssh password login. Root keeps key-only access.
4. Writes `Host vps` to `~/.ssh/config` (created if needed). `ssh vps` now logs in as `deploy`.
5. Starts Traefik, which gets Let's Encrypt certificates for every site.

Setup shows its changes and asks once (`-y` skips this). It checks key login **before** turning off passwords, so a failed key can't lock you out.

#### Packages by system

- apt (Ubuntu, Debian): Docker, rsync, ufw and unattended-upgrades. ufw allows ssh, 80, 443 and 443/udp (HTTP/3).
- Alpine: Docker, rsync and ufw.
- dnf, yum, zypper: Docker and rsync. Their base repositories have no ufw or fail2ban.
- fail2ban: apt only, where ssh passwords stay on (`--no-harden`); with keys only there is nothing to guess. Add it later with `lf harden fail2ban`.
- AWS, Google Cloud, Azure, Oracle Cloud, Alibaba Cloud: no ufw (see [Cloud providers](#cloud-providers)).

#### Deploy without setting up first

`lf deploy` sets up a new server first, then deploys.

```sh
lf deploy -s vps --host 203.0.113.7     # asks the root password (--password-stdin, $LANDFALL_PASSWORD)
```

Without `--host`, it offers setup when a configured server isn't set up (or takes no key yet).

### A server you already reach with `ssh vps`

```sh
lf setup vps --check        # what is there, what would change
lf setup vps
```

landfall reads host, user, port and key from `ssh -G` and keeps a working key. It prints done (`✓`), to do (`→`) and refused (`!`).

Setup skips a step when:

- **Firewall:** ufw is off, and enabling it would block a listening public port (Postgres on 5432, WireGuard on 51820/udp, …).
  Docker-published ports stay reachable (Docker's NAT bypasses ufw), unless Docker uses nftables or lacks IPv6 NAT: then setup skips the firewall too.
- **ssh hardening:** other users still log in with a password, or sshd refuses keys (`PubkeyAuthentication no`).
  Settings come from `sshd -T`, so `Include` files such as `/etc/ssh/sshd_config.d/*.conf` count.
  Afterwards setup rechecks and reports a drop-in that turns passwords back on.
- **Traefik:** something other than landfall's `traefik` holds 80/443. For your own Traefik, setup offers `lf traefik use`.

- Stopped Docker gets started. An existing Docker is never reinstalled.
- A missing compose, or the old v1 `docker-compose`, is replaced with the newest release.
- Existing sites are never touched.
- In a terminal, setup asks about each conflict (default no). `-y` never accepts a conflict; only `--force` does.

Rerunning setup is safe. If hardening removed root's key login, it logs in as the first run's sudo user.
`--dashboard-user` and `--email` are checked before anything changes.

### Minimal setup: Docker only, no Traefik

Minimal setup ensures Docker runs and creates `/opt/landfall` and the Docker network. No Traefik, deploy user,
packages, firewall or sshd changes. landfall logs in as the user you gave it.

```sh
lf setup vps --minimal --check   # report only
lf setup vps --minimal           # Docker only if missing
lf setup vps --minimal --harden  # minimal, plus key-only ssh
lf setup vps                     # later: full setup
lf traefik setup -s vps          # later: only Traefik
```

Without Traefik, sites get no domain and `lf deploy` asks for none. Use a tunnel:

```sh
lf tunnel my-site                # site on a local port, over ssh
lf tunnel postgres --port 5432   # any container or Compose project
```

`-d` still works, with a warning that nothing answers until Traefik runs.

### Setup flags

| flag | effect |
|---|---|
| `-u admin` / `-p 2222` | log in as `admin` (needs sudo) / ssh port |
| `-K` | ask for the login's sudo password (or set `$LANDFALL_SUDO_PASSWORD`) |
| `-i ~/.ssh/id_ed25519` | use an existing key instead of generating one |
| `--password-stdin` | read the login password from stdin (or set `$LANDFALL_PASSWORD`) |
| `--deploy-user ""` | deploy as the login user instead of creating `deploy` |
| `--domain example.com` | primary main domain |
| `--staging` / `--no-staging` | use Let's Encrypt's staging CA while testing (remembered) |
| `--dashboard traefik.example.com` | Traefik dashboard behind basic auth (`traefik` alone means `traefik.<main domain>`) |
| `--image traefik:v3.5` | Traefik image (remembered, default `traefik:v3`) |
| `--host-network` | run Traefik on the host network (remembered), see [Traefik](traefik.md) |
| `--no-http3` | Traefik without HTTP/3 on 443/udp (remembered), see [Traefik](traefik.md) |
| `--no-firewall` / `--no-harden` / `--no-traefik` / `--no-ssh-config` | skip a step |
| `--firewall` | install and enable ufw even behind a provider firewall |
| `--minimal` | only Docker and `/opt/landfall` (see [Minimal setup](#minimal-setup-docker-only-no-traefik)) |
| `--check` / `--key-only` / `--force` | report only / install only the key / apply despite conflicts |

With `--minimal`, a part's own flag turns it back on: `--harden`, `--firewall`, `--traefik`, `--deploy-user deploy`.

On a first Traefik install in a terminal, setup asks for image, host network, e-mail and dashboard (`-y`: defaults).
The e-mail is optional: Let's Encrypt no longer sends expiry mails.

## Managing servers

### Register and configure

```sh
lf server add vps                                       # register an existing ssh alias
lf server add box --host 198.51.100.4 -u ubuntu -i ~/.ssh/box --default
lf server add web --host 198.51.100.5 -u admin          # asks the password once, installs ~/.ssh/landfall_web
lf server config vps                                    # show entry, Traefik settings, ssh login, keys, Host block
lf server list --all --check                            # which servers accept a login now
lf server use vps
lf config --tunnel-only --keep 3                        # defaults for all servers; also lists landfall's paths
lf server rm vps                                        # forget locally
lf server uninstall vps                                 # remove landfall from the server (type the name)
lf ssh vps -- docker ps
lf reboot                                               # reboot, wait, check containers run again
```

`lf server uninstall` refuses while the server has tenants. Run `lf tenant off --rm-tenants` first, then
`lf tenant rm <user> --purge` for each (see [Tenants](tenants.md#turn-tenants-off)).

### What `server add` changes

Nothing on the server. It writes a `Host <name>` block between `# >>> landfall:<name>` markers
(`--no-ssh-config`: keep details in landfall's config instead).

In your own Host block, landfall acts only when the key fails: it puts the working `IdentityFile` first, drops
lines whose file is gone, and backs up to `~/.ssh/config.landfall-bak`.

### Usage and disk space

```sh
lf stats                 # CPU, memory, disks, network, top processes, per-container usage
lf stats blog -w         # one site's containers, refreshed every 5s (--interval)
lf disk                  # space by images, volumes, build cache, sites, container logs
```

With [tenants](/tenants), `stats` also shows each tenant's CPU and memory against its limits. A tenant sees only its own.
`stats` samples one second over ssh; nothing runs on the server between calls. One core = 100% process CPU.
`disk` adds up folders, so a full disk takes seconds. Without root or passwordless sudo, it may miss root-owned folders and container logs.

### Prune

```sh
lf prune                 # remove unused images, build cache, unused networks (--all: unused tagged images too)
lf prune --dry-run       # show what would go
lf prune --logs          # also empty container logs; keep the systemd journal's newest 100M
lf prune --volumes       # also volumes no site owns and removed sites' backups
```

`prune` keeps containers, landfall's proxy network (even when empty), images any container uses (stopped too),
images built for a site release (rollback runs them without rebuilding) and images a journal undo puts back.

`--logs` truncates live container logs and deletes rotated ones. It needs root, passwordless sudo or root's key login.

`--volumes` deletes volumes no container mounts (stopped ones count), except an existing site's.
`lf sites rm` keeps a site's volumes; they go here. The data is lost for good, so you type the server name (`-y` skips).

### Cloud providers

landfall reads the provider from `/sys/class/dmi/id`, with no request and nothing installed. `lf setup` and `lf server info` show it.

These always have a firewall in front, closed until you open a port, so setup skips ufw:

- AWS (EC2, Lightsail): security group
- Google Cloud: VPC firewall
- Azure: network security group
- Oracle Cloud: security list
- Alibaba Cloud: security group

Open 80, 443 and 443/udp (HTTP/3) in the provider's console; landfall can't from the server.

Hetzner, DigitalOcean, Vultr, Akamai (Linode), Scaleway and UpCloud have one only if you add it; setup installs ufw.

```sh
lf setup vps --firewall     # install and enable ufw anyway
lf firewall enable -s vps   # or later
```

#### Set the provider yourself

Use when detection is wrong or empty. It is remembered per server; `lf security` and `lf server info` use it too.

```sh
lf setup vps --cloud aws         # treat it as AWS: no ufw
lf setup vps --cloud none        # no provider: ufw
lf setup vps --cloud auto        # detect again
lf server add vps --cloud aws    # the same, without running setup
lf server config vps --cloud aws # the same, offline, for a known server
```

Names: `aws`, `gcp`, `azure`, `oracle`, `alibaba`, `hetzner`, `digitalocean`, `vultr`, `linode`, `scaleway`, `upcloud`.

In the web UI:

- Set it from the provider in the server's header, Change in Settings, or "Provider" in the setup dialog.
- The server's list links to the provider's console.
- Behind a provider firewall, the Firewall section is called Host firewall and lists ports to open there.

### What setup leaves on the server

- No agent or binary. `/opt/landfall` holds plain files: Compose projects, Traefik, the journal, a README.
- `/opt/landfall/landfall.json` names the newest landfall that changed the server and the upgrades it has. `lf server info` shows it; `lf server upgrade` brings the server up to date ([Servers and landfall versions](updates.md#servers-and-landfall-versions)).
- Packages: Docker, rsync, curl, ca-certificates; ufw, fail2ban, unattended-upgrades where they apply ([Packages by system](#packages-by-system)).
- On apt, `apt-get clean` runs after each install.
- A deploy keeps the newest 5 releases of a site (`--keep`), removes untagged images and trims the build cache.
- File backups for `lf undo` are capped at 10 per file.
- `lf prune` frees the rest.

### NAS, Steam Deck and other systems without a package manager

Systems without apt, dnf, yum, apk or zypper (Synology DSM, SteamOS, …): `lf setup` refuses (`--check` and
`--key-only` work). Register them with `lf server add` and deploy as is. `lf server info` shows what works, and why not:

```
login    root · root or sudo
init     systemd
docker   24.0.2 · compose 2.20.1
firewall DSM has its own firewall: Control Panel → Security → Firewall
```

- Synology: Docker comes from Container Manager in Package Center, so `lf update --compose` leaves it alone.
  landfall refuses to change host name, time zone, swap or Docker's settings (Control Panel owns them); DSM's firewall replaces ufw.
- SteamOS: install Docker in your home directory (landfall does not run podman).
- Without passwordless sudo, a login can deploy but not change the system.
- The web UI hides tabs and actions that don't work there.
- landfall adds `/usr/local/sbin` and `/usr/local/bin` to `PATH`: non-interactive ssh often lacks them (DSM keeps `docker` there).

### Root login

fail2ban, firewall, updates, users and `lf undo` need root. Without passwordless sudo, landfall tries in order:

1. the Host set with `lf server config --root-login`;
2. `root` with the server's own key;
3. the sudo user setup used (`admin` in landfall's config);
4. other `~/.ssh/config` Hosts with the same HostName and port, root first.

A second Host block for root is enough:

```
Host vps
  HostName 203.0.113.7
  User deploy
Host vps-root
  HostName 203.0.113.7
  User root
  IdentityFile ~/.ssh/vps_root
```

```sh
lf server config vps --root-login vps-root   # use vps-root for root work (tests it once)
lf server config vps --root-login auto       # back to the order above
```

Web UI: Change next to *root work* in the server's Settings lists Hosts that reach the same machine.

### Sudo with a password

Give a sudo password once per command:

```sh
lf setup vps -u anna -K          # asks for anna's sudo password
lf harden vps -K                 # works on any command
LANDFALL_SUDO_PASSWORD=… lf reboot vps -y   # without a terminal
```

- A terminal prompts by itself when root work has no other way. The web UI offers **Give the sudo password** and reruns.
- It stays in memory for that command, never in config, journal or log.
- It travels in the script on ssh's stdin, never in a command line. An askpass helper (no secret, removed at the end) hands it to `sudo`.

Before root work, landfall says how: `runs as root: sudo as anna`, or the root login. Setup checks this first;
without root, passwordless sudo or `-K`, it stops and names the options.

### Docker access is root

Deploys need only the `docker` group. That group is root in all but name: a member can mount `/` in a container and
change any file. Guard the deploy user's key like root's.

A separate deploy user still helps: without a sudo password it can't install packages or change sshd or the firewall,
and `lf history` shows its actions under its name.

To let someone deploy without that power, make them a [tenant](tenants.md) instead: a user with its own rootless
Docker, sites and Traefik, limited to the domains you give it.
