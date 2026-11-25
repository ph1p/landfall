# Compose sites

A site can be a whole Compose project: app, database, worker.
The same `compose.yaml` runs locally (`docker compose up`) and on the server (`lf deploy`).
`lf init` writes one for an existing project:

```sh
lf init --postgres                 # compose.yaml (app + db + volume) and compose.override.yaml (local ports)
echo POSTGRES_PASSWORD=dev > .env  # local only
docker compose up --build          # http://localhost:3000
lf deploy -e POSTGRES_PASSWORD=$(openssl rand -hex 16)   # the first time; later just lf deploy
```

A compose file next to an app holding only a database or cache is not a Compose site:
landfall deploys the app and runs those services beside it ([Deploy a site](deploy.md)).
Static, Dockerfile and image sites are Compose sites too; landfall writes their `compose.yaml`.

## Example

```yaml
services:
  app:
    build: .
    env_file: [{ path: .env, required: false }]
    environment:
      DATABASE_URL: postgres://app:${POSTGRES_PASSWORD}@db:5432/app
    depends_on: { db: { condition: service_healthy } }
    x-landfall:
      port: 3000                       # Traefik serves the site's domains from here
  admin:
    image: adminer
    x-landfall: { port: 8080, domains: [db.example.com] }   # its own domains
  db:
    image: postgres:17-alpine
    environment: { POSTGRES_USER: app, POSTGRES_DB: app, POSTGRES_PASSWORD: "${POSTGRES_PASSWORD:?}" }
    volumes: [db:/var/lib/postgresql/data]
    healthcheck: { test: pg_isready -U app, interval: 5s }
volumes:
  db:
```

## Routing with `x-landfall`

- `port`: where Traefik sends requests.
- `domains`: the service's own domains (a bare name or `@` works as in `-d`).
- One routed service without `domains` serves the site's domains, which `-d` and `lf domains` manage.
- Services without `x-landfall` (the database) stay off Traefik's network.

### More ports of one service

- `routes` sends further ports to their own domains.
- `subdomain: admin` serves `admin.<domain>` for every site domain, following `lf domains`.
- `private` names ports never routed; reach them with `lf tunnel <site> <name>`.

```yaml
x-landfall:
  port: 3000                                # the site's domains
  routes:
    - { port: 3001, subdomain: admin }      # admin.<each site domain>
    - { port: 9000, domains: [s3.example.com] }
  private:
    cms: 3002                               # lf tunnel blog cms
    manage: { port: 3003, path: /manage }   # lf tunnel blog manage opens http://localhost:3003/manage
```

For a service with only private ports, `lf tunnel <site> <service>` opens the one named like it, else its first.

### Only from some addresses

`allow` on `x-landfall` (for its `port`) or on a route takes IP addresses and CIDR ranges.
Traefik answers everyone else with 403 (an `ipallowlist` middleware, checked before any login).

```yaml
x-landfall:
  port: 3000
  routes:
    - { port: 3001, subdomain: admin, allow: [10.0.0.0/8, 203.0.113.7] }
```

A route can also have its own login, or none: `lf auth -r admin -u anna`, `lf auth -r hooks --public` ([Day-to-day](sites.md)).

### Replicas, rolling deploys and Traefik options

These keys are optional. Without them a service runs once and is recreated on each deploy.

- `update: rolling`: new containers get ready before the old ones stop.
- `sticky`, `healthcheck`, `ratelimit`, `headers`, `compress`, `retry`: Traefik's load balancer and middlewares, on `x-landfall` or a route.
- `weight`: services on the same domains share their traffic by weight.
- `match`: a cookie or header that sends a request to one service of a split, like `match: { cookie: variant=b }`.
- `deploy.replicas` runs more containers; `lf scale` changes the count.

```yaml
x-landfall:
  port: 3000
  update: rolling
  healthcheck: /health
  ratelimit: 20
```

See [Scaling and load balancing](scaling.md).

## A compose.yaml without `x-landfall`

It deploys as it is. landfall routes the HTTP ports its services publish (`ports:`) or `expose:`.

- The first service with `build:` (else one on a usual web port) gets the site's domains on its first port.
- Every other port gets a subdomain: `<service>` or `<service>-<port>`.
- Side tools never get the main domains, even when they come first: Adminer, phpMyAdmin, pgAdmin, Mailpit, MailHog, Portainer, Dozzle, Swagger UI…
- Databases, mail and other non-HTTP ports stay internal.

`lf deploy` prints this route plan and marks new routes. Every routed port is public: check it.
`lf init` writes the plan into compose.yaml as `x-landfall` (showing the diff). Any `x-landfall` turns this off for the whole file.

## Published ports

Published `ports:` stay local, since they would bypass Traefik and the firewall.

- On the server, the release's override resets them (`ports: !reset []`). Your compose.yaml is unchanged.
- `lf init` moves them to `compose.override.yaml`, which `docker compose` merges locally and `lf deploy` leaves out.
- With `x-landfall` set, `ports:` is refused. To publish one on the server anyway, add `x-landfall: { publish: true }` to that service.

## Data and volumes

Named volumes keep your data across deploys and rollbacks.

- `lf sites rm` keeps them, so a redeploy finds the data. `--volumes` deletes them, each backed up first; `lf undo` brings them back.
- `lf volume` backs them up and copies them to and from your machine ([Volumes and backups](volumes.md)).
- Each deploy gets a new release folder, so a writable bind mount like `./data` is refused: use a named volume. Read-only `./dist:…:ro` is fine.

## Images, variables and labels

- Images built on the server are tagged `<site>-<service>:<release>`, so a rollback runs the exact image again.
- Variables in `compose.yaml` come from the site's `.env` on the server (`-e`, `--dotenv`, `lf env`). `${VAR:?}` makes a missing one fail the deploy before anything changes.
- Your own `traefik.*` labels win. A service with its own router keeps them; landfall adds only the network.
- `-f other.yaml` deploys another file from the project folder, saved in `.landfall.json`.
- Sites need Docker Compose 2.24 or newer on the server (`lf update --compose`).
