# Deploy a site

Point the domain's A/AAAA record at the server first. Let's Encrypt needs to reach ports 80 and 443.
No domain yet? Leave out `-d`. landfall offers `<name>.<ip-with-dashes>.sslip.io` (`-y` accepts it) and the site has HTTPS right away.

| kind | when | how |
|---|---|---|
| **compose** | the folder has a `compose.yaml` that runs an app (one service builds or serves HTTP) | Uploads the folder and runs it as one Compose project. See [Compose sites](compose.md). |
| **static** | no compose file, no Dockerfile | Uploads the folder and serves it with `nginx:alpine` (gzip, long cache headers for assets). The folder is where the site generator builds to, even before the first build (Vite/Astro `dist/` or its `outDir`, SvelteKit/CRA/Docusaurus `build/`, Next `out/`, Gatsby/Hugo `public/`, Eleventy/Jekyll `_site/`, Nuxt `.output/public/`, Angular, MkDocs `site/`), else `.` if it has an `index.html`, else the first of `dist/ build/ out/ public/ _site/ site/` with one. Publishing a detected generator's folder, deploy runs the project's `build` script here first (saved in `.landfall.json`, so every redeploy builds again; `-b` sets another command, `--build ''` none). `lf deploy <dir>` picks another folder. `--spa` sends unknown paths to `index.html`. |
| **app** | a server, no `Dockerfile` | landfall writes a Dockerfile, builds it on the server (so native modules match Linux) and passes `PORT`. **Node.js**: Next.js (a `start` script like `node server.ts` runs as its custom server), Nuxt (`nuxt build`), TanStack Start, SolidStart, SvelteKit with `adapter-node`, Astro with `@astrojs/node`, React Router / Remix, Angular SSR, any `start` script that isn't a dev server, or a server dependency (Express, Fastify, Hono, NestJS, `ws`, Socket.IO…) with `server.js`/`index.js`/`main`; Node from `.nvmrc` / `.node-version`, else the newest maintained major `engines.node` allows (24 when it does), the lockfile's package manager (else `packageManager`) at the version `packageManager` pins, via corepack, `HOST=0.0.0.0`, port 3000. **Bun**: the same, on Bun's image, for a `bun.lock`, `bunfig.toml`, `@types/bun` or a start command with `bun`; it also runs `index.ts`/`server.ts` with a server dependency or `Bun.serve`. **Python** (Django, FastAPI, Flask, Starlette, Quart, Sanic, Streamlit; pip, uv, Poetry, Pipenv; 8000), **Go** (8080), **Rust** (8080), **Java/Kotlin** (Spring Boot, Quarkus, Micronaut, Ktor…; Maven or Gradle, the JDK the build asks for; 8080), **.NET** (8080), **Ruby** (Rails, Rack; 3000), **PHP** (Laravel, Symfony, plain `index.php`; Apache; 80), **Elixir/Phoenix** (4000). A `Procfile` `web:` line names the start command. Websockets pass through Traefik as is. `--start 'cmd'` makes any folder one, `--build` changes the build (`''` for none), `--port` the port, `--static` publishes static files instead, `--volume /app/data` keeps a folder across deploys (a named volume; Rails on SQLite gets `/app/storage`; `--volume ''` for none), `--worker` runs it without a port or domain (a bot, a queue consumer); all saved to `.landfall.json`. `lf init` writes the Dockerfile into the project to change it. |
| **dockerfile** | the folder has a `Dockerfile` | Uploads the folder and builds it on the server. The port comes from the last `EXPOSE` with a number, else `--port` (default 3000, with a warning: nothing may listen there). `--static` forces static. |
| **image** | `--image ghcr.io/me/app:1.2` | Pulls the image and runs it. Traefik routes the port the image `EXPOSE`s (`--port` picks another). An image that exposes no port runs as a worker, without a domain. `-e`, `--dotenv` and `--volume` work as for apps. A private registry needs `lf registry login` once. An image only this machine's Docker has is sent there (see below). |

```sh
cd my-site
lf deploy -d example.com -d www.example.com -s vps      # static, name = folder name (-n to override)
lf deploy -b "npm run build"                            # build locally first (a detected Vite/Astro/… build runs anyway)
lf deploy --start "node server.js" --port 8080          # an app: landfall writes its Dockerfile (Node.js, Python, Go, Java…)
lf deploy --start "python bot.py" --worker --volume /app/data   # a worker, no domain; /app/data outlives deploys
lf deploy -d app.example.com -e DATABASE_URL=postgres://… --dotenv .env.production   # Dockerfile app
lf deploy -n api --image ghcr.io/me/api:1.4 -d api.example.com                        # image: routes the port it EXPOSEs
lf deploy -n api --image ghcr.io/me/api:1.5                                            # later: the new tag replaces the old one
lf deploy -n app --image myapp:dev                                                     # an image built here: sent without a registry
lf deploy --no-domain                                   # no domain yet: reach it with lf tunnel, add one later with lf domains --add
lf deploy -s box                                        # box has no Traefik (lf setup --minimal): deployed with no domain, like --no-domain
lf deploy                                               # later: redeploy using ./.landfall.json
```

