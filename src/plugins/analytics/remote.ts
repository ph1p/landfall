// Reading and writing the collector on the server: /opt/landfall/analytics, a plain Compose project.
import type { PluginContext } from "../../core/plugins/plugin-api";
import { writeFileCmd } from "../../core/ssh/ssh";
import { clientJs } from "./client";
import { COOKIE_MODES, DOMAIN, PREFIX, PROJECT, SITE, type CookieMode, type Storage } from "./shared";

const CTR_FILTER = `label=com.docker.compose.project=${PROJECT}`;
const IMAGE = "node:22-alpine";

const b64 = (s: string) => Buffer.from(s).toString("base64");
/** Sets $qid to the running collector's container, or empty. */
const RUNNING_QID = `qid=$(docker ps -q --filter ${CTR_FILTER} | head -n1)`;
/** Shell function lfq: runs query.mjs in the collector $qid, or in a one-off container when $qid is empty. */
const queryFn = (d: string) =>
  `lfq() { if [ -n "$qid" ]; then docker exec "$qid" node --no-warnings /app/query.mjs "$@"; else docker run --rm --user "$(id -u):$(id -g)" -v ${d}/app:/app:ro -v ${d}/data:/data ${IMAGE} node --no-warnings /app/query.mjs "$@"; fi; }`;
export const dirOf = (ctx: PluginContext) => `${ctx.paths.root}/analytics`;
export const errText = (e: unknown) => String((e as Error)?.message ?? e).replace(/^error: /, "");

export interface Funnel {
  site: string;
  name: string;
  steps: string[];
}
/** Per-site settings in app/sites.json: the collector reads them every 30 seconds. */
export type SiteSettings = Record<string, { cookie?: CookieMode }>;

export interface State {
  docker: "ok" | "missing" | "noaccess";
  proxy: { network: string; entrypoint: string; resolver: string };
  /** Traefik's network exists. */
  network: boolean;
  /** domain → site */
  hosts: Record<string, string>;
  settings: SiteSettings;
  /** app/storage.json: how much data the collector keeps. */
  storage: Storage;
  funnels: Funnel[];
  /** The sites landfall deployed on the server. */
  sites: string[];
  /** The domains of the site that was asked for (probe's o.site). */
  domains: string[];
  collector?: { status: string; started: string; restarts: number; error: string };
  logs: string[];
  /** Per enabled site: whether its home page loads the script, and what /_lf/a/s.js answers through Traefik. */
  tags: Record<string, { host: string; tag: boolean; page: string; endpoint: string }>;
  size: number;
  /** /opt/landfall/analytics exists: something to uninstall. */
  installed: boolean;
  /** A file the plugin wrote that does not parse. */
  broken?: string;
  data?: any;
  queryError?: string;
  /** Sites that collect, sorted. */
  enabled: string[];
  running: boolean;
}

/** The cookie mode of a site: off unless sites.json says otherwise. */
export const cookieOf = (st: Pick<State, "settings">, site: string): CookieMode => {
  const m = st.settings[site]?.cookie;
  return m && COOKIE_MODES.includes(m) ? m : "off";
};

/**
 * Everything the commands and the panel need, in one ssh round trip.
 * o.site: also the domains of that site's routers. o.tags: also fetch each enabled site's home page through Traefik.
 * o.query: also run app/query.mjs with this request (in the collector, or in a one-off container when it is down).
 */
