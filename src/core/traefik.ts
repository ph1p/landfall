import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { checkEmail, checkImage, defaults, checkLoginName, DOMAIN, MIN_PASSWORD, expandDomain, loadConfig, saveConfig, type Server } from "./config";
import { runScript, shq, writeFileCmd } from "./ssh";
import { DEFAULT_TRAEFIK_IMAGE, DYNAMIC_DIR, NETWORK, PRELUDE, PROXY_FILE, proxyFile, ROOT, SITES, TLS_FILE, TRAEFIK_DIR, traefikCompose, type Proxy } from "./templates";
import { askSecret, c, fail, info, ok, step, warn } from "./term";
import { adminLogin } from "./privilege";

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
/** The login user when only a password is given. */
export const DEFAULT_USER = "admin";

/** An htpasswd line for a site login; asks for the password unless given. flag: the option that named the user, for errors. */
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
