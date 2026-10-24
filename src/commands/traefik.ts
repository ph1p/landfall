import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { defineCommand, serverOpt } from "../cmd";
import { checkEmail, checkImage, defaults, checkInt, checkLoginName, DOMAIN, MIN_PASSWORD, expandDomain, loadConfig, resolveServer, saveConfig, type Server } from "../config";
import { assessTraefik, foreignProxy, probeServer } from "../inventory";
import { dashboardHosts, dashboardRouters, dockerLogs, hasDashboardTunnel } from "../remote";
import { ctrAddress, findContainer, openTunnel, routerPort } from "../tunnel";
import { runScript, shq, writeFileCmd } from "../ssh";
import { DEFAULT_TRAEFIK_IMAGE, DYNAMIC_DIR, NETWORK, PRELUDE, PROXY_CTR, PROXY_FILE, proxyFile, ROOT, SITES, TLS_FILE, TRAEFIK_DIR, traefikCompose, TUNNEL_PORT, type Proxy } from "../templates";
import { askSecret, c, confirm, confirmRemoval, fail, info, ok, step, warn } from "../ui";
import { adminLogin } from "../updates";

export interface TraefikInstall {
  /** Optional; falls back to what the server entry remembers. */
  email?: string;
  staging?: boolean;
  image?: string;
  hostNetwork?: boolean;
  http3?: boolean;
  dashboard?: string;
  dashboardUser: string;
  dashboardPassword?: string;
  /** Overwrite a docker-compose.yml edited by hand. */
  force?: boolean;
}

/** Traefik expects bcrypt as $2y$; bcryptjs emits $2b$ which is the same algorithm. */
export async function htpasswd(user: string, password: string) {
  const hash = await bcrypt.hash(password, 10);
  return `${user}:${hash.replace(/^\$2b\$/, "$2y$")}`;
}
/** The user of an htpasswd line. */
export const loginUser = (line: string) => line.slice(0, line.indexOf(":"));
/** An htpasswd line for a site login; asks for the password unless given. flag: the option that named the user, for errors. */
/** The login user when only a password is given. */
export const DEFAULT_USER = "admin";

export async function newLogin(user: string, password?: string, flag = "user") {
  checkLoginName(user, flag);
  const pw = password ?? (await askSecret(`Password for ${user}:`));
  if (pw.length < MIN_PASSWORD) fail(`use a password of at least ${MIN_PASSWORD} characters`);
  return htpasswd(user, pw);
}

/** What `installTraefik` will run with: flags first, then what the server entry remembers. */
export function traefikSettings(server: Server, o: Pick<TraefikInstall, "email" | "staging" | "image" | "hostNetwork" | "http3">) {
  return {
    email: o.email ?? server.email ?? defaults().email,
    staging: !!(o.staging ?? server.staging),
    image: o.image || server.traefikImage || DEFAULT_TRAEFIK_IMAGE,
    hostNetwork: !!(o.hostNetwork ?? server.hostNetwork),
    http3: (o.http3 ?? server.http3) !== false,
  };
}

export const describeTraefik = (t: ReturnType<typeof traefikSettings>) =>
  [t.image, t.hostNetwork ? "host network" : "ports 80/443 published", t.http3 ? "HTTP/3" : "no HTTP/3", t.staging && "LE staging"].filter(Boolean).join(", ");