export async function probe(ctx: PluginContext, o: { site?: string; tags?: boolean; query?: object } = {}): Promise<State> {
  const d = ctx.shq(dirOf(ctx));
  const oneLine = (tag: string, file: string) => String.raw`printf '${tag}\t%s\n' "$(cat ${d}/${file} 2>/dev/null | tr -d '\n' || true)"`;
  const out = await ctx.script(String.raw`
[ ! -d ${d} ] || echo INSTALLED
command -v docker >/dev/null 2>&1 || { echo NODOCKER; exit 0; }
docker info >/dev/null 2>&1 || { echo NODOCKERACCESS; exit 0; }
proxy=$(grep -v '^#' ${ctx.shq(ctx.paths.root + "/proxy.env")} 2>/dev/null | tr '\n' ' ' || true)
printf 'PROXY\t%s\n' "$proxy"
net=$(printf '%s\n' $proxy | sed -n 's/^network=//p' | grep . || echo web)
printf 'NET\t%s\n' "$(docker network inspect "$net" >/dev/null 2>&1 && echo yes || echo no)"
${oneLine("HOSTS", "app/hosts.json")}
${oneLine("SETTINGS", "app/sites.json")}
${oneLine("STORAGE", "app/storage.json")}
${oneLine("FUNNELS", "funnels.json")}
printf 'SITES\t%s\n' "$(ls -1 ${ctx.shq(ctx.paths.sites)} 2>/dev/null | tr '\n' ' ' || true)"
id=$(docker ps -aq --filter ${CTR_FILTER} | head -n1)
running=
if [ -n "$id" ]; then
  ctr=$(docker inspect -f '{{.State.Running}}{{.RestartCount}}|{{.State.Status}}|{{.State.StartedAt}}|{{.RestartCount}}|{{.State.Error}}' "$id")
  printf 'CTR\t%s\n' "$(printf %s "$ctr" | cut -d'|' -f2-)"
  case "$ctr" in "true0|"*) running=1 ;; *) docker logs --tail 8 "$id" 2>&1 | sed 's/^/LOG\t/' || true ;; esac
fi
printf 'SIZE\t%s\n' "$(cat ${d}/data/analytics.db ${d}/data/analytics.db-wal 2>/dev/null | wc -c | tr -d ' ')"
site=${ctx.shq(o.site ?? "")}
if [ -n "$site" ]; then
  # Hosts in the rules of the site's routers: landfall names them <site>_<service>[_<port>].
  docker ps -q | xargs -r docker inspect -f '{{range $k, $v := .Config.Labels}}{{$k}}={{$v}}{{println}}{{end}}' 2>/dev/null \
    | grep -E "^traefik\.http\.routers\.$site(_[^.]*)?\.rule=" | grep -o 'Host([^)]*)' | tr -d '\140' \
    | sed 's/^Host(//; s/)$//' | sort -u | sed 's/^/DOMAIN\t/' || true
fi
if [ -n ${ctx.shq(o.tags ? "1" : "")} ] && command -v curl >/dev/null 2>&1 && [ -f ${d}/app/hosts.json ]; then
  # One check per site, all at once: each curl may wait 4 seconds.
  { grep -o '"[a-z0-9.-]*":"[a-z0-9-]*"' ${d}/app/hosts.json || true; } | tr -d '"' | awk -F: '!seen[$2]++' | { while IFS=: read -r h s; do {
    page=$(curl -sk --max-time 4 --resolve "$h:443:127.0.0.1" -w '\n%{http_code}' "https://$h/" 2>/dev/null || true)
    code=$(printf '%s' "$page" | tail -n1)
    case "$page" in *'${PREFIX}s.js'*) tag=yes ;; *) tag=no ;; esac
    ep=$(curl -sk --max-time 4 --resolve "$h:443:127.0.0.1" -o /dev/null -w '%{http_code}' "https://$h${PREFIX}s.js" 2>/dev/null || true)
    printf 'TAG\t%s\t%s\t%s\t%s\t%s\n' "$s" "$h" "$tag" "$code" "$ep"
  } & done; wait; }
fi
q=${ctx.shq(o.query ? b64(JSON.stringify(o.query)) : "")}
if [ -n "$q" ]; then
  funnels=$(cat ${d}/funnels.json 2>/dev/null || echo '[]')
  ${queryFn(d)}
  qid=; [ -z "$running" ] || qid=$id
  if [ ! -f ${d}/data/analytics.db ]; then res='{"empty":true}'; rc=0
  else res=$(lfq "$q" "$funnels" 2>&1) && rc=0 || rc=$?
  fi
  [ "$rc" = 0 ] && echo QUERY || echo QUERYERR
  printf '%s\n' "$res"
fi
exit 0`);
  return parseProbe(out);
}

