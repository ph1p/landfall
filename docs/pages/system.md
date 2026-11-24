# Server administration

Firewall, services, SSH keys, users and hardening on a server.
Every change is journaled; [History and undo](history.md) says what can be undone.

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

- Changes run as root or with sudo, else (like `deploy`) with root's key login.
- landfall refuses a change that would block the ssh port, and `enable` while ports in use have no rule. `--force` overrides.
- Docker-published ports bypass ufw, so deny doesn't close them: bind them to `127.0.0.1` in their compose file.
- ufw stops at the first match, so `update`, `rm` and its undo keep the rule's position. `update` puts the old rule back if ufw rejects the new one.

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

- They need root or passwordless sudo, else root's key login. Services work with systemd and OpenRC.
- All but `swap off` and `services restart` can be undone: `lf undo` stops a started service, puts a removed key back,
  bans an unbanned IP again, or restores the old name, zone or `daemon.json`.
- The log limit applies to containers created afterwards; Docker restarts only with `--restart`. Redeploy or restart sites to apply it.

## Users

One account per person or deploy job, with its own SSH keys, password and sudo:

```sh
lf users                                   # root and uid 1000+: sudo, password set or not, keys; --json
lf users add anna --key ~/anna.pub --sudo  # or --generate-key (a pair at ~/.ssh/<server>_anna), --password
lf users add ci --key "ssh-ed25519 AAAA…"  # key only, no sudo
lf users passwd anna                       # asks twice; --generate prints a new one once, --remove: key login only
lf users sudo anna --nopasswd              # landfall's rule in /etc/sudoers.d (checked with visudo); --off takes it away
lf users rm anna                           # with its home (--keep-home keeps it); asks you to type the name
lf keys add ~/anna2.pub -u anna            # more keys, as for any user
```

- They need the same, plus `useradd` or busybox's `adduser`.
  Without these, or where the system manages its own users (Synology DSM), `lf users` commands fail saying why and the web UI has no Users tab.
- landfall never removes root, its login user, or the login it manages users with, nor takes their sudo.
- Adding users and sudo changes can be undone. Removing users and passwords cannot: the journal keeps no hashes.
- Passwords reach the server on the script's stdin, never a command line.

## Security

```sh
lf security                       # ssh passwords, root login, firewall, fail2ban, automatic updates, pending reboot
lf harden                         # all of: ssh (keys only), fail2ban, updates; or name the parts
lf harden ssh                     # asks first; refuses while a user logs in with a password only (--force)
lf keys add --generate -u anna    # new pair at ~/.ssh/<server>_anna, its public key on the server
```

- `lf security` doesn't warn about ufw being off behind an AWS, Google Cloud, Azure, Oracle or Alibaba firewall, nor about missing fail2ban with keys only.
- `lf harden ssh` always refuses while sshd refuses keys (`PubkeyAuthentication no`), even with `--force`.
- `lf setup` and `lf server add` end with the same advice; the web UI's system tab has a button per fix. Each fix is journaled: `lf undo` takes it back.
- Automatic updates know apt (unattended-upgrades), dnf (dnf-automatic) and apk (a daily `apk upgrade` from cron).
- Without root or sudo, landfall only checks sshd's settings. It reads them from `sshd -T`, what sshd really uses: `Include` files count and the first value wins.