/** Install traefik and remember its settings on the lf server entry `name` (if registered). */
export async function installTraefik(name: string, server: Server, o: TraefikInstall) {
  const t = traefikSettings(server, o);
  checkImage(t.image);
  if (t.email) checkEmail(t.email);
  const { email, staging } = t;
  step("installing traefik");
  // The dashboard stays as remembered unless --dashboard changes it ("off" removes it).
  let dashboard = o.dashboard === "off" ? undefined : server.dashboard;
  let password: string | undefined;
  const host = o.dashboard && o.dashboard !== "off" ? expandDomain(o.dashboard, server) : o.dashboardPassword && dashboard?.host;
  if (host) {
    if (!DOMAIN.test(host)) fail(`not a dashboard domain: ${host}${host.includes(".") ? "" : " (set a main domain first: lf server domain)"}`);
    const user = checkLoginName(o.dashboard ? o.dashboardUser : (dashboard?.user ?? o.dashboardUser), "--dashboard-user");
    password = o.dashboardPassword ?? randomBytes(12).toString("base64url");
    dashboard = { host, user, htpasswd: await htpasswd(user, password) };
  }
  const compose = traefikCompose({ ...t, dashboard });
  if (t.hostNetwork) await openHostPorts(server, t.http3);
  await runScript(
    server,
    `${PRELUDE}
ensure_network ${NETWORK}
[ -w ${TRAEFIK_DIR} ] || { $SUDO install -d -o "$(id -un)" ${TRAEFIK_DIR}; }
mkdir -p ${TRAEFIK_DIR}/letsencrypt ${DYNAMIC_DIR} && cd ${TRAEFIK_DIR}
${writeFileCmd("dynamic/landfall.yml", TLS_FILE)}
# The dashboard tunnel arrives from the gateway of the network (bridge mode): only it may use the tunnel entrypoint.
gw=$(docker network inspect ${NETWORK} -f '{{range .IPAM.Config}}{{.Gateway}} {{end}}' 2>/dev/null | tr ' ' '\\n' | grep -m1 '[.]' || true)
printf 'LANDFALL_GATEWAY=%s\\n' "\${gw:-127.0.0.1}" > .env
if [ -e docker-compose.yml ]; then
  ${writeFileCmd(".docker-compose.yml.new", compose)}
  # .landfall.sha256: what landfall wrote last. A different file was edited by hand.
  if [ -f .landfall.sha256 ] && ! sha256sum -c --status .landfall.sha256 2>/dev/null && ! cmp -s .docker-compose.yml.new docker-compose.yml && [ -z "${o.force ? "1" : ""}" ]; then
    diff -u docker-compose.yml .docker-compose.yml.new >&2; rm -f .docker-compose.yml.new
    echo "${TRAEFIK_DIR}/docker-compose.yml was edited by hand; the diff above is what landfall would change. Keep your edits: change dynamic/ or the flags instead; overwrite them: lf traefik setup --force" >&2
    exit 1
  fi
  # Same config again: nothing to journal.
  if cmp -s .docker-compose.yml.new docker-compose.yml; then rm -f .docker-compose.yml.new
  else
    u=$(saved docker-compose.yml)
    mv .docker-compose.yml.new docker-compose.yml
    record ${shq(`reconfigured traefik (${describeTraefik(t)})`)} "cd ${TRAEFIK_DIR} && $u && sha256sum docker-compose.yml > .landfall.sha256 && dc up -d --remove-orphans"
  fi
else
  ${writeFileCmd("docker-compose.yml", compose)}
  # Certificates in letsencrypt/ stay, a later install reuses them.
  record ${shq(`installed traefik (${describeTraefik(t)})`)} "cd ${TRAEFIK_DIR} && dc down --remove-orphans && rm -f docker-compose.yml .env .landfall.sha256 dynamic/landfall.yml && { rmdir dynamic 2>/dev/null || true; }"
fi
# Written now: a start that fails below must not make landfall's own file look edited by hand.
sha256sum docker-compose.yml > .landfall.sha256
log "starting traefik"
dc up -d --remove-orphans --quiet-pull
sleep 2 # traefik exits shortly after start on a bad config
ensure_running traefik`,
  );
  const cfg = loadConfig();
  if (cfg.servers[name]) {
    Object.assign(cfg.servers[name], {
      // landfall's default stays the default: changing it later reaches this server too.
      email: email === defaults().email ? undefined : email,
      staging: staging || undefined,
      traefikImage: t.image === DEFAULT_TRAEFIK_IMAGE ? undefined : t.image,
      hostNetwork: t.hostNetwork || undefined,
      http3: t.http3 ? undefined : false,
      dashboard,
    });
    saveConfig(cfg);
  }
  ok(`traefik running (${describeTraefik(t)}) — HTTPS certificates from Let's Encrypt`);
  if (t.hostNetwork) info(c.dim("host network: ufw now decides who reaches 80/443"));
  if (dashboard) {
    ok(`dashboard: https://${dashboard.host}`);
    if (password) info(`user ${c.bold(dashboard.user)}  password ${c.bold(password)}`);
    else info(c.dim(`user ${dashboard.user}, password unchanged (--dashboard-password to set a new one)`));
  }
}

