# Server administration

Firewall, services, SSH keys, users and hardening on a server. Every change is journaled; see [History and undo](history.md) for what can be undone.

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

## Server system

```sh
lf system                         # host name, time zone, clock, swap, Docker log limit, services, keys, whether fail2ban runs
lf services                       # what landfall relies on (docker, ssh, fail2ban …) and failed ones; --all for every one
lf services restart docker        # also start, stop; asks first for docker, refuses ssh without --force
lf services logs fail2ban -f      # journald, else the service's log file; -n lines
lf keys                           # who may log in, per user; ★ is the key this machine uses
lf keys add ~/.ssh/anna.pub       # to the login user; --user root for another
lf keys rm anna@laptop            # by comment or (part of) the fingerprint
lf bans                           # what fail2ban blocks, per jail (lf fail2ban, a built-in plugin)
lf unban 203.0.113.9              # lf fail2ban also bans, and sets ban times; see plugins.md
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

## Users

Server accounts, one per person or deploy job, each with their own SSH keys, password and sudo:

```sh
lf users                                   # root and uid 1000+: sudo, password set or not, keys; --json
lf users add anna --key ~/anna.pub --sudo  # or --generate-key (a pair at ~/.ssh/<server>_anna), --password
lf users add ci --key "ssh-ed25519 AAAA…"  # key only, no sudo
lf users passwd anna                       # asks twice; --generate prints a new one once, --remove: key login only
lf users sudo anna --nopasswd              # landfall's rule in /etc/sudoers.d (checked with visudo); --off takes it away
lf users rm anna                           # with its home (--keep-home keeps it); asks you to type the name
lf keys add ~/anna2.pub -u anna            # more keys, as for any user
```

These need root or passwordless sudo (or root's key login) and `useradd` or busybox's `adduser`. Where that is
missing, or on a system that manages its own users (Synology DSM), every `lf users` command fails saying why and
the web UI has no Users tab. landfall never removes root, the user it logs in as, or the login it manages users
with, nor takes sudo from them. Adding a user and sudo changes are undoable. Removing a user and passwords are
not: the journal keeps no hashes. Passwords reach the server on the script's stdin, never on a command line.

## Security

```sh
lf security                       # ssh passwords, root login, firewall, fail2ban, automatic updates, pending reboot
                                  # behind an AWS, Google Cloud, Azure, Oracle or Alibaba firewall, ufw being off is not a warning
                                  # with keys only, a missing fail2ban is not a warning
lf harden                         # all of: ssh (keys only), fail2ban, updates; or name the parts
lf harden ssh                     # asks first; refuses while a user logs in with a password only (--force)
lf keys add --generate -u anna    # new pair at ~/.ssh/<server>_anna, its public key on the server
```

`lf setup` and `lf server add` end with the same advice, and the web UI shows it on the system tab with a
button per fix. Each fix is journaled, so `lf undo` takes it back. Automatic updates know apt
(unattended-upgrades), dnf (dnf-automatic) and apk (a daily `apk upgrade` from cron). Without root or sudo landfall only checks sshd's settings.