A compose file can hold only what the app needs, like Redis or Postgres, while the app itself has no service in it.
landfall then deploys the app (its Dockerfile, or the one landfall writes) and runs those services beside it.
The app's service is called `app` (or `web` when `app` is taken) and depends on them.
It reaches them by service name, like `redis://redis:6379`.
Their `ports:` are dropped, so a database is not open on the server's public address; `lf tunnel <site> redis --port 6379` reaches one.
Their `${VARS}` come from the site's `.env`, as in any Compose site.
`-f docker-compose.yml` (or `compose` in `.landfall.json`) deploys the file on its own instead.

```sh
# Next.js app plus docker-compose.yml with redis: the app is built, redis runs beside it
lf deploy -d app.example.com
```

The first deploy writes `.landfall.json`. Commit it:

```json
{ "name": "my-site", "server": "vps", "domains": ["example.com", "www.example.com"] }
```

A Node project can keep these settings in `package.json` instead, under `"landfall"`.
Then the deploy writes `.landfall.json` only for what differs:

```json
{ "name": "my-site", "landfall": { "name": "my-site", "server": "vps", "domains": ["example.com"] } }
```

Local `.env*` files are never uploaded: each site has its own `.env` on the server. Pass variables with
`-e`/`--dotenv`, or later with `lf env`. `--local-env` takes what the project asks for (below) and the site's `.env`
lacks from the project's own `.env`, nothing else; an empty answer to the question takes it too. `--dotenv -` reads the lines from stdin, so secrets stay out of `ps`.
A variable `compose.yaml` requires (`${ADMIN_PASSWORD:?…}`) that the site's `.env` lacks is asked for before the
upload (with `-y` the deploy stops there), and `lf ui` shows a field for each in its deploy dialog. The keys of a
`.env.example` (or `.env.sample`, `.env.template`, `.env.dist`) count too, for every kind but static and for a Compose
project with an `env_file`: an empty one is asked for (Enter leaves it empty), one with a value is only listed, never sent.
`lf env` hides the values unless you pass `--reveal`, and so does the **Edit** dialog in `lf ui` until you click
**Show values**. The `.env` itself stays a plain file next to `compose.yaml`, so `docker compose` reads it without landfall.

Secrets that should not sit in the environment (keys, certificates, passwords) go in files instead: `lf secret DB_PASSWORD=…`
or `lf secret --file TLS_KEY=./key.pem` writes `.secrets/<NAME>` next to the site's `.env` (folder 0700). An app, Dockerfile
or image site gets each one at `/run/secrets/<NAME>`. A `compose.yaml` names the ones it uses with plain Compose secrets,
so the same file works locally with your own `.secrets/` folder (keep it out of git; landfall never uploads it):

```yaml
services:
  app:
    secrets: [DB_PASSWORD]
secrets:
  DB_PASSWORD:
    file: ./.secrets/DB_PASSWORD
```

`lf secret` lists names and sizes, never values. Changing one restarts the services that mount it; `lf undo` puts the old one back.
Changed something locally? Run `lf deploy` again (or **Redeploy** in `lf ui`). When both sides have `rsync`, a redeploy sends
only the files that changed and copies the rest from the live release on the server (files you removed stay
removed); otherwise it uploads the whole folder. Either way it becomes a new release, so `lf rollback` still goes back.
`--keep 10` keeps more releases. A deploy is refused when another Compose project on the server already uses the
site's project name, since `docker compose` would otherwise take over its containers.

A deploy changes nothing live until the new release is built and pulled. If its containers then do not start,
the previous release runs again with its old `.env` (new `-e` values are staged in `.env.new` until then), the
failed release folder and its images are removed, and the deploy fails with the error; its journal line is
marked undone. Only one deploy of a site runs at a time: a second one stops with `another deploy of <site> is
running (<who>)`; a lock left by a cut-off deploy expires after an hour. Release ids come from the server's
clock, so deploys from machines with skewed clocks still sort. `lf sites info` shows each release's git commit
and branch (`, uncommitted changes` when the tree was dirty) and who deployed it.

`.landfall.json` from a cloned repository may name a server you do not have (`lf server ls`): deploy asks
before sending the project there. A server landfall has not set up is offered `lf setup` first. When ssh
cannot connect at all, deploy says why (`cannot connect to <host>: <ssh's last line>`).

