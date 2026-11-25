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

`lf ci init` writes this job for you, with its own ssh key.

### Set up CI with `lf ci init`

```sh
lf ci init --dry-run      # show the job's file and what it deploys; change nothing
lf ci init                # GitHub or GitLab, from origin
lf ci init gitlab         # name the forge
lf ci rm                  # stop: remove the CI key and the secrets
```

- It writes `.github/workflows/landfall.yml`, or `.gitlab-ci.yml` on GitLab. Commit and push it; it prints the `git add` line.
- The job runs on a push of a branch or tag that some environment's rule allows. It runs `lf deploy --for-ref`, which picks the environment.
- Without rules, pushes to the current branch deploy the project.
- Tags with a pre-release suffix (`v1.2.0-rc.1`) start no run, unless a tag rule sets `prerelease`.
- It makes a new ed25519 key for the job. The private key never stays on this computer.
- It adds the public key to the deploy login on each server the rules name, with `restrict`. `lf undo` removes it.
- It reads each server's host keys over ssh. The job checks them strictly.
- It sets the secrets `LANDFALL_SSH_KEY` and `LANDFALL_KNOWN_HOSTS` with `gh` or `glab`, when one is installed and logged in.
- Without them, it writes the two values to files under the config folder. Add them on the repository's secrets page, then delete the files.
- The job gets the servers' settings from `.landfall.json` and a config it writes on the runner. Your local logins and admin keys stay here.
- `.landfall.json` must be in git: the job reads it. `lf ci init` warns when it is not.
- The job runs `npx landfall@^<this version>`.
- On GitLab, when `.gitlab-ci.yml` is not landfall's, it writes `.gitlab/landfall.yml`. Add the `include` it prints to your `.gitlab-ci.yml`.
- A GitHub workflow file of the same name that landfall did not write stops it. `--force` replaces it.
- Running it again makes a new key and replaces the old one on the servers.
- `lf ci rm` removes the key from the servers (journaled) and deletes the secrets. Deleting the secrets cannot be undone. Delete the job's file in git yourself.
- Secrets your app needs go in as usual: `--dotenv -` from a CI secret, never `-e`.

**Security.** The CI key can do what the deploy login can. That login is in the docker group, which is as strong as root.
`restrict` blocks a terminal and port forwarding, but landfall cannot limit the key to one command.
Whoever can push a matching ref, or read the repository's secrets, can deploy to these servers.

