# Try it locally

You can try landfall without renting a server.
A Docker container on your machine plays the server.
It runs Ubuntu with systemd, sshd, ufw and its own Docker, like a fresh VPS.
landfall cannot tell the difference: setup, deploys, logs, rollbacks, undo, tenants and the web UI all work.
You can copy the server's landfall folder to your machine at any time and look at every file landfall wrote.

You need Docker and Node 22.4 or newer.
It takes about five minutes.

Run every step in order, in one shell.
Each step ends with a check. Do not go on until the check passes.

## 1. Start a test server

```sh
# everything this page creates lives in ~/landfall-try
mkdir -p ~/landfall-try && cd ~/landfall-try

# build the test server image: Ubuntu with systemd, sshd, ufw and Docker
docker build -t landfall-try "https://github.com/ph1p/landfall.git#main:test/e2e/ubuntu"

# a key that only this test server accepts
ssh-keygen -q -t ed25519 -N "" -f ~/landfall-try/key

# start it: ssh on port 2201, HTTPS on port 8443
docker run -d --privileged --cgroupns=private --name landfall-try \
  -v /var/lib/docker -v /var/lib/containerd -v /opt/landfall/tenants \
  -p 2201:22 -p 8443:443 -e AUTHORIZED_KEY="$(cat ~/landfall-try/key.pub)" landfall-try

# wait until its Docker answers
until docker exec landfall-try docker info >/dev/null 2>&1; do sleep 1; done

# copy the server's /opt/landfall to ~/landfall-try/server; run it again to refresh the copy
snap() { rm -rf ~/landfall-try/server && docker cp -q landfall-try:/opt/landfall ~/landfall-try/server; }
```

- The build URL has the form `<repository>#<branch>:<folder>`. Docker clones the branch `main` and builds the folder `test/e2e/ubuntu`. You do not need a checkout.
- In a checkout of the repository, build the folder instead: `docker build -t landfall-try test/e2e/ubuntu`.
- The container needs `--privileged` because it runs its own Docker.
- `--cgroupns=private` gives systemd its own cgroups. Tenants need them.
- The three `-v` volumes keep Docker's data off the container's own file system. Docker cannot run on top of itself there.
- `snap` copies the server's `/opt/landfall`. The copy does not follow later changes. Run `snap` again for a fresh one.
- Do not mount `/opt/landfall` from your machine instead. A shared folder does not keep the file owners, and setup fails with `Operation not permitted`.

Check:

```sh
# prints "true"
docker inspect -f '{{.State.Running}}' landfall-try
```

## 2. Install lf

```sh
# the published CLI
npm i -g landfall
```

landfall normally writes servers to `~/.config/landfall` and ssh aliases to `~/.ssh/config`.
Keep your real config out of the experiment.
These two variables move both into `~/landfall-try`, for this shell only:

```sh
# config, ssh aliases and known hosts live in ~/landfall-try
export LANDFALL_CONFIG_DIR=~/landfall-try/cfg LANDFALL_SSH_CONFIG=~/landfall-try/ssh_config
printf 'Host *\n  UserKnownHostsFile %s/known_hosts\n' ~/landfall-try > ~/landfall-try/ssh_config
```

Check:

```sh
# prints the installed version
lf --version
```

## 3. Set up the server

```sh
# what setup would do, without changing anything
lf setup try --host 127.0.0.1 --port 2201 --key ~/landfall-try/key --check

# set it up: deploy user, ufw, Docker check, Traefik, ssh alias "try"
lf setup try --host 127.0.0.1 --port 2201 --key ~/landfall-try/key --email you@example.com --staging -y
```

- `--staging` uses Let's Encrypt's test service. Real certificates cannot reach a container on your machine.
- ufw only guards the container. Tenants need it, so setup turns it on as on a real server.
- The security notes at the end (loose kernel settings, waiting updates) are expected here.
- Setup creates the user `deploy`. From now on, landfall logs in as `deploy`, as on a real server.

To log in as `root` again:

```sh
# server "try" logs in as root from now on
lf server add try -u root
```

In the web UI, open **Settings** on `try` and click **Change login** in the SSH card.

Let's Encrypt cannot issue certificates for a container on your machine.
Give Traefik a self-signed certificate for `*.localhost` instead:

```sh
# a self-signed certificate for localhost and *.localhost, used by Traefik
docker exec landfall-try sh -c 'cd /opt/landfall/traefik/dynamic &&
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 365 -subj /CN=landfall-try \
    -addext "subjectAltName=DNS:localhost,DNS:*.localhost" -keyout key.pem -out cert.pem 2>/dev/null &&
  printf "tls:\n  certificates:\n    - certFile: /etc/traefik/dynamic/cert.pem\n      keyFile: /etc/traefik/dynamic/key.pem\n" > local.yml'
```

