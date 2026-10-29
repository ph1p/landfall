import fs from "node:fs";
import { loadProject, type Server } from "./config";
import { isOld, moveVolumes, oldSiteError, oldSiteProject, takeoverLines, takeoverRecord } from "./legacy";
import { parse as parseYaml } from "yaml";
import {
  builtImage,
  COMPOSE_FILES,
  currentRelease,
  isUp,
  kindOf,
  OVERRIDE_FILES,
  overrideYaml,
  projectName,
  routed,
  SECRETS_DIR,
  ROUTER_RULE,
  ruleHosts,
  siteState,
  type SiteState,
  siteDomains,
  siteMain,
  SITE_LINES,
  STATUS_RANK,
  statusKind,
  readSiteLine,
  isSiteMeta,
  type Release,
  type SiteMeta,
  ENV_NAME,
  volumeDir,
} from "./compose";
import { onStop } from "./job";
import { runScript, shq, sshExec, writeFileCmd } from "./ssh";
import { HELPER, JOURNAL, OWN_PROXY, parseProxy, PRELUDE, PROXY_CTR, PROXY_FILE, SITES, TUNNEL_ROUTER, type Proxy } from "./templates";
import { fail, readStdin, warn } from "./term";

export const siteDir = (name: string) => `${SITES}/${name}`;

export const SITE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** Names of the sites on the server (folders with a site.json). */
export async function siteNames(s: Server): Promise<string[]> {
  const { stdout } = await runScript(s, `for f in ${SITES}/*/site.json; do [ ! -f "$f" ] || basename "$(dirname "$f")"; done`, { capture: true });
  return stdout.split("\n").filter(Boolean).sort();
}

