# Deploy a site

Point the domain's A/AAAA record at the server first. Let's Encrypt needs ports 80 and 443.
No domain yet? Leave out `-d`: landfall offers `<name>.<ip-with-dashes>.sslip.io` (`-y` accepts it), with HTTPS right away.

```sh
cd my-site
lf deploy -d example.com -d www.example.com -s vps      # static, name = folder name (-n to override)
lf deploy -b "npm run build"                            # build locally first (a detected Vite/Astro/… build runs anyway)
lf deploy --start "node server.js" --port 8080          # an app: landfall writes its Dockerfile (Node.js, Python, Go, Java…)
lf deploy --start "python bot.py" --worker --volume /app/data   # a worker, no domain; /app/data outlives deploys
lf deploy -d app.example.com -e DATABASE_URL=postgres://… --dotenv .env.production   # Dockerfile app
lf deploy -n api --image ghcr.io/me/api:1.4 -d api.example.com                        # image: routes the port it EXPOSEs
lf deploy -n api --image ghcr.io/me/api:1.5                                            # later: the new tag replaces the old one
lf deploy --no-domain                                   # no domain yet: reach it with lf tunnel, add one later with lf domains --add
lf deploy -s box                                        # box has no Traefik (lf setup --minimal): deployed with no domain, like --no-domain
lf deploy                                               # later: redeploy using ./.landfall.json
```

## What kind of site