export function parseProbe(out: string): State {
  const st: State = {
    docker: "ok",
    proxy: { network: "web", entrypoint: "websecure", resolver: "le" },
    network: true,
    hosts: {},
    settings: {},
    storage: {},
    funnels: [],
    sites: [],
    domains: [],
    logs: [],
    tags: {},
    size: 0,
    installed: false,
    enabled: [],
    running: false,
  };
  const json = (text: string, file: string) => {
    try {
      return JSON.parse(text);
    } catch {
      st.broken = `${file} is not valid JSON`;
      return undefined;
    }
  };
  const lines = out.split("\n");
  const at = lines.findIndex((l) => l === "QUERY" || l === "QUERYERR");
  for (const line of at < 0 ? lines : lines.slice(0, at)) {
    const [tag, ...f] = line.split("\t");
    if (tag === "NODOCKER") st.docker = "missing";
    else if (tag === "NODOCKERACCESS") st.docker = "noaccess";
    else if (tag === "PROXY")
      for (const w of (f[0] ?? "").split(/\s+/)) {
        const i = w.indexOf("=");
        const k = w.slice(0, i) as keyof State["proxy"];
        if (i > 0 && k in st.proxy) st.proxy[k] = w.slice(i + 1);
      }
    else if (tag === "INSTALLED") st.installed = true;
    else if (tag === "NET") st.network = f[0] === "yes";
    else if (tag === "HOSTS" && f[0]) st.hosts = json(f[0], "app/hosts.json") ?? {};
    else if (tag === "SETTINGS" && f[0]) st.settings = json(f[0], "app/sites.json") ?? {};
    else if (tag === "STORAGE" && f[0]) st.storage = json(f[0], "app/storage.json") ?? {};
    else if (tag === "FUNNELS" && f[0]) st.funnels = json(f[0], "funnels.json") ?? [];
    else if (tag === "SITES") st.sites = (f[0] ?? "").split(/\s+/).filter((s) => SITE.test(s));
    else if (tag === "CTR") {
      const [status, started, restarts, error] = f.join("\t").split("|");
      st.collector = { status, started, restarts: Number(restarts) || 0, error };
    } else if (tag === "LOG") st.logs.push(f.join("\t"));
    else if (tag === "SIZE") st.size = Number(f[0]) || 0;
    else if (tag === "DOMAIN" && DOMAIN.test(f[0])) st.domains.push(f[0]);
    else if (tag === "TAG") st.tags[f[0]] = { host: f[1], tag: f[2] === "yes", page: f[3], endpoint: f[4] };
  }
  if (at >= 0) {
    const text = lines
      .slice(at + 1)
      .join("\n")
      .trim();
    if (lines[at] === "QUERY") {
      try {
        st.data = JSON.parse(text);
      } catch {
        st.queryError = `the query printed no JSON: ${text.slice(0, 300)}`;
      }
    } else
      st.queryError =
        text
          .split("\n")
          .filter((l) => !/^\s+at /.test(l))
          .slice(-6)
          .join("\n") || "the query failed";
  }
  st.enabled = [...new Set(Object.values(st.hosts))].sort();
  st.running = st.collector?.status === "running" && st.collector.restarts === 0;
  return st;
}

const NO_DOCKER = "Docker is not installed on this server: run lf setup first";
const NO_DOCKER_ACCESS = "this login cannot use Docker: add it to the docker group (lf setup does) or log in as root";

/** Stops a command where the server cannot run the collector, with what to do about it. */
export function needDocker(ctx: PluginContext, st: State) {
  if (st.docker === "missing") ctx.fail(NO_DOCKER);
  if (st.docker === "noaccess") ctx.fail(NO_DOCKER_ACCESS);
  if (st.broken) ctx.fail(`${dirOf(ctx)}/${st.broken}: fix or delete it, then lf analytics repair`);
}

