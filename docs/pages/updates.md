# Updates

```sh
lf updates                         # packages (security marked, reboot needed), images, Docker/compose versions
lf update                          # upgrade packages and pull newer images (asks first)
lf update --security               # only security updates (apt, dnf/yum); images stay
lf update --packages --reboot      # reboot afterwards if needed
lf update --images                 # Traefik and image sites: pull, recreate
lf update blog --images            # one site
lf update --compose                # newest compose, where landfall installed it (goes alone)
```

- Package upgrades (apt-get, dnf/yum, apk, zypper) cannot be undone.
- `--security` implies `--packages`. `--reboot` applies to `--packages`.
- Image and compose updates record the previous version; `lf undo` restores it.
- Never touched: images pinned by digest, Dockerfile sites, foreign containers.
- Version-pinned tags move to the newest tag of the same shape (`traefik:v3.6` → `traefik:v3.7`).

## landfall itself

```sh
npm i -g landfall@latest           # update the CLI (pnpm add -g, bun add -g where you installed it that way)
LANDFALL_NO_UPDATE_CHECK=1 lf ls   # one run without the check; export it to turn the check off
```

- Once a day, landfall asks the npm registry for its newest version.
- When a newer one exists, a command run in a terminal ends with one line on stderr saying so. It says so at most once a day.
- `lf ui` shows the newer version next to its own in the header. Click it to copy the update command.
- landfall never installs an update by itself.
- No check without a terminal, in CI (`$CI`), or with `LANDFALL_NO_UPDATE_CHECK` or `NO_UPDATE_NOTIFIER` set.
- Without network, it asks again after an hour. The answer lives in `~/.config/landfall/update-check.json`.

## Servers and landfall versions

```sh
lf server info                     # the row "landfall": version that changed the server last, its upgrades
lf server upgrade                  # run the upgrades this server lacks (asks first)
lf server upgrade --dry-run        # only list them
lf server upgrade --json           # version, newest, migration, pending, newer
lf history                         # each run names the landfall version that made it
```

- Each line of the server journal names the landfall version that wrote it.
  The last line tells which landfall changed the server last.
- `/opt/landfall/landfall.json` holds two fields: `newest` and `migration`.
- `newest` is the highest landfall that ever changed the server. It never goes down.
- `migration` counts the upgrades the server has. Only `lf setup`, `lf server upgrade` and `lf undo` change it.
- Each release in a site's `site.json` names the landfall that deployed it. `lf sites info` shows it.
- When a newer landfall changed the server than the one you run, landfall warns on stderr and keeps going.
  It warns once per command. Update with `npm i -g landfall@latest`.
- An upgrade changes files landfall wrote before, in the shape a newer landfall expects. Each one is journaled.
  `lf undo` reverts it and sets the count back.
- `lf setup` runs the missing upgrades too. A fresh server starts with all of them.
- `lf server upgrade` refuses a server that a newer landfall upgraded. Update lf first.
- The web UI shows the version in the server's facts line. It turns yellow when the server needs attention.
- When upgrades are pending, the web UI shows a note with an Upgrade button. It runs `lf server upgrade`.
- When a newer landfall changed the server, the note offers to copy the update command instead.
- The web UI's history names the landfall version of each run.

## Vulnerabilities

```sh
lf scan                            # known vulnerabilities in every running container's image
lf scan blog                       # one site
lf scan --all --fixable            # every severity, only what a newer package fixes
lf scan --no-others                # only traefik and the sites
lf scan --remove                   # delete Trivy's image and databases
```

`lf scan` runs [Trivy](https://trivy.dev) (`aquasec/trivy`, pinned) on the server and changes nothing. Each image goes in as a `docker save` stream; the scanner gets no Docker socket.

The first scan asks before downloading Trivy's image (~190 MB) and databases (several GB, volume `landfall-trivy`). `--remove` or Remove Trivy in the web UI deletes both.

Per image it names the fix:

- redeploy, for images built on the server (builds pull the newest base image)
- `lf update --images`, for a newer pull
- a newer tag
- a newer base, when the OS is past its end of life

By default it also scans other running containers' images, named by compose project (or container) and marked "not landfall's". landfall cannot update those; their hint points to where they were set up. The UI's Updates tab has the same scan, with an "Other containers too" box.
