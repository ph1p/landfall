import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { defineCommand, serverOpt } from "../cmd";
import { DOMAIN, expandDomain, loadConfig, resolveServer, saveConfig, type Server } from "../config";
import { assessTraefik, foreignProxy, probeServer } from "../inventory";
import { dockerLogs } from "../remote";
import { runScript, shq, writeFileCmd } from "../ssh";
import { DEFAULT_TRAEFIK_IMAGE, NETWORK, PRELUDE, PROXY_CTR, PROXY_FILE, proxyFile, ROOT, TRAEFIK_DIR, traefikCompose, type Proxy } from "../templates";
import { c, fail, info, ok, step } from "../ui";

export interface TraefikInstall {
  /** Optional; falls back to what the server entry remembers. */
  email?: string;
  staging?: boolean;
  image?: string;
  hostNetwork?: boolean;
  dashboard?: string;
  dashboardUser: string;
  dashboardPassword?: string;
}

/** Traefik expects bcrypt as $2y$; bcryptjs emits $2b$ which is the same algorithm. */
export async function htpasswd(user: string, password: string) {
  const hash = await bcrypt.hash(password, 10);
  return `${user}:${hash.replace(/^\$2b\$/, "$2y$")}`;
}

/** What `installTraefik` will run with: flags first, then what the server entry remembers. */
export function traefikSettings(server: Server, o: Pick<TraefikInstall, "email" | "staging" | "image" | "hostNetwork">) {
  return {
    email: o.email ?? server.email,
    staging: !!(o.staging ?? server.staging),
    image: o.image || server.traefikImage || DEFAULT_TRAEFIK_IMAGE,
    hostNetwork: !!(o.hostNetwork ?? server.hostNetwork),
  };
}

export const describeTraefik = (t: ReturnType<typeof traefikSettings>) =>
  [t.image, t.hostNetwork ? "host network" : "ports 80/443 published", t.staging && "LE staging"].filter(Boolean).join(", ");

/** Install traefik and remember its settings on the lf server entry `name` (if registered). */
export async function installTraefik(name: string, server: Server, o: TraefikInstall) {
  const t = traefikSettings(server, o);
  const { email, staging } = t;
  step("installing traefik");
  // The dashboard stays as remembered unless --dashboard changes it ("off" removes it).
  let dashboard = o.dashboard === "off" ? undefined : server.dashboard;
  let password: string | undefined;
  const host = o.dashboard && o.dashboard !== "off" ? expandDomain(o.dashboard, server) : o.dashboardPassword && dashboard?.host;
  if (host) {
    if (!DOMAIN.test(host)) fail(`not a dashboard domain: ${host}${host.includes(".") ? "" : " (set a main domain first: lf server domain)"}`);
    const user = o.dashboard ? o.dashboardUser : (dashboard?.user ?? o.dashboardUser);
    password = o.dashboardPassword ?? randomBytes(12).toString("base64url");
    dashboard = { host, user, htpasswd: await htpasswd(user, password) };
  }
  const compose = traefikCompose({ ...t, dashboard });
  await runScript(
    server,
    `${PRELUDE}
ensure_network ${NETWORK}
[ -w ${TRAEFIK_DIR} ] || { $SUDO install -d -o "$(id -un)" ${TRAEFIK_DIR}; }
mkdir -p ${TRAEFIK_DIR}/letsencrypt && cd ${TRAEFIK_DIR}
if [ -e docker-compose.yml ]; then
  ${writeFileCmd(".docker-compose.yml.new", compose)}
  # Same config again: nothing to journal.
  if cmp -s .docker-compose.yml.new docker-compose.yml; then rm -f .docker-compose.yml.new
  else
    u=$(saved docker-compose.yml)
    mv .docker-compose.yml.new docker-compose.yml
    record "reconfigured traefik (${describeTraefik(t)})" "cd ${TRAEFIK_DIR} && $u && dc up -d --remove-orphans"
  fi
else
  ${writeFileCmd("docker-compose.yml", compose)}
  # Certificates in letsencrypt/ stay, a later install reuses them.
  record "installed traefik (${describeTraefik(t)})" "cd ${TRAEFIK_DIR} && dc down --remove-orphans && rm -f docker-compose.yml"
fi
log "starting traefik"
dc up -d --remove-orphans --quiet-pull
sleep 2 # traefik exits shortly after start on a bad config
ensure_running traefik`,
  );
  const cfg = loadConfig();
  if (cfg.servers[name]) {
    Object.assign(cfg.servers[name], {
      email,
      staging: staging || undefined,
      traefikImage: t.image === DEFAULT_TRAEFIK_IMAGE ? undefined : t.image,
      hostNetwork: t.hostNetwork || undefined,
      dashboard,
    });
    saveConfig(cfg);
  }
  ok(`traefik running (${describeTraefik(t)}) — HTTPS certificates from Let's Encrypt`);
  if (t.hostNetwork) info(c.dim("host network: ufw now decides who reaches 80/443 (landfall's firewall allows both)"));
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
docker network inspect ${p.network} >/dev/null 2>&1 || { echo "docker network ${p.network} does not exist" >&2; exit 1; }
[ -w ${ROOT} ] || $SUDO install -d -o "$(id -un)" ${ROOT}
u=$(saved ${PROXY_FILE})
${writeFileCmd(PROXY_FILE, proxyFile(p))}
record ${shq(`sites use traefik ${p.container}`)} "$u"`,
  );
  ok(`sites join network ${c.bold(p.network)} with entrypoint ${c.bold(p.entrypoint)} and resolver ${c.bold(p.resolver)}`);
  info(c.dim(`redeploy existing sites to switch them over; delete ${PROXY_FILE} to let landfall run its own traefik again`));
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
    dashboard: { type: "string", desc: "serve the traefik dashboard on this domain (basic auth), remembered; `traefik` = traefik.<main domain>, `off` removes it" },
    "dashboard-user": { type: "string", desc: "dashboard user", default: "admin" },
    "dashboard-password": { type: "string", desc: "dashboard password (default: generated)" },
  },
  async run(_, o) {
    const { name, server } = resolveServer(o.server);
    const t = assessTraefik(await probeServer(server));
    if (t.status === "conflict") fail(`not touching ${name}: ${t.detail}`);
    if (t.proxy) fail(`${name} already has its own traefik: ${t.detail}. landfall does not reconfigure it (lf traefik use)`);
    await installTraefik(name, server, {
      email: o.email,
      staging: o.staging,
      image: o.image,
      hostNetwork: o["host-network"],
      dashboard: o.dashboard,
      dashboardUser: o["dashboard-user"],
      dashboardPassword: o["dashboard-password"],
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
