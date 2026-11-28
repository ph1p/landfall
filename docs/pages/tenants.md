# Tenants

Share one server between several people, each with their own sites, Docker and certificates.

A tenant is a Linux user on your server. It gets:

- its own rootless Docker, which runs as that user;
- its own folder, `/opt/landfall/tenants/<user>`, for its sites, Traefik and Docker data;
- its own Traefik, which gets the Let's Encrypt certificates for its domains;
- the domains you give it, and no others.

A tenant uses `lf` like you do: `lf server add`, `lf deploy`, `lf logs`. It cannot see other tenants' sites,
containers or files, and it has no root. Tenants are off until you add the first one.

Use tenants for people you trust a little: a client, a colleague, a side project. A tenant with a shell can still see
some things about the server and its neighbours (see [Security model](#security-model)).

## How it works

```
             :80, :443
                 │
        central Traefik (yours, host network)
         │                  │
   your sites     TCP route per tenant, still encrypted (TLS passthrough)
                            │
                 127.0.0.1:<port>  tenant's Traefik (rootless Docker)
                            │
                      tenant's sites
```

- Your Traefik keeps 80 and 443. It runs on the host network once tenants are on.
- For each tenant it has a TCP route that matches the tenant's domains by name (SNI).
- It passes those connections on still encrypted, so it never sees the tenant's traffic or keys.
- The tenant's Traefik listens on `127.0.0.1` only, on a port from 20000–20999.
- It gets certificates with the TLS-ALPN-01 challenge over 443, so it needs no port 80.
- It learns the client's real address through PROXY protocol, so access logs and `lf traffic` show real IPs.
- `*.example.com` covers every name one level below `example.com`, such as `blog.example.com`.
  It does not cover `example.com` itself, nor `a.b.example.com`. Give both if the tenant needs both.

## Requirements

`lf tenant add` checks these before it changes anything, and names what is missing:

- systemd and cgroup v2.
- `runuser` and `flock` (util-linux).
- apt or dnf. Other package managers are refused.
- Docker from `download.docker.com` (`docker-ce`). Docker from the distribution (`docker.io`, `moby-engine`) has no
  rootless extras and is refused.
- landfall's own Traefik, running. A server that uses `lf traefik use` cannot have tenants.
- A firewall: ufw active, or a provider firewall you vouch for with `--provider-firewall`.

The firewall matters because a tenant can open ports of its own. Without one, they would be reachable from anywhere.

```sh
lf firewall enable -s vps    # turn ufw on first
```

## Add a tenant (admin)

```sh
lf tenant add anna -s vps --key ~/anna.pub --domain anna.dev --domain '*.anna.dev'   # create the tenant
lf tenant add bob -s vps --key "ssh-ed25519 AAAA… bob@laptop" --domain bob.example.com --memory 2G --cpu 200%
lf tenant add carl -s box --key ~/carl.pub --domain carl.dev --provider-firewall   # no ufw: the provider's firewall keeps ports closed
```

- `--key` is a public key line or a `.pub` file. It is the tenant's only way in: the user has no password.
- `--domain` repeats. A tenant needs at least one. Tenants' domains cannot overlap. A domain one of your sites
  uses cannot go to a tenant, and neither can a wildcard that covers one (`*.x.dev` when a site uses `sub.x.dev`).
- `--port` picks the tenant Traefik's local port. The default is the first free one from 20000–20999.
- `--memory`, `--cpu` and `--tasks` set limits (see [Limits](#limits)).
- The name is lowercase letters, digits, `_` and `-`, up to 31 characters. `root` and `state` are taken.
- An existing user, or one in the `docker` group, is refused.

Then point the tenant's domains at the server (an `A`/`AAAA` record, or a wildcard record for `*.anna.dev`), and send
the tenant its invite.

### Invite the tenant

```sh
lf tenant invite anna -s vps                         # what to send anna
lf tenant invite anna -s vps | pbcopy                # straight to the clipboard (macOS)
lf tenant invite anna -s vps --host vps.example.com  # a name instead of the address in your ssh config
```

The invite is plain text, in five steps:

1. Install lf.
2. Add the server: an `lf server add` line, or a `~/.ssh/config` block with `Host`, `HostName`, `Port`, `User` and
   `IdentityFile`.
3. Start its own Traefik with `lf traefik setup`.
4. The DNS records for each of its domains.
5. A first `lf deploy`, under its wildcard domain if it has one.

It also names the tenant's open ports and whether cron is off. The key path in it is a guess
(`~/.ssh/id_ed25519`): the tenant uses the private half of the key given with `--key`.

### What the first tenant changes

The first `lf tenant add` on a server prepares it. It shows this and asks first. `-y` does not answer that question: without a terminal, pass `--force`.

1. Records the server's state before tenants in `/opt/landfall/tenants/state.json` (root only).
2. Installs the packages rootless Docker needs: `docker-ce-rootless-extras` and `slirp4netns`, plus `uidmap` and
   `dbus-user-session` on apt, or `shadow-utils` on dnf.
3. Where AppArmor restricts user namespaces (Ubuntu 24.04 and later), writes `/etc/apparmor.d/landfall-rootlesskit`.
4. Writes `/etc/systemd/system/user@.service.d/landfall-delegate.conf`, so limits per user work.
5. Closes `/opt/landfall` to other users: they may enter it, but only `tenants/` is open to them.
6. With ufw, allows 80/tcp, 443/tcp and 443/udp explicitly.
7. Moves your Traefik to the host network and recreates it. **Your sites are offline for a few seconds.**
   The old compose file is kept as `/opt/landfall/tenants/traefik-compose.before.yml`.

Every tenant after that only creates its own user, Docker and route. Your sites are not touched.

`state.json` notes each step as it is done. If the first `lf tenant add` stops halfway, the next one refuses.
Run `lf tenant off` to take back what was changed, then add the tenant again.

### What each tenant gets

- A user with a home (0700), bash, no password, and entries in `/etc/subuid` and `/etc/subgid`.
- Its key in `~/.ssh/authorized_keys`.
- Lingering, so its Docker keeps running when it logs out.
- Rootless Docker, the Docker context `rootless` and the `web` network. Its data lives in
  `/opt/landfall/tenants/<user>/docker`.
- `/opt/landfall/tenants/<user>.json`: its port, domains and limits. The tenant can read it, not change it.
- `/opt/landfall/traefik/dynamic/tenant-<user>.yml`: its route in your Traefik.

## Use the server (tenant)

The tenant works from its own computer, with its own key:

```sh
lf server add vps --host 203.0.113.7 -u anna -i ~/.ssh/anna   # register the server; landfall sees it is a tenant
lf traefik setup -s vps                                       # start your own Traefik
lf server domain vps anna.dev                                 # optional: sites default to <site>.anna.dev (else under the first *. domain)
lf deploy -s vps -d blog.anna.dev                             # deploy as usual
```

`lf server add` reads the tenant file over ssh and says so:

```
anna is a tenant on vps: sites go to /opt/landfall/tenants/anna
```

From then on, every command on that server works inside the tenant:

- Sites, releases, volumes and backups live under `/opt/landfall/tenants/anna`.
- Docker commands go to the tenant's own rootless Docker.
- `lf traefik setup` sets up the tenant's Traefik on its local port. It has no port 80, no HTTP/3 and no dashboard domain.
- A site may use only the tenant's domains. Others fail with `… not among your domains on vps (…); ask its admin to add it`.
- `lf tunnel` works. It relays through a small `alpine/socat` container, since rootless Docker's addresses are not
  reachable from the host.
- `lf history` and `lf undo` show and revert the tenant's own runs.

### What a tenant can run

Sites and deploys (`deploy`, `ls`, `sites`, `logs`, `env`, `secret`, `restart`, `stop`, `start`, `rollback`, `release rm`,
`adopt`, `promote`, `refs`, `git track`, `git key`, `autodeploy`), volumes and backups, `tunnel`, `scale`, `weight`,
`domains`, `auth`, `redirects`, `registry`, `check`, `stats`, `disk`, `traffic`, `certs`, `prune`, the `traefik`
commands for its own Traefik (`status`, `logs`, `setup`, `restart`, `access-log`, `strict-tls`, `dashboard`),
`history`, `undo`, the local commands (`server add`/`list`/`config`/`use`/`rm`, `ssh`, `init`, `eject`, `keygen`,
`config`, `ui`, `plugins`) and plugin commands marked for tenants.
Of the built-in plugins, `analytics` and `trivy` work for tenants, and `exposure` runs locally anyway. `fail2ban` does not.

Everything else is for the admin, and fails before it reaches the server:

```
error: lf firewall is for the admin of vps; anna is a tenant there
```

That covers `setup`, `harden`, `security`, `firewall`, `users`, `keys`, `system`, `services`, `swap`, `hostname`,
`timezone`, `log-limit`, `updates`, `update`, `scan`, `reboot`, `server uninstall`, `server upgrade`, `traefik use`,
`traefik rm`, `ci` and every `tenant` command. A tenant's `lf prune` cleans only its own Docker: `--logs` empties its
container logs and leaves the system journal to the admin.

## Manage tenants (admin)

```sh
lf tenant ls -s vps                                   # every tenant: port, state, Docker, sites, containers, memory, limits, domains
lf tenant ls -s vps --sizes                           # add disk use per tenant (slower: du over its files)
lf tenant ls -s vps --json                            # the same as JSON
lf tenant domains anna -s vps --add shop.anna.dev     # give a domain
lf tenant domains anna -s vps --rm old.anna.dev       # take one back
lf tenant limits anna -s vps --memory 4G --cpu none   # change limits; none removes one
lf tenant rights anna -s vps --open 25565/tcp         # open a public port for anna's containers
lf tenant rights anna -s vps --no-cron                # no crontab for anna
lf tenant rights anna -s vps                          # what anna may do
lf tenant stop anna -s vps                            # stop its Docker: its sites go offline (asks first)
lf tenant start anna -s vps                           # start it again
```

- `domains` refuses to remove the last domain, and refuses a domain that overlaps another tenant's.
  To hand one of a tenant's domains to your own site, take it back first. Until then, `lf deploy` says
  `… belongs to tenant anna; lf tenant domains anna --rm hands it back`.
- Your Traefik's route for the tenant changes at once. The tenant's `lf` reads the new list on its next deploy,
  domain change or `lf traefik setup`.
- `stop` and `start` refuse a removed tenant.

### Limits

Limits apply to everything the tenant runs, through its systemd slice (`user-<uid>.slice`):

| option | sets | example |
|---|---|---|
| `--memory` | `MemoryMax` | `2G` |
| `--cpu` | `CPUQuota`; 100% is one core | `200%` |
| `--tasks` | `TasksMax`: processes and threads | `2000` |

They take effect at once. `none` removes a limit. There are no disk quotas.

### Rights

Rights are what a tenant may do beyond its domains and limits. By default it may use cron and has no public port.

| option | does | enforced by |
|---|---|---|
| `--no-cron` / `--cron` | takes away or gives back the tenant's crontab | `/etc/cron.deny` |
| `--open 25565/tcp` | opens a public port for the tenant's containers (repeats) | ufw |
| `--close 25565/tcp` | closes it again (repeats) | ufw |

```sh
lf tenant rights anna -s vps --open 25565/tcp --open 25565/udp   # a game server
lf tenant rights anna -s vps --close 25565/udp                   # take one back
lf tenant rights anna -s vps --json                              # {"cron": true, "ports": ["25565/tcp"]}
```

- A port is a number from 1024 to 65535 with `/tcp` or `/udp`. Rootless Docker cannot publish ports below 1024.
  20000–20999 are the local ports of the tenants' Traefiks and are refused.
- A port belongs to one tenant at a time. A port ufw already allows for something else is refused.
- The tenant publishes it on all addresses: `0.0.0.0:25565:25565` in its compose file. Without an address, landfall
  publishes on `127.0.0.1`.
- Without ufw, `--open` only records the right. Open the port in the provider's firewall too; the command warns.
- `--no-cron` keeps the tenant's crontab aside and adds the user to `/etc/cron.deny`. `--cron` brings both back.
  Without cron, the tenant cannot turn on `lf autodeploy` or scheduled volume backups.
- Cron off is a policy, not a sandbox. A tenant with a shell can still start systemd user timers.
- `lf tenant rm` keeps the ports open, so `restore` brings the tenant back as it was. `--purge` closes them.
- Every change is undoable.

There is no right for mail or for a shell. The server cannot take a shell away from a user who deploys with ssh, and
outgoing mail is a network question: block port 25 at the provider if you need to.

## Remove a tenant

```sh
lf tenant rm anna -s vps             # deactivate: logins, Docker and routes stop; data stays
lf tenant restore anna -s vps        # bring it back as it was
lf tenant rm anna -s vps --purge     # delete the user and all its data (type the name)
```

`lf tenant rm` without `--purge`:

- moves its route aside, so your Traefik stops sending it traffic;
- stops and disables its Docker and turns off lingering;
- locks the user, moves `authorized_keys` aside and ends its sessions;
- saves and clears its crontab (`/opt/landfall/tenants/<user>.crontab.disabled`);
- keeps its user, files, port and domains, so no one else can take them.

`lf tenant restore` reverses each step. `lf undo` does the same.

`--purge` works on an active or a removed tenant. It uninstalls its rootless Docker and deletes the user, its home,
`/opt/landfall/tenants/<user>`, its limits and its `subuid`/`subgid` entries. **It cannot be undone.** It asks you to
type the name; `-y` skips that.

## Turn tenants off

```sh
lf tenant off -s vps                         # undo what the first tenant changed
lf tenant off -s vps --rm-tenants            # deactivate the remaining tenants first
lf tenant off -s vps --remove-packages       # also remove the packages it installed
```

`tenant off` reverses the first tenant's changes from `state.json`, newest first: the ufw rules it added, your
Traefik's network (a short outage again), the modes under `/opt/landfall`, the AppArmor profile and the systemd
drop-in. It keeps the packages unless you pass `--remove-packages`.

- It refuses while tenants are active: `lf tenant rm` them first, or pass `--rm-tenants`.
- Removed tenants keep their users and data. Purge them to delete those.
- `lf undo` turns tenants back on. Removed packages stay removed.

## Interactions with other commands

While tenants are on:

- `lf traefik setup` keeps your Traefik on the host network. `--no-host-network` fails until `lf tenant off`.
- `lf traefik use` fails: tenants need landfall's Traefik.
- `lf firewall disable` fails, because the tenants' ports would be open to everyone. `--force` turns it off all the same.
- `lf server uninstall` fails. Run `lf tenant off --rm-tenants`, then `lf tenant rm <user> --purge` for each tenant.
- `lf users` marks tenants. `lf users rm` refuses one: `lf tenant rm <user> --purge` removes it.
- The web UI's Users tab marks tenant users and does not offer to take them over.

## Security model

What keeps tenants apart:

- Each tenant's Docker runs as its own user, without root. A container that breaks out is that user, not root.
- Homes and tenant folders are 0700. `/opt/landfall` is closed to other users, except `tenants/` (0751), where they
  can read only their own `<user>.json`.
- `state.json` is root's (0600).
- Containers publish ports on `127.0.0.1` unless the compose file names another address.
- The firewall keeps every other port closed from outside, except the ports you open with `lf tenant rights`.
- A tenant has no sudo. Root work fails with `error: this needs root; ask the admin of vps`.
- Each tenant's routes cover only its own domains. Its Traefik never sees another tenant's TLS keys.
- Every tenant change on the server holds one lock, and writes only over the state it read. A concurrent change fails
  with `changed meanwhile; run the command again`.

What does not:

- A tenant with a shell can connect to another tenant's Traefik on `127.0.0.1:<port>`. It cannot read that traffic,
  but it can send requests that look like they come from any IP, so that tenant's access log can be spoofed.
- `ps` shows every user's processes, with their command lines.
- There are no disk quotas. One tenant can fill the disk for everyone.
- Rootless Docker has limits: no `network_mode: host`, no published ports below 1024, and some kernel features are missing.
- Tenants share the server's kernel. A kernel exploit reaches everyone.

Do not use tenants to separate people who may attack each other. Give them separate servers.

### Let's Encrypt rate limits

Let's Encrypt issues at most 50 certificates per registered domain per week. Each tenant's Traefik asks for its own
certificates, one per name. Tenants that use names under the same registered domain (`anna.example.com`,
`bob.example.com`) share that limit with each other and with you. Give tenants domains of their own where you can.

## In the web UI

As the admin, the server's **Tenants** section shows `lf tenant ls`:

- **Add tenant** asks for user, public key, domains and limits. Without ufw, it asks you to confirm the provider's
  firewall (`--provider-firewall`). On the first tenant it warns about the short outage.
- **Measure disk** runs `lf tenant ls --sizes`.
- After **Add tenant**, the invite opens. **Invite…** in a tenant's menu shows it again, with a **Copy** button.
- Each tenant's menu changes domains, limits and rights, stops or starts its Docker, removes or restores it, and deletes
  it with its data (type the name).
- The **Rights** column shows what differs from the default: `no cron`, open ports.
- Without tenants, the section explains what a tenant gets and what the first one changes. It says why when the server
  cannot have tenants (no systemd).
- **Turn tenants off…** runs `lf tenant off` once no tenant is active.

Elsewhere, the admin sees where tenants are:

- The server's tile on the overview counts its tenants, and **Sites** names them (`lf ls` too). Their sites run in
  their own Docker, so they are not in your list.
- Domain fields refuse a domain a tenant holds, and say which tenant has it.
- **Traffic** notes that requests to tenants' domains pass through encrypted and are not in your access log.
- **Firewall** notes that ufw keeps tenants' published ports closed.
- **Stats** shows each tenant's CPU and memory against its limits.

A tenant who runs `lf ui` sees a tenant badge and only what it may do: sites, deploys, stats, traffic, its Traefik,
history, and plugin sections marked for tenants. System, Updates, Users, Firewall and Tenants are hidden, and so are
setup, upgrade and uninstall. The deploy dialog suggests `<site>.<domain>` under the tenant's first wildcard domain, and
domain fields name the domains it may use.

## Known gaps

- `lf stats` for a tenant shows the whole server's CPU, memory and disks. Its own use is the line under Tenants.