| kind | when | what happens |
|---|---|---|
| [**compose**](compose.md) | a `compose.yaml` that runs an app (one service builds or serves HTTP) | Runs the folder as one Compose project. |
| [**static**](#static-sites) | no compose file, no Dockerfile | Serves the folder with `nginx:alpine`. |
| [**app**](#apps-without-a-dockerfile) | a server, no `Dockerfile` | landfall writes a Dockerfile and builds it on the server. |
| [**dockerfile**](#dockerfile-sites) | a `Dockerfile` | Builds it on the server. |
| [**image**](#deploy-an-image) | `--image ghcr.io/me/app:1.2` | Pulls the image and runs it. |

All but image upload the folder.

### Static sites

nginx serves gzip and long cache headers for assets.
landfall publishes the generator's output folder, even before the first build:
Vite/Astro `dist/` (or its `outDir`), SvelteKit/CRA/Docusaurus `build/`, Next `out/`, Gatsby/Hugo `public/`,
Eleventy/Jekyll `_site/`, Nuxt `.output/public/`, Angular, MkDocs `site/`.
Else `.` if it has an `index.html`, else the first of `dist/ build/ out/ public/ _site/ site/` with one.

For a detected generator, deploy runs the project's `build` script on this machine first.
It is saved in `.landfall.json`, so every redeploy builds again.

- `-b` sets another build command; `--build ''` none.
- `lf deploy <dir>` publishes another folder.
- `--spa` sends unknown paths to `index.html`.

### Apps without a Dockerfile

landfall builds on the server, so native modules match Linux, and passes `PORT`. Websockets pass through Traefik as is.

**Node.js**: Next.js (a `start` script like `node server.ts` runs as its custom server), Nuxt (`nuxt build`),
TanStack Start, SolidStart, SvelteKit with `adapter-node`, Astro with `@astrojs/node`, React Router / Remix, Angular SSR,
any `start` script that isn't a dev server, or a server dependency (Express, Fastify, Hono, NestJS, `ws`, Socket.IO…)
with `server.js`/`index.js`/`main`.

- Node from `.nvmrc` / `.node-version`, else the newest maintained major `engines.node` allows (24 when it does).
- The lockfile's package manager (else `packageManager`) at the version `packageManager` pins, via corepack.
- `HOST=0.0.0.0`, port 3000.

**Bun**: the same, on Bun's image, for a `bun.lock`, `bunfig.toml`, `@types/bun` or a start command with `bun`.
It also runs `index.ts`/`server.ts` with a server dependency or `Bun.serve`.

Other runtimes and their port:

- **Python** (Django, FastAPI, Flask, Starlette, Quart, Sanic, Streamlit; pip, uv, Poetry, Pipenv): 8000
- **Go**, **Rust**, **.NET**: 8080
- **Java/Kotlin** (Spring Boot, Quarkus, Micronaut, Ktor…; Maven or Gradle, the JDK the build asks for): 8080
- **Ruby** (Rails, Rack): 3000
- **PHP** (Laravel, Symfony, plain `index.php`; Apache): 80
- **Elixir/Phoenix**: 4000

A `Procfile` `web:` line names the start command. Options, all saved to `.landfall.json`:

- `--start 'cmd'` makes any folder an app.
- `--build` changes the build (`''` for none), `--port` the port.
- `--static` publishes static files instead.
- `--volume /app/data` keeps a folder across deploys (a named volume; Rails on SQLite gets `/app/storage`; `--volume ''` for none).
- `--worker` runs it without a port or domain (a bot, a queue consumer).

`lf init` writes the Dockerfile into the project, to change it.

### Dockerfile sites

The port comes from the last `EXPOSE` with a number, else `--port` (default 3000, with a warning: nothing may listen there).
`--static` forces static.

### Services beside the app

A compose file can hold only the app's dependencies, like Redis or Postgres.
landfall then deploys the app (its Dockerfile, or one landfall writes) with those services beside it:

- The app's service is `app` (or `web` when `app` is taken) and depends on them.
- It reaches them by service name, like `redis://redis:6379`.
- Their `ports:` are dropped, so a database is not open on the server's public address. `lf tunnel <site> redis --port 6379` reaches one.
- Their `${VARS}` come from the site's `.env`, as in any Compose site.

`-f docker-compose.yml` (or `compose` in `.landfall.json`) deploys the file on its own instead.

```sh
# Next.js app plus docker-compose.yml with redis: the app is built, redis runs beside it
lf deploy -d app.example.com
```

## Project settings

The first deploy writes `.landfall.json`. Commit it:

```json
{
  "name": "my-site",
  "server": "vps",
  "domains": ["example.com", "www.example.com"]
}
```

A Node project can keep them in `package.json` under `"landfall"`; `.landfall.json` then holds only what differs:

```json
{
  "name": "my-site",
  "landfall": {
    "name": "my-site",
    "server": "vps",
    "domains": ["example.com"]
  }
}
```

## Environment variables

Local `.env*` files are never uploaded: each site has its own `.env` on the server.

- Pass variables with `-e`/`--dotenv`, or later with `lf env`.
- `--dotenv -` reads stdin, so secrets stay out of `ps`.
- `--local-env` takes from the project's `.env` only what the project asks for (below) and the site's `.env` lacks.

Deploy asks, before the upload, for each variable `compose.yaml` requires (`${ADMIN_PASSWORD:?…}`) that the site's `.env` lacks.
With `-y` the deploy stops there. `lf ui` shows a field for each in its deploy dialog.
An empty answer takes the local `.env` value.

Keys of a `.env.example` (or `.env.sample`, `.env.template`, `.env.dist`) count too, for every kind but static and for a Compose project with an `env_file`.
An empty key is asked for (Enter leaves it empty). A key with a value is only listed, never sent.

`lf env` hides values unless you pass `--reveal`; the `lf ui` **Edit** dialog until you click **Show values**.
The `.env` is a plain file next to `compose.yaml`, so `docker compose` reads it without landfall.

## Secrets

Keys, certificates and passwords that should not be in the environment go in files:

```sh
lf secret DB_PASSWORD=…
lf secret --file TLS_KEY=./key.pem   # from a local file
lf secret                            # names and sizes, never values
```

- Each is written to `.secrets/<NAME>` next to the site's `.env` (folder 0700).
- An app, Dockerfile or image site gets it at `/run/secrets/<NAME>`.
- Changing one restarts the services that mount it. `lf undo` puts the old one back.

A `compose.yaml` names the ones it uses with plain Compose secrets, so it also works locally with your own `.secrets/` folder.
Keep that out of git; landfall never uploads it.

```yaml
services:
  app:
    secrets: [DB_PASSWORD]
secrets:
  DB_PASSWORD:
    file: ./.secrets/DB_PASSWORD
```

## Redeploy

Run `lf deploy` again, or **Redeploy** in `lf ui`.

- With `rsync` on both sides, it sends only changed files and copies the rest from the live release (removed files stay removed). Else it uploads the whole folder.
- Each deploy is a new release, so `lf rollback` goes back. `--keep 10` keeps more releases.
- A deploy is refused when another Compose project on the server uses the site's project name: `docker compose` would take over its containers.

## When a deploy fails

Nothing goes live until the new release is built and pulled. If its containers do not start:

- the previous release runs again with its old `.env` (new `-e` values wait in `.env.new` until then)
- the failed release folder and its images are removed
- the deploy fails with the error, and its journal line is marked undone

One deploy of a site runs at a time. A second stops with `another deploy or change of <site> is running (<who>): …`.
A lock left by a cut-off deploy expires after an hour.

Release ids use the server's clock, so deploys from skewed machines still sort.
`lf sites info` shows each release's git commit, branch or tag (`, uncommitted changes` when the tree was dirty), where it came from (`ref`, `server`, `ci`, `auto`) and who deployed it.
To deploy a branch or tag, or to let a site follow one, see [Git deploys](git.md).

A cloned `.landfall.json` may name a server you do not have (`lf server ls`): deploy asks before sending the project there.
A server landfall has not set up is offered `lf setup` first.
When ssh cannot connect, deploy says why: `cannot connect to <host>: <ssh's last line>`.

## Build on this machine

`--build-local` builds images here instead of on the server: for a small server, or one with no network for the build.

- It builds for the server's platform (`uname -m`, via `docker build --platform`) and loads them with `docker save | gzip | ssh docker load`.
- It needs local Docker. Cross-platform builds need QEMU/binfmt, which Docker Desktop has.
- Builds using `ssh`, `secrets`, `additional_contexts`, `platforms` or a remote context still build on the server.
- Images get the same `<site>-<service>:<release>` tags, so rollbacks and cleanup work as usual.
- Saved to `.landfall.json`; `--no-build-local` reverts. In `lf ui`: the deploy dialog's "Build them on this machine" box.

## Hooks

Shell commands in `.landfall.json`, or `package.json` scripts, can run along a deploy: tests before it, migrations in the new release, a smoke test after the start.
See [Lifecycle hooks](hooks.md).

```sh
# deploy, but without the verify hook
lf deploy --skip-hook verify
```

## Deploy an image

`--image` deploys a prebuilt image without a compose file: landfall writes a one-service `compose.yaml` and routes it like any site.

- Traefik routes the port the image `EXPOSE`s; `--port` overrides it.
- No `EXPOSE`: it runs as a worker, without port or domain.
- `-e`, `--dotenv` and `--volume` work as for apps.
- A new tag replaces the running container; the old release stays for `lf rollback`.
- In the web UI, **Deploy folder…** has a link for an image; image sites have a **Redeploy** button.

```sh
lf deploy -n uptime --image louislam/uptime-kuma:1 --volume /app/data -d status.example.com   # an off-the-shelf app with its data kept
lf deploy -n api --image ghcr.io/me/api:1.4 -e DATABASE_URL=postgres://… --port 8080          # env and a port the image does not EXPOSE
```

A private registry needs one login on the server.
Credentials go to the deploy user's `~/.docker/config.json` there, base64 encoded, not encrypted.
Use a token that can only read packages.

```sh
echo "$GHCR_TOKEN" | lf registry login ghcr.io -u me --password-stdin -s vps   # pull private images from ghcr.io
lf registries -s vps                                                           # the registries docker on vps is logged in to
lf registry logout ghcr.io -s vps                                              # remove the stored credentials
```

### Images from this machine

An image only this machine's Docker has goes over `docker save | gzip | ssh docker load`, no registry; landfall shows how much it sent.

- This happens on its own for an image built here and never pushed (no repo digest).
- `--send-image` sends any local image; `--no-send-image` makes the server pull. Both are saved to `.landfall.json`.

```sh
docker build -t myapp:dev .
lf deploy -n app --image myapp:dev -d app.example.com   # sends myapp:dev to the server and runs it
lf deploy --send-image                                  # pick one of this machine's images from a list
```

- landfall first compares the image's platform with the server's (`uname -m`). An `arm64` image for an `amd64` server fails with the `docker build --platform` command that fixes it.
- Each deploy sends the whole image: Docker does not reuse layers across `docker load`.
- The server tags it `<site>-app:<release>`, so redeploying the same local tag replaces the container.
- Old releases' images go with the releases (`--keep`), as with `--build-local`.

## Deploy from CI

```sh
lf ci init      # write a GitHub Actions or GitLab CI job, give it its own ssh key, set its secrets
```

`lf ci init` does the steps below for you. See [Set up CI](git.md#set-up-ci-with-lf-ci-init).

To write the job by hand: with `-y`, `lf deploy` runs unattended. It needs an ssh key for the server landfall set up, named so ssh reaches it without your `~/.ssh/config`:

```yaml
# .github/workflows/deploy.yml
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: webfactory/ssh-agent@v0.9.0
        with:
          ssh-private-key: "${{ secrets.DEPLOY_KEY }}"
      - run: ssh-keyscan -H 203.0.113.10 >> ~/.ssh/known_hosts
      - run: npx landfall deploy -s deploy@203.0.113.10 -y
```

- Add the public key to `~/.ssh/authorized_keys` of the user landfall logs in as (see `lf server ls`).
- `-s <that user>@<host>` overrides `server` in `.landfall.json`; domains, name and the rest still come from it.
- Pass secrets with `--dotenv -` from a CI secret (`echo "$PROD_ENV" | lf deploy --dotenv - -y`), never as `-e`.
- The release records the checked-out commit; the journal names the runner as deployer.
- A failed start restores the previous release and exits non-zero: the job fails, the site stays up.
- With [git rules](git.md), `--for-ref "$GITHUB_REF"` deploys each branch or tag to the environment whose rule matches.

## What gets uploaded

The deployed folder, without `.git`, `node_modules`, `.DS_Store`, `.landfall.json`, `.env`, `.env.*`, `.secrets`,
`compose.override.*`, and for an app the runtime's build caches (e.g. `.venv`, `target`).

Change that with `exclude` and `include` in `.landfall.json`: `.gitignore` syntax, paths relative to that file.
`include` wins over everything, so it can bring back a default or what `.gitignore` leaves out.
A deploy keeps both lists when it saves `.landfall.json`.

```json
{
  "name": "blog",
  "exclude": ["data/", "*.sqlite", "/docs/drafts/"],
  "include": ["node_modules"]
}
```

`.gitignore` is off by default: a static site uploads `dist/`, which is usually in it.
`--gitignore` also leaves out what `.gitignore` files inside the folder ignore (saved; `--no-gitignore` turns it off).
An ignored folder is never entered: include the folder, not a file inside it.

The first deploy prints the upload's size and largest entries, and asks above 100 MB (`-y` skips that).

## Environments

Named environments (staging, preview…) each deploy as their own site, with own `.env`, secrets, domains and releases, on any server.

```sh
lf deploy -E staging -d staging.example.com -s test-vps   # site shop-staging; saved under environments.staging
lf env -E staging API_URL=https://staging-api.example.com # every site command takes -E (or LANDFALL_ENV=staging)
lf logs -E staging
```

```json
{
  "name": "shop",
  "server": "vps",
  "domains": ["shop.example.com"],
  "environments": {
    "staging": {
      "server": "test-vps",
      "domains": ["staging.example.com"]
    }
  }
}
```

An environment inherits the project's settings and overrides what its block names: `name` (default `<name>-<env>`),
`server`, or any setting like `compose: "compose.staging.yaml"`. Domains and redirects are never inherited.
Without `-E`, commands act on the project itself.
On the server it is a plain site: nothing knows about environments, and deleting `.landfall.json` loses nothing.
[Git rules](git.md) can say which branches or tags each environment deploys.

A compose site can add a standard override per environment: `compose.staging.yaml` beside `compose.yaml`
(or `docker-compose.staging.yml` beside `docker-compose.yml`).
`lf deploy -E staging` merges it like `docker compose -f compose.yaml -f compose.staging.yaml`.
The release's `compose.yaml` holds the merged result (variables left as `${...}`), so `docker compose up` there runs what was deployed.

```yaml
# compose.staging.yaml
services:
  web:
    environment:
      LOG_LEVEL: debug
  mailpit:
    image: axllent/mailpit
```

## Running without landfall

Nothing on the server needs the CLI. Each site is a folder for plain `docker compose`
(`/opt/landfall/README` on the server says the same):

```sh
cd -P /opt/landfall/sites/blog/current          # -P: into the release folder itself
docker compose ps                               # or logs -f, restart, up -d, down
cd /opt/landfall/sites/blog                     # roll back by hand: point current at an older release …
ln -sfn releases/20260122143005 current
cd -P current && docker compose up -d           # … and bring it up
```

landfall's additions sit in the release's `compose.override.yaml`, plain Compose: the project name, image tags,
Traefik labels (router `<site>_<service>` per service, `<site>_<service>_<port>` per extra route), the proxy network
and `ports: !reset []`. `x-landfall` is a Compose extension field that `docker compose` ignores.

To leave landfall, copy `compose.yaml` and that override to any Docker host and run `docker compose up -d`
behind your own Traefik with the same labels, or drop the override and publish ports yourself.
`lf eject` does this in your project: it writes the live release's labels into `compose.traefik.yaml`
for `docker compose -f compose.yaml -f compose.traefik.yaml up -d` (images build from source again; volumes are Docker's own).
`--network`, `--entrypoint` and `--resolver` match your Traefik.

A project you started yourself behind landfall's Traefik shows in `lf sites` as not deployed by landfall.
`lf adopt <project>` makes it a site `lf` can list, show logs for, restart and remove, while it keeps running from its own folder.

## Main domains

```sh
lf server domain vps example.com            # checks DNS for example.com and *.example.com
lf deploy                                   # site "blog" → blog.example.com
lf deploy -d shop                           # no dot → shop.example.com
lf domains blog --add www                   # www.example.com
lf deploy -d @                              # @ → example.com itself
lf domains blog --add @                     # blog also serves example.com
lf domains blog --redirect www              # www.<blog's first domain> redirects to it (see Sites: Redirects)
lf deploy -d @ --redirect www               # the same on deploy; --no-redirect drops the redirects
lf server domain vps --add other.org        # more main domains; the first stays primary
lf server domain vps --primary other.org    # switch the primary
lf server domain vps --rm other.org         # drop one; --clear drops all (back to sslip.io)
lf server domain vps --tunnel-only          # new sites get no domain unless -d: reach them with lf tunnel (--no-tunnel-only undoes)
```

`server domain` prints the A records to add: the domain and a wildcard `*.example.com`.
Then every new site resolves without touching DNS. For non-primary main domains, write the full name (`-d shop.other.org`).

A domain belongs to one site. Giving it to another (`lf deploy -d @`, `lf domains shop --add example.com`) asks, then moves it; the old site keeps its other domains.
Refused: a move that leaves a site with no domain, and a redeploy whose domain comes only from `.landfall.json` (pass `-d` to move it on purpose).
