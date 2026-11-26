# Scaling and load balancing

Every feature on this page is opt-in.
A site that uses none of these keys or commands deploys as before: one container per service, recreated on each deploy.

All keys go into a service's `x-landfall` in compose.yaml ([Compose sites](compose.md)).

## Replicas

Run more than one container of a service. Traefik balances requests over all of them.

```yaml
services:
  web:
    build: .
    deploy:
      replicas: 3          # or the older scale: 3
    x-landfall:
      port: 3000
```

`lf scale` changes the count without a new deploy:

```sh
# show each service's count, where it comes from, and its update mode
lf scale blog
# run 3 containers of web and 2 of worker
lf scale blog web=3 worker=2
# go back to the count in compose.yaml
lf scale blog web=default
```

- The count goes into the release's `compose.override.yaml`, so `docker compose up -d` on the server keeps it.
- It stays for later deploys and rollbacks. `lf undo` reverts it.
- A count of 0 stops the service. Its data stays.
- A service with `container_name` or published ports (`x-landfall.publish`) runs only once. landfall refuses more.
- `lf scale --json` prints `{site, services}`: each service with `replicas`, `source` (`lf scale`, `compose.yaml` or `default`), `update`, and `weight` and `split` when it is in a traffic split.

## Rolling deploys

By default a deploy recreates a changed service: it is down for a moment.
With `update: rolling`, the new containers start beside the old ones first.

```yaml
x-landfall:
  port: 3000
  update: rolling
```

On each deploy, for each rolling service:

1. The other services start first (a new database, a cache).
2. If its configuration or image is unchanged, nothing happens.
3. New containers start beside the running ones, as many as it should run.
4. landfall waits until they run and, if they have a healthcheck, are healthy (up to 5 minutes).
5. The old containers stop (30 seconds to finish) and are removed.

If the new containers do not get ready, they are removed, the old ones keep serving, and the release goes back.

- Give the service a healthcheck (in compose.yaml or the image). Without one, "ready" only means "started".
- A rolling service needs `x-landfall.port`. It may not set `container_name`, publish ports or have its own Traefik labels.
- `lf scale` and `lf weight` never roll a service: they change no configuration that needs new containers.

## Load balancer options

```yaml
x-landfall:
  port: 3000
  sticky: true                     # a cookie pins each client to one container; sticky: my_cookie names it
  healthcheck: /health             # Traefik sends nothing to a container that fails it
  # or, with its own interval and timeout:
  # healthcheck:
  #   path: /health
  #   interval: 10s
  #   timeout: 3s
  ratelimit: 20                    # requests per second per client IP
  # or, with a burst:
  # ratelimit:
  #   average: 20
  #   burst: 50
  headers:                         # response headers; an empty value removes one
    X-Frame-Options: DENY
  compress: true                   # gzip and brotli
  retry: 3                         # retries a request when a container cannot be reached
```

- Routes take the same keys: `routes: [{ port: 3001, subdomain: admin, ratelimit: 5 }]`.
- Middlewares run in this order: `allow`, `ratelimit`, the login (`lf auth`), `headers`, `compress`, `retry`.
- Traefik's `healthcheck` is separate from Docker's `healthcheck:`. Docker's decides when a container is ready; Traefik's decides where requests go.

## Traffic split

Two or more services with `weight` on the same domains share their traffic by weight.
Use it to send a few requests to a new version (a canary).

```yaml
services:
  stable:
    image: ghcr.io/me/app:1.4
    x-landfall:
      port: 3000
      weight: 90
  canary:
    image: ghcr.io/me/app:1.5
    x-landfall:
      port: 3000
      weight: 10
```

```sh
# show the split
lf weight blog
# send everything to canary
lf weight blog stable=0 canary=100
```

