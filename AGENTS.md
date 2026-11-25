# AGENTS.md

Guide for coding agents working on landfall itself. If you only need to *use* the `lf` CLI (deploy, inspect,
administer servers), read [docs/pages/automation.md](docs/pages/automation.md) instead.

landfall is a TypeScript CLI (`lf` / `landfall`) that sets up Linux servers over ssh and deploys Docker Compose
sites behind Traefik. There is no agent on the server: every remote action is a bash script sent over ssh, and
everything landfall owns lives under `/opt/landfall` as plain files.

## Commands

```sh
pnpm install
pnpm dev <command> [args]   # run the CLI from source (tsx), e.g. pnpm dev deploy --help
pnpm test                   # unit tests (vitest, test/unit); no network, no Docker
pnpm typecheck              # tsc for the CLI and, separately, for the web page (src/ui/app)
pnpm lint                   # oxlint (.oxlintrc.json)
pnpm fmt                    # oxfmt, printWidth 160 (.oxfmtrc.json); pnpm fmt:check only reports
pnpm build                  # tsdown → dist/cli.mjs, vite → dist/ui
pnpm docs:dev               # the documentation site (Vocs) on localhost; pnpm docs:build writes docs/dist
pnpm e2e                    # build, then test/e2e/run.sh against a throwaway sshd+dockerd container (needs Docker)
E2E_ONLY="volumes ui" pnpm e2e   # setup, then only these sections and what they build on
```

Run `pnpm test`, `pnpm typecheck`, `pnpm lint` and `pnpm fmt` before you call a change done; CI fails on lint
errors and unformatted files. Use `pnpm e2e` (or a focused `E2E_ONLY`) when a
change alters a remote script or deploy behavior. Development needs Node 22.18+ or 24.11+; the published CLI
runs on Node 22.4+, so do not use runtime APIs newer than that in `src/core` or `src/cli`.

## Repository map

| path | what |
|---|---|
| `src/cli/cli.ts` | entry point: argument dispatch, `lf --help` groups (`help()`), error and exit-code handling |
| `src/cli/cmd.ts` | `defineCommand`, option parsing, global options (`-h`, `-y`, `-E`), `serverOpt` |
| `src/cli/registry.ts` | the `commands` list and the `aliases` map: every command is registered here |
| `src/cli/commands/*.ts` | one file per area (deploy, sites, volume, server, setup, system, firewall, traefik, …) |
| `src/cli/job-args.ts` | validates and masks the argv of commands the web UI runs |
| `src/core/` | everything shared by CLI and web UI: config, ssh, remote scripts, compose analysis, views |
| `src/core/lib/` | building blocks with no domain: config, terminal output, `fail`, quoting, formatting, jobs |
| `src/core/ssh/` | reaching a server: ssh, ssh config, sudo/login, tunnels, remote shell templates, journal, migrations |
| `src/core/server/` | one server as a whole: facts, system, security, firewall, users, updates, stats, prune, inventory |
| `src/core/site/` | one site on a server: compose analysis, releases, site status, hooks, volumes, domains |
| `src/core/deploy/` | getting code to a server: sources, git, local builds, framework detection, CI, autodeploy |
| `src/core/traefik/` | the proxy: Traefik config, traffic and access logs, redirects, strict TLS |
| `src/core/views/` | read models that `--json` prints and the web UI reads: views, dashboard, infra graph |
| `src/core/plugins/` | the plugin contract and loader |
| `src/core/ssh/ssh.ts` | `runScript` (bash over ssh), `shq` (shell quoting), file writes, uploads |
| `src/core/ssh/templates.ts` | remote shell: `PRELUDE` helpers, paths (`ROOT`, `SITES`, `TRAEFIK_DIR`), generated files |
| `src/core/ssh/journal.ts` | parse the server journal, plan `lf undo` |
| `src/core/lib/term.ts` | output helpers (`step`, `ok`, `info`, `warn`, `fail`, `printJson`, `table`) and prompts |
| `src/core/lib/config.ts` | local config, servers, `.landfall.json` (`ProjectConfig`), environments |
| `src/core/views/views.ts` | the objects that `--json` prints and the web UI reads |
| `src/core/plugins/plugin-api.ts` | the plugin contract: `Plugin`, `PluginContext`, UI blocks (no `node:` imports; the web page uses it) |
| `src/core/plugins/plugins.ts` | loading plugins (built in and `~/.config/landfall/plugins`), the context their code runs with |
| `src/plugins/` | the built-in plugins (fail2ban, trivy), written against the same API |
| `src/cli/plugins.ts` | turns plugin commands and aliases into `lf` commands |
| `src/cli/commands/plugins.ts` | `lf plugins`, `plugin add`, `plugin rm`, `plugin new` |
| `src/ui/server/` | `lf ui`: local HTTP server; reads call core directly, writes spawn `lf` jobs |
| `src/ui/app/` | the browser page (React + Tailwind, built by vite) |
| `test/unit/` | vitest; remote scripts are captured by mocking `runScript` and checked with `bash -n` |
| `test/e2e/run.sh` | end-to-end run against a container with sshd and dockerd |
| `docs/` | the documentation site (Vocs): pages in `docs/pages`, `docs/vocs.config.ts`; `docs/pages/reference.md` lists every command |

