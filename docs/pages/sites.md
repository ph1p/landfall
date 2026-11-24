# Day-to-day

Commands act on the site in `./.landfall.json`. Name another site as first argument, another server with `-s`.

```sh
lf ls                              # sites with status, and your own containers behind Traefik
lf sites info                      # services, domains, releases (--json: as lf ls --json, plus its folder)
lf logs -f                         # follow logs (-n 500 for more lines)
lf logs blog db                    # one service
lf logs api -s vps                 # another site on another server
lf rollback                        # previous release (--to <id> for a specific one)
lf release rm                      # delete all releases but the live one (--keep n, or name ids)
lf restart | stop | start
lf open
lf sites rm blog                   # delete the site (asks you to type the name)
```

## Env and secrets

```sh
lf env API_KEY=abc                 # set env (container is recreated); -u KEY removes one
lf env --dotenv - < .env.prod      # from a file or stdin, values never in ps
lf env                             # names, values hidden; --reveal, --keys (only names), --json
lf env --pull .env.production      # copy the server's .env to a local file (mode 600)
lf secret DB_PASSWORD=…            # file at /run/secrets/DB_PASSWORD; --file K=path, -u K; bare: list
```

## Domains and logins

```sh
lf domains                         # where DNS points, whether HTTPS answers
lf domains --add www.example.com   # also --rm, --set (updates .landfall.json)
lf domains --rm @                  # take the main domain off
lf domains --redirect www          # www.<first domain> redirects to the first domain
lf domains --rm www.example.com    # stop the redirect (--rm takes domains and redirects)
lf auth -u anna                    # login in front of the site (asks for the password, -p passes it)
lf auth --password-stdin < pw.txt  # user admin, password from stdin
lf auth --rm-user anna | --off
lf auth -r admin -u bob            # own login on one route (subdomain, domain or service:port)
lf auth -r hooks --public          # no login on that route; -r hooks --off restores the site's login
```

### Redirects

A redirect host answers every request with a permanent redirect to the site's first domain.
Path and query stay: `https://www.example.com/blog?p=2` goes to `https://example.com/blog?p=2`.

```sh
lf domains blog --redirect www                # www.<first domain> → first domain
lf domains blog --redirect old-blog.org       # any host can redirect, not only www
lf domains blog --redirect www.example.com    # a domain the site serves turns into a redirect
lf domains blog --add www.example.com         # back to serving it
lf domains blog                               # redirects are listed with an arrow, DNS- and HTTPS-checked
```

- A bare name is a subdomain of the site's first domain. With `--add`, a bare name is a subdomain of the server's main domain.
- Point DNS at the server for each redirect host. Traefik gets a certificate for it like for any domain.
- Plain HTTP goes to HTTPS first, then to the first domain.
- The redirect has no login and no address check: it only points elsewhere.
- Traefik answers `301` for GET and HEAD and `308` for other methods.
- A redirect host another site serves moves here after a prompt, like a domain.
- Redirects are saved in `.landfall.json` under `redirects`, and every deploy keeps them.
- A site with no domain keeps its redirects but does not route them until it has a domain again.
- `lf undo` takes a redirect change back.
- `lf deploy --redirect www` sets the redirects on deploy. `--no-redirect` removes them.
- A host that redirects elsewhere, with no site behind it, is a server redirect: `lf redirect add` (see [Traefik](traefik.md)).

Removing the last domain leaves the site running, unrouted.

## Tunnels

```sh
lf tunnel blog                     # http://localhost:<port> straight to its container, no domain needed
lf tunnel my-compose-app -s vps    # any Compose project or container landfall did not deploy
lf tunnel my-app db                # postgresql://localhost:5432 (port its image exposes; --port picks another)
lf tunnel blog -l 3000 --lan       # local port 3000, also on your network (a phone on the same Wi-Fi)
lf tunnels                         # open tunnels: URL, site, server, since when (--json)
```

- No server setup needed: a server you only added (`lf server add`) is enough to reach any container.
- The web page lists tunnels under Tunnels.
- sshd must allow port forwarding. With `AllowTcpForwarding no`, requests fail and `lf tunnel` says so. Set it to `yes` (or `local`) in `/etc/ssh/sshd_config` and reload ssh.

## Confirmations

These ask first: `sites rm`, `domains --rm/--set`, `server domain --rm/--clear`, `auth --rm-user/--off`, `firewall rm`, `undo`, `traefik rm`, `server rm`, `server uninstall`.
`sites rm` and `undo --all` want the name typed back.

Domain and login changes are journaled; `lf undo` reverts them.
