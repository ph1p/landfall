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
