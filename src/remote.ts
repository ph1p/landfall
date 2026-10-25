import fs from "node:fs";
import type { Server } from "./config";
import { parse as parseYaml } from "yaml";
import {
  builtImage,
  COMPOSE_FILES,
  currentRelease,
  isDone,
  isOld,
  isUp,
  kindOf,
  oldProject,
  OVERRIDE_FILES,
  overrideYaml,
  projectName,
  routed,
  ROUTER_RULE,
  ruleHosts,
  siteState,
  type SiteState,
  siteDomains,
  siteMain,
  type Release,
  type SiteMeta,
} from "./compose";
import { runScript, shq, sshExec, writeFileCmd } from "./ssh";
import { OWN_PROXY, parseProxy, PRELUDE, PROXY_CTR, PROXY_FILE, SITES, TUNNEL_ROUTER, type Proxy } from "./templates";
import { fail, readStdin, warn } from "./ui";

export const siteDir = (name: string) => `${SITES}/${name}`;

export function validName(name: string) {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) fail(`invalid site name "${name}" (use lowercase letters, digits, dashes)`);
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
    } catch {
      fail(`corrupt ${dir}/site.json on ${s.host}`);
    }
  }
  return { meta, env, proxy: parseProxy(proxy) ?? OWN_PROXY, exists: exists.trim() === "1" };
}

/** A site that exists and is a Compose project; `deployed` also refuses adopted ones (no releases). */
export async function requireSite(s: Server, name: string, o: { deployed?: string } = {}): Promise<{ meta: SiteMeta; env: string; proxy: Proxy }> {
  const site = await readSite(s, name);
  if (!site.meta) fail(`no site "${name}" on ${s.host}. See \`lf sites list\``);
  const meta = site.meta!;
  if (isOld(meta)) fail(`${name} was deployed by an older landfall: run \`lf deploy\` in its project once to move it to a Compose project`);
  if (o.deployed && meta.adopted) fail(`${name} is adopted (${meta.adopted}): landfall does not ${o.deployed} it; change its compose files there`);
  return site as { meta: SiteMeta; env: string; proxy: Proxy };
}

/** Release ids are timestamps, so newest first is a reverse string sort. */
export const newestFirst = (meta: SiteMeta) => [...meta.releases].sort((a, b) => b.id.localeCompare(a.id));

/** Logs of one container (the proxy). */
export const dockerLogs = (s: Server, ctr: string, o: { tail?: string; follow?: boolean }) =>
  sshExec(s, [`docker logs --tail ${shq(o.tail ?? "100")} ${o.follow ? "-f " : ""}${ctr}`]);

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
    // A group is up only if all its routed containers are.
    if (!e.status || !isUp(st)) e.status = st;
    out.set(key, e);
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * One status for a site: the first routed service that is not up, else any other service that
 * is neither up nor done (one-shot jobs exit 0), else the routed service's.
 */
export function siteStatus(meta: SiteMeta, services: ServiceStatus[]): string {
  if (!services.length) return "not running";
  const r = currentRelease(meta);
  const names = new Set(r?.services.filter(routed).map((s) => s.name));
  const main = services.filter((s) => names.has(s.service));
  const bad = main.find((s) => !isUp(s.status)) ?? services.find((s) => !names.has(s.service) && !isUp(s.status) && !isDone(s.status));
  return (bad ?? main[0] ?? services[0]).status;
}

/** Compose project of a site; sites of landfall before Compose sites ran as landfall-<name>. */
/** The compose project a site runs as. */
export const siteProject = (meta: SiteMeta) => (isOld(meta) ? oldProject(meta.name) : projectName(meta));