/** Route landfall's sites through an existing Traefik: landfall writes PROXY_FILE and never touches that Traefik. */
export async function useProxy(server: Server, p: Proxy) {
  step(`using traefik ${c.bold(p.container)} for lf sites`);
  await runScript(
    server,
    `${PRELUDE}
docker network inspect ${shq(p.network)} >/dev/null 2>&1 || { echo ${shq(`docker network ${p.network} does not exist`)} >&2; exit 1; }
[ -w ${ROOT} ] || $SUDO install -d -o "$(id -un)" ${ROOT}
u=$(saved ${PROXY_FILE})
${writeFileCmd(PROXY_FILE, proxyFile(p))}
record ${shq(`sites use traefik ${p.container}`)} "$u"`,
  );
  ok(`sites join network ${c.bold(p.network)} with entrypoint ${c.bold(p.entrypoint)} and resolver ${c.bold(p.resolver)}`);
  info(c.dim(`redeploy existing sites to switch them over; delete ${PROXY_FILE} to let landfall run its own traefik again`));
}

/** Who runs the Traefik for lf sites on the server, and the sites behind it. */
export async function traefikState(server: Server): Promise<{ proxy?: string; compose?: "ours" | "foreign"; sites: string[] }> {
  const { stdout } = await runScript(
    server,
    `[ ! -f ${PROXY_FILE} ] || printf 'proxy\\t%s\\n' "$(sed -n 's/^container=//p' ${PROXY_FILE})"
f=${TRAEFIK_DIR}/docker-compose.yml
[ ! -f $f ] || { grep -q "managed by landfall" $f && echo compose ours || echo compose foreign; }
for d in ${SITES}/*/; do [ -d "$d" ] && printf 'site\\t%s\\n' "$(basename "$d")"; done; true`,
    { capture: true },
  );
  const st: { proxy?: string; compose?: "ours" | "foreign"; sites: string[] } = { sites: [] };
  for (const line of stdout.split("\n")) {
    const [k, v] = line.split(/[\t ]/);
    if (k === "proxy") st.proxy = v || "?";
    if (k === "compose") st.compose = v as "ours" | "foreign";
    if (k === "site") st.sites.push(v);
  }
  return st;
}

/**
 * Host mode puts traefik behind ufw (published ports bypass it): when ufw is on, allow 80, 443 and,
 * for HTTP/3, 443/udp. Needs root, which the deploy login usually lacks.
 */
async function openHostPorts(server: Server, http3: boolean) {
  const rules = ["80/tcp", "443/tcp", ...(http3 ? ["443/udp"] : [])];
  let login: Server;
  try {
    login = await adminLogin(server, "checking ufw");
  } catch {
    return warn(`can't check ufw without root; if it is on, allow ${rules.join(", ")} (lf firewall add)`);
  }
  await runScript(
    login,
    `${PRELUDE}
command -v ufw >/dev/null 2>&1 && $SUDO ufw status 2>/dev/null | grep -q "Status: active" || exit 0
${rules.map((r) => `ufw_add allow ${r}`).join("\n")}`,
  );
}

/** Stops landfall's traefik and takes out its config, undoable; certificates stay unless `certs`. */
export async function removeTraefik(server: Server, o: { certs?: boolean } = {}) {
  step("removing traefik");
  await runScript(
    server,
    `${PRELUDE}
cd ${TRAEFIK_DIR}
log "stopping traefik"
dc down --remove-orphans
# One assignment each: an assignment's status is only its last $(...), so a failed backup would go unnoticed.
u1=$(saved ${TRAEFIK_DIR}/docker-compose.yml)
u2=$(saved ${TRAEFIK_DIR}/.landfall.sha256)
u3=$(saved ${DYNAMIC_DIR}/landfall.yml)
u="$u1; $u2; $u3"
rm -f docker-compose.yml .landfall.sha256 ${DYNAMIC_DIR}/landfall.yml
${o.certs ? "rmf letsencrypt" : ""}
# Certificates removed with --certs come back from Let's Encrypt on the next start.
record ${shq(`removed traefik${o.certs ? " and its certificates" : ""}`)} "$u; cd ${TRAEFIK_DIR} && dc up -d --remove-orphans"`,
  );
}

