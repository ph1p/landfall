# Try it locally

You can try landfall without renting a server.
A Docker container on your machine plays the server: it runs sshd and its own Docker, like a fresh VPS.
landfall cannot tell the difference. Setup, deploys, logs, rollbacks, undo and the web UI all work.
It takes about five minutes.

You need Docker and Node 22.4 or newer.

## 1. Start a test server

```sh
# a folder for everything this page creates
mkdir -p ~/landfall-try && cd ~/landfall-try

# build the test server image: Alpine with sshd and Docker
docker build -t landfall-try "https://github.com/ph1p/landfall.git#main:test/e2e"

# a key that only this test server accepts
ssh-keygen -q -t ed25519 -N "" -f ~/landfall-try/key

# start it: ssh on port 2201, HTTPS on port 8443
docker run -d --privileged --name landfall-try -p 2201:22 -p 8443:443 \
  -e AUTHORIZED_KEY="$(cat ~/landfall-try/key.pub)" landfall-try

# wait until its Docker answers
until docker exec landfall-try docker info >/dev/null 2>&1; do sleep 1; done
```

The container needs `--privileged` because it runs its own Docker.

## 2. Install lf

```sh
# the published CLI
npm i -g landfall
```

Keep your real config out of the experiment.
landfall normally writes servers to `~/.config/landfall` and ssh aliases to `~/.ssh/config`.
These two variables move both into the test folder, for this shell only:

```sh
# config, ssh aliases and known hosts live in ~/landfall-try
export LANDFALL_CONFIG_DIR=~/landfall-try/cfg LANDFALL_SSH_CONFIG=~/landfall-try/ssh_config
printf 'Host *\n  UserKnownHostsFile %s/known_hosts\n' ~/landfall-try > ~/landfall-try/ssh_config
```

Run every `lf` command on this page in this shell.

## 3. Set up the server

```sh
# what setup would do, without changing anything
lf setup try --host 127.0.0.1 --port 2201 --key ~/landfall-try/key --check

# set it up: deploy user, Docker check, Traefik, ssh alias "try"
lf setup try --host 127.0.0.1 --port 2201 --key ~/landfall-try/key --email you@example.com --staging --no-firewall -y
```

- `--staging` uses Let's Encrypt's test service. Real certificates cannot reach a container on your machine anyway.
- `--no-firewall` skips ufw. It would only guard the container.
- The security notes at the end (firewall off, no automatic updates) are expected here.

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

## 4. Deploy a site

```sh
# a static site: a folder with an index.html
mkdir -p ~/landfall-try/hello && cd ~/landfall-try/hello
echo '<h1>hello from landfall</h1>' > index.html

# deploy it to the test server
lf deploy -s try -d hello.localhost -y
```

The site remembers its domain. Later deploys need only `lf deploy`.

```sh
# -k: the certificate is self-signed
curl -k https://hello.localhost:8443
```

In a browser, open `https://hello.localhost:8443` and accept the certificate warning.

`deploy` ends with a warning that it could not reach `https://hello.localhost`.
It checks port 443, but the container listens on 8443. The site is fine.

Change `index.html` and deploy again to see a new release.
Any project works the same way: a Node app, a Dockerfile, a Compose file. See [Deploy a site](deploy.md).

## 5. Look around

```sh
lf ls                       # sites on the server
lf sites info hello         # services, domains and every release
lf logs hello               # container logs
lf rollback hello -y        # back to the previous release
lf history                  # every change landfall made on the server
lf undo                     # take back the last one
lf server info try          # OS, hardware, memory, disk, containers
lf ssh try                  # a shell on the test server
lf ui                       # the web UI in your browser
```

Nothing can break: the server is a container you throw away.

## Clean up

```sh
# remove the test servers and their data
docker rm -fv landfall-try landfall-try-tn

# remove keys, config and sites
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
| `docker info` never answers | The container needs `--privileged`. Check `docker logs landfall-try`. |
| `hello.localhost` does not resolve | Some systems do not resolve `*.localhost`. Use `curl -k --resolve hello.localhost:8443:127.0.0.1 https://hello.localhost:8443`, or add `127.0.0.1 hello.localhost` to `/etc/hosts`. |
| `curl: (35)` or a TLS error | Traefik answers only names it has a certificate for. Run the certificate step again; it covers `*.localhost` only. |
| `Permission denied (publickey)` | The container was started with another key. Start it again with `AUTHORIZED_KEY` from `~/landfall-try/key.pub`. |
| `REMOTE HOST IDENTIFICATION HAS CHANGED` | A new container has a new host key. `rm ~/landfall-try/known_hosts`. |

## Optional: tenants

[Tenants](tenants.md) give other people their own rootless Docker on your server.
They need systemd, which the Alpine image lacks, so they get a second test server based on Ubuntu.

```sh
# Ubuntu with systemd and Docker
docker build -t landfall-try-tenants "https://github.com/ph1p/landfall.git#main:test/e2e/tenants"

# its own cgroup namespace, and volumes for Docker's data (no overlay on overlay)
docker run -d --privileged --cgroupns=private --name landfall-try-tn \
  -v /var/lib/docker -v /var/lib/containerd -v /opt/landfall/tenants \
  -p 2202:22 -p 8444:443 -e AUTHORIZED_KEY="$(cat ~/landfall-try/key.pub)" landfall-try-tenants
until docker exec landfall-try-tn docker info >/dev/null 2>&1; do sleep 1; done

# set it up, then add the tenant anna with her own key and domains
lf setup tbox --host 127.0.0.1 --port 2202 --key ~/landfall-try/key --email you@example.com --staging -y
ssh-keygen -q -t ed25519 -N "" -f ~/landfall-try/anna
lf tenant add anna -s tbox --key ~/landfall-try/anna.pub -d anna.localhost -d '*.anna.localhost' --force
```

The first tenant needs `--force`: it moves Traefik to the host network, which restarts it.

Now act as anna. She logs in with her own key and runs her own Traefik:

```sh
# register anna's login and start her Traefik
lf server add anna --host 127.0.0.1 --port 2202 --user anna -i ~/landfall-try/anna
lf traefik setup -s anna --email you@example.com --staging -y

# a certificate for anna's domains, in anna's Traefik
docker exec landfall-try-tn sh -c 'cd /opt/landfall/tenants/anna/traefik/dynamic &&
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 365 -subj /CN=landfall-try \
    -addext "subjectAltName=DNS:anna.localhost,DNS:*.anna.localhost" -keyout key.pem -out cert.pem 2>/dev/null &&
  printf "tls:\n  certificates:\n    - certFile: /etc/traefik/dynamic/cert.pem\n      keyFile: /etc/traefik/dynamic/key.pem\n" > local.yml &&
  chown anna: key.pem cert.pem local.yml'

# deploy the hello site as anna
cd ~/landfall-try/hello && lf deploy -s anna -d blog.anna.localhost -y
curl -k https://blog.anna.localhost:8444
```

The central Traefik passes `blog.anna.localhost` to anna's Traefik, still encrypted.
`lf ls -s anna` shows only her sites. `lf ls -s tbox` does not show hers.

## Run the test suite

landfall's end-to-end tests use the same two images.
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
