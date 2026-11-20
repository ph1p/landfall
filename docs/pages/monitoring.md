# Traffic, certificates and checks

```sh
lf traffic                          # last 24h per site: requests, 4xx/5xx, median and 95% response time, bytes sent
lf traffic blog --since 1h          # one site (or a host): requests per minute, busiest paths, failing requests, clients
lf certs                            # each site domain's certificate: days left, issuer, why getting one failed
lf check                            # request every site over HTTPS from this machine; exits 1 when one fails
lf check example.com --resolve 198.51.100.4   # one domain, against an address before DNS points there
```

`traffic` reads Traefik's access log (JSON lines on its stdout, written by `lf traefik setup`) and adds it up
on the server with awk, so only the counts cross ssh. It reaches back as far as the container log does:
`lf log-limit` caps it, `--since` takes up to 30d. Spans up to 6h count per minute, longer ones per hour;
response times come from a histogram and are within about 20%. Traefik installed before this version logs
plain text: `lf traefik setup` switches it to JSON (Traefik restarts for a moment). A server's own Traefik
(`lf traefik use`) needs `--accesslog=true --accesslog.format=json` in its command.

`certs` reads certificates from what Traefik mounts: `acme.json` (Let's Encrypt; needs root or passwordless
sudo when it is root-owned) and certificate files in `dynamic/`. Only certificates leave the server, never
keys. Errors come from Traefik's log of the last 7 days (`--since`). Let's Encrypt renews 30 days ahead, so
under 30 days means renewal is due, under 7 that it is failing.

`check` runs on your machine, the way a visitor sees a site: status, time to the response, and whether the
certificate is trusted and valid for at least 7 more days. Give it domains and it needs no server, so it
works from cron or CI. The web UI checks a server's domains each minute while its Sites tab is open (the
dot on each domain; hover for the details).