/** --follow/--tail, shared by `logs` and `traefik logs`. */
export const logOpts = {
  follow: { type: "boolean", short: "f", desc: "follow" },
  tail: { type: "string", short: "n", desc: "lines", default: "100" },
} as const;

export const traefikSetup = defineCommand({
  name: "traefik setup",
  summary: "Install or reconfigure Traefik (reverse proxy + automatic HTTPS) on a server. Safe to re-run; refuses if ports 80/443 belong to something else.",
  options: {
    server: serverOpt,
    email: { type: "string", desc: "contact e-mail for the Let's Encrypt account (optional)" },
    staging: { type: "boolean", desc: "Let's Encrypt staging CA, remembered (--no-staging to switch back)" },
    image: { type: "string", desc: `traefik image, remembered (default: ${DEFAULT_TRAEFIK_IMAGE})` },
    "host-network": { type: "boolean", desc: "run on the host network: real client IPs, ufw applies; remembered (--no-host-network)" },
    http3: { type: "boolean", desc: "HTTP/3 over QUIC on 443/udp, on by default; remembered (--no-http3 turns it off)" },
    dashboard: { type: "string", desc: "serve the traefik dashboard on this domain (basic auth), remembered; `traefik` = traefik.<main domain>, `off` removes it" },
    "dashboard-user": { type: "string", desc: "dashboard user", default: DEFAULT_USER },
    "dashboard-password": { type: "string", desc: "dashboard password (default: generated)" },
    force: { type: "boolean", desc: "overwrite a docker-compose.yml that was edited by hand" },
  },
  async run(_, o) {
    const { name, server } = resolveServer(o.server);
    const probe = await probeServer(server);
    const t = assessTraefik(probe);
    if (t.status === "conflict") fail(`not touching ${name}: ${t.detail}`);
    if (t.proxy) fail(`${name} already has its own traefik: ${t.detail}. landfall does not reconfigure it (lf traefik use)`);
    // On the host network traefik's tunnel entrypoint binds 127.0.0.1:${TUNNEL_PORT} itself: taken, it would not start.
    if (traefikSettings(server, { hostNetwork: o["host-network"] }).hostNetwork) {
      const taken = probe.listen.find((l) => l.port === TUNNEL_PORT && l.proc !== "traefik");
      if (taken) fail(`port ${TUNNEL_PORT} is in use by ${taken.proc}; traefik on the host network needs it for lf tunnel`);
    }
    await installTraefik(name, server, {
      email: o.email && checkEmail(o.email),
      staging: o.staging,
      image: o.image,
      hostNetwork: o["host-network"],
      http3: o.http3,
      dashboard: o.dashboard,
      dashboardUser: o["dashboard-user"],
      dashboardPassword: o["dashboard-password"],
      force: o.force,
    });
  },
});

export const traefikUse = defineCommand({
  name: "traefik use",
  args: "[container]",
  summary: `Deploy sites through a Traefik that already runs on the server (yours, not landfall's).

landfall reads network, entrypoint and cert resolver from the container's flags;
pass them when it is configured by a file. That Traefik is never changed.`,
  options: {
    server: serverOpt,
    network: { type: "string", desc: "docker network traefik watches (providers.docker.network)" },
    entrypoint: { type: "string", desc: "HTTPS entrypoint (the one on :443)" },
    resolver: { type: "string", desc: "certificate resolver" },
  },
  async run([ctr], o) {
    const { name, server } = resolveServer(o.server);
    const probe = await probeServer(server);
    const found = foreignProxy(probe.values.foreign_proxy);
    const container = ctr ?? found?.name;
    if (!container) fail(`no traefik container publishes port 443 on ${name}; name it: lf traefik use <container>`);
    const detected = found?.name === container ? found : undefined;
    const p = {
      container: container!,
      network: o.network ?? detected?.proxy?.network,
      entrypoint: o.entrypoint ?? detected?.proxy?.entrypoint,
      resolver: o.resolver ?? detected?.proxy?.resolver,
    };
    const missing = (["network", "entrypoint", "resolver"] as const).filter((k) => !p[k]);
    if (missing.length) fail(`could not read the ${missing.join(", ")} of ${container}; pass ${missing.map((m) => `--${m}`).join(" ")}`);
    await useProxy(server, p as Proxy);
  },
});

