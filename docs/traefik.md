# Traefik

```sh
lf traefik status                              # container state, routes, mode (--json)
lf traefik logs -f                             # certificate errors show up here (--access adds requests)
lf traefik setup --email you@example.com       # reconfigure (safe to re-run)
lf traefik setup --dashboard traefik           # dashboard at traefik.<main domain> behind a login; `off` removes it
lf traefik dashboard                           # the dashboard on localhost through an SSH tunnel, no domain needed
lf traefik setup --host-network                # bind 80/443 on the host
lf traefik setup --no-http3                    # turn HTTP/3 off (on by default)
```

landfall's Traefik is the container `traefik` from `/opt/landfall/traefik/docker-compose.yml`. By default Docker
publishes 80/443 to it. Sites work the same in both modes:

|                                       | ports published (default)                 | `--host-network` |
| ------------------------------------- | ----------------------------------------- | ---------------- |
| client IP in logs / `X-Forwarded-For` | real IPv4; IPv6 may show Docker's gateway | always real      |
| ufw                                   | Docker's NAT bypasses ufw for 80/443      | ufw applies      |

HTTP/3 (QUIC) is on by default: Traefik also listens on 443/udp, and browsers switch to it after their first
HTTP/2 request. Setup's firewall opens 443/udp (only with HTTP/3 on); with `--host-network` on a server whose ufw is active,
`lf traefik setup` opens 80/tcp, 443/tcp and 443/udp. `--no-http3` turns it off (remembered). In the web UI (`lf ui`)
these options are in a server's settings under Traefik → Settings….

Traefik only answers hosts it has a certificate for (`sniStrict`). A domain pointed at the server but served
by no site fails the TLS handshake, as if nothing listened there, instead of showing a 404 or Traefik's own
certificate; plain HTTP to it redirects to HTTPS and fails the same way. A new site's domain fails the same way
for the seconds until Let's Encrypt issues its certificate. Your own certificates and Traefik config go into
`/opt/landfall/traefik/dynamic/`: landfall rewrites only `landfall.yml` there. If you edit
`docker-compose.yml` by hand, `lf traefik setup` shows the diff and stops; `--force` overwrites your edits.

**Traefik's dashboard.** `lf traefik dashboard` always reaches it through an SSH tunnel: Traefik serves it on
port 8080 to the server itself only (loopback and the `web` network's gateway), never published. A Traefik set
up before this needs `lf traefik setup` once. `--dashboard <domain>` also serves it on a domain behind a login;
the password is generated and printed once (`--dashboard-password` sets your own, `--dashboard-user` the user,
default `admin`).

With your own Traefik, `lf traefik dashboard` tunnels to the entrypoint of the router that serves the dashboard
on a domain and sends that domain along (TLS name and Host), so its login still applies. Without such a router,
`--port 8080` tunnels to its API port (api.insecure).

Image, network mode, HTTP/3, e-mail, staging and dashboard are remembered per server, so re-running
`lf traefik setup` keeps them.

**Using a Traefik you already run.** If 80/443 belong to your own Traefik container, landfall does not install a second one:

```sh
lf traefik use -s vps                          # finds the container on :80/:443
lf traefik use proxy-traefik-1 -s vps   # or name it
```

Containers you run yourself behind that Traefik (compose projects with `traefik.http.routers.*.rule` labels)
show up in `lf ls` and the web UI as "not deployed by landfall", with their domains and folder. landfall
never touches them; deploying one of their domains warns, since Traefik would send visitors to only one.
`lf adopt <project>` turns one into a site (see [Running without landfall](deploy.md#running-without-landfall)).

**Removing Traefik.** `lf traefik rm` stops landfall's Traefik and takes out its config; sites stay but are
unreachable until `lf undo` or `lf traefik setup`. Certificates stay unless `--certs`. With `traefik use`, it only
makes sites stop using your Traefik, which keeps running.

landfall reads the network, HTTPS entrypoint and cert resolver from the container's flags. If your Traefik is
configured by a file, pass `--network proxy --entrypoint websecure --resolver letsencrypt`. The choice is stored
in `/opt/landfall/proxy.env`. landfall never changes that Traefik.