/** probe with a query, failing when the query does. */
export async function query(ctx: PluginContext, req: object, more: { site?: string; tags?: boolean } = {}) {
  const st = await probe(ctx, { ...more, query: req });
  needDocker(ctx, st);
  if (st.queryError) ctx.fail(`could not read the analytics database: ${st.queryError}`);
  if (st.enabled.length && !st.running) ctx.log.warn("the collector is not running, so nothing is collected: lf analytics repair");
  return st;
}

export function composeYml(proxy: State["proxy"], hosts: Record<string, string>) {
  const rule = `(${Object.keys(hosts)
    .sort()
    .map((h) => `Host(\`${h}\`)`)
    .join(" || ")}) && PathPrefix(\`${PREFIX}\`)`;
  const q = JSON.stringify;
  return `# landfall analytics: the collector for ${PREFIX} on the sites in app/hosts.json
name: ${PROJECT}
services:
  collector:
    image: ${IMAGE}
    restart: unless-stopped
    command: ["node", "--no-warnings", "/app/server.mjs"]
    user: "@UID@"
    read_only: true
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    mem_limit: 128m
    volumes:
      - ./app:/app:ro
      - ./data:/data
    networks: [proxy]
    labels:
      traefik.enable: "true"
      traefik.docker.network: ${q(proxy.network)}
      traefik.http.routers.${PROJECT}.rule: ${q(rule)}
      traefik.http.routers.${PROJECT}.entrypoints: ${q(proxy.entrypoint)}
      traefik.http.routers.${PROJECT}.tls.certresolver: ${q(proxy.resolver)}
      traefik.http.routers.${PROJECT}.priority: "10000"
      traefik.http.services.${PROJECT}.loadbalancer.server.port: "8080"
networks:
  proxy:
    external: true
    name: ${q(proxy.network)}
`;
}

const README = `# landfall analytics

Written by lf analytics. A plain Docker Compose project:

- compose.yml: the collector (node:22-alpine), routed by Traefik for /_lf/a/ on the domains in app/hosts.json
- app/: the collector (server.mjs), the queries (query.mjs), the browser script (client.js) and time zone to country codes (tz.json)
- app/hosts.json: which domain belongs to which site
- app/sites.json: per site settings, e.g. {"blog": {"cookie": "consent"}} (off, on or consent)
- app/storage.json: how much to keep, e.g. {"keepDays": 90, "maxBytes": 524288000}; without it 365 days, no size limit
- data/analytics.db: the collected hits (SQLite); the collector deletes older ones every hour
- funnels.json: the funnels lf analytics funnel defined

Start it by hand with: docker compose up -d
Read it by hand with: sqlite3 data/analytics.db 'SELECT * FROM hits ORDER BY t DESC LIMIT 20'
Remove it with: lf analytics disable <site> for every site (add --purge to delete the data too)
`;

/** The files apply rewrites, in the order of their undo shells ($u1, $u2, …). */
const APPLIED = ["compose.yml", "app/hosts.json", "app/server.mjs", "app/query.mjs", "app/client.js", "app/sites.json", "app/tz.json"];

/**
 * Writes the collector for `hosts` and `settings` and starts it, or stops it and removes compose.yml when no host is
 * left. Always recreates the container: it reads its scripts only at start. One journal entry, written before it
 * starts: when it does not start, lf undo still puts the old state back.
 * Returns the HTTP status of /_lf/a/s.js through Traefik per host ("" without curl).
 */