Navigate by symbol where you can: `cona outline <file>`, `cona show <Symbol>`, `cona refs <Name>`.

## Layer rules

Enforced by `test/unit/layers.test.ts`:

- `src/core` imports nothing from `src/cli` or `src/ui`.
- `src/ui` imports nothing from `src/cli`. The web UI runs CLI commands as subprocesses, never as imports.
- `src/ui/app` (the browser bundle) may value-import a core module only if that module and everything it imports
  avoids `node:` modules. Type-only imports are fine.

## Adding or changing a command

1. Define it with `defineCommand({ name, args, summary, options, run })` in the matching `src/cli/commands/*.ts`.
   Use `serverOpt` for `-s`, and resolve site and server the way neighbouring commands do (`target(...)`).
2. Add it to `commands` in `src/cli/registry.ts` (aliases go in `aliases`).
3. Put it in a group in `help()` in `src/cli/cli.ts`. Unlisted commands land under "More".
4. Read commands: build the data in core (a view), print it with `printJson` under `--json`, else as a table.
   The web UI reads the same object, so keep the shape stable.
5. Commands that change a server: do the work in one `runScript` and journal every change (see below).
6. Document it in `docs/pages/reference.md` and in the topic page under `docs/pages/`. Add it to the `--json` table in
   `docs/pages/automation.md` if it supports `--json`, and to "What cannot be undone" there if it cannot be undone.

## Invariants

Breaking one of these breaks users' scripts, CI jobs or servers.

- **Output channels.** stdout carries results only (tables, `--json`). Progress, warnings and errors go to stderr
  (`step`, `ok`, `info`, `warn`). Errors are thrown with `fail()`, which prints `error: …` and exits 1.
- **No prompts without a terminal.** Ask only through `confirm`, `confirmRemoval`, `confirmRisky` or `ask` from
  `term.ts`. They fail with a clear message when there is no TTY, and `-y` answers them. Never read stdin directly
  for a prompt.
- **`-y` never overrides a safety check.** Refusals that could lock someone out or break a running service use
  `confirmRisky` or need `--force`, and the error text says so.
- **Secrets stay out of argv, logs and the journal.** Passwords come from `--password-stdin`, `$LANDFALL_PASSWORD`
  or `$LANDFALL_SECRET_<OPTION>`; env values from `--dotenv -` or files. Journal entries say `KEY=…`, not values.
  `job-args.ts` masks them in the web UI.
- **Every server change is journaled and, where possible, undoable.** In remote scripts, call
  `record "<what>" "<undo shell>"` after each change (no undo shell means "cannot be undone"), and back files up
  with `saved <file>`, whose output is the shell that restores it. Check `lf history` / `lf undo` still read it.
- **Remote scripts are bash with `set -euo pipefail`.** Quote every interpolated value with `shq`. Use the `PRELUDE`
  helpers (`svc`, `dc`, `pkg_install`, `ufw_add`, `_as`, …) instead of assuming systemd, apt or root.
  Support every package manager landfall knows (apt, dnf, yum, apk, zypper) or refuse clearly.
- **No agent on the server.** Do not add a daemon or a landfall binary there. What landfall writes must still work
  by hand: plain Compose projects, plain cron lines, a README under `/opt/landfall`.
- **The web UI is a front end for the CLI.** Every UI write is an `lf` command it shows to the user. A feature
  belongs in the CLI first.
- **Progress for the UI.** Long commands report structured progress with `report()` from `term.ts`. It writes
  only when `LANDFALL_REPORT` is set.

## Tests

- Unit tests sit in `test/unit/<area>.test.ts`. To test a remote script, mock `runScript` from
  `src/core/ssh` and check the captured script (see `test/unit/scripts.test.ts`): it parses with `bash -n` and
  contains the expected steps in order.
- Tests must not touch the real `~/.config/landfall` or `~/.ssh`. Point `LANDFALL_CONFIG_DIR` and
  `LANDFALL_SSH_CONFIG` at a temp directory.
- New e2e checks go into a section of `test/e2e/run.sh`, so `E2E_ONLY` can select them.

## Documentation

User docs are part of a change. Update `docs/pages/` (and `README.md` if the quickstart or the concepts change) in the
same commit as the behavior. The docs are written in short, plain sentences: one fact per sentence, commands in code
blocks with a comment saying what they do. A new page also goes into the sidebar in `docs/vocs.config.ts`.

## Commits

Conventional commits: `type(scope): subject`, with a short body for the what and the one non-obvious why
(for example `fix(deploy): keep the previous release when the health check fails`). No AI attribution lines.

## Releases

Releases are automatic. Every push to `main` runs CI, then semantic-release (`.releaserc.cjs`,
`.github/workflows/release.yml`): `feat` publishes a minor version, `fix`, `perf`, `refactor` and `revert` a patch,
a breaking change (`feat!:` or `BREAKING CHANGE:`) a major one. It publishes to npm, tags `vX.Y.Z`, writes the
GitHub release and commits the version to `package.json`. Do not bump the version or run `npm publish` by hand.
The docs site deploys to GitHub Pages after each release, and on pushes that change only `docs/`.