export async function overview(s: Server): Promise<Overview> {
  const { stdout } = await runScript(
    s,
    `printf 'READY\\t%s\\n' "$([ -d ${SITES} ] && command -v docker >/dev/null 2>&1 && echo 1)"
P=${PROXY_CTR}
printf 'TRAEFIK\\t%s\\t%s\\t%s\\n' "$(docker ps -a --filter "name=^$P$" --format '{{.Status}}' 2>/dev/null || true)" "$P" "$([ -f ${PROXY_FILE} ] && echo 1)"
for f in ${SITES}/*/site.json; do [ -f "$f" ] || continue; printf 'SITE\\t'; tr -d '\\n' < "$f"; echo; done
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
      try {
        metas.push(JSON.parse(line.slice(kind.length + 1)));
      } catch {
        warn(`skipped a corrupt site.json on ${s.host}: ${line.slice(5, 80)}`);
      }
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
 * Round trip after the upload: give the release its .env link and one compose.yaml (renamed
 * from `file`, or `generated`), drop override files (landfall writes its own), and return
 * the release's real path and its `docker compose config`. On failure the caller discards
 * the release (discardRelease).
 */
export async function prepareRelease(
  s: Server,
  name: string,
  id: string,
  o: { file?: string; generated?: Record<string, string>; env?: string } = {},
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
    ...Object.entries(o.generated ?? {}).map(([f, text]) => writeFileCmd(f, text)),
    ...(file && file !== "compose.yaml" ? [`mv -f ${shq(file)} compose.yaml`] : []),
    `rm -f ${others.map(shq).join(" ")}`,
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
      `[ -r ${shq(meta.adopted!)} ] && [ -x ${shq(meta.adopted!)} ] || { echo "$(id -un) cannot read ${meta.adopted}; adopt it as a user who can (lf server config)" >&2; exit 1; }`,
      `[ ! -e ${shq(dir)} ] || { echo "${dir} exists already" >&2; exit 1; }`,
      `mkdir -p ${shq(dir)} && cd ${shq(dir)}`,
      `ln -s ${shq(meta.adopted!)} current`,
      writeFileCmd("site.json", JSON.stringify(meta, null, 2) + "\n"),
      `record ${shq(`adopted ${meta.project} as site ${meta.name}`)} ${shq(`rm -rf ${dir}`)}`,
    ].join("\n"),
  );
}

/** Remove a prepared release that never went live (and the site's folder if nothing else is in it). */
export async function discardRelease(s: Server, name: string, id: string) {
  const site = siteDir(name);
  await runScript(
    s,
    `cd / && rm -rf ${shq(`${site}/releases/${id}`)}; [ -f ${shq(site + "/site.json")} ] || { rmdir ${shq(site + "/releases")} 2>/dev/null; { [ -s ${shq(site + "/.env")} ] || rm -f ${shq(site + "/.env")}; }; rmdir ${shq(site)} 2>/dev/null; } || true`,
  );
}

export interface ApplyOpts {
  env?: string;
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

const UP = "dc up -d --wait --wait-timeout 300 --remove-orphans --quiet-pull";

/** Shell that starts the Compose project in `current`, printing its state and logs if it does not come up. */
export const upLines = (name: string) => [
  `log "starting ${name}"`,
  `(cd -P current && ${UP}) || { log "${name} did not start:"; (cd -P current && dc ps -a >&2; dc logs --tail 30 >&2) || true; exit 1; }`,
];

/** Shell: remove a built image, quietly; one still in use stays. */
const rmImage = (i: string) => `docker image rm ${shq(i)} >/dev/null 2>&1 || true`;

/** Shell that writes a site's files for meta.current, points `current` at it and starts it. */
function siteLines(meta: SiteMeta, proxy: Proxy, o: { env?: string; build?: boolean; pull?: boolean } = {}): string[] {
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
    o.env !== undefined ? writeFileCmd(".env", o.env, "600") : "[ -e .env ] || { touch .env && chmod 600 .env; }",
    `(cd -P ${rel} && ${writeFileCmd("compose.override.yaml", overrideYaml(meta, release, proxy))}) || exit 1`,
  ];
  if (o.build && release.services.some((s) => s.build)) {
    lines.push(`log "building ${meta.name}"`, `(cd -P ${rel} && dc build -q) || exit 1`);
  }
  if (o.pull) lines.push(`log "pulling images of ${meta.name}"`, `(cd -P ${rel} && dc pull -q --ignore-buildable) || exit 1`);
  // site.json only now, with the switch: a failed build or pull leaves it naming the release that still runs.
  lines.push(writeFileCmd("site.json", JSON.stringify(meta, null, 2) + "\n"));
  // Swapped in one rename, so `current` always points at a whole release.
  lines.push(`ln -sfn ${rel} current.new && mv -Tf current.new current`, ...upLines(meta.name));
  return lines;
}

const builtImages = (meta: SiteMeta, r: Release) => (r.services ?? []).filter((s) => s.build).map((s) => builtImage(meta.name, s.name, r.id));

const dropRelease = (meta: SiteMeta, r: Release) => [
  `rmf ${shq(`${siteDir(meta.name)}/releases/${r.id}`)}`,
  ...builtImages(meta, r).map(rmImage),
];

/** Shell that takes down a site of landfall before Compose sites and removes its files, keeping .env. */
function takeoverLines(old: SiteMeta, keep?: string): string[] {
  const dir = siteDir(old.name);
  const images = old.kind === "dockerfile" ? (old.releases as any[]).map((r) => r.image).filter(Boolean) : [];
  return [
    `cd ${shq(dir)}`,
    `log "removing the old container of ${old.name}"`,
    `dc -p ${shq(oldProject(old.name))} down --remove-orphans >/dev/null 2>&1 || docker rm -f ${shq(oldProject(old.name))} >/dev/null 2>&1 || true`,
    `rm -f docker-compose.yml nginx.conf`,
    ...old.releases.filter((r) => r.id !== keep).map((r) => `rm -rf ${shq("releases/" + r.id)}`),
    ...images.map(rmImage),
  ];
}

/**
 * Write site.json and the override for meta.current, switch `current` to it and start it.
 * Used by deploy, rollback and domain changes alike, so all go through the exact same path.
 * Journaled with the shell that brings back o.prev (or removes a new site).
 */
/** Change a deployed site in place (domains, login, current release) and apply it; undo restores it as it was. */
export async function changeSite(s: Server, meta: SiteMeta, proxy: Proxy, what: string, change: (m: SiteMeta) => void) {
  const prev = structuredClone(meta);
  change(meta);
  meta.updatedAt = new Date().toISOString();
  await applySite(s, meta, proxy, { keep: meta.releases.length, prev, what });
}

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
    // The old layout's releases are not Compose projects: nothing to go back to.
    // Old container first: once site.json says v2, a failed start would never get to remove it.
    lines.push(
      `record ${shq(`${o.what} (moved from landfall's old site layout, cannot be undone)`)}`,
      ...takeoverLines(o.takeover, meta.current),
      ...siteLines(meta, proxy, o),
    );
    await runScript(s, lines.join("\n"));
    return;
  }
  // The undo shell is head + "$u" + tail: $u is what `saved` printed to put .env back.
  let head: string;
  let tail = "";
  const saveEnv = o.prev ? o.env !== undefined : !!o.existed;
  if (saveEnv) lines.push(`u=$(saved ${shq(dir + "/.env")})`);
  if (!o.prev) {
    // `lf sites rm` may have removed it since.
    head = `[ ! -d ${shq(dir)} ] || {\n${removeLines(meta, { keepDir: o.existed }).join("\n")}\n`;
    tail = "\n}";
  } else {
    const old = o.prev;
    const back = { ...old, releases: old.releases.filter((r) => kept.some((k) => k.id === r.id)) };
    const added = kept.filter((r) => !old.releases.some((p) => p.id === r.id));
    // `lf sites rm` took its releases since: putting site.json back would revive a broken site.
    head = `[ -d ${shq(dir)} ] || { log ${shq(`${meta.name} was removed since, nothing to put back`)}; exit 0; }\n`;
    tail = "\n" + [...siteLines(back, proxy), ...added.flatMap((r) => dropRelease(meta, r))].join("\n");
  }
  // Journaled before starting: a site that fails to start is still put back by undo.
  lines.push(`record ${shq(o.what)} ${shq(head)}${saveEnv ? '"$u"' : ""}${shq(tail)}`);
  lines.push(...siteLines(meta, proxy, o));
  for (const r of pruned) lines.push(...dropRelease(meta, r));
  await runScript(s, lines.join("\n"));
}

/** Run `dc <args>` in a site's live release, after an optional setup snippet in the site's folder. */
export async function composeCmd(s: Server, name: string, args: string, before = "") {
  await runScript(s, `${PRELUDE}\ncd ${shq(siteDir(name))}\n${before}\ncd -P current && dc ${args}`);
}

/** Logs of a site's services (or one of them), via its compose project. */
export const siteLogs = (s: Server, name: string, o: { service?: string; tail?: string; follow?: boolean }) =>
  sshExec(s, [
    `cd -P ${shq(siteDir(name) + "/current")} && docker compose logs --tail ${shq(o.tail ?? "100")} ${o.follow ? "-f " : ""}${o.service ? shq(o.service) : ""}`,
  ]);

export function removeLines(meta: SiteMeta, o: { keepDir?: boolean; volumes?: boolean } = {}): string[] {
  const dir = siteDir(meta.name);
  const v = o.volumes ? " -v" : "";
  const images = meta.adopted ? [] : meta.releases.flatMap((r) => builtImages(meta, r));
  // keepDir: the dir was there before landfall used it, so take out only landfall's files (.env is the caller's).
  const files = ["site.json", "current", "current.new", ...meta.releases.map((r) => `releases/${r.id}`)].map(shq).join(" ");
  return [
    `cd ${shq(dir)}`,
    `{ [ -e current ] && (cd -P current && dc down --remove-orphans${v}); } >/dev/null 2>&1 || dc -p ${shq(siteProject(meta))} down --remove-orphans${v} >/dev/null 2>&1 || true`,
    ...images.map(rmImage),
    ...(o.keepDir
      ? [`rmf ${files}`, "rmdir releases 2>/dev/null || true"]
      : ["cd /", `rmf ${shq(dir)}`]),
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
  const pending = new Map(Object.entries(set));
  for (const line of existing.split("\n")) {
    const key = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1];
    if (key && unset.includes(key)) continue;
    if (key && pending.has(key)) {
      out.push(`${key}=${pending.get(key)}`);
      pending.delete(key);
    } else if (line.trim() || out.length) out.push(line);
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  for (const [k, v] of pending) out.push(`${k}=${v}`);
  return out.length ? out.join("\n") + "\n" : "";
}

/** KEY=VALUE lines of a dotenv file; `export` prefixes and comments are skipped. */
export const dotenvLines = (text: string): string[] =>
  text
    .split("\n")
    .map((l) => l.trim().replace(/^export\s+/, ""))
    .filter((l) => l && !l.startsWith("#") && l.includes("="));

/** A local dotenv file as pairs; `-` reads stdin, which keeps the values out of `ps`. */
export const readEnvFile = async (path: string) =>
  parseEnvPairs(dotenvLines(path === "-" ? await readStdin() : fs.readFileSync(path, "utf8")));

export function parseEnvPairs(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of pairs) {
    const i = p.indexOf("=");
    if (i < 1) fail(`invalid env "${p}", expected KEY=VALUE`);
    out[p.slice(0, i)] = p.slice(i + 1);
  }
  return out;
}
