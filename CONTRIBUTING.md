# Contributing

Thanks for helping with landfall. Bug reports and pull requests are welcome at
[github.com/ph1p/landfall](https://github.com/ph1p/landfall/issues).

## Setup

You need Node.js 22.18+ or 24.11+ and pnpm. The build tools need newer Node patches than the published CLI, which
runs on Node 22.4+. Docker is needed only for the end-to-end tests.

```sh
pnpm install
pnpm dev <command>     # run from source (tsx), e.g. pnpm dev deploy --help
pnpm test              # unit tests (vitest)
pnpm typecheck         # the CLI and the web page
pnpm lint              # oxlint
pnpm fmt               # oxfmt (pnpm fmt:check only reports)
pnpm build             # tsdown → dist/cli.mjs, vite → dist/ui
pnpm e2e               # full run against a throwaway sshd+dockerd container (needs Docker)
E2E_ONLY="volumes ui" pnpm e2e   # setup, then only these sections and the ones they build on
```

`pnpm dev:ui` rebuilds the web page on every change while you work on `src/ui/app`.

## Before you open a pull request

- `pnpm test`, `pnpm typecheck` and `pnpm lint` pass, and `pnpm fmt` leaves nothing to change.
- A change to a remote script or to deploying has a unit test, and an e2e check where it makes sense.
- The docs under `docs/` (and `README.md`, if needed) describe the new behavior.
- Commits follow conventional commits: `type(scope): subject`, plus a short body with the why.

[AGENTS.md](AGENTS.md) describes the architecture, the layer rules and the invariants every change keeps
(output channels, prompts, secrets, the journal). It is written for coding agents, and it is the best overview
for people too.

## CI

CI runs unit tests, both typechecks, oxlint, the oxfmt check and the production build on current Node 22 and 24 releases. A separate
job installs only production dependencies and checks the built CLI on Node 22.4.0, the advertised runtime floor.
The Docker smoke suite (`static secrets ui`, plus prerequisites) runs only on manual workflow dispatch, without
server credentials or deployments.
