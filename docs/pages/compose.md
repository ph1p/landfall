# Compose sites

A site can be a whole Compose project: the app, its database, a worker. The same `compose.yaml` runs locally
with `docker compose up` and on the server with `lf deploy`. `lf init` writes one for an existing project:

```sh
lf init --postgres                 # compose.yaml (app + db + volume) and compose.override.yaml (local ports)
echo POSTGRES_PASSWORD=dev > .env  # local only
docker compose up --build          # http://localhost:3000
lf deploy -e POSTGRES_PASSWORD=$(openssl rand -hex 16)   # the first time; later just lf deploy
```

A compose file with only a database or a cache in it, next to an app, is not a Compose site.
landfall deploys the app and runs those services beside it (see [Deploy a site](deploy.md)).

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

- **`x-landfall`** on a service routes it: `port` is where Traefik sends requests, `domains` gives it its own
  (a bare name or `@` works as in `-d`). One routed service without `domains` serves the site's domains, which
  `-d` and `lf domains` manage. Services without `x-landfall` (the database) stay off Traefik's network.
- **More ports of one service**: `routes` sends further ports to their own domains, and `private` names ports
  that are never routed (reach them with `lf tunnel <site> <name>`). `subdomain: admin` serves
  `admin.<domain>` for every domain of the site, and follows `lf domains`:

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

  A service with only private ports opens the one named like it (else its first) with `lf tunnel <site> <service>`.

- **Only from some addresses**: `allow` on `x-landfall` (for its `port`) or on a route takes IP addresses and
  CIDR ranges; Traefik answers everyone else with 403 (an `ipallowlist` middleware, checked before any login):

  ```yaml
  x-landfall:
    port: 3000
    routes:
      - { port: 3001, subdomain: admin, allow: [10.0.0.0/8, 203.0.113.7] }
  ```

  A route can also have its own login instead of the site's, or none: `lf auth -r admin -u anna`,
  `lf auth -r hooks --public` ([Day-to-day](sites.md)).

- **A compose.yaml without `x-landfall` deploys as it is.** landfall routes the HTTP ports its services
  publish (`ports:`) or `expose:`: the first service with `build:` (else one on a usual web port) gets the
  site's domains with its first port, every other port a subdomain (`<service>` or `<service>-<port>`).
  Side tools (Adminer, phpMyAdmin, pgAdmin, Mailpit, MailHog, Portainer, Dozzle, Swagger UI…) never get the
  main domains, even when they come first.
  Databases, mail and other non-HTTP ports stay internal. `lf deploy` prints this route plan and marks new
  routes; every routed port is public, so check it. `lf init` writes the plan down as `x-landfall` in your
  compose.yaml (shows the diff), and any `x-landfall` turns this off for the whole file.
- **Published `ports:` stay local.** A published port would bypass Traefik and the firewall, so on the server
  the release's override resets them (`ports: !reset []`). Your compose.yaml is not changed, and `lf init` moves
  them to `compose.override.yaml`, which `docker compose` merges locally and `lf deploy` leaves out. With
  `x-landfall` set, `ports:` is refused instead; to publish a port on the server anyway, add
  `x-landfall: { publish: true }` to that service.
- **Named volumes keep your data** across deploys and rollbacks. `lf sites rm` keeps them, so deploying the
  site again finds its data; `lf sites rm --volumes` deletes them (each backed up first, `lf undo` brings them back). `lf volume` backs them up and copies them
  to and from your machine ([Volumes and backups](volumes.md)). Each deploy gets a new release folder, so
  a writable bind mount like `./data` is refused: write data to a named volume (read-only `./dist:…:ro` is fine).
- **Images built on the server** are tagged `<site>-<service>:<release>`, so a rollback runs the exact image again.
- Variables in `compose.yaml` come from the site's `.env` on the server (`-e`, `--dotenv`, `lf env`).
  `${VAR:?}` makes a missing one fail the deploy before anything changes.
- Your own `traefik.*` labels win: a service with its own router keeps them and landfall adds only the network.
- `-f other.yaml` deploys another file from the project folder; it is saved in `.landfall.json`. Sites need Docker Compose 2.24 or newer
  on the server (`lf update --compose`).

The static, Dockerfile and image kinds are Compose sites too: landfall writes their `compose.yaml` for you.
