# Git deploys

landfall deploys a folder. When that folder is a git checkout, it can also deploy a branch, a tag or a commit.
Rules say which refs go to which [environment](deploy.md#environments): `develop` to dev, `main` to test, tags `v*` to prod.

All of this is optional.
Without a `git` key in `.landfall.json`, `lf deploy` works as it always has, in a git checkout or not.

## What a release records

Every deploy from a git checkout records where its files came from:

- the commit (short and full SHA), the branch, and the tag at the commit, if any;
- whether the working tree had uncommitted changes;
- the source: the working tree, a clean export (`--ref`, `--tag`), or a CI run (with a link to the run on GitHub Actions or GitLab CI);
- `origin`'s URL, without credentials.

`lf sites info` and the web UI show it per release.
Hooks get the tag as `LANDFALL_TAG`. `LANDFALL_VERSION` stays the commit.

## Deploy a branch, tag or commit

```sh
lf deploy --ref main            # a clean export of main's newest commit
lf deploy --ref 3f2a9c1         # a commit
lf deploy --tag v1.4.2          # a tag
lf deploy -E prod --tag latest  # the newest tag prod's rule allows
```

- `--ref` and `--tag` deploy a clean copy of the commit (`git archive`): no uncommitted, untracked or ignored files.
- Compose files, the Dockerfile and `package.json` come from the commit. `.landfall.json` comes from the working tree.
- A static site that builds on this machine installs its dependencies first, with the lockfile's package manager. That takes longer than a deploy from the working tree.
- The refs come from this checkout. Run `git fetch --tags` first to deploy what others pushed.
- `--tag latest` sorts tags by version (`v1.10.0` after `v1.9.0`). A release sorts above its pre-releases. Tags that are not versions come last, newest first.

## Rules: which refs an environment deploys

```sh
lf git track -E dev --branch develop                      # dev deploys develop
lf git track -E test --branch main --branch 'release/*'   # test deploys main and release branches
lf git track -E prod --tag 'v*' --require-clean           # prod deploys version tags, committed files only
lf git track                                              # print every rule
lf git track -E prod --off                                # prod deploys anything again
```

The rules live in `.landfall.json`, per environment:

```json
{
  "name": "shop",
  "git": { "url": "git@github.com:acme/shop.git" },
  "environments": {
    "dev": { "git": { "branch": "develop" } },
    "test": { "git": { "branch": ["main", "release/*"] } },
    "prod": { "git": { "tag": "v*", "requireClean": true } }
  }
}
```

- `*` matches within one `/`, `**` across it, `?` one character.
- A branch rule matches branches, a tag rule matches tags. A rule can name both.
- A tag with a pre-release suffix (`v1.2.0-rc.1`) matches only with `--prerelease` (`"prerelease": true`).
- `--require-clean` refuses a working tree with uncommitted changes. `--ref` and `--tag` deploy a clean export, so they pass.
- An environment without a rule deploys anything.
- `lf git track` changes only `.landfall.json`. Nothing changes on a server.

### What a rule checks

`lf deploy -E prod` checks what it deploys against prod's rule:

- from the working tree: the branch checked out, and the branches and tags at HEAD;
- with `--ref` or `--tag`: that ref, and the branches and tags at its commit.

When nothing matches, the deploy stops and says what to run instead:

```text
error: environment prod deploys tags v*; HEAD on feature/x is not one. deploy a tag: lf deploy -E prod --tag latest (--force deploys it anyway)
```

`-y` never skips this check. `--force` does, with a warning.

## What runs where

```sh
lf refs            # each environment: its rule, what runs, the newest matching ref
lf refs -E prod    # one environment
lf refs --json     # for scripts and the web UI
```

`lf refs` reads this checkout's refs and each environment's server.
An unreachable server marks only its own environment.
`newest` is the newest ref the rule allows: the highest tag, or the branch head.
It also says how many commits that ref is ahead of what runs.

## Promote

```sh
# deploy the commit that runs on test to prod
lf promote test prod
```

- It reads the commit live in the first environment and checks it against the second one's rule.
- A tag rule needs a matching tag on that commit. Tag it first: `git tag v1.4.2 <commit> && git push --tags`.
- It asks, then deploys a clean export of the commit, named by its tag (`lf deploy -E prod --ref refs/tags/v1.4.2`).
- `--force` promotes a commit the rule does not allow.
- The commit must be in this checkout (`git fetch` brings it).

## CI: let the rules pick the environment

```sh
# GitHub Actions
npx landfall deploy --for-ref "$GITHUB_REF" -y
# GitLab CI
npx landfall deploy --for-ref "${CI_COMMIT_TAG:-$CI_COMMIT_BRANCH}" -y
```

- `--for-ref` takes `refs/heads/main`, `refs/tags/v1.2.0` or a bare name, and deploys to the environment whose rule matches.
- No match, or more than one, stops the deploy. Rules that overlap need `-E` instead.
- It does not take `-E`.
- When the checkout already is that commit (CI's detached HEAD), it deploys the working tree, without an export.
- The release links to the CI run.

See [Deploy from CI](deploy.md#deploy-from-ci) for the ssh key the runner needs.

## In the web UI

- A project without rules shows a quiet *Set up git deploys* link. It opens the rules editor.
- The rules editor shows which branches and tags each rule matches, and warns when two rules overlap. Saving runs `lf git track`.
- The pipeline board shows one column per environment: the rule, what runs, what is newer, and *Deploy latest*, *Deploy…* and *Promote*.
- The deploy dialog of a git checkout offers *Working tree* (the default) or a branch, tag or commit.

## landfall version and app version

Two versions appear on a release:

- the **app version**: the git tag or commit this page is about (`Release.git`, `LANDFALL_TAG`, `LANDFALL_VERSION`);
- the **landfall version**: the `lf` that deployed it (`Release.landfall`). See [Updates](updates.md#servers-and-landfall-versions).

`lf version` prints the landfall version.