`--build-local` builds the images on this machine instead of the server, for the server's platform
(`uname -m`, via `docker build --platform`), and loads them there with `docker save | gzip | ssh docker load`.
Useful when the server is small or has no network for the build. It needs Docker running locally (cross-platform
builds need QEMU/binfmt, which Docker Desktop has), and builds that use `ssh`, `secrets`, `additional_contexts`,
`platforms` or a remote context still build on the server. The images get the same `<site>-<service>:<release>`
tags, so rollbacks and cleanup work as usual. It is saved to `.landfall.json` (`--no-build-local` builds on the
server again); in `lf ui` it is the deploy dialog's "Build them on this machine" box.

## Hooks

`package.json` can name scripts to run along a deploy: tests before it, migrations in the new release, a smoke test after the start.
See [Lifecycle hooks](hooks.md).

```sh
# deploy, but without the verify hook
lf deploy --skip-hook verify
```

## Deploy an image

`--image` deploys a prebuilt image without a compose file.
landfall writes a one-service `compose.yaml` for it and routes it like any other site.
Traefik routes the port the image declares with `EXPOSE`; `--port` overrides it.
An image with no `EXPOSE` runs as a worker: no port, no domain.
Deploying a new tag replaces the running container; the old release stays for `lf rollback`.
In the web UI, **Deploy folder…** has a link for an image, and image sites have a **Redeploy** button.

```sh
lf deploy -n uptime --image louislam/uptime-kuma:1 --volume /app/data -d status.example.com   # an off-the-shelf app with its data kept
lf deploy -n api --image ghcr.io/me/api:1.4 -e DATABASE_URL=postgres://… --port 8080          # env and a port the image does not EXPOSE
```

A private registry needs a login on the server once.
The credentials go to the deploy user's `~/.docker/config.json` on the server, base64 encoded, not encrypted.
Use a token that can only read packages.

```sh
echo "$GHCR_TOKEN" | lf registry login ghcr.io -u me --password-stdin -s vps   # pull private images from ghcr.io
lf registries -s vps                                                           # the registries docker on vps is logged in to
lf registry logout ghcr.io -s vps                                              # remove the stored credentials
```

### Images from this machine

An image that only this machine's Docker has goes to the server without a registry.
landfall sends it with `docker save | gzip | ssh docker load` and shows how much it sent.
It does so on its own for an image built here and never pushed (one without a repo digest).
`--send-image` sends any local image; `--no-send-image` makes the server pull it instead.
Both are saved to `.landfall.json`.

```sh
docker build -t myapp:dev .
lf deploy -n app --image myapp:dev -d app.example.com   # sends myapp:dev to the server and runs it
lf deploy --send-image                                  # pick one of this machine's images from a list
```

Before sending, landfall compares the image's platform with the server's (`uname -m`).
An `arm64` image for an `amd64` server fails with the `docker build --platform` command that fixes it.
Each deploy sends the whole image again: Docker does not reuse layers across `docker load`.
On the server the image is tagged `<site>-app:<release>`, so a redeploy of the same local tag replaces the container.
Old releases' images go with the releases (`--keep`), like images built with `--build-local`.

## Deploy from CI

`lf deploy` runs unattended with `-y`: it needs an ssh key that logs in to the server landfall set up, and the
server named so ssh reaches it without your `~/.ssh/config`:

```yaml
# .github/workflows/deploy.yml
on: { push: { branches: [main] } }
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: webfactory/ssh-agent@v0.9.0
        with: { ssh-private-key: "${{ secrets.DEPLOY_KEY }}" }
      - run: ssh-keyscan -H 203.0.113.10 >> ~/.ssh/known_hosts
      - run: npx landfall deploy -s deploy@203.0.113.10 -y
```

- Add the key's public half to `~/.ssh/authorized_keys` of the user landfall logs in as (the one in `lf server ls`).
- `-s <that user>@<host>` overrides `server` in `.landfall.json`; domains, name and the rest still come from it.
- Secrets go in with `--dotenv -` from a CI secret (`echo "$PROD_ENV" | lf deploy --dotenv - -y`), never as `-e` on the command line.
- The release records the commit CI checked out, and the journal names the runner as who deployed it.
- A failed start puts the previous release back and exits non-zero, so the job fails without taking the site down.

## What gets uploaded