/** Edit distance, for suggesting a site name close to a mistyped one. */
function distance(a: string, b: string) {
  let row = [...Array(b.length + 1).keys()];
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

/**
 * The error for a site name the server does not have: its sites, a close name, and the site ./.landfall.json
 * deploys when that one is there (`here`). argv: the command as typed, to repeat it with the right name.
 */
export function noSiteMessage(name: string, host: string, names: string[], here?: string, argv: string[] = []) {
  const close = names.filter((x) => x !== name && (x.includes(name) || name.includes(x) || distance(x, name) <= (name.length > 3 ? 2 : 1)));
  // ./.landfall.json counts only for a name typed on the command line, not one from lf ui.
  const pick = here && here !== name && names.includes(here) && argv.includes(name) ? here : close.length === 1 ? close[0] : undefined;
  const lines = [`no site ${name} on ${host}. ${names.length ? `Sites: ${names.join(", ")}` : "It has no sites yet (lf deploy)"}`];
  const again = pick && argv.includes(name) ? `lf ${argv.map((a) => (a === name ? pick : a)).join(" ")}` : "";
  if (pick && pick === here) lines.push(`this folder deploys as ${pick}${again && `: ${again}`}`);
  else if (pick) lines.push(`did you mean ${pick}?${again && ` ${again}`}`);
  return lines.join("\n");
}

/** Fails with noSiteMessage for `name` on the server. */
export async function noSite(s: Server, name: string): Promise<never> {
  const names = await siteNames(s).catch(() => []);
  let here: string | undefined;
  try {
    here = loadProject(process.cwd())?.name;
  } catch {}
  return fail(noSiteMessage(name, s.host, names, here, process.argv.slice(2)));
}

export function validName(name: string) {
  if (!SITE_NAME.test(name)) fail(`invalid site name "${name}" (use lowercase letters, digits, dashes)`);
  return name;
}

const SEP = "\n--8<--landfall--8<--\n";

/** Fetch site.json and .env of a site, and the Traefik it goes through, in one round trip. */
export async function readSite(s: Server, name: string): Promise<{ meta?: SiteMeta; env: string; proxy: Proxy; exists: boolean }> {
  const dir = siteDir(name);
  const { stdout } = await runScript(
    s,
    [...[`${dir}/site.json`, `${dir}/.env`, PROXY_FILE].map((f) => `cat ${shq(f)} 2>/dev/null || true`), `[ ! -d ${shq(dir)} ] || echo 1`].join(
      `; printf %s ${shq(SEP)}; `,
    ),
    { capture: true },
  );
  const [json, env = "", proxy = "", exists = ""] = stdout.split(SEP);
  let meta: SiteMeta | undefined;
  if (json.trim()) {
    try {
      meta = JSON.parse(json);
    } catch {}
    if (!isSiteMeta(meta)) fail(`corrupt ${dir}/site.json on ${s.host}`);
  }
  return { meta, env, proxy: parseProxy(proxy) ?? OWN_PROXY, exists: exists.trim() === "1" };
}

/** A site that exists and is a Compose project; `deployed` also refuses adopted ones (no releases). */
export async function requireSite(s: Server, name: string, o: { deployed?: string } = {}): Promise<{ meta: SiteMeta; env: string; proxy: Proxy }> {
  const site = await readSite(s, name);
  if (!site.meta) await noSite(s, name);
  const meta = site.meta!;
  if (isOld(meta)) fail(oldSiteError(name));
  if (o.deployed && meta.adopted) fail(`${name} is adopted (${meta.adopted}): landfall does not ${o.deployed} it; change its compose files there`);
  return site as { meta: SiteMeta; env: string; proxy: Proxy };
}

/** Release ids are timestamps, so newest first is a reverse string sort. */
export const newestFirst = (meta: SiteMeta) => [...meta.releases].sort((a, b) => b.id.localeCompare(a.id));

/** Logs of one container (the proxy). */
export const dockerLogs = (s: Server, ctr: string, o: { tail?: string; follow?: boolean }) =>
  sshExec(s, [`docker logs --tail ${shq(o.tail ?? "100")} ${o.follow ? "-f " : ""}${shq(ctr)}`]);

export interface ServiceStatus {
  service: string;
  container: string;
  /** e.g. "Up 3 hours (healthy)", "Exited (1) 2 minutes ago". */
  status: string;
}

export interface SiteStatus {
  meta: SiteMeta;
  status: string;
  services: ServiceStatus[];
  /** Every domain it answers on (siteDomains). */
  domains: string[];
  /** The service serving the site's own domains: `lf domains` changes them. None: fixed in compose.yaml. */
  main?: string;
  state: SiteState;
  /** kindOf: what lists show. */
  kind: string;
}

export interface Overview {
  /** docker and /opt/landfall/sites exist, i.e. `lf setup` ran. */
  ready: boolean;
  /** traefik container status, empty if not installed. */
  traefik: string;
  /** Its container name: landfall's `traefik`, or the one sites were pointed at. */
  proxy: string;
  /** Sites go through a Traefik the server already had (PROXY_FILE): landfall never reconfigures it. */
  adopted: boolean;
  sites: SiteStatus[];
  /** Containers routed by Traefik that landfall did not deploy (your own compose projects). Read only. */
  others: External[];
  /** Traefik's dashboard: the domains routers serve it on, and whether `lf traefik dashboard` can tunnel to it. */
  dashboard: { hosts: string[]; tunnel: boolean };
  /** Running containers neither a site nor routed by Traefik (databases, workers): only a tunnel reaches them. */
  unrouted: Unrouted[];
}

export interface Unrouted {
  container: string;
  status: string;
  image: string;
  /** Its Compose project and service, if it has one. */
  project?: string;
  service?: string;
  /** TCP ports it listens on in its container (exposed or published), lowest first. */
  ports: number[];
}

/** The container side of `docker ps`'s Ports column ("0.0.0.0:25->25/tcp, 80/tcp"); ranges left out. */
export const containerPorts = (col: string) =>
  [...new Set([...col.matchAll(/(?:^|[\s>])(\d+)\/tcp/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);

/** Domains a container's routers serve Traefik's dashboard (api@internal) on. */
export function dashboardHosts(labels: Record<string, string>): string[] {
  return dashboardRouters(labels).flatMap((r) => r.hosts);
}

/** The routers serving Traefik's dashboard (api@internal), with the domains in their rules. */
export function dashboardRouters(labels: Record<string, string>): { router: string; hosts: string[] }[] {
  return Object.entries(labels)
    .map(([k, v]) => [k.match(/^traefik\.http\.routers\.([^.]+)\.service$/)?.[1], v])
    .filter(([r, v]) => r && v === "api@internal")
    .map(([r]) => ({ router: r!, hosts: ruleHosts(labels[`traefik.http.routers.${r}.rule`] ?? "") }));
}
/** landfall's Traefik serves its dashboard to the server itself, for `lf traefik dashboard`. */
export const hasDashboardTunnel = (labels: Record<string, string>) => labels[`traefik.http.routers.${TUNNEL_ROUTER}.service`] === "api@internal";

export interface External {
  /** Compose project, or the container name without one. */
  name: string;
  domains: string[];
  /** Status of its routed containers, e.g. "Up 3 hours". */
  status: string;
  containers: string[];
  /** Compose working directory on the server. */
  dir?: string;
  /** Compose files it was started with, comma-separated (com.docker.compose.project.config_files). */
  files?: string;
}

/**
 * Group containers that carry Traefik router rules by compose project. Skips landfall's own
 * sites, projects landfall adopted, the proxy itself, and
 * traefik.enable=false.
 */
export function externals(
  ctrs: { name: string; labels: Record<string, string> }[],
  status: Map<string, string>,
  proxy: string,
  sites: Set<string> = new Set(),
): External[] {
  const out = new Map<string, External>();
  for (const { name, labels } of ctrs) {
    if (name === proxy || labels["landfall.managed"] || labels["traefik.enable"] === "false") continue;
    const project = labels["com.docker.compose.project"];
    if (project && sites.has(project)) continue;
    const hosts = Object.entries(labels)
      .filter(([k]) => ROUTER_RULE.test(k))
      .flatMap(([, v]) => ruleHosts(v));
    if (!hosts.length) continue;
    const key = project || name;
    const e = out.get(key) ?? {
      name: key,
      domains: [],
      status: "",
      containers: [],
      dir: labels["com.docker.compose.project.working_dir"],
      files: labels["com.docker.compose.project.config_files"],
    };
    e.domains = [...new Set([...e.domains, ...hosts])];
    e.containers.push(name);
    const st = status.get(name) ?? "not running";
    // A group shows its worst container.
    if (!e.status || STATUS_RANK[statusKind(st)] > STATUS_RANK[statusKind(e.status)]) e.status = st;
    out.set(key, e);
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * One status for a site: the first routed service that is not up, else any other service that
 * is down (one-shot jobs exit 0), else any unhealthy one, else the routed service's.
 */
function siteStatus(meta: SiteMeta, services: ServiceStatus[]): string {
  if (!services.length) return "not running";
  const r = currentRelease(meta);
  const names = new Set(r?.services.filter(routed).map((s) => s.name));
  const main = services.filter((s) => names.has(s.service));
  const bad =
    main.find((s) => !isUp(s.status)) ??
    services.find((s) => !names.has(s.service) && statusKind(s.status) === "down") ??
    services.find((s) => statusKind(s.status) === "warn");
  return (bad ?? main[0] ?? services[0]).status;
}

/** The compose project a site runs as; sites of landfall before Compose sites ran as landfall-<name>. */
export const siteProject = (meta: SiteMeta) => oldSiteProject(meta) ?? projectName(meta);

export async function overview(s: Server): Promise<Overview> {
  const { stdout } = await runScript(
    s,
    `printf 'READY\\t%s\\n' "$([ -d ${SITES} ] && command -v docker >/dev/null 2>&1 && echo 1)"
P=${PROXY_CTR}
printf 'TRAEFIK\\t%s\\t%s\\t%s\\n' "$(docker ps -a --filter "name=^$P$" --format '{{.Status}}' 2>/dev/null || true)" "$P" "$([ -f ${PROXY_FILE} ] && echo 1)"
${SITE_LINES}
docker ps -a --format 'CTR\\t{{.Names}}\\t{{.Status}}\\t{{.Label "com.docker.compose.project"}}\\t{{.Label "com.docker.compose.service"}}\\t{{.Image}}\\t{{.Ports}}' 2>/dev/null || true
ids=$(docker ps -aq 2>/dev/null || true)
# inspect, unlike ps, does not expand \\t: hence {{"\\t"}}.
[ -z "$ids" ] || docker inspect -f 'LABELS{{"\\t"}}{{.Name}}{{"\\t"}}{{json .Config.Labels}}' $ids 2>/dev/null || true`,
    { capture: true },
  );
  const status = new Map<string, string>();
  const byProject = new Map<string, ServiceStatus[]>();
  const metas: SiteMeta[] = [];
  const labeled: { name: string; labels: Record<string, string> }[] = [];
  const o: Overview = { ready: false, traefik: "", proxy: "traefik", adopted: false, sites: [], others: [], dashboard: { hosts: [], tunnel: false }, unrouted: [] };
  const ctrs: Unrouted[] = [];
  for (const line of stdout.split("\n")) {
    const [kind, a = "", b = "", project = "", service = "", image = "", ports = ""] = line.split("\t");
    if (kind === "READY") o.ready = a === "1";
    if (kind === "TRAEFIK") {
      o.traefik = a;
      o.proxy = b || "traefik";
      o.adopted = project === "1";
    }
    if (kind === "SITE") {
      // One broken site.json must not hide every other site.
      const meta = readSiteLine(line);
      if (meta) metas.push(meta);
      else warn(`skipped a corrupt site.json on ${s.host}: ${line.slice(kind.length + 1, 80)}`);
    }
    if (kind === "CTR") {
      status.set(a, b);
      ctrs.push({ container: a, status: b, image, ports: containerPorts(ports), ...(project && { project, service }) });
      if (project) byProject.set(project, [...(byProject.get(project) ?? []), { service: service || a, container: a, status: b }]);
    }
    if (kind === "LABELS") {
      try {
        labeled.push({ name: a.replace(/^\//, ""), labels: JSON.parse(b ?? "null") ?? {} });
      } catch {}
    }
  }
  o.others = externals(labeled, status, o.proxy, new Set(metas.map(siteProject)));
  o.dashboard = {
    hosts: [...new Set(labeled.flatMap((x) => dashboardHosts(x.labels)))],
    // Through landfall's tunnel entrypoint, else through a router that serves it on a domain.
    tunnel: labeled.some((x) => x.name === o.proxy && (hasDashboardTunnel(x.labels) || dashboardHosts(x.labels).length > 0)),
  };
  const known = new Set([o.proxy, ...o.others.flatMap((e) => e.containers)]);
  const siteProjects = new Set(metas.map(siteProject));
  o.unrouted = ctrs
    .filter((x) => isUp(x.status) && !known.has(x.container) && !(x.project && siteProjects.has(x.project)))
    .sort((x, y) => x.container.localeCompare(y.container));
  o.sites = metas.map((meta) => {
    const services = (byProject.get(siteProject(meta)) ?? []).sort((x, y) => x.service.localeCompare(y.service));
    return { meta, status: siteStatus(meta, services), services, domains: siteDomains(meta), main: siteMain(meta)?.name, state: siteState(meta), kind: kindOf(meta) };
  });
  return o;
}

/**
 * Hold a site for one deploy: a second one at the same time would build into the same folder and switch
 * `current` under the first. A lock older than an hour is from a deploy that was cut off. Returns the
 * server's clock as a release id, so ids follow each other even when this machine's clock is off.
 */
export async function lockSite(s: Server, name: string): Promise<{ now: string; unlock: () => Promise<void> }> {
  const lock = `${SITES}/.${name}.deploying`;
  const { stdout } = await runScript(
    s,
    [
      `mkdir -p ${SITES}`,
      `if ! mkdir ${shq(lock)} 2>/dev/null; then`,
      `  [ -n "$(find ${shq(lock)} -maxdepth 0 -mmin +60 2>/dev/null)" ] && rm -rf ${shq(lock)} && mkdir ${shq(lock)} ||`,
      `  { echo "another deploy or change of ${name} is running ($(cat ${shq(lock + "/by")} 2>/dev/null || echo unknown)): wait for it, or remove ${lock} if it was cut off" >&2; exit 1; }`,
      `fi`,
      `printf '%s\\n' "$LANDFALL_ACTOR" >${shq(lock + "/by")}`,
      `date -u +%Y%m%d%H%M%S`,
    ].join("\n"),
    { capture: true },
  );
  const unlock = () => runScript(s, `rm -rf ${shq(lock)}`).then(() => {});
  const off = onStop(unlock);
  return { now: stdout.trim(), unlock: () => (off(), unlock()) };
}

/**
 * Round trip after the upload: give the release its .env link and one compose.yaml (renamed
 * from `file`, or `generated`), drop override files (landfall writes its own), and return
 * the release's real path and its `docker compose config`. On failure the caller discards
 * the release (discardRelease).
 */
export async function prepareRelease(
  s: Server,
  name: string,
  id: string,
  o: { file?: string; generated?: Record<string, string>; env?: string; layer?: string } = {},
): Promise<{ dir: string; config: any }> {
  const site = siteDir(name);
  const rel = `${site}/releases/${id}`;
  // Moved to the release root: paths inside it (build: ., ./data) would point elsewhere from a subfolder.
  const file = o.file?.replace(/^(\.\/)+/, "");
  if (file?.includes("/")) fail(`-f takes a compose file in the project folder itself, not ${o.file}`);
  const others = [...COMPOSE_FILES, ...OVERRIDE_FILES].filter((f) => f !== "compose.yaml");
  const script = [
    PRELUDE,
    // Older compose cannot read the optional env_file of generated sites or `up --wait`.
    `v=$(dc version --short 2>/dev/null | sed 's/^v//'); compose_ok "$v" || { echo "sites need docker compose 2.24 or newer, the server has \${v:-none}: run lf update --compose" >&2; exit 1; }`,
    `mkdir -p ${shq(rel)} && cd -P ${shq(rel)}`,
    `[ -e ../../.env ] || { touch ../../.env && chmod 600 ../../.env; }`,
    "ln -sfn ../../.env .env",
    // Dangling until the site starts (siteLines makes the folder): a refused deploy leaves nothing behind.
    `ln -sfn ../../${SECRETS_DIR} ${SECRETS_DIR}`,
    ...Object.entries(o.generated ?? {}).map(([f, text]) => writeFileCmd(f, text)),
    ...(file && file !== "compose.yaml" ? [`mv -f ${shq(file)} compose.yaml`] : []),
    `rm -f ${others.map(shq).join(" ")}`,
    // An environment's file merged in, uninterpolated: plain `docker compose up` in the release still runs what was deployed.
    ...(o.layer
      ? [
          `dc -f compose.yaml -f ${shq(o.layer)} config --no-interpolate --no-path-resolution --no-normalize >.merged.yaml || { rm -f .merged.yaml; exit 1; }`,
          `{ printf '%s\\n' ${shq(`# ${file ?? "compose.yaml"} with ${o.layer} merged in by landfall`)}; cat .merged.yaml; } >compose.yaml && rm -f .merged.yaml`,
        ]
      : []),
    // The .env this deploy is about to write, so a first deploy can set what compose.yaml requires.
    ...(o.env !== undefined ? [writeFileCmd(".env.next", o.env, "600")] : []),
    `[ -f compose.yaml ] || { echo "no compose.yaml in the upload" >&2; exit 1; }`,
    // stderr apart: compose warns there (an unset \${VAR}), and a warning inside the YAML breaks parsing it.
    `cfg=$(dc ${o.env !== undefined ? "--env-file .env.next " : ""}-f compose.yaml config 2>.config.err) || { cat .config.err >&2; rm -f .config.err; exit 1; }`,
    "cat .config.err >&2; rm -f .config.err",
    "rm -f .env.next",
    `pwd -P; printf %s ${shq(SEP)}; printf '%s\\n' "$cfg"`,
  ].join("\n");
  const { stdout } = await runScript(s, script, { capture: true });
  const [dir, text = ""] = stdout.split(SEP);
  let config: any;
  try {
    config = parseYaml(text);
  } catch (e: any) {
    fail(`could not read \`docker compose config\` of ${name}: ${e?.message ?? e}`);
  }
  return { dir: dir.trim(), config };
}

/**
 * Make a Compose project landfall did not deploy a site: sites/<name>/current points at its
 * folder, so logs, restart and status work like for any site. Its files stay as they are.
 */
export async function adoptSite(s: Server, meta: SiteMeta) {
  const dir = siteDir(meta.name);
  await runScript(
    s,
    [
      PRELUDE,
      `[ -r ${shq(meta.adopted!)} ] && [ -x ${shq(meta.adopted!)} ] || { echo "$(id -un) cannot read "${shq(meta.adopted!)}"; adopt it as a user who can (lf server config)" >&2; exit 1; }`,
      `[ ! -e ${shq(dir)} ] || { echo "${dir} exists already" >&2; exit 1; }`,
      `mkdir -p ${shq(dir)} && cd ${shq(dir)}`,
      `ln -s ${shq(meta.adopted!)} current`,
      writeFileCmd("site.json", JSON.stringify(meta, null, 2) + "\n"),
      `record ${shq(`adopted ${meta.project} as site ${meta.name}`)} ${shq(`rm -rf ${dir}`)}`,
    ].join("\n"),
  );
}

/**
 * Remove a release that is not live (never was, or a failed start went back from it) with the images
 * it built, and the site's folder if nothing else is in it. One `current` points at stays: lf undo has it.
 */
export async function discardRelease(s: Server, name: string, id: string, images: string[] = []) {
  const rel = `releases/${id}`;
  await runScript(
    s,
    [
      PRELUDE,
      `cd ${shq(siteDir(name))} 2>/dev/null || exit 0`,
      `[ "$(readlink current 2>/dev/null)" != ${shq(rel)} ] || exit 0`,
      `rm -f .env.new; rmf ${shq(rel)}`,
      ...images.map(rmImage),
      `[ -f site.json ] || { rmdir releases ${SECRETS_DIR} 2>/dev/null; { [ -s .env ] || rm -f .env; }; cd / && rmdir ${shq(siteDir(name))} 2>/dev/null; } || true`,
    ].join("\n"),
  );
}

export interface ApplyOpts {
  env?: string;
  /** Files of the site's folder to write (null: remove), e.g. `.secrets/KEY`; undo puts them back. */
  files?: Record<string, string | null>;
  /** Services to recreate after it starts: what they read from a changed file is not seen otherwise. */
  recreate?: string[];
  /** docker compose build the release's services that build (deploy). */
  build?: boolean;
  /** docker compose pull its images first (deploy). */
  pull?: boolean;
  keep?: number;
  /** The site as it was before, so the journal can put it back; none = new site. */
  prev?: SiteMeta;
  /** A site of landfall before Compose sites, replaced by this one: its old files and container go, without undo. */
  takeover?: SiteMeta;
  /** Journal line, e.g. "deploy blog release 20250101-120000". */
  what: string;
  /** A new site whose dir was already there (leftovers, or someone's files): undo removes only what landfall wrote. */
  existed?: boolean;
}

// Not the script on stdin: Compose asks there, e.g. to recreate a volume whose configuration changed.
const UP = "dc up -d --wait --wait-timeout 300 --remove-orphans --quiet-pull </dev/null";

/**
 * Shell that starts the Compose project in `current`, printing its state and logs if it does not come up;
 * then `failed` runs (outside the `||`, where set -e would be ignored) and the script exits 1.
 */
const upLines = (name: string, failed: string[] = []) => [
  `log "starting ${name}"`,
  `up=1; (cd -P current && ${UP}) || { up=0; log "${name} did not start:"; (cd -P current && dc ps -a >&2; dc logs --tail 30 >&2) || true; }`,
  `if [ "$up" = 0 ]; then`,
  ...failed,
  `exit 1`,
  `fi`,
];

/** Shell: remove a built image, quietly; one still in use stays. */
const rmImage = (i: string) => `docker image rm ${shq(i)} >/dev/null 2>&1 || true`;

interface SiteLinesOpts extends Pick<ApplyOpts, "env" | "build" | "pull" | "files" | "recreate"> {
  /** Shell after the build and pull, before anything that changes the running site (journal it, take over). */
  before?: string[];
  /** Shell when it does not start (put the previous release back). */
  failed?: string[];
}

/**
 * Shell that writes a site's files for meta.current, points `current` at it and starts it.
 * Until the build and pull are done nothing the running site reads changes: the new .env waits in .env.new.
 */
function siteLines(meta: SiteMeta, proxy: Proxy, o: SiteLinesOpts = {}): string[] {
  const dir = siteDir(meta.name);
  const release = currentRelease(meta)!;
  const rel = shq("releases/" + meta.current);
  const project = projectName(meta);
  const lines = [
    `mkdir -p ${shq(dir)} && cd ${shq(dir)}`,
    // Compose finds containers by project name alone: one started elsewhere under the same name would be
    // recreated or removed by this site's 'up --remove-orphans'.
    `here=$(pwd -P)/`,
    `other=$(docker ps -a --filter ${shq(`label=com.docker.compose.project=${project}`)} --format '{{.Label "com.docker.compose.project.working_dir"}}' 2>/dev/null | while read -r d; do case "$d/" in ("$here"*) ;; (*) echo "\${d:-a container without a folder}"; break ;; esac; done || true)`,
    `[ -z "$other" ] || { echo ${shq(`a Compose project named ${project} already runs from`)} "$other:" ${shq(`deploying would replace its containers. Pick another site name, or make it a site with lf adopt ${project}`)} >&2; exit 1; }`,
    o.env !== undefined ? writeFileCmd(".env.new", o.env, "600") : "[ -e .env ] || { touch .env && chmod 600 .env; }",
    // Releases from before .secrets get the link too, so a rollback still finds them.
    ...(meta.adopted ? [] : [`[ -d ${SECRETS_DIR} ] || install -d -m 700 ${SECRETS_DIR}`, `(cd -P ${rel} && ln -sfn ../../${SECRETS_DIR} ${SECRETS_DIR}) || exit 1`]),
    `(cd -P ${rel} && ${writeFileCmd("compose.override.yaml", overrideYaml(meta, release, proxy))}) || exit 1`,
    // The override binds them there: Docker cannot create a volume on a folder that is not.
    ...(meta.adopted ? [] : (meta.volumes ?? []).map((k) => `mkdir -p ${shq(volumeDir(meta.name, k))}`)),
  ];
  // Interpolated with the new .env (the release's .env links the live one).
  const dc = o.env !== undefined ? "dc --env-file ../../.env.new" : "dc";
  const bail = o.env !== undefined ? "{ rm -f .env.new; exit 1; }" : "exit 1";
  if (o.build && release.services.some((s) => s.build)) {
    lines.push(`log "building ${meta.name}"`, `(cd -P ${rel} && ${dc} build -q --pull) || ${bail}`);
  }
  if (o.pull) lines.push(`log "pulling images of ${meta.name}"`, `(cd -P ${rel} && ${dc} pull -q --ignore-buildable) || ${bail}`);
  lines.push(
    ...(o.before ?? []),
    ...(o.env !== undefined ? ["mv -f .env.new .env"] : []),
    // Secrets are 644 so a container's non-root user reads them; the folder (700) keeps others on the host out.
    ...Object.entries(o.files ?? {}).map(([f, text]) =>
      text === null ? `rm -f ${shq(f)}` : writeFileCmd(f, text, f.startsWith(`${SECRETS_DIR}/`) ? "644" : "600"),
    ),
  );
  // site.json only now, with the switch: a failed build or pull leaves it naming the release that still runs.
  lines.push(writeFileCmd("site.json", JSON.stringify(meta, null, 2) + "\n"));
  // Swapped in one rename, so `current` always points at a whole release.
  lines.push(`ln -sfn ${rel} current.new && mv -Tf current.new current`, ...moveVolumes(meta, o.failed), ...upLines(meta.name, o.failed));
  if (o.recreate?.length) lines.push(`log "recreating ${o.recreate.join(", ")}"`, `(cd -P current && ${UP} --force-recreate --no-deps ${o.recreate.map(shq).join(" ")}) || exit 1`);
  return lines;
}

/** Images the services of release `r` built. */
export const builtImages = (name: string, r: Release) => (r.services ?? []).filter((s) => s.build).map((s) => builtImage(name, s.name, r.id));

const dropRelease = (meta: SiteMeta, r: Release) => [
  `rmf ${shq(`${siteDir(meta.name)}/releases/${r.id}`)}`,
  ...builtImages(meta.name, r).map(rmImage),
];

/** Releases `lf release rm` takes: the given ids, else all but the `keep` newest (like a deploy's --keep). Never the live one. */
export function oldReleases(meta: SiteMeta, o: { ids?: string[]; keep?: number } = {}): Release[] {
  return newestFirst(meta).filter((r, i) => r.id !== meta.current && (o.ids?.length ? o.ids.includes(r.id) : i >= (o.keep ?? 0)));
}

/**
 * Delete releases of a site: their folders and the images built for them. Not reversible: they are gone for rollback.
 * Read again under the deploy lock, so a deploy or rollback in between is not undone by an old site.json.
 */
export async function removeReleases(s: Server, name: string, ids: string[]): Promise<Release[]> {
  const lock = await lockSite(s, name);
  try {
    const { meta } = await requireSite(s, name, { deployed: "remove releases of" });
    const gone = oldReleases(meta, { ids });
    if (!gone.length) return [];
    meta.releases = meta.releases.filter((r) => !gone.includes(r));
    const what = `removed release${gone.length > 1 ? "s" : ""} ${gone.map((r) => r.id).join(", ")} of ${name} (cannot be undone)`;
    // site.json first: it never names a release whose folder is gone.
    const lines = [PRELUDE, `cd ${shq(siteDir(name))}`, writeFileCmd("site.json", JSON.stringify(meta, null, 2) + "\n"), ...gone.flatMap((r) => dropRelease(meta, r)), `record ${shq(what)}`];
    await runScript(s, lines.join("\n"));
    return gone;
  } finally {
    await lock.unlock();
  }
}

/** Change a deployed site in place (domains, login, current release) and apply it; undo restores it as it was. */
export async function changeSite(s: Server, name: string, proxy: Proxy, what: string, change: (m: SiteMeta) => void, o: Pick<ApplyOpts, "files" | "recreate"> = {}): Promise<SiteMeta> {
  // Under the deploy lock, on site.json as it is now: a deploy or change in between would be lost on write.
  const lock = await lockSite(s, name);
  try {
    const { meta } = await requireSite(s, name);
    const prev = structuredClone(meta);
    change(meta);
    meta.updatedAt = new Date().toISOString();
    await applySite(s, meta, proxy, { ...o, keep: meta.releases.length, prev, what });
    return meta;
  } finally {
    await lock.unlock();
  }
}

/**
 * Write site.json and the override for meta.current, switch `current` to it and start it.
 * Used by deploy, rollback and domain changes alike, so all go through the exact same path.
 * Journaled with the shell that brings back o.prev (or removes a new site).
 */
export async function applySite(s: Server, meta: SiteMeta, proxy: Proxy, o: ApplyOpts) {
  const keep = Math.max(Number.isInteger(o.keep) ? o.keep! : 5, 2);
  // Newest first; never prune the active release, nor the one undo goes back to.
  const sorted = newestFirst(meta);
  const kept = sorted.filter((r, i) => i < keep || r.id === meta.current || r.id === o.prev?.current);
  const pruned = sorted.filter((r) => !kept.includes(r));
  meta.releases = kept;

  const dir = siteDir(meta.name);
  const lines = [PRELUDE];
  if (o.takeover) {
    // Old container down once the new one is built, but before site.json says v2: a failed start would never get to remove it.
    const before = [`record ${shq(takeoverRecord(o.what))}`, ...takeoverLines(o.takeover, meta.current)];
    lines.push(...siteLines(meta, proxy, { ...o, before }));
    await runScript(s, lines.join("\n"));
    return;
  }
  // The undo shell is head + "$u" + tail: $u is what `saved` printed to put .env back.
  let head: string;
  let tail = "";
  const saveEnv = o.prev ? o.env !== undefined : !!o.existed;
  if (saveEnv) lines.push(`u=$(saved ${shq(dir + "/.env")})`);
  const files = Object.keys(o.files ?? {});
  if (files.some((f) => f.startsWith(`${SECRETS_DIR}/`))) lines.push(`install -d -m 700 ${shq(`${dir}/${SECRETS_DIR}`)}`);
  files.forEach((f, i) => lines.push(`f${i}=$(saved ${shq(`${dir}/${f}`)})`));
  const restore = [...(saveEnv ? ['"$u"'] : []), ...files.map((_, i) => `"$f${i}"`)].join(shq("\n"));
  if (!o.prev) {
    // `lf sites rm` may have removed it since.
    head = `[ ! -d ${shq(dir)} ] || {\n${removeLines(meta, { keepDir: o.existed }).join("\n")}\n`;
    tail = "\n}";
  } else {
    const old = o.prev;
    // Volumes stay in the folder: back in Docker's, Compose would ask to recreate them, empty.
    const back = { ...old, releases: old.releases.filter((r) => kept.some((k) => k.id === r.id)), ...(meta.volumes && { volumes: meta.volumes }) };
    const added = kept.filter((r) => !old.releases.some((p) => p.id === r.id));
    // `lf sites rm` took its releases since: putting site.json back would revive a broken site.
    head = `[ -d ${shq(dir)} ] || { log ${shq(`${meta.name} was removed since, nothing to put back`)}; exit 0; }\n`;
    // `lf release rm` may have deleted the release it went back to.
    head += `[ -d ${shq(`${dir}/releases/${old.current}`)} ] || { log ${shq(`release ${old.current} of ${meta.name} was removed since, nothing to go back to`)}; exit 0; }\n`;
    tail = "\n" + [...siteLines(back, proxy, { recreate: o.recreate }), ...added.flatMap((r) => dropRelease(meta, r))].join("\n");
  }
  // Journaled once built, before the switch: a site that fails to start is still put back by undo.
  // Its journal line is known only if no one else wrote one in between; then the rollback marks it undone.
  const count = `$(wc -l < ${JOURNAL} 2>/dev/null || echo 0)`;
  const before = [`undo=${shq(head)}${restore}${shq(tail)}`, `jn=${count}`, `record ${shq(o.what)} "$undo"`, `jl=${count}; [ "$((jl))" -eq "$((jn + 1))" ] || jl=""`];
  // A start that fails puts the site back as it was right away; a new site stays for lf undo to remove.
  const failed = o.prev
    ? [
        `set +e; ( set -e; eval "$undo" ); rc=$?; set -e`,
        `if [ "$rc" = 0 ]; then [ -z "$jl" ] || _journal undo "$jl" ""; log ${shq(`${meta.name} is back as it was`)}`,
        `else log ${shq(`could not put ${meta.name} back as it was: lf undo`)}; fi`,
      ]
    : [`log ${shq(`lf undo removes ${meta.name}`)}`];
  lines.push(...siteLines(meta, proxy, { ...o, before, failed }));
  for (const r of pruned) lines.push(...dropRelease(meta, r));
  await runScript(s, lines.join("\n"));
}

/** Run `dc <args>` in a site's live release, after an optional setup snippet in the site's folder. */
export async function composeCmd(s: Server, name: string, args: string, before = "") {
  await runScript(s, `${PRELUDE}\ncd ${shq(siteDir(name))}\n${before}\ncd -P current && dc ${args}`);
}

/** Logs of a site's services (or one of them), via its compose project. */
/** Exit code of a remote command that found no site folder: the caller reports it with noSite. */
const NO_SITE = 79;

export async function siteLogs(s: Server, name: string, o: { service?: string; tail?: string; follow?: boolean }) {
  const dir = shq(siteDir(name) + "/current");
  const code = await sshExec(s, [
    `{ [ -d ${dir} ] || exit ${NO_SITE}; } && cd -P ${dir} && docker compose logs --tail ${shq(o.tail ?? "100")} ${o.follow ? "-f " : ""}${o.service ? shq(o.service) : ""}`,
  ]);
  if (code === NO_SITE) await noSite(s, name);
  return code;
}

/** Ends a site's line in the crontab (lf volume backup --schedule): what finds it again. */
export const cronMark = (site: string) => `# landfall backup ${site}:`;

export function removeLines(meta: SiteMeta, o: { keepDir?: boolean; volumes?: boolean } = {}): string[] {
  const dir = siteDir(meta.name);
  const v = o.volumes ? " -v" : "";
  const images = meta.adopted ? [] : meta.releases.flatMap((r) => builtImages(meta.name, r));
  // keepDir: the dir was there before landfall used it, so take out only landfall's files (.env is the caller's).
  const files = ["site.json", "current", "current.new", ...meta.releases.map((r) => `releases/${r.id}`), ...(o.volumes ? ["volumes"] : [])].map(shq).join(" ");
  return [
    `cd ${shq(dir)}`,
    `{ [ -e current ] && (cd -P current && dc down --remove-orphans${v}); } >/dev/null 2>&1 || dc -p ${shq(siteProject(meta))} down --remove-orphans${v} >/dev/null 2>&1 || true`,
    ...images.map(rmImage),
    // Scheduled backups stop with the site; those already made stay with the volumes.
    `! command -v crontab >/dev/null || ! crontab -l 2>/dev/null | grep -qF ${shq(cronMark(meta.name))} || crontab -l | grep -vF ${shq(cronMark(meta.name))} | crontab - || true`,
    // The containers' users own the volumes' files (postgres is 999): a container deletes them, no sudo needed.
    ...(o.volumes ? [`[ ! -d volumes ] || docker run --rm -q -v "$PWD/volumes:/v" ${HELPER} find /v -mindepth 1 -delete`] : []),
    ...(o.keepDir
      ? [`rmf ${files}`, "rmdir releases 2>/dev/null || true"]
      : o.volumes
        ? ["cd /", `rmf ${shq(dir)}`]
        : // The volumes stay, and so do their backups (lf volume backup): only those are left in the folder.
          [`for f in * .[!.]* ..?*; do { [ -e "$f" ] || [ -L "$f" ]; } && [ "$f" != backups ] && [ "$f" != volumes ] && rmf "$f" || true; done`, "cd /", `rmdir ${shq(dir)} 2>/dev/null || true`]),
  ];
}

/**
 * Deletes a site for good: its releases are gone, so this cannot be undone. Named volumes
 * (databases, uploads) stay unless `volumes`. An adopted site's own folder is left alone.
 */
export async function removeSite(s: Server, meta: SiteMeta, o: { volumes?: boolean } = {}) {
  const what = `removed site ${meta.name} (${siteDomains(meta).join(", ") || "no domains"})${o.volumes ? " and its volumes" : ""}`;
  await runScript(s, [PRELUDE, ...removeLines(meta, o), `record ${shq(what)}`].join("\n"));
}

/** Merge KEY=VALUE pairs into dotenv text, preserving order and comments. */
export function mergeEnv(existing: string, set: Record<string, string>, unset: string[] = []): string {
  const out: string[] = [];
  const done = new Set<string>();
  for (const line of existing.split("\n")) {
    const key = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=/)?.[1];
    if (key && unset.includes(key)) continue;
    if (key && Object.hasOwn(set, key)) {
      // Compose takes the last of duplicate keys: keep one, set.
      if (!done.has(key)) out.push(`${key}=${set[key]}`);
      done.add(key);
    } else if (line.trim() || out.length) out.push(line);
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  for (const [k, v] of Object.entries(set)) if (!done.has(k)) out.push(`${k}=${v}`);
  return out.length ? out.join("\n") + "\n" : "";
}

/** KEY=VALUE lines of a dotenv file; `export` prefixes and comments are skipped. */
export const dotenvLines = (text: string): string[] =>
  text
    .split("\n")
    // `KEY = v` is fine for Compose too.
    .map((l) => l.trim().replace(/^export\s+/, "").replace(/^([^=\s]+)\s*=\s*/, "$1="))
    .filter((l) => l && !l.startsWith("#") && l.includes("="));

/** The files of a site's .secrets folder with their sizes; never their content. */
export async function readSecrets(s: Server, name: string): Promise<{ key: string; size: number }[]> {
  const { stdout } = await runScript(
    s,
    `cd ${shq(`${siteDir(name)}/${SECRETS_DIR}`)} 2>/dev/null || exit 0; for f in *; do [ -f "$f" ] && printf '%s\t%s\n' "$f" "$(wc -c < "$f")"; done; true`,
    { capture: true },
  );
  return stdout.split("\n").filter(Boolean).map((l) => ({ key: l.split("\t")[0], size: Number(l.split("\t")[1]) }));
}

/** `docker compose config` of the site's live release, or undefined when it does not resolve. */
export async function liveConfig(s: Server, name: string): Promise<any> {
  const { stdout } = await runScript(s, `${PRELUDE}\ncd ${shq(siteDir(name))} && cd -P current && dc config 2>/dev/null || true`, { capture: true });
  try {
    return parseYaml(stdout) ?? undefined;
  } catch {
    return undefined;
  }
}

/** The variables of a .env in order, each value as written after `=` (quotes included). */
export const envEntries = (text: string): { key: string; value: string }[] =>
  dotenvLines(text).map((l) => ({ key: l.slice(0, l.indexOf("=")).trim(), value: l.slice(l.indexOf("=") + 1) }));

/** What `lf env --json` prints and the web UI lists: values only when revealed, else just their length. */
export function envView(text: string, reveal = false) {
  return { vars: envEntries(text).map(({ key, value }) => (reveal ? { key, value } : { key, length: value.length })) };
}

/** A .env as `lf env` shows it: comments and blank lines dropped, every value hidden. */
export const maskedEnv = (text: string) => envEntries(text).map(({ key, value }) => `${key}=${"•".repeat(8)} (${value.length})\n`).join("");

/** A local dotenv file as pairs; `-` reads stdin, which keeps the values out of `ps`. */
export const readEnvFile = async (path: string) =>
  parseEnvPairs(dotenvLines(path === "-" ? await readStdin() : fs.readFileSync(path, "utf8")));

/** The .env in a project folder, without its empty values ("" and '' too); none or an unreadable one: {}. */
export function localEnv(dir: string): Record<string, string> {
  try {
    const all = parseEnvPairs(dotenvLines(fs.readFileSync(`${dir}/.env`, "utf8")));
    return Object.fromEntries(Object.entries(all).filter(([, v]) => v.replace(/^(["'])\1$/, "")));
  } catch {
    return {};
  }
}

/** KEY=VALUE pairs; a .env holds one variable per line, so its values (`oneLine`) cannot span lines. */
export function parseEnvPairs(pairs: string[], oneLine = false): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of pairs) {
    const i = p.indexOf("=");
    if (i < 1) fail(`invalid env "${p.split("\n")[0]}", expected KEY=VALUE`);
    const key = p.slice(0, i);
    if (!ENV_NAME.test(key)) fail(`not a variable name: ${JSON.stringify(key)} (letters, digits, _ . -)`);
    if (oneLine && /[\r\n]/.test(p.slice(i + 1))) fail(`${key}: a .env value is one line; put multi-line text (keys, certificates) in a secret: lf secret`);
    out[key] = p.slice(i + 1);
  }
  return out;
}