- Weights are 0 to 1000. A service gets its weight divided by the sum. At least one weight must be above 0.
- `lf weight` changes only Traefik's routing: no container restarts. `lf undo` reverts it.
- The split is a file in `/opt/landfall/traefik/dynamic`, read by Traefik's file provider.
  It needs landfall's own Traefik (`lf traefik setup`). `lf eject` refuses a site with a split.
- `sticky` keeps a client on one side of the split. Traefik skips an unhealthy side only when every side has a `healthcheck`.
- The services share one router, the one of the first service by name. Its `allow`, middlewares and login apply to the whole split.
  Another service in the split may leave out `allow`, `ratelimit`, `headers`, `compress` and `retry`, or set them to the same values. Different values are an error.
- `lf auth <site> --route <service>` with any service of the split sets the login of the shared router.

### Force a variant

`match` sends requests with a cookie or a header to one service of the split, whatever the weights.

```yaml
services:
  a:
    image: ghcr.io/me/app:1.4
    x-landfall:
      port: 3000
      weight: 100
  b:
    image: ghcr.io/me/app:1.5
    x-landfall:
      port: 3000
      weight: 0                         # no random share: only matching requests reach b
      match:
        cookie: variant=b               # or header: X-Variant=b, or both
```

```sh
# reach b on purpose
curl -H 'Cookie: variant=b' https://blog.example.com
curl -H 'X-Variant: b' https://blog.example.com
```

- A request matches when it has the cookie or the header with that value. Names have letters, digits, `-` and `_`. Values may also have dots.
- `match` needs `weight` on the same service. With `weight: 0` only matching requests reach it: a preview for testers before any visitor sees it.
- It is an extra Traefik router (`<site>_<service>-match`). Its rule is longer, so Traefik tries it before the split's router.
- It uses the split's middlewares: `allow`, the login and the others still apply. A cookie never skips the login.
- Your app sets the cookie, for example on an opt-in page. landfall only reads it.
- `lf weight <site>` shows each service's `match`.

### Compare the variants

`lf weight --stats` shows what each service of the split served, from Traefik's access log.

```sh
# the last 24 hours
lf weight blog --stats
# the last hour, as JSON
lf weight blog --stats --since 1h --json
```

```
SERVICE  WEIGHT     REQUESTS     MATCHED  4XX     5XX       P50   P95
a        90 (90%)   9120 (91%)   -        12 (0%) 3 (0%)    41ms  180ms
b        10 (10%)   893 (9%)     41       2 (0%)  14 (2%)   45ms  420ms
```

- REQUESTS is what reached the service, with its share of the split. MATCHED counts the requests its `match` sent.
- 4XX and 5XX count status codes; the percentage is of the service's requests.
- P50 and P95 are response times, from a histogram: within about 20%.
- `--since` takes `30m`, `24h` or `7d`, up to what the container log holds (`lf log-limit`).
- The counts are read on the server with awk; only the sums cross ssh. Traefik must log JSON (`lf traefik access-log` turns it on for your own Traefik).

### A/B testing

The pieces above make a simple A/B test.

1. Deploy two services of the same app on the same domains, with `weight` (for example 50 and 50).
2. Add `sticky: true` to both services, so each visitor stays on one side.
3. Tell each side which one it is, for example with `environment: { VARIANT: b }`, and send that to your analytics.
4. Give your team `match` to see either side on purpose.
5. Watch errors and response times with `lf weight <site> --stats`.
6. Pick the winner: `lf weight blog a=0 b=100`, then deploy it as the only service.

landfall splits traffic by chance and counts requests. It does not target users or measure conversions. Use a feature flag service or your analytics for that.

## Limits

- A traffic split, `match` and `--stats` need landfall's own Traefik (`lf traefik setup`). `match` needs Traefik v3.

- `lf restart <site> <service>` restarts every container of the service at once.
- `lf tunnel` reaches one container of a service.
- A rolling deploy stops old containers with SIGTERM. Requests still running on them can fail unless the app finishes them first. `retry` hides most of these.
