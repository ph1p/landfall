# Traffic, certificates and checks

```sh
lf traffic                          # last 24h per site: requests, 4xx/5xx, median and 95% response time, bytes sent
lf traffic blog --since 1h          # one site (or a host): requests per minute, busiest paths, failing requests, clients
lf certs                            # each domain's certificate (sites and server redirects): days left, issuer, why getting one failed
lf check                            # request every site over HTTPS from this machine; exits 1 when one fails
lf check example.com --resolve 198.51.100.4   # one domain, against an address before DNS points there
```

## Traffic

`traffic` sums Traefik's access log (JSON lines on stdout: landfall's Traefik writes them, `lf traefik access-log` turns them on for your own) with awk on the server; only counts cross ssh.

- History reaches as far as the container log (`lf log-limit` caps it); `--since` takes up to 30d.
- Up to 6h counts per minute, longer per hour. Response times come from a histogram, within about 20%.
- `lf traffic` and the web UI say when Traefik has no access log, logs plain text, or logs to a file.
- A site's clients show their 4xx answers (400-405) beside their requests. `lf fail2ban web on` bans clients with too many ([fail2ban](plugins.md#web-scanners-and-floods)); the Traffic tab then has a Ban button per client.

The access log is Traefik's container log. Manage it with `lf traefik access-log`:

```sh
lf traefik access-log -s vps                   # on or off, the log's size on disk and its size cap
lf traefik access-log on -s vps                # turn on the JSON log; Traefik restarts once; lf undo reverts it
lf traefik access-log off -s vps               # turn it off; lf traffic then has nothing to count
lf traefik access-log clear -s vps             # empty the log now; old traffic is gone, cannot be undone
lf log-limit 20m -s vps                        # cap every container log, Traefik's too (see System)
```

- The web UI has the same actions in the Traffic tab, under "Access log". Its footer shows the log's size cap.
- Without a cap (`no size limit`), the log grows until the disk is full. `lf log-limit` sets one.
- `clear` works when Docker keeps the log as a `json-file` (the default). It asks first.
- On landfall's Traefik, `on` and `off` rewrite the Traefik setup, like `lf traefik setup --access-log` / `--no-access-log`. The choice is remembered.
- On your own Traefik (`lf traefik use`), they add or remove `--accesslog=true --accesslog.format=json` in the service's `command:` in its compose file. It shows the change and asks first.
- A compose file only root can read (under `/root`) needs root: landfall uses a root key login, or asks for the sudo password once.
- It refuses when the Traefik takes its config from a file, comes from several compose files, or sets `--accesslog.filepath`. Then change the flags yourself (or `accessLog: {format: json}` in its config file).
- `off` refuses when the access log is not set by flags in the command, for example by environment variables.
- For the services of a traffic split, `lf weight <site> --stats` counts per service ([Scaling](scaling.md)).

## Certificates

`certs` reads `acme.json` (Let's Encrypt; root-owned, or under `/root`, needs passwordless sudo or a root key login) and certificate files in `dynamic/`. Only certificates leave the server, never keys. Errors come from Traefik's log of the last 7 days (`--since`). Let's Encrypt renews 30 days ahead: under 30 days means renewal is due, under 7 that it fails.

## Checks

`check` runs on your machine, as a visitor: status, response time, and whether the certificate is trusted and valid 7+ more days. Given domains, it needs no server, so it works from cron or CI. The web UI checks a server's domains each minute while its Sites tab is open (dot per domain; hover for details).
