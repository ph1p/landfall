# Try landfall locally

You can try landfall without a server.
A Docker container on your machine plays the server: it runs sshd and its own Docker daemon.
The test suite uses the same container.

You need Docker, Node 22.4 or newer, and a checkout of the landfall repository.

## Start the test server

```sh
# get the container definitions
git clone https://github.com/ph1p/landfall && cd landfall

# build the image: sshd and Docker in one container
docker build -t landfall-try test/e2e

# a key that only this container accepts
mkdir -p ~/landfall-try
ssh-keygen -q -t ed25519 -N "" -f ~/landfall-try/key

# start it: ssh on port 2222, HTTPS on port 8443
docker run -d --privileged --name landfall-try -p 2222:22 -p 8443:443 \
  -e AUTHORIZED_KEY="$(cat ~/landfall-try/key.pub)" landfall-try

# wait until its Docker answers
until docker exec landfall-try docker info >/dev/null 2>&1; do sleep 1; done
```

The container needs `--privileged` because it runs its own Docker daemon.

## Keep your own config apart

landfall writes servers to `~/.config/landfall` and ssh aliases to `~/.ssh/config`.
Point both at the test folder, so your real config stays untouched.

```sh
# landfall's config and ssh config for this shell only
export LANDFALL_CONFIG_DIR=~/landfall-try/cfg LANDFALL_SSH_CONFIG=~/landfall-try/ssh_config
printf 'Host *\n  UserKnownHostsFile %s/known_hosts\n' ~/landfall-try > ~/landfall-try/ssh_config
```

Run every `lf` command below in this shell.

## Set up the server

```sh
# install landfall
npm i -g landfall

# set up the container like a VPS: deploy user, Traefik, ssh alias "try"
lf setup try --host 127.0.0.1 --port 2222 --key ~/landfall-try/key --email you@example.com --staging --no-firewall -y
```

- `--staging` uses Let's Encrypt's test service. It cannot issue certificates for a container on your machine anyway.
- `--no-firewall` skips ufw. In the container it would only guard the container.

Traefik needs a certificate to answer HTTPS.
The image ships a self-signed one for `*.127-0-0-1.sslip.io` and `*.test`.
Give it to Traefik:

```sh
# hand Traefik the image's self-signed certificate
docker exec landfall-try sh -c 'd=/opt/landfall/traefik/dynamic && cp /e2e/cert.pem /e2e/key.pem $d/ &&
  printf "tls:\n  certificates:\n    - certFile: /etc/traefik/dynamic/cert.pem\n      keyFile: /etc/traefik/dynamic/key.pem\n" > $d/local.yml'
```

## Deploy a site

```sh
# a static site: a folder with an index.html
mkdir -p ~/landfall-try/hello && cd ~/landfall-try/hello
echo '<h1>hello from landfall</h1>' > index.html

# deploy it to the container
lf deploy -s try -y
```

The site gets `hello.127-0-0-1.sslip.io`.
That name resolves to 127.0.0.1, so it reaches the container.

```sh
# -k: the certificate is self-signed
curl -k https://hello.127-0-0-1.sslip.io:8443
```

In a browser, open `https://hello.127-0-0-1.sslip.io:8443` and accept the certificate warning.

Everything else works as on a real server: `lf ls`, `lf logs`, `lf rollback`, `lf history`, `lf undo`.
`lf ui` opens the web UI for it.

## Try tenants

[Tenants](tenants.md) need systemd and rootless Docker.
The Alpine image above has neither, so they get their own Ubuntu image.

```sh
# Ubuntu with systemd and Docker
docker build -t landfall-try-tenants test/e2e/tenants

# its own cgroup namespace, and volumes for Docker's data (no overlay on overlay)
docker run -d --privileged --cgroupns=private --name landfall-try-tn \
  -v /var/lib/docker -v /var/lib/containerd -v /opt/landfall/tenants \
  -p 2223:22 -p 8444:443 -e AUTHORIZED_KEY="$(cat ~/landfall-try/key.pub)" landfall-try-tenants

# wait until its Docker answers
until docker exec landfall-try-tn docker info >/dev/null 2>&1; do sleep 1; done

# set it up, then add a tenant
lf setup tbox --host 127.0.0.1 --port 2223 --key ~/landfall-try/key --email you@example.com --staging -y
ssh-keygen -q -t ed25519 -N "" -f ~/landfall-try/anna
lf tenant add anna -s tbox --key ~/landfall-try/anna.pub -d anna.test -d '*.anna.test' --force
```

The first tenant needs `--force`: it moves Traefik to the host network, which restarts it.

Now work as the tenant:

```sh
# log in as anna, start anna's own Traefik
lf server add anna --host 127.0.0.1 --port 2223 --user anna -i ~/landfall-try/anna
lf traefik setup -s anna --email you@example.com --staging -y

# hand anna's Traefik the image's certificate for *.anna.test
docker exec landfall-try-tn sh -c 'd=/opt/landfall/tenants/anna/traefik/dynamic && cp /e2e/cert.pem /e2e/key.pem $d/ &&
  printf "tls:\n  certificates:\n    - certFile: /etc/traefik/dynamic/cert.pem\n      keyFile: /etc/traefik/dynamic/key.pem\n" > $d/local.yml && chown -R anna: $d'

# deploy the hello site as anna
cd ~/landfall-try/hello && lf deploy -s anna -d blog.anna.test -y

# blog.anna.test does not resolve: point curl at the container
curl -k --resolve blog.anna.test:8444:127.0.0.1 https://blog.anna.test:8444
```

## Clean up

```sh
# remove the containers and their volumes
docker rm -fv landfall-try landfall-try-tn

# remove the key, config and site
rm -rf ~/landfall-try
```

## Run the test suite

The same containers run landfall's end-to-end tests.
In the repository:

```sh
# build, then run every section against fresh containers
pnpm install && pnpm e2e

# only some sections, after setup
E2E_ONLY="static tenants" pnpm e2e

# keep the container and the work folder after the run
KEEP=1 pnpm e2e
```
