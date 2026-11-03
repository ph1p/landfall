# Updates

```sh
lf updates                         # packages (security marked, reboot needed), images, Docker/compose versions
lf update                          # upgrade packages and pull newer images (asks first)
lf update --security              # only security updates (apt, dnf/yum); images stay
lf update --packages --reboot      # reboot afterwards if needed
lf update --images                 # Traefik and image sites: pull, recreate
lf update blog --images            # one site
lf update --compose                # newest compose, where landfall installed it
```

Package upgrades (apt-get, dnf/yum, apk, zypper) cannot be undone. `--security` and `--reboot` imply `--packages`. Image and compose updates record the previous version,
so `lf undo` restores it. landfall never touches images pinned by digest, Dockerfile sites or foreign containers.
Version-pinned tags show the newest tag of the same shape (`traefik:v3.6` → `traefik:v3.7`).

## Vulnerabilities

```sh
lf scan                            # known vulnerabilities in every image the running containers use
lf scan blog                       # one site
lf scan --all --fixable            # every severity, only what a newer package fixes
lf scan --no-others                # only traefik and the sites, not containers landfall did not deploy
```

`lf scan` runs [Trivy](https://trivy.dev) (`aquasec/trivy`, pinned) on the server and changes nothing. Each image goes
in as a `docker save` stream: the scanner gets no Docker socket. The first scan asks before it downloads Trivy: its image
(~190 MB) and its vulnerability databases (several GB, in the volume `landfall-trivy`). `lf scan --remove` (or Remove
Trivy in the web UI) deletes both again. Per image it says what fixes the findings:
redeploy for images built on the server (builds pull the newest base image), `lf update --images` for a newer pull,
a newer tag, or a newer base when the OS is past its end of life. `--others` adds the images of every other running
container, named by compose project (or container) and marked "not landfall's": landfall cannot update those, so
their hint points to where they were set up. The UI's Updates tab has the same scan, with an "Other containers too" box.