Names under `.localhost` always point at your own machine. No DNS is involved.

Check:

```sh
# copy the server's files, then list README, journal.log, landfall.json, sites/, tenants/ and traefik/
snap && ls ~/landfall-try/server

# Traefik's Compose file and the certificate you just added
ls ~/landfall-try/server/traefik ~/landfall-try/server/traefik/dynamic
```

## 4. Deploy a site

```sh
# a static site: a folder with an index.html
mkdir -p ~/landfall-try/hello && cd ~/landfall-try/hello
echo '<h1>hello from landfall</h1>' > index.html

# deploy it to the test server
lf deploy -s try -d hello.localhost -y
```

The site remembers its domain. Later deploys need only `lf deploy`.

`deploy` ends with a warning that it could not reach `https://hello.localhost`.
It checks port 443, but the container listens on 8443. The site is fine.

Check:

```sh
# prints <h1>hello from landfall</h1>; -k because the certificate is self-signed
curl -k https://hello.localhost:8443
```

In a browser, open `https://hello.localhost:8443` and accept the certificate warning.

## 5. See what landfall wrote

Everything landfall keeps on the server is a plain file under `/opt/landfall`.
`snap` copies it to `~/landfall-try/server`:

```sh
# a fresh copy, then the whole tree without the release contents
snap && find ~/landfall-try/server -maxdepth 4 -not -path '*/releases/*/*'
```

| path | what |
|---|---|
| `README` | what the folder is, for whoever logs in after you |
| `journal.log` | every change landfall made. `lf history` reads it, `lf undo` replays its undo commands |
| `landfall.json` | the server's landfall settings |
| `traefik/` | Traefik's Compose project, its config, and `letsencrypt/acme.json` with the certificates |
| `sites/hello/releases/` | one folder per deploy, named by date and time |
| `sites/hello/current` | a symlink to the live release |
| `sites/hello/site.json` | the site's domains, services and release history |
| `sites/hello/.env` | the site's environment variables, once you set any |

Deploy again and watch the folder change:

```sh
# a second release
echo '<h1>version 2</h1>' > index.html && lf deploy -y

# a fresh copy: two release folders; current points at the newer one
snap && ls -l ~/landfall-try/server/sites/hello ~/landfall-try/server/sites/hello/releases
```

Right after a deploy, the site can answer `404 page not found` for a few seconds.
Traefik needs that long to notice the new container.

`~/landfall-try/server` is only a copy. Editing it changes nothing on the server.

## 6. Look around

```sh
lf ls                       # sites on the server
lf sites info hello         # services, domains and every release
lf logs hello               # container logs
lf rollback hello -y        # back to the previous release; current moves back
lf history                  # every change landfall made on the server
lf undo                     # take back the last one
lf server info try          # OS, hardware, memory, disk, containers
lf ssh try                  # a shell on the test server
lf ui                       # the web UI in your browser
```

Any project deploys the same way: a Node app, a Dockerfile, a Compose file. See [Deploy a site](deploy.md).
Nothing can break: the server is a container you throw away.

## Clean up

```sh
# remove the test server and its data
docker rm -fv landfall-try

# remove keys, config, sites and the copied server folder
rm -rf ~/landfall-try
```

Open a new shell, or unset the two variables, to work with your real servers again:

```sh
unset LANDFALL_CONFIG_DIR LANDFALL_SSH_CONFIG
```

## Troubleshooting

| problem | fix |
|---|---|
| `port is already allocated` | Another program uses 2201 or 8443. Pick other ports in `docker run -p` and in `--port`. |
| `docker info` never answers | The container needs `--privileged` and `--cgroupns=private`. Check `docker logs landfall-try`. |
| `chmod: … Operation not permitted` during setup | `/opt/landfall` is mounted from your machine. Start the container without `-v`, and use `snap` to see the files. |
| `hello.localhost` does not resolve | Some systems do not resolve `*.localhost`. Use `curl -k --resolve hello.localhost:8443:127.0.0.1 https://hello.localhost:8443`, or add `127.0.0.1 hello.localhost` to `/etc/hosts`. |
| `curl: (35)` or a TLS error | Traefik answers only names it has a certificate for. Run the certificate step again; it covers `*.localhost` only. |
| `404 page not found` | Right after a deploy, wait a few seconds. Otherwise check the domain with `lf sites info hello`. |
| `Permission denied (publickey)` | The container was started with another key. Start it again with `AUTHORIZED_KEY` from `~/landfall-try/key.pub`. |
| `REMOTE HOST IDENTIFICATION HAS CHANGED` | A new container has a new host key. `rm ~/landfall-try/known_hosts`. |

## Optional: tenants

