# Web UI

```sh
lf ui                 # starts on 127.0.0.1:4777 and opens your browser
lf ui --no-open       # only print the login link
```

The web UI is a front end for the CLI. Every action runs a plain `lf` command as a subprocess, streams its
output into a side panel and shows the command (`$ lf rollback blog -s vps --to 20260122143005 -y`), so
anything you do there you can repeat in a terminal or a script. Runs started there are journaled like any
other and show up in `lf history`. The pages read the same data the `--json` commands print:

| page        | commands                                                                                                                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Overview    | `lf server list --check`, recent deploys, `lf config` (defaults, and where landfall puts things)                                                                                                                                     |
| Server menu | `lf server info`, `server use`, `reboot`, `server rm`, `server uninstall`                                                                                                                                                            |
| Sites       | `lf ls`, `sites info`, `deploy`, `rollback`, `release rm`, `logs`, `restart`/`stop`/`start`, `env`, `secret`, `domains`, `auth`, `tunnel`, `sites rm`; a site's menu runs `lf check <site>`, `lf stats <site>` and opens its traffic |
| Stats       | `lf stats` (a new sample every 5s while the tab is open), `lf disk` on request, Clean up… (`lf prune`)                                                                                                                               |
| Traffic     | `lf traffic --since 1h/24h/7d`, `lf certs`; click a site for `lf traffic <site>`. The Sites tab shows failing requests of the last 24h and whether each domain answers over HTTPS                                                    |
| Traefik     | `lf traefik status` (routes), `traefik logs`, `traefik restart`, `traefik use`, `traefik rm`                                                                                                                                         |
| Updates     | `lf updates`, `lf update`                                                                                                                                                                                                            |
| Firewall    | `lf firewall` and its subcommands                                                                                                                                                                                                    |
| Users       | `lf users` and its subcommands; the tab shows only where landfall may manage users                                                                                                                                                   |
| System      | `lf system`, `services`, `keys`, `unban`, `swap`, `hostname`, `timezone`, `log-limit`                                                                                                                                                |
| History     | `lf history`, `lf undo`                                                                                                                                                                                                              |
| Settings    | `lf server config`, `server domain`, `traefik setup` (Settings…, Dashboard…), `traefik dashboard`                                                                                                                                    |

Servers are on the left (★ marks the default). The dot next to each says whether landfall's key login works
(green), sshd refuses it (yellow) or ssh does not answer (red); hover for the reason. It checks on load, every
minute while the page is open, and on **Check** at the foot of the list (like `lf server list --check`).
Reachable servers come first; unreachable ones move to a closed **Unreachable** group. Git hosts and aliases
for this machine (`localhost`, `127.0.0.1`, e.g. a Colima VM) from `~/.ssh/config` are not listed. **Deploy folder…** browses local folders, or takes a dropped
folder or `.zip` (up to 512 MiB; archives with symlinks or hard links are refused). Destructive actions ask first.

- **Login:** through the printed `/login?t=…` link. The token is kept in `~/.config/landfall/ui-token`; delete
  that file to rotate it.
- **Local only:** it listens on `127.0.0.1` and refuses requests with a foreign `Host` or `Origin`.
- Running `lf ui` again while it runs just opens the page. If another program has port 4777, it takes the next
  free one (an explicit `--port` fails instead).
- **Limits:** at most 20 commands run at once. Job arguments are handed to the `lf` subprocess through
  a private, lossless stdin envelope, never on its command line. Command text masks passwords and env/secret
  values; arbitrary command output can still contain sensitive data. Dashboard jobs cannot also read command
  stdin (`--dotenv -` / `--password-stdin`): use a dotenv filename or the dashboard's password/value fields.
  Direct terminal commands retain their normal stdin options.
- **No screen scraping:** commands report results the UI needs (deploy URL, tunnel address, setup checks, a
  refusal that `--force` would override) on a separate channel, so the UI never parses CLI text.
