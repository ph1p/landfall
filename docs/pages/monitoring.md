# Traffic, certificates and checks

```sh
lf traffic                          # last 24h per site: requests, 4xx/5xx, median and 95% response time, bytes sent
lf traffic blog --since 1h          # one site (or a host): requests per minute, busiest paths, failing requests, clients
lf certs                            # each domain's certificate (sites and server redirects): days left, issuer, why getting one failed
lf check                            # request every site over HTTPS from this machine; exits 1 when one fails
lf check example.com --resolve 198.51.100.4   # one domain, against an address before DNS points there
```

## Traffic

`traffic` sums Traefik's access log (JSON lines on stdout, set by `lf traefik setup`) with awk on the server; only counts cross ssh.

- History reaches as far as the container log (`lf log-limit` caps it); `--since` takes up to 30d.
- Up to 6h counts per minute, longer per hour. Response times come from a histogram, within about 20%.
- An older Traefik logs plain text: `lf traefik setup` switches it to JSON (brief restart).
- Your own Traefik (`lf traefik use`) needs `--accesslog=true --accesslog.format=json` in its command.

## Certificates

`certs` reads `acme.json` (Let's Encrypt; root-owned needs root or passwordless sudo) and certificate files in `dynamic/`. Only certificates leave the server, never keys. Errors come from Traefik's log of the last 7 days (`--since`). Let's Encrypt renews 30 days ahead: under 30 days means renewal is due, under 7 that it fails.

## Checks

`check` runs on your machine, as a visitor: status, response time, and whether the certificate is trusted and valid 7+ more days. Given domains, it needs no server, so it works from cron or CI. The web UI checks a server's domains each minute while its Sites tab is open (dot per domain; hover for details).
