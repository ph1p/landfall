# Day-to-day

```sh
lf ls                              # sites with status, and your own containers behind Traefik
lf sites info                      # services, domains, releases (--json: the site as lf ls --json lists it, with its folder)
lf logs -f                         # follow logs (-n 500 for more lines)
lf logs blog db                    # one service
lf rollback                        # previous release (--to <id> for a specific one)
lf release rm                      # delete all releases but the live one (--keep n, or name ids)
lf env API_KEY=abc                 # set env (container is recreated); -u KEY removes one
lf env --dotenv -  < .env.prod      # the same from a file or stdin, values never in ps
lf env                             # names with values hidden; --reveal shows them, --keys only names, --json
lf env --pull .env.production      # copy the server's .env to a local file (mode 600)
lf secret DB_PASSWORD=…            # a secret file, at /run/secrets/DB_PASSWORD; --file K=path, -u K, lf secret lists them
lf restart | stop | start
lf domains                         # where DNS points, whether HTTPS answers
lf domains --add www.example.com   # also --rm, --set (updates .landfall.json)
lf domains --rm @                  # take the main domain off; the last one leaves the site running, unrouted
lf auth -u anna                    # login in front of the site (asks for the password, -p passes it)
lf auth --password-stdin < pw.txt  # the same for user admin, password from stdin
lf auth --rm-user anna | --off
lf auth -r admin -u bob            # a login of its own on one route (subdomain, domain or service:port)
lf auth -r hooks --public          # no login on that route; -r hooks --off asks for the site's login again
lf open
lf tunnel blog                     # http://localhost:<port> straight to its container: test it without a domain
lf tunnel my-compose-app -s vps    # also any Compose project or container landfall did not deploy
lf tunnel my-app db                # a database: postgresql://localhost:5432 (the port its image exposes; --port picks another)
lf tunnel blog -l 3000 --lan       # local port 3000, also on this machine's network: open it from a phone on the same Wi-Fi
lf tunnels                         # the tunnels open on this machine: URL, site, server, since when (--json)
lf sites rm blog                   # delete the site (asks you to type the name)
lf logs api -s vps                 # another site on another server
```

A tunnel needs no setup on the server. A server you only added (`lf server add`) is enough: `lf tunnel <container>`
reaches any container running there. The web page lists them under Tunnels.

A tunnel needs the server's sshd to allow port forwarding. With `AllowTcpForwarding no` the tunnel opens but
every request fails; `lf tunnel` then says so: set it to `yes` (or `local`) in `/etc/ssh/sshd_config` and reload ssh.

Commands that remove something ask first: `sites rm`, `domains --rm/--set`, `server domain --rm/--clear`,
`auth --rm-user/--off`, `firewall rm`, `undo`, `traefik rm`, `server rm` and `server uninstall`. `sites rm` and `undo --all` want the name typed
back. Domain and login changes are journaled, so `lf undo` reverts them.