The deployed folder, without `.git`, `node_modules`, `.DS_Store`, `.landfall.json`, `.env`, `.env.*`, `.secrets` and
`compose.override.*` (plus the runtime's build caches for an app, e.g. `.venv` or `target`). To change that, list
patterns under `exclude` and `include` in `.landfall.json`. They use `.gitignore` syntax, with paths relative to its
folder. `include` wins over everything else, so it can bring back a default or what `.gitignore` leaves out:

```json
{
  "name": "blog",
  "exclude": ["data/", "*.sqlite", "/docs/drafts/"],
  "include": ["node_modules"]
}
```

A deploy keeps both lists when it saves `.landfall.json`.

`.gitignore` does not apply by default: a static site uploads `dist/`, which is usually in it. `lf deploy --gitignore`
also leaves out what the `.gitignore` files inside the deployed folder ignore, and is saved in `.landfall.json`
(`--no-gitignore` turns it off). An ignored folder is never entered, so nothing inside it comes back: include the
folder, not a file inside it.

The first deploy of a site prints the upload's size and its largest entries. Above 100 MB it asks first (`-y` skips that).

## Environments

A project can have named environments (staging, preview…). Each is deployed as its own ordinary site, with its
own `.env`, secrets, domains and releases, on the same server or another one:

```sh
lf deploy -E staging -d staging.example.com -s test-vps   # site shop-staging; saved under environments.staging
lf env -E staging API_URL=https://staging-api.example.com # every site command takes -E (or LANDFALL_ENV=staging)
lf logs -E staging
```

```json
{
  "name": "shop", "server": "vps", "domains": ["shop.example.com"],
  "environments": { "staging": { "server": "test-vps", "domains": ["staging.example.com"] } }
}
```

An environment takes the project's settings and changes what its block names: `name` (default `<name>-<env>`),
`server`, any other setting such as `compose: "compose.staging.yaml"`. Domains are never inherited. Without
`-E`, everything works on the project itself. On the server an environment is a site like any other: nothing
there knows about environments, and deleting `.landfall.json` loses nothing.

A compose site can change per environment with a standard override file next to its compose file:
`compose.staging.yaml` beside `compose.yaml` (or `docker-compose.staging.yml` beside `docker-compose.yml`).
`lf deploy -E staging` merges it in, as `docker compose -f compose.yaml -f compose.staging.yaml` does
locally. The release's `compose.yaml` on the server holds the merged result (variables left as `${...}`), so
`docker compose up` there runs what was deployed.

```yaml
# compose.staging.yaml
services:
  web:
    environment: { LOG_LEVEL: debug }
  mailpit:
    image: axllent/mailpit
```

## Running without landfall

Nothing on the server depends on the CLI. Each site is a folder you can drive with plain `docker compose`:

```sh
cd -P /opt/landfall/sites/blog/current          # -P: into the release folder itself
docker compose ps                               # or logs -f, restart, up -d, down
cd /opt/landfall/sites/blog                     # roll back by hand: point current at an older release …
ln -sfn releases/20260122143005 current
cd -P current && docker compose up -d           # … and bring it up
```

Everything landfall adds is in the release's `compose.override.yaml`, plain Compose: the project name, the
image tags, the Traefik labels (a router `<site>_<service>` per service, `<site>_<service>_<port>` per extra
route), the proxy network and `ports: !reset []`. To leave landfall, copy your `compose.yaml` and that override
to any host with Docker and run `docker compose up -d`, behind your own Traefik with the same labels (or drop
the override and publish ports yourself). `lf eject` does this in your project: it writes the live release's
labels into `compose.traefik.yaml` (images are built from source again, volumes are Docker's own), for
`docker compose -f compose.yaml -f compose.traefik.yaml up -d`; `--network`, `--entrypoint` and `--resolver`
match your Traefik. `x-landfall` is a Compose extension field: `docker compose` ignores it.

`/opt/landfall/README` on the server explains the same. A project you started yourself behind landfall's
Traefik shows up in `lf sites` as not deployed by landfall; `lf adopt <project>` makes it a site that `lf` can
list, show logs for, restart and remove, while it keeps running from its own folder.

## Main domains

```sh
lf server domain vps example.com            # checks DNS for example.com and *.example.com
lf deploy                                   # site "blog" → blog.example.com
lf deploy -d shop                           # no dot → shop.example.com
lf domains blog --add www                   # www.example.com
lf deploy -d @                              # @ → example.com itself
lf domains blog --add @                     # blog also serves example.com
lf server domain vps --add other.org        # more main domains; the first stays primary
lf server domain vps --primary other.org    # switch the primary
lf server domain vps --rm other.org         # drop one; --clear drops all (back to sslip.io)
lf server domain vps --tunnel-only          # new sites get no domain unless -d: reach them with lf tunnel (--no-tunnel-only undoes)
```

`server domain` prints the A records to add: one for the domain and a wildcard `*.example.com`. With those in
place, every new site resolves without touching DNS again. For non-primary main domains, write the full name (`-d shop.other.org`).

A domain belongs to one site. Giving it to another one (`lf deploy -d @`, `lf domains shop --add example.com`)
asks, then moves it: the old site keeps its other domains. A move that would leave a site with none is refused,
and so is a redeploy whose domain comes only from `.landfall.json` (pass `-d` to move it on purpose).
