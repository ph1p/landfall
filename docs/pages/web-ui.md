# Web UI

```sh
lf ui                 # starts on 127.0.0.1:4777 and opens your browser
lf ui --no-open       # only print the login link
```

The web UI is a front end for the CLI. Each action runs a plain `lf` command as a subprocess, streams its output into a side panel and shows the command (`$ lf rollback blog -s vps --to 20260122143005 -y`) to repeat in a terminal or script. These runs are journaled and show up in `lf history`. Pages read the same data as the `--json` commands. Destructive actions ask first.

| page        | commands |
| ----------- | -------- |
| Overview    | `lf server list --check`, recent deploys, `lf config` (defaults, where landfall puts things) |
| Server menu | `lf server info`, `server use`, `reboot`, `server rm`, `server uninstall` |
| Sites       | `lf ls`, `sites info`, `deploy`, `rollback`, `release rm`, `logs`, `restart`/`stop`/`start`, `env`, `secret`, `domains`, `auth`, `tunnel`, `sites rm`. A site's menu runs `lf check <site>`, `lf stats <site>`, and opens its traffic |
| Stats       | `lf stats` (new sample every 5s while open), `lf disk` on request, Clean up… (`lf prune`) |
| Traffic     | `lf traffic --since 1h/24h/7d`, `lf certs`; a site's `lf traffic <site>`. The Sites tab shows failing requests of the last 24h and whether each domain answers over HTTPS |
| Traefik     | `lf traefik status` (routes), `traefik logs`, `traefik restart`, `traefik use`, `traefik rm` |
| Updates     | `lf updates`, `lf update` |
| Firewall    | `lf firewall` and subcommands |
| Users       | `lf users` and subcommands; shown only where landfall may manage users |
| System      | `lf system`, `services`, `keys`, `swap`, `hostname`, `timezone`, `log-limit` |
| Plugins     | one per plugin with a section, e.g. *fail2ban* (`lf fail2ban`, `fail2ban ban`/`unban`/`config`), *Trivy* (`lf trivy`, `trivy images`/`files`/`rm`). See [Plugins](plugins.md) |
| History     | `lf history`, `lf undo` |
| Settings    | `lf server config` (`--cloud`: Change next to provider, or the provider in the header), `server domain`, `traefik setup` (Settings…, Dashboard…), `traefik dashboard`, `lf registries`, `registry login`/`logout` |

## Servers and deploys

- Servers are on the left; ★ marks the default.
- The dot shows whether landfall's key login works (green), sshd refuses it (yellow) or ssh does not answer (red). Hover for the reason.
- It checks on load, every minute while open, and on **Check** at the foot of the list (like `lf server list --check`).
- Unreachable servers move to a closed **Unreachable** group at the end.
- Git hosts and aliases for this machine (`localhost`, `127.0.0.1`, e.g. a Colima VM) in `~/.ssh/config` are not listed.
- **Deploy folder…** browses local folders, or takes a dropped folder or `.zip` (up to 512 MiB; archives with symlinks or hard links are refused).
- Its **a Docker image** link deploys an image (`lf deploy --image`) and suggests images from this machine's Docker. It runs in an empty folder with `--no-save`, so the folder `lf ui` started in adds no `.landfall.json` settings.
- **Redeploy** on an image site asks for the image again.
- Deploy, Redeploy, Roll back and Delete list the [hooks](hooks.md) they run, each with a box to skip it (`--skip-hook`).
- A site's **Edit** dialog takes redirect hosts next to its domains (`lf domains --redirect`). The site row shows each one with an arrow to the first domain.
- The **Traefik** section lists the server's redirects (`lf redirects`), each with its DNS and HTTPS state.
- **Add…** and **Change…** run `lf redirect add`; **Remove…** runs `lf redirect rm`.
- A redirects file edited by hand is reported there, and the buttons stay off until it is fixed.

## Security and limits

- **Login:** through the printed `/login?t=…` link. The token lives in `~/.config/landfall/ui-token`; delete it to rotate.
- **Local only:** listens on `127.0.0.1`, refuses a foreign `Host` or `Origin`.
- **Port:** a second `lf ui` only opens the page. If port 4777 is taken, it uses the next free one; an explicit `--port` fails instead.
- **Limits:** at most 20 commands run at once.
- **Arguments:** go to the `lf` subprocess through a private, lossless stdin envelope, never its command line. Command text masks passwords and env/secret values; command output can still contain sensitive data.
- **stdin:** UI jobs cannot read command stdin (`--dotenv -` / `--password-stdin`). Use a dotenv filename or the UI's password/value fields. Terminal commands keep their stdin options.
- **sudo password:** when sudo needs a password (what `-K` asks for in a terminal), the job offers **Give the sudo password**. It reruns the command with the password in the stdin envelope, for that run only: not stored, not in the command line.
- **No screen scraping:** commands report what the UI needs (deploy URL, tunnel address, setup checks, a refusal `--force` would override) on a separate channel.