export async function apply(ctx: PluginContext, st: State, hosts: Record<string, string>, settings: SiteSettings, what: string) {
  const dir = dirOf(ctx);
  const d = ctx.shq(dir);
  const put = (file: string, text: string) => writeFileCmd(`${dir}/${file}`, text);
  // The container runs as the login (it owns data/), so it needs no capability to write there.
  const putCompose = `printf %s ${ctx.shq(b64(composeYml(st.proxy, hosts)))} | base64 -d | sed "s/@UID@/$(id -u):$(id -g)/" | _put ${d}/compose.yml`;
  const stop = `docker rm -f $(docker ps -aq --filter ${CTR_FILTER}) >/dev/null 2>&1 || true`;
  const any = Object.keys(hosts).length > 0;
  const out = await ctx.script(String.raw`
_as ${ctx.shq(ctx.paths.root)} mkdir -p ${d}/app ${d}/data
${APPLIED.map((f, i) => `u${i + 1}=$(saved ${d}/${f})`).join("\n")}
${put("README.md", README)}
${put("app/hosts.json", JSON.stringify(hosts))}
${put("app/sites.json", JSON.stringify(settings))}
${put("app/server.mjs", ctx.file("app/server.mjs"))}
${put("app/query.mjs", ctx.file("app/query.mjs"))}
${put("app/client.js", clientJs(ctx))}
${put("app/tz.json", ctx.file("app/tz.json"))}
${any ? putCompose : `_as ${d} rm -f ${d}/compose.yml`}
record ${ctx.shq(what)} "${APPLIED.map((_, i) => `$u${i + 1}; `).join("")}"${ctx.shq(`if [ -f ${d}/compose.yml ]; then (cd ${d} && dc up -d --force-recreate --remove-orphans); else ${stop}; fi`)}
${
  any
    ? String.raw`(cd ${d} && dc up -d --quiet-pull --force-recreate --remove-orphans) >&2 || { echo "docker compose could not start the collector (see above)" >&2; exit 3; }
# Running, and not restarting over and over: else show why.
sleep 3
id=$(docker ps -aq --filter ${CTR_FILTER} | head -n1)
if [ "$(docker inspect -f '{{.State.Running}}{{.RestartCount}}' "$id" 2>/dev/null)" != true0 ]; then
  docker logs --tail 15 "$id" >&2 2>&1 || true
  echo "the collector does not stay up (its log is above)" >&2
  exit 3
fi
if command -v curl >/dev/null 2>&1; then
  for h in ${Object.keys(hosts).map(ctx.shq).join(" ")}; do
    printf 'EP\t%s\t%s\n' "$h" "$(curl -sk --max-time 5 --resolve "$h:443:127.0.0.1" -o /dev/null -w '%{http_code}' "https://$h${PREFIX}s.js" 2>/dev/null || true)"
  done
fi`
    : stop
}`);
  return Object.fromEntries(
    out
      .split("\n")
      .filter((l) => l.startsWith("EP\t"))
      .map((l) => l.split("\t").slice(1) as [string, string]),
  );
}

/** apply, with the next steps when the collector does not come up. */
export async function applyOrExplain(ctx: PluginContext, st: State, hosts: Record<string, string>, settings: SiteSettings, what: string) {
  try {
    return await apply(ctx, st, hosts, settings, what);
  } catch (e) {
    return ctx.fail(`${errText(e)}\n  The files are written and journaled. Fix the cause, then run lf analytics repair, or lf undo to go back.`);
  }
}

/** Warns about hosts where Traefik does not hand /_lf/a/ to the collector. */
export function checkEndpoints(ctx: PluginContext, codes: Record<string, string>) {
  for (const [h, code] of Object.entries(codes)) {
    if (code === "200") continue;
    if (code === "000" || code === "") ctx.log.warn(`could not reach https://${h}${PREFIX}s.js from the server; check it from a browser`);
    else ctx.log.warn(`https://${h}${PREFIX}s.js answers ${code}, not 200: is ${h} served by this Traefik, with a certificate?`);
  }
}

/** Writes funnels.json, journaled with the old file as undo. */
export async function writeFunnels(ctx: PluginContext, list: Funnel[], what: string) {
  const d = ctx.shq(dirOf(ctx));
  await ctx.script(`_as ${ctx.shq(ctx.paths.root)} mkdir -p ${d}
u=$(saved ${d}/funnels.json)
${writeFileCmd(`${dirOf(ctx)}/funnels.json`, JSON.stringify(list, null, 2) + "\n")}
record ${ctx.shq(what)} "$u"`);
}