export const traefikRemove = defineCommand({
  name: "traefik rm",
  summary: `Stop landfall's Traefik and remove its config. Sites stay but are unreachable until \`lf traefik setup\`.

Certificates in letsencrypt/ stay for a later install unless --certs. Undo with \`lf undo\`.
With a Traefik of your own (lf traefik use), landfall only stops routing sites through it.`,
  options: { server: serverOpt, certs: { type: "boolean", desc: "also delete the Let's Encrypt certificates" } },
  async run(_, o) {
    const { name, server } = resolveServer(o.server);
    const st = await traefikState(server);
    if (st.proxy) {
      if (!(await confirm(`Stop routing sites on ${name} through your traefik ${st.proxy}? It keeps running.`, false))) fail("cancelled");
      await runScript(server, `${PRELUDE}\nu=$(saved ${PROXY_FILE})\n_as ${ROOT} rm -f ${PROXY_FILE}\nrecord ${shq(`sites stop using traefik ${st.proxy}`)} "$u"`);
      ok(`landfall no longer uses ${st.proxy}; it keeps running and keeps routing the sites until they are redeployed`);
      return info(c.dim("lf traefik setup installs landfall's own traefik"));
    }
    if (st.compose === "foreign") fail(`${TRAEFIK_DIR}/docker-compose.yml was not written by landfall; not touching it`);
    if (!st.compose) return ok(`no traefik of landfall's on ${name}`);
    const sites = st.sites.length ? ` ${st.sites.join(", ")} will be unreachable until \`lf traefik setup\`.` : "";
    await confirmRemoval(`Stop and remove traefik${o.certs ? " and its certificates" : ""} on ${name}?${sites}`);
    await removeTraefik(server, { certs: o.certs });
    ok(`traefik removed${o.certs ? "" : c.dim(" (certificates stay for a later install; --certs deletes them)")}`);
    info(c.dim("lf undo puts it back, lf traefik setup installs it again"));
  },
});

export const traefikStatus = defineCommand({
  name: "traefik status",
  summary: "Show traefik container state and the routes it serves.",
  options: { server: serverOpt },
  async run(_, o) {
    const { server } = resolveServer(o.server);
    await runScript(
      server,
      `P=${PROXY_CTR}
if ! docker inspect "$P" >/dev/null 2>&1; then echo "traefik is not installed (lf traefik setup)"; exit 0; fi
[ -f ${PROXY_FILE} ] && echo "your own traefik, landfall only routes sites through it (${PROXY_FILE})"
docker ps -a --filter "name=^$P$" --format '{{.Names}}  {{.Image}}  {{.Status}}  network {{.Networks}}'
echo
echo "routes:"
# One line per rule: sites often pair an http and an https router with the same rule.
# Containers without a rule (traefik.enable only) print nothing.
docker ps --filter label=traefik.enable=true --format '{{.Names}}' | while read -r n; do
  docker inspect -f '{{range $k, $v := .Config.Labels}}{{$k}}={{$v}}{{println}}{{end}}' "$n" 2>/dev/null | awk -v n="$n" '
    /^traefik[.]http[.]routers[.][^.=]+[.](rule|entrypoints)=/ {
      split($0, k, "."); v = substr($0, index($0, "=") + 1)
      if ($0 ~ /[.]rule=/) rule[k[4]] = v; else ep[k[4]] = v
    }
    END {
      for (r in rule) {
        x = rule[r]; m = split((r in ep) ? ep[r] : "all", a, ",")
        for (i = 1; i <= m; i++) if (!((x, a[i]) in seen)) { seen[x, a[i]] = 1; e[x, ++cnt[x]] = a[i] }
      }
      # Sorted, so the same routes always print the same way.
      for (x in cnt) {
        for (i = 2; i <= cnt[x]; i++) for (j = i; j > 1 && e[x, j - 1] > e[x, j]; j--) { t = e[x, j]; e[x, j] = e[x, j - 1]; e[x, j - 1] = t }
        s = e[x, 1]; for (i = 2; i <= cnt[x]; i++) s = s "," e[x, i]
        printf "  %s  %s  (%s)\\n", n, x, s
      }
    }' || true
done | sort`,
    );
  },
});

