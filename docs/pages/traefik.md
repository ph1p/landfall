# Traefik

```sh
lf traefik status                              # container state, routes, mode (--json)
lf traefik logs -f                             # certificate errors show up here (--access adds requests)
lf traefik setup --email you@example.com       # reconfigure (safe to re-run)
lf traefik setup --dashboard traefik           # dashboard at traefik.<main domain> behind a login; `off` removes it
lf traefik dashboard                           # the dashboard on localhost through an SSH tunnel, no domain needed
lf traefik setup --host-network                # bind 80/443 on the host (--no-host-network switches back)
lf traefik setup --no-http3                    # turn HTTP/3 off (on by default)
lf traefik setup --no-access-log               # no JSON access log, so no lf traffic (on by default)
```

landfall's Traefik is the container `traefik` from `/opt/landfall/traefik/docker-compose.yml`. Setup remembers image, network mode, HTTP/3, access log, e-mail, staging and dashboard per server, so re-running it keeps them. In `lf ui`: a server's settings, Traefik → Settings….

By default Docker publishes 80/443 to it. Sites work the same in both modes:

|                                       | ports published (default)                 | `--host-network` |
| ------------------------------------- | ----------------------------------------- | ---------------- |
| client IP in logs / `X-Forwarded-For` | real IPv4; IPv6 may show Docker's gateway | always real      |
| ufw                                   | Docker's NAT bypasses ufw for 80/443      | ufw applies      |

**HTTP/3** (QUIC): Traefik also listens on 443/udp; browsers switch after their first HTTP/2 request. Setup's firewall opens 443/udp only with HTTP/3 on. With `--host-network` and active ufw, `lf traefik setup` opens 80/tcp, 443/tcp and 443/udp.

**Unknown hosts.** Traefik only answers hosts it has a certificate for (`sniStrict`). A domain pointed at the server but served by no site fails the TLS handshake, as if nothing listened: no 404, no Traefik certificate. Plain HTTP redirects to HTTPS and fails the same way. So does a new site's domain until Let's Encrypt issues its certificate, a few seconds. A Traefik of your own does this only after `lf traefik strict-tls on` (see [below](#refusing-unknown-hosts-on-your-own-traefik)).

**Server redirects.** A host can redirect to any URL with no site behind it:

```sh
lf redirect add old.example.com https://example.com/blog   # old.example.com/a?b=1 → https://example.com/blog/a?b=1
lf redirect add promo https://shop.example.com/sale --no-path --temporary   # promo.<main domain>, always to that URL, 302
lf redirects                                               # the list, DNS- and HTTPS-checked (--json)
lf redirect rm old.example.com                             # asks first; lf undo brings it back
```

- The redirects live in `/opt/landfall/traefik/dynamic/redirects.yml`, read by Traefik's file provider.
- They need landfall's own Traefik. With a Traefik you run, add them to its own configuration.
- Point DNS at the server for each host. Traefik gets a certificate for it like for any domain. `lf certs` lists it with an arrow to its target.
- Permanent redirects answer `301` for GET and HEAD and `308` for other methods. `--temporary` answers `302` and `307`.
- A host a site serves moves to the redirect after a prompt. A site that adds a redirect's host takes it over after a prompt.
- Every change is journaled. `lf undo` takes it back.
- To redirect a site's extra hosts to its own first domain, use `lf domains --redirect` (see [Sites](sites.md)).

**Your own config.** Certificates and Traefik config go in `/opt/landfall/traefik/dynamic/`; landfall rewrites only `landfall.yml` and `redirects.yml` there. If you edit `docker-compose.yml` by hand, `lf traefik setup` shows the diff and stops; `--force` overwrites.

**Traefik's dashboard.** `lf traefik dashboard` always uses an SSH tunnel: Traefik serves it on port 8080 to the server only (loopback and the `web` network's gateway), never published. A Traefik set up before this needs `lf traefik setup` once. `--dashboard <domain>` also serves it on a domain behind a login. The password is generated and printed once; `--dashboard-password` sets your own, `--dashboard-user` the user (default `admin`).

With your own Traefik, `lf traefik dashboard` tunnels to the entrypoint of the router serving the dashboard on a domain, and sends that domain (TLS name and Host), so its login applies. Without such a router, `--port 8080` tunnels to its API port (api.insecure).

**Using a Traefik you already run.** If your own Traefik holds 80/443, landfall installs no second one:

```sh
lf traefik use -s vps                          # finds the container on :80/:443
lf traefik use proxy-traefik-1 -s vps          # or name it
```

- landfall reads network, HTTPS entrypoint and cert resolver from the container's flags. For a file-configured Traefik, pass `--network proxy --entrypoint websecure --resolver letsencrypt`.
- The choice is stored in `/opt/landfall/proxy.env`. landfall does not change that Traefik. The exceptions are `lf traefik access-log on|off` ([Monitoring](monitoring.md#traffic)) and `lf traefik strict-tls on|off` (below), when you run them.
- `lf traefik use` and `lf traefik status` connect to port 443 with a made-up hostname. If your Traefik answers with its self-signed default certificate, they warn: browsers show a certificate warning for every hostname no site serves.
- Your containers behind it (Compose projects with `traefik.http.routers.*.rule` labels) show in `lf ls` and the web UI as "not deployed by landfall", with domains and folder. landfall never touches them.
- Deploying one of their domains warns: Traefik would send visitors to only one.
- `lf adopt <project>` turns one into a site (see [Running without landfall](deploy.md#running-without-landfall)).

**Refusing unknown hosts on your own Traefik.** Without `sniStrict`, your Traefik answers a hostname no site serves with its self-signed `TRAEFIK DEFAULT CERT`. With a wildcard DNS record, any typo then shows a certificate warning. `lf traefik strict-tls` turns `sniStrict` on, like landfall's own Traefik:

```sh
lf traefik strict-tls -s vps                   # what port 443 answers for an unknown hostname
lf traefik strict-tls on -s vps                # refuse them; browsers say the site cannot be reached
lf traefik strict-tls off -s vps               # answer them with the default certificate again
```

- `on` writes `landfall-tls.yml` into the folder of Traefik's file provider (`--providers.file.directory`).
- Without a file provider, it first adds `--providers.file.directory=/etc/traefik/dynamic`, `--providers.file.watch=true` and the volume `./dynamic:/etc/traefik/dynamic:ro` to the compose file. It shows the diff, asks, and recreates the container.
- With a watched folder, Traefik reloads the file by itself. Without `--providers.file.watch`, landfall restarts the container.
- `off` removes only `landfall-tls.yml`. The file provider stays.
- landfall refuses when another file already sets `tls.options.default`, or when Traefik reads a config file (`--configfile`, a mounted `traefik.yml`). Set `sniStrict: true` there yourself.
- Every change is journaled. `lf undo` puts the files back.
- landfall's own Traefik always refuses unknown hosts. `on` changes nothing there.

**Removing Traefik.** `lf traefik rm` stops landfall's Traefik and removes its config. Sites stay, unreachable until `lf undo` or `lf traefik setup`. Certificates stay unless `--certs`. After `traefik use`, it only detaches sites from your Traefik, which keeps running.
