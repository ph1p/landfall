# Troubleshooting

`…` marks the varying part of a message.

| error or symptom | fix |
| --- | --- |
| `setup needs root or sudo for …` | `-u root`, `-K` (sudo password), or passwordless sudo |
| `installing … needs root: …` / `… has no sudo` | The login cannot install packages. Use `-K`, name a root login with `lf server config <name> --root-login <ssh-alias>`, or run the install command from the message as root |
| `… no root key login works` / `fail2ban answers root only` | Add a Host with `User root` (or a sudo user) for the machine to `~/.ssh/config`, name one with `lf server config <name> --root-login <ssh-alias>`, or use `-K` |
| `ssh cannot resolve <name>` | Not in your ssh config: `lf server add <name> --host …` |
| `skipping firewall/ssh hardening: …` | Setup protected something running there. Fix it, or re-run with `--force` |
| `skipping traefik: port 80 is in use by …` | Free the port, then `lf traefik setup`. A Traefik? `lf traefik use` |
| `Docker on … does not answer` / `permission denied … docker.sock` | Login user may not use Docker: `sudo usermod -aG docker <user>`, or let setup create the deploy user. landfall logs in anew itself |
| certificate warning in the browser | You used `--staging`: `lf setup <name> --no-staging` |
| no certificate at all | DNS must point at the server, 80/443 must be open. See `lf traefik logs` |
| TLS handshake fails | No site serves the domain (`lf domains --add …`), or its certificate is not issued yet: `lf traefik logs` |
| `… was edited by hand` (traefik setup) | Move your change to `dynamic/` or flags, or `lf traefik setup --force` |
| site container keeps restarting | `lf logs`; check `--port` / `x-landfall.port` and env |
| `… publishes 5432 on the server, past Traefik and the firewall` | `lf init` moves `ports:` to `compose.override.yaml`, or allow it: `x-landfall: { publish: true }` |
| `lf traffic` shows scanners, fail2ban does not ban them | fail2ban watches ssh only. `lf fail2ban web on` adds jails for Traefik's access log |
| `fail2ban's web jails still read the old log of traefik` | Traefik was recreated without root. `lf fail2ban web on` |
| `sites need docker compose 2.24 or newer` | `lf update --compose` |
| `required variable … is missing` / `compose.yaml needs …` | Set it on the server: `lf env KEY=…` or `lf deploy -e KEY=…` |
| `… blocks ssh port 22 … (--force to do it anyway)` | `lf firewall allow 22/tcp` first, or force if you have another way in |
| `… Pass -y to confirm (no terminal to ask)` | Add `-y` |
| `local config is locked: …` | Another writer has 5 seconds to finish. If no landfall writer is active, remove only the reported abandoned `.lock` directory. Never delete the config directory |
| `local configuration … changed during this command` | Another command changed the same settings. Review local config, then retry. Finished remote work was not reverted |