See [Deploy from CI](deploy.md#deploy-from-ci) to write the job by hand.

## Deploy from the server

```sh
lf git key gh:acme/shop -s web                 # give the server a deploy key, once
lf deploy --git gh:acme/shop -s web            # the repository's default branch
lf deploy --git git@github.com:acme/shop.git#v1.4.2 -s web
lf deploy --git gh:acme/shop -E prod --tag latest
```

- With `--git`, the server fetches the repository itself. Nothing is uploaded, and no checkout is needed here.
- The URL can be `git@host:owner/repo.git`, `ssh://…`, `https://…`, `gh:owner/repo`, `gl:group/repo` or a path on the server.
- The part after `#` is a branch, tag or commit. `--ref` and `--tag` do the same; give one of them, not both.
- The server keeps a bare mirror under `/opt/landfall/repos/<host>-<repo>/`. The first fetch makes it.
- A server without git gets it on the first fetch. Installing needs root: landfall uses the root key login, or sudo (`-K` gives the sudo password).
- This machine gets a copy of the commit to read its settings. The release's files come from the server's mirror.
- Settings come from the commit's `.landfall.json`. A `.landfall.json` in the current folder wins, and `--git` never writes one.
- The environment's rule is checked against the server's branches and tags. `--force` deploys past it.
- A static site that builds on this machine is uploaded after its build, as a normal deploy is.
- Submodules are not supported.

### Deploy keys

```sh
lf git key                          # the project's repository (git.url, else origin)
lf git key gh:acme/shop -s web      # a repository by URL
lf git key gh:acme/shop --rm        # remove the server's key
```

- A private repository needs a deploy key. `lf git key` makes an ed25519 key on the server, once, and prints its public key.
- The private key stays on the server, in the repository's folder under `/opt/landfall/repos/`.
- With `gh` (GitHub) or `glab` (GitLab) installed and logged in, it offers to add the key as a read-only deploy key.
- Without them, it prints the page where you add the key by hand.
- landfall stores no GitHub or GitLab token.
- github.com's and gitlab.com's host keys are built in. Other hosts are trusted on first use.
- `lf undo` removes a key it made. `--rm` cannot be undone.

## Auto-deploy: the server deploys new commits

```sh
lf autodeploy -E test --every 5m       # test deploys new commits of its branch rule
lf autodeploy -E prod --every 15m      # prod deploys newer tags of its tag rule
lf autodeploy -E test                  # what it follows, what it saw last, the log
lf autodeploy -E test --now            # check once, now, and print what it did
lf autodeploy -E test --off            # stop
lf autodeploy shop-test -s web --every 1h --branch main   # a site by name, outside its folder
```

- Auto-deploy is off until you turn it on. It needs a site deployed from git, and a server that can fetch the repository (`lf git key`).
- A cron line of the login user runs `/opt/landfall/sites/<name>/autodeploy.sh`. There is no daemon.
- `--every` takes `1m` to `59m` or `1h` to `23h`.
- The site follows the environment's rule. A branch rule deploys the newest commit of the branch. A tag rule deploys the highest matching version.
- With a tag rule, only newer tags deploy. Pre-releases (`v1.2.0-rc.1`) deploy only with `--prerelease` or `prerelease` in the rule.
- `--branch` and `--tag` follow other refs than the rule. A rule with both branches and tags needs one of them.
- Without a rule, it follows the branch the running release came from.
- Turning it on fetches once, so a repository the server cannot read is refused right away. It installs `jq` and git if needed, the same way.
- The script remembers the last commit it saw. After `lf rollback` or a manual deploy, it waits for a new commit; it does not deploy back over yours.
- A deploy, rollback, `lf scale` or `lf weight` rewrites the script, so it always matches the running site.
- It skips a run while another deploy of the site runs.
- A release made this way shows the source *auto-deploy* and is deployed by `autodeploy`. `lf undo` puts back the release before it.
- It keeps the newest 5 releases, plus the one that ran before.
- The log is `/opt/landfall/sites/<name>/autodeploy.log`. It keeps the last 200 lines.
- `lf undo` of turning it on or off restores the setting, the script and the cron line.

### What auto-deploy leaves to `lf deploy`

- A commit that changes `compose.yaml`, the environment's compose layer, a compose override, `package.json` or `.landfall.json` is not deployed.
  The log says which `lf deploy` to run, and the commit is not tried again.
- Only these file names are checked. A compose file under another name (`-f`) is not.
- A commit that fails to build or start is not tried again. The next new commit is.
- Files the running release has beside git (generated files, uploads not in the repository) are copied from it.
- `.dockerignore` and other ignore files of a local deploy do not apply: the release holds the commit's files.
- Tags sort by version, as `git tag --sort=-v:refname` sorts them. Keep tag names to versions (`v1.2.3`).
- Sites from an image, static sites and adopted sites cannot deploy themselves.

## In the web UI

- A project without rules shows a quiet *Set up git deploys* link. It opens the rules editor.
- The rules editor shows which branches and tags each rule matches, and warns when two rules overlap. Saving runs `lf git track`.
- The pipeline board shows one column per environment: the rule, what runs, what is newer, and *Deploy latest*, *Deploy…* and *Promote*.
- The deploy dialog of a git checkout offers *Working tree* (the default) or a branch, tag or commit.
- *Deploy from git…* (on an empty server, and in the folder picker) deploys a repository the server fetches. It can make the deploy key first.
- A site deployed that way shows *Redeploy*, which fetches the same branch or tag again.
- *Deploy from CI…* on the pipeline board shows what `lf ci init` would write: the forge, whether `gh` or `glab` is logged in, what deploys, the servers' keys and the job's file. *Set up* runs `lf ci init`, then shows the `git add` line. When CI is set up, it offers *Remove CI…* (`lf ci rm`).
- *Auto-deploy…* on the pipeline board, and the *Auto-deploy* box of an open site, run `lf autodeploy`.
  The box shows what the site follows, the last commit it saw, the log, and *Check now* (`--now`).
  A column that deploys itself shows an *auto* badge with its interval.

## landfall version and app version

Two versions appear on a release:

- the **app version**: the git tag or commit this page is about (`Release.git`, `LANDFALL_TAG`, `LANDFALL_VERSION`);
- the **landfall version**: the `lf` that deployed it (`Release.landfall`). See [Updates](updates.md#servers-and-landfall-versions).

`lf version` prints the landfall version.