export const traefikLogs = defineCommand({
  name: "traefik logs",
  summary: "Show traefik logs (certificate errors show up here).",
  options: { server: serverOpt, ...logOpts },
  async run(_, o) {
    return dockerLogs(resolveServer(o.server).server, PROXY_CTR, o);
  },
});

export const traefikRestart = defineCommand({
  name: "traefik restart",
  summary: "Restart traefik.",
  options: { server: serverOpt },
  async run(_, o) {
    const { server } = resolveServer(o.server);
    await runScript(server, `${PRELUDE}\ndocker restart ${PROXY_CTR} >/dev/null\nrecord "restarted traefik"`);
    ok("traefik restarted");
  },
});

export const traefikDashboard = defineCommand({
  name: "traefik dashboard",
  summary: `Open Traefik's dashboard on localhost through an SSH tunnel.

No domain or password needed: landfall's Traefik serves the dashboard to the server
itself, and only there. To also serve it on a domain behind a password:
lf traefik setup --dashboard traefik (traefik.<main domain>).

A Traefik of your own works too when it routes the dashboard to a domain: the tunnel
goes to that entrypoint and sends the domain along (log in with its password).`,
  options: {
    server: serverOpt,
    local: { type: "string", short: "l", desc: "local port (default: 8080, else a free one)" },
    lan: { type: "boolean", desc: "listen on this machine's network too: open it from a phone on the same Wi-Fi" },
    port: { type: "string", desc: "with a Traefik of your own: the port of its API (api.insecure: 8080)" },
  },
  async run(_, o) {
    const { name, server } = resolveServer(o.server);
    const st = await traefikState(server);
    const ctr = await findContainer(server, [`name=^${st.proxy ?? "traefik"}$`]);
    if (!ctr) fail(`traefik is not running on ${name}${st.proxy ? "" : " (lf traefik setup)"}`);
    const hosts = dashboardHosts(ctr!.labels);
    const also = hosts.length ? `also at ${hosts.map((h) => `https://${h}`).join(", ")} (with its password)` : undefined;
    const port = o.port ? checkInt(o.port, "--port", 1, 65535) : !st.proxy && hasDashboardTunnel(ctr!.labels) ? TUNNEL_PORT : undefined;
    const what = `traefik dashboard of ${name}`;
    if (port) return openTunnel(server, ctrAddress(ctr!, NETWORK), port, { local: o.local, lan: o.lan, path: "/dashboard/", what, note: also });
    // No API port: go through the router that serves it on a domain, as that domain.
    const routed = dashboardRouters(ctr!.labels)
      .flatMap((r) => (r.hosts[0] ? [{ host: r.hosts[0], at: routerPort(ctr!, r.router) }] : []))
      .find((r) => r.at);
    if (!routed)
      fail(
        st.proxy
          ? `${st.proxy} is your own traefik and serves no dashboard on a domain; if it serves its API (api.insecure), pass its port: --port 8080`
          : `traefik on ${name} was set up by an older landfall: \`lf traefik setup -s ${name}\` adds the dashboard tunnel`,
      );
    const { host, at } = routed!;
    await openTunnel(server, ctrAddress(ctr!, NETWORK), at!.port, {
      local: o.local,
      lan: o.lan,
      path: "/dashboard/",
      what,
      note: `through ${host}'s router (it asks for its login)`,
      as: { name: host, tls: at!.tls },
    });
  },
});
