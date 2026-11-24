# Lifecycle hooks

Hooks run npm scripts at fixed points of a deploy, a rollback and a removal.
Declare them in `package.json`, next to the scripts.
landfall runs them with the project's package manager (from the lockfile): npm, pnpm, yarn or bun.

```json
{
  "scripts": {
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "db:migrate": "prisma migrate deploy",
    "smoke": "node scripts/smoke.mjs",
    "notify": "node scripts/notify.mjs",
    "backup": "node scripts/backup.mjs"
  },
  "landfall": {
    "hooks": {
      "prebuild": ["lint", "typecheck"],
      "predeploy": "test",
      "release": "db:migrate",
      "verify": "smoke",
      "postdeploy": "notify",
      "onfailure": "notify",
      "predestroy": "backup"
    }
  }
}
```

- A hook is a script name or a list. A list runs in order and stops at the first failure.
- On the server, a hook's scripts share one container.
- An unknown hook, or a script missing from `scripts`, is an error before anything runs.
- The section can also hold the [project settings](/reference#landfalljson).

## The hooks

| hook | runs | where | when it fails |
|---|---|---|---|
| `prebuild` | before the build | this machine | the deploy stops |
| `postbuild` | after the build | this machine | a warning |
| `predeploy` | before anything is sent to the server | this machine | the deploy stops |
| `release` | once, after the new release is built, before it starts | a one-off container of the new release | the deploy stops; the previous release keeps running |
| `verify` | after the new release started | the running container | the previous release comes back |
| `postdeploy` | after `verify` | the running container | a warning |
| `onfailure` | when the deploy fails at any step | this machine | a warning |
| `prerollback` | before `lf rollback` switches | the running (old) release's container | the rollback stops |
| `postrollback` | after `lf rollback` switched | the restored release's container | a warning |
| `predestroy` | before `lf sites rm` removes anything | the running container | nothing is removed |

- The `pre` hooks, `release` and `verify` stop what they guard.
- The `post` hooks and `onfailure` only report. A failing `onfailure` does not run itself again.

## The lifecycle

```
lf deploy
  prebuild ─► build ─► postbuild ─► predeploy           this machine
     │
     ▼
  upload ─► build on the server ─► release ─► start ─► verify ─► postdeploy   server
                                     │                   │
                                     └─ fails: stop      └─ fails: previous release back
  any failure ─► onfailure                              this machine

lf rollback
  prerollback (old release) ─► switch ─► postrollback (restored release)

lf sites rm
  predestroy ─► stop and delete
```

## Where server hooks run

`release`, `verify`, `postdeploy`, `prerollback`, `postrollback` and `predestroy` run in the site's container on the server.
That is the service serving the site's domains, else the one landfall builds.
It needs the scripts and the package manager, as an app image built from the project has; lacking the package manager, landfall uses `npm`.
A Compose site with several services can name one:

```json
{ "landfall": { "service": "web", "hooks": { "release": "db:migrate" } } }
```

A static site runs in nginx, without `package.json`: it can use only `prebuild`, `postbuild`, `predeploy` and `onfailure`.

`release` runs once in a one-off container of the new release (`docker compose run --rm`), however many replicas the service has.
Traefik never routes to it. Its dependencies, like a database, start first.

Each release keeps its server hooks in the site's `site.json`, so `lf rollback` and `lf sites rm` run them from any folder.

## Environment variables

Every hook gets these:

| variable | value |
|---|---|
| `LANDFALL_HOOK` | the hook's name |
| `LANDFALL_DEPLOYMENT_ID` | the run's id, as `lf history` shows it |
| `LANDFALL_PROJECT` | the site's name |
| `LANDFALL_SERVER` | the server's name (hooks on this machine) |
| `LANDFALL_RELEASE` | the release id (server hooks) |
| `LANDFALL_VERSION` | the git commit, else the release id |
| `LANDFALL_PREVIOUS_VERSION` | the version that ran before (server hooks of a redeploy and a rollback) |
| `LANDFALL_URL` | the app inside its container, like `http://127.0.0.1:3000` (`verify`, `postdeploy`, `postrollback`) |
| `LANDFALL_FAILED_STEP` | what failed: the hook's name, or `build`, `deploy` (`onfailure`) |
| `LANDFALL_FAILED_HOOK` | the hook that failed, if one did (`onfailure`) |
| `LANDFALL_ERROR` | the error message (`onfailure`) |

Server hooks also get the service's own environment, so `release` reaches the app's database.

## Skipping hooks

```sh
lf deploy --skip-hook verify            # without the verify hook; repeatable, any hook
lf deploy --skip-hooks                  # without any hook
lf rollback --skip-hook prerollback
```

The output and the journal (`lf history`) name skipped hooks.

## Output and failures

Hook output goes to the deploy log, on stderr.
A failing hook is named: `hook verify failed: npm run smoke`.

The new release replaces the old one in place; no second copy runs.

- A failing `verify` brings the previous release back. A new site has none: it stays, and `lf undo` removes it.
- `release` runs while the old release still serves traffic, and a failing `verify` does not undo it.
  Write migrations the previous release can run with: add columns before the code uses them, drop them a release later.

## Examples

```js
// scripts/smoke.mjs: verify that the app answers
const res = await fetch(`${process.env.LANDFALL_URL}/health`);
if (!res.ok) throw new Error(`health check: ${res.status}`);
```

```js
// scripts/notify.mjs: postdeploy and onfailure
const text = process.env.LANDFALL_FAILED_STEP
  ? `${process.env.LANDFALL_PROJECT}: deploy failed at ${process.env.LANDFALL_FAILED_STEP}`
  : `${process.env.LANDFALL_PROJECT}: ${process.env.LANDFALL_VERSION} is live`;
await fetch(process.env.CHAT_WEBHOOK, { method: "POST", body: JSON.stringify({ text }) });
```
