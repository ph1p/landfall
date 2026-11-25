# Web UI

```sh
lf ui                 # starts on 127.0.0.1:4777 and opens your browser
lf ui --no-open       # only print the login link
```

The web UI is a front end for the CLI. Each action runs a plain `lf` command as a subprocess, streams its output into a side panel and shows the command (`$ lf rollback blog -s vps --to 20260122143005 -y`) to repeat in a terminal or script. These runs are journaled and show up in `lf history`. Pages read the same data as the `--json` commands. Destructive actions ask first.

| page        | commands |
| ----------- | -------- |
| Overview    | `lf server list --check`, recent deploys, `lf config` (defaults, where landfall puts things) |
| Map         | every server and what runs on it, as connected nodes; adds a server, a site or a domain, and deploys a dropped project (see below) |
| Server menu | `lf server info`, `server use`, `reboot`, `server rm`, `server uninstall` |
| Sites       | `lf ls`, `sites info`, `deploy`, `rollback`, `release rm`, `logs`, `restart`/`stop`/`start`, `env`, `secret`, `domains`, `auth`, `tunnel`, `scale`, `weight`, `sites rm`. A site's menu runs `lf check <site>`, `lf stats <site>`, and opens its traffic |
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
- So do a build change in **Edit** and a volume change with **Redeploy now**: both redeploy the site.
- The deploy dialog takes redirect hosts next to the domains (`lf deploy --redirect`).
- A site's **Edit** dialog takes redirect hosts next to its domains (`lf domains --redirect`). The site row shows each one with an arrow to the first domain.
- The **Traefik** section lists the server's redirects (`lf redirects`), each with its DNS and HTTPS state.
- **Add…** and **Change…** run `lf redirect add`; **Remove…** runs `lf redirect rm`.
- A redirects file edited by hand is reported there, and the buttons stay off until it is fixed.

## Map

**Map** in the sidebar draws your whole infrastructure on one page (`#map`).

- This machine and its projects sit on the left. Each server is a box to their right.
- A server's header shows its name, address and status. Everything that runs on it sits inside the box.
- Inside a box, columns from left to right: Traefik, sites and apps, their containers and volumes, and domains.
- A server that ssh cannot reach shows as its header only, with a red dot.
- Lines show how things connect. Green is routed and up, red is failing or refused, yellow is a warning.
- Traefik's routes share one line that branches to each site.
- A dashed line means no domain reaches it: only a tunnel does (`lf tunnel`). Deploy and redirect lines are dashed too.
- Domains show whether their DNS points at the server and whether HTTPS answers.
- Compose projects landfall did not deploy show as *not landfall's*. Containers no route reaches are grouped by Compose project.
- Click a node for its details and actions in a side panel: logs, restart, redeploy, settings, open in the browser.
- Double-click a node to open its page.
- Dashed **Add** nodes fill the gaps: **Add a server**, **Set up this server** (`lf setup`), **Deploy a site** and **Add a domain** (`lf domains`).
- Drag a local project onto a server's band to deploy it there. The deploy dialog opens first.
- Hover a node to light its direct neighbours. Select it to light its whole path, from this machine to its domains.
- The search box dims everything that does not match and counts the matches. Enter jumps to the next one.
- The buttons next to it hide containers, volumes, domains, apps that are not landfall's, and the Add nodes.
- The status button counts what is down or warning. Click it to jump to the next problem; it shows **All up** when nothing is.
- **Fold** in a server's header (or **Fold on the map** in its panel) shows only the server and its proxy, with a count of its sites, problems and domains.
- The fold button in the bottom-right row folds or unfolds every server.
- Scroll to pan; Ctrl or ⌘ and scroll to zoom. Drag the background to pan. Panning stops at the map's edges.
- The row in the bottom right zooms, fits the map to the window, folds every server and reads every server again. Click the percentage to go back to 100%.
- When the map is larger than the window, a small overview sits above that row. Click or drag in it to move there.
- **Legend and keys** in the bottom left explains the lines and lists the keys.
- Keys: `/` finds, `n` jumps to the next problem (`N` back), `+` and `-` zoom, `0` fits, Esc clears the selection.
- The browser remembers the hidden layers and folded servers.

## Security and limits

- **Login:** through the printed `/login?t=…` link. The token lives in `~/.config/landfall/ui-token`; delete it to rotate.
- **Local only:** listens on `127.0.0.1`, refuses a foreign `Host` or `Origin`.
- **Port:** a second `lf ui` only opens the page. If port 4777 is taken, it uses the next free one; an explicit `--port` fails instead.
- **Limits:** at most 20 commands run at once.
- **Arguments:** go to the `lf` subprocess through a private, lossless stdin envelope, never its command line. Command text masks passwords and env/secret values; command output can still contain sensitive data.
- **stdin:** UI jobs cannot read command stdin (`--dotenv -` / `--password-stdin`). Use a dotenv filename or the UI's password/value fields. Terminal commands keep their stdin options.
- **sudo password:** when sudo needs a password (what `-K` asks for in a terminal), the job offers **Give the sudo password**. It reruns the command with the password in the stdin envelope, for that run only: not stored, not in the command line.
- **No screen scraping:** commands report what the UI needs (deploy URL, tunnel address, setup checks, a refusal `--force` would override) on a separate channel.