[Tenants](tenants.md) give other people their own rootless Docker on your server.
The test server has everything they need: it boots systemd, which runs each tenant's own Docker ([Requirements](tenants.md#requirements)).

You play two people here:

- **you**, the admin. You use the server `try` from the steps above.
- **anna**, the tenant. landfall creates the Linux user `anna` on the server. She logs in as `anna` with her own key, `~/landfall-try/anna`.

The tenant's name is yours to choose. It must not exist on the server yet. This page uses `anna`.

```sh
# anna's key pair: the public half goes to the admin, the private half is her login
ssh-keygen -q -t ed25519 -N "" -f ~/landfall-try/anna
```

Then add the tenant either with `lf` or in the web UI.

### Add the tenant with lf

```sh
# you: add anna with her key and domains
lf tenant add anna -s try --key ~/landfall-try/anna.pub -d anna.localhost -d '*.anna.localhost' --force

# anna: register her login and start her Traefik
lf server add anna --host 127.0.0.1 --port 2201 --user anna -i ~/landfall-try/anna
lf traefik setup -s anna --email you@example.com --staging -y
```

The first tenant needs `--force`: it moves Traefik to the host network, which restarts it.

### Add the tenant in the web UI

Start the UI from the shell with `LANDFALL_CONFIG_DIR` and `LANDFALL_SSH_CONFIG` set (step 2).
Without them, the UI writes to your real config.

```sh
# anna's public key: you paste it into the UI
cat ~/landfall-try/anna.pub

# the web UI, with the test config
lf ui
```

1. As you, open **Tenants** on `try` and click **Add tenant**:

   | field | value |
   |---|---|
   | User | `anna` |
   | Public key | the line `cat ~/landfall-try/anna.pub` printed |
   | Domains | `anna.localhost *.anna.localhost` |

   The first tenant restarts Traefik. The UI asks you to confirm.
   The invite it shows next is for a real tenant. Here, anna's key is `~/landfall-try/anna`, not `~/.ssh/id_ed25519`.
2. As anna, click **Add server**:

   | field | value |
   |---|---|
   | Name | `anna` |
   | Address | `127.0.0.1` |
   | User | `anna` |
   | SSH port | `2201` |
   | Private key file | `~/landfall-try/anna` |

   Uncheck **Set it up now**. A tenant cannot set up the server.
3. Open **Traefik** on `anna` and click **Install it**. This starts anna's own Traefik.

The UI shows anna only her own sections: sites, traffic, history, Traefik and settings.

### Deploy as anna

Give anna's Traefik a certificate for her domains, then deploy:

```sh
# a self-signed certificate for anna's domains, in anna's Traefik
docker exec landfall-try sh -c 'cd /opt/landfall/tenants/anna/traefik/dynamic &&
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 365 -subj /CN=landfall-try \
    -addext "subjectAltName=DNS:anna.localhost,DNS:*.anna.localhost" -keyout key.pem -out cert.pem 2>/dev/null &&
  printf "tls:\n  certificates:\n    - certFile: /etc/traefik/dynamic/cert.pem\n      keyFile: /etc/traefik/dynamic/key.pem\n" > local.yml &&
  chown anna: key.pem cert.pem local.yml'

# deploy the hello site as anna
cd ~/landfall-try/hello && lf deploy -s anna -d blog.anna.localhost -y
```

The central Traefik passes `blog.anna.localhost` to anna's Traefik, still encrypted.

Check:

```sh
# prints the hello page, served by anna's Traefik
curl -k https://blog.anna.localhost:8443

# only anna's sites; lf ls -s try does not show them
lf ls -s anna
```

To look at the files, use a shell on the server:

```sh
# anna's sites and her Traefik
docker exec landfall-try ls -l /opt/landfall/tenants/anna
```

| problem | fix |
|---|---|
| `Permission denied (publickey)` as anna | The server `anna` uses the wrong key. It needs `~/landfall-try/anna`, the private half of the key you gave the tenant. |
| `anna` cannot run a command | Tenants run only their own commands. Server-wide commands need the admin server, `try`. |
| `user anna exists and is not a tenant` | The name is taken on the server. Pick another tenant name. |

## Run the test suite

landfall's end-to-end tests use this image for tenants, and an Alpine image for everything else.
In a checkout of the repository:

```sh
# build lf, then run every section against fresh containers
pnpm install && pnpm e2e

# setup, then only these sections and what they build on
E2E_ONLY="static tenants" pnpm e2e

# keep the containers and the work folder after the run
KEEP=1 pnpm e2e
```

To try your own changes by hand, build them and use that `lf` in step 2 instead of the published one:

```sh
# lf from the checkout
pnpm install && pnpm build && alias lf="node $PWD/dist/cli.mjs"
```
