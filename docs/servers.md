# Servers

Prepare a server for landfall, register servers you already have, and look after them.

## Prepare a server

### A fresh server (only a root password)

```sh
lf setup vps --host 203.0.113.7
```

1. Creates `~/.ssh/landfall_vps` and installs it with `ssh-copy-id`. You type the root password once.
2. Installs Docker, rsync, ufw (allowing ssh, 80 and 443, plus 443/udp for HTTP/3) and unattended-upgrades.
   That is on apt (Ubuntu, Debian). Alpine gets ufw; dnf, yum and zypper systems get Docker and
   rsync, since their base repositories have no ufw or fail2ban.
   fail2ban is installed on apt only where ssh passwords stay on (`--no-harden`). With keys only there is nothing to guess.
   `lf harden fail2ban` installs it later.
   On AWS, Google Cloud, Azure, Oracle Cloud and Alibaba Cloud it leaves ufw out: see [Cloud providers](#cloud-providers).
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
| `--host-network` | run Traefik on the host network (remembered), see [Traefik](traefik.md) |
| `--no-http3` | Traefik without HTTP/3 on 443/udp (remembered), see [Traefik](traefik.md) |
| `--no-firewall` / `--no-harden` / `--no-traefik` / `--no-ssh-config` | skip a step |
| `--firewall` | install and enable ufw even behind a provider firewall |
| `--check` / `--key-only` / `--force` | report only / install only the key / apply despite conflicts |

On a first Traefik install, setup asks for the image, host network, e-mail and dashboard in a terminal. `-y`
takes the defaults. The e-mail is optional, because Let's Encrypt no longer sends expiry mails.

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
lf prune                                                # remove unused images, the build cache and unused networks (--all: unused tagged images too)
lf prune --logs                                         # also empty container logs and shrink the systemd journal to 100M
lf prune --volumes                                      # also delete volumes no site owns and removed sites' backups
lf reboot                                               # reboot, wait until it is back, check its containers run again
```

`stats` samples the server for one second over ssh; nothing runs on the server between calls. CPU of a
process counts one core as 100%. `disk` adds up folders, so it takes a few seconds on a full disk; without
root or passwordless sudo, root-owned folders and container logs may be missing.

`prune` keeps images any container uses (stopped ones too), images built for a site release (rollback runs
them without rebuilding) and images an undo in the journal puts back. Containers stay, and so does landfall's
proxy network while nothing is on it. `--dry-run` shows what would go. `--logs` also empties every container's log (the live file is truncated, rotated ones are
deleted) and shrinks the systemd journal to its newest 100M; it needs root or passwordless sudo, else root's key login.
`--volumes` deletes volumes no container mounts (stopped ones count), except those of a site that still exists:
`lf sites rm` keeps a site's volumes, and they go here once the site is gone. Their data cannot be brought back,
so it asks you to type the server name (`-y` skips that).

### Cloud providers

landfall reads the provider from the server's hardware strings (`/sys/class/dmi/id`). It sends no request and
installs nothing for that. `lf setup` and `lf server info` show the provider.

| provider | firewall in front | setup |
|---|---|---|
| AWS (EC2, Lightsail) | security group | no ufw |
| Google Cloud | VPC firewall | no ufw |
| Azure | network security group | no ufw |
| Oracle Cloud | security list | no ufw |
| Alibaba Cloud | security group | no ufw |
| Hetzner, DigitalOcean, Vultr, Akamai (Linode), Scaleway, UpCloud | only if you add one | ufw as usual |

Where the provider's firewall is always in front, it is closed until you open a port. ufw would repeat its rules,
so setup does not install it. Open 80 and 443 (and 443/udp for HTTP/3) in the provider's console: landfall cannot
do that from the server.

```sh
lf setup vps --firewall     # install and enable ufw anyway
lf firewall enable -s vps   # or later
```

Set the provider yourself where landfall reads it wrong or not at all. landfall remembers it for the server.
`lf security` and `lf server info` use it too.

```sh
lf setup vps --cloud aws         # treat it as AWS: no ufw
lf setup vps --cloud none        # no provider: ufw as usual
lf setup vps --cloud auto        # forget the setting and detect again
lf server add vps --cloud aws    # the same, without running setup
```

In the web UI, the setup dialog has the same choice as "Provider".

The names are `aws`, `gcp`, `azure`, `oracle`, `alibaba`, `hetzner`, `digitalocean`, `vultr`, `linode`, `scaleway` and `upcloud`.

### What setup leaves on the server

landfall keeps its own footprint small:

- No agent and no landfall binary. `/opt/landfall` holds plain files: Compose projects, Traefik, the journal, a README.
- Packages: Docker, rsync, curl and ca-certificates, plus ufw, fail2ban and unattended-upgrades where they apply.
  ufw is only installed where setup turns it on. fail2ban is only installed where ssh passwords stay on.
- On apt, landfall empties the package cache (`apt-get clean`) after it installs something.
- A deploy keeps the newest 5 releases of a site (`--keep`), removes untagged images and trims the build cache.
- File backups made for `lf undo` are capped at 10 per file.
- `lf prune` shows and frees what is left: unused images, build cache, old logs.

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