/** Writes app/storage.json, journaled with the old file as undo. The collector rereads it within a minute. */
export async function writeStorage(ctx: PluginContext, storage: Storage, what: string) {
  const d = ctx.shq(dirOf(ctx));
  const body = Object.keys(storage).length ? JSON.stringify(storage, null, 2) + "\n" : "";
  await ctx.script(`_as ${ctx.shq(ctx.paths.root)} mkdir -p ${d}/app
u=$(saved ${d}/app/storage.json)
${body ? writeFileCmd(`${dirOf(ctx)}/app/storage.json`, body) : `_as ${d}/app rm -f ${d}/app/storage.json`}
record ${ctx.shq(what)} "$u"`);
}

/**
 * Streams the stored hits to stdout as CSV or JSON lines (query.mjs op export). Reads only. One ssh round trip: the
 * script checks the install and Docker itself.
 */
export async function exportData(ctx: PluginContext, req: { site?: string; days?: number; format: "csv" | "jsonl" }) {
  const d = ctx.shq(dirOf(ctx));
  const q = ctx.shq(b64(JSON.stringify({ op: "export", ...req })));
  await ctx.script(
    String.raw`[ -d ${d} ] || { echo "analytics is not installed on this server" >&2; exit 0; }
command -v docker >/dev/null 2>&1 || { echo ${ctx.shq(NO_DOCKER)} >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo ${ctx.shq(NO_DOCKER_ACCESS)} >&2; exit 1; }
[ -f ${d}/data/analytics.db ] || { echo "no collected data on this server" >&2; exit 0; }
${queryFn(d)}
${RUNNING_QID}
lfq ${q}`,
    { capture: false },
  );
}

/** Deletes a site's hits with query.mjs (in the collector, or a one-off container). Cannot be undone. */
export async function purge(ctx: PluginContext, site: string): Promise<number | undefined> {
  const d = ctx.shq(dirOf(ctx));
  const q = ctx.shq(b64(JSON.stringify({ op: "purge", site })));
  const out = await ctx.script(String.raw`[ -f ${d}/data/analytics.db ] || { echo '{"deleted":0}'; exit 0; }
${queryFn(d)}
${RUNNING_QID}
lfq ${q}
echo
record ${ctx.shq(`analytics: deleted the collected data of ${site}`)}`);
  try {
    return JSON.parse(out.trim().split("\n").pop()!).deleted;
  } catch {
    return undefined;
  }
}

/**
 * Removes the collector container and /opt/landfall/analytics. keepData keeps data/ and funnels.json, so a later
 * enable counts on from there. Cannot be undone: the journal's backups live in that directory too.
 * Works without Docker (nothing to stop then). Returns false when there was nothing to remove.
 */
export async function uninstall(ctx: PluginContext, keepData: boolean): Promise<boolean> {
  const d = ctx.shq(dirOf(ctx));
  const root = ctx.shq(ctx.paths.root);
  const out = await ctx.script(String.raw`id=
if command -v docker >/dev/null 2>&1; then id=$(docker ps -aq --filter ${CTR_FILTER} 2>/dev/null || true); fi
if [ ! -d ${d} ] && [ -z "$id" ]; then echo NONE; exit 0; fi
[ -z "$id" ] || docker rm -f $id >/dev/null
if [ -d ${d} ]; then
${keepData ? `  _as ${d} find ${d} -mindepth 1 -maxdepth 1 ! -name data ! -name funnels.json -exec rm -rf {} +` : `  _as ${root} rm -rf ${d}`}
fi
record ${ctx.shq(keepData ? "analytics: uninstalled the collector, kept its data" : "analytics: uninstalled the collector and deleted its data")}`);
  return !out.includes("NONE");
}
