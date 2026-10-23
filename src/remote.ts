import type { Server } from "./config";
import { runScript, shq, sshExec, writeFileCmd } from "./ssh";
import { container, nginxConf, OWN_PROXY, parseProxy, PRELUDE, PROXY_CTR, PROXY_FILE, siteCompose, SITES, type Proxy, type Release, type SiteMeta } from "./templates";
import { fail, warn } from "./ui";

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

export async function requireSite(s: Server, name: string): Promise<{ meta: SiteMeta; env: string; proxy: Proxy }> {
  const site = await readSite(s, name);
  if (!site.meta) fail(`no site "${name}" on ${s.host}. See \`lf sites list\``);
  return site as { meta: SiteMeta; env: string; proxy: Proxy };
}

/** Release ids are timestamps, so newest first is a reverse string sort. */
export const newestFirst = (meta: SiteMeta) => [...meta.releases].sort((a, b) => b.id.localeCompare(a.id));

export const dockerLogs = (s: Server, ctr: string, o: { tail?: string; follow?: boolean }) =>
  sshExec(s, [`docker logs --tail ${shq(o.tail ?? "100")} ${o.follow ? "-f " : ""}${ctr}`]);

export interface SiteStatus {
  meta: SiteMeta;
  status: string;
}

export interface Overview {
  /** docker and /opt/landfall/sites exist, i.e. `lf setup` ran. */
  ready: boolean;
  /** traefik container status, empty if not installed. */
  traefik: string;
  /** Its container name: landfall's `traefik`, or the one sites were pointed at. */
  proxy: string;
  sites: SiteStatus[];
}

export async function overview(s: Server): Promise<Overview> {
  const { stdout } = await runScript(
    s,
    `printf 'READY\\t%s\\n' "$([ -d ${SITES} ] && command -v docker >/dev/null 2>&1 && echo 1)"
P=${PROXY_CTR}
printf 'TRAEFIK\\t%s\\t%s\\n' "$(docker ps -a --filter "name=^$P$" --format '{{.Status}}' 2>/dev/null || true)" "$P"
for f in ${SITES}/*/site.json; do [ -f "$f" ] || continue; printf 'SITE\\t'; tr -d '\\n' < "$f"; echo; done
docker ps -a --filter label=landfall.managed=true --format 'CTR\\t{{.Names}}\\t{{.Status}}' 2>/dev/null || true`,
    { capture: true },
  );
  const status = new Map<string, string>();
  const metas: SiteMeta[] = [];
  const o: Overview = { ready: false, traefik: "", proxy: "traefik", sites: [] };
  for (const line of stdout.split("\n")) {
    const [kind, a = "", b] = line.split("\t");
    if (kind === "READY") o.ready = a === "1";
    if (kind === "TRAEFIK") {
      o.traefik = a;
      o.proxy = b || "traefik";
    }
    if (kind === "SITE") {
      // One broken site.json must not hide every other site.
      try {
        metas.push(JSON.parse(line.slice(kind.length + 1)));
      } catch {
        warn(`skipped a corrupt site.json on ${s.host}: ${line.slice(5, 80)}`);
      }
    }
    if (kind === "CTR") status.set(a, b);
  }
  o.sites = metas.map((meta) => ({ meta, status: status.get(container(meta.name)) ?? "not running" }));
  return o;
}

export const listSites = async (s: Server) => (await overview(s)).sites;

export interface ApplyOpts {
  env?: string;
  /** docker build the current release (dockerfile sites). */
  build?: boolean;
  /** docker pull before starting (image sites). */
  pull?: boolean;
  keep?: number;
  /** The site as it was before, so the journal can put it back; none = new site. */
  prev?: SiteMeta;
  /** Journal line, e.g. "deploy blog release 20250101-120000". */
  what: string;
  /** A new site whose dir was already there (leftovers, or someone's files): undo removes only what landfall wrote. */
  existed?: boolean;
}

/** Shell that writes a site's files for meta.current and (re)starts it, in its directory. */
function siteLines(meta: SiteMeta, proxy: Proxy, o: { env?: string; build?: boolean; pull?: boolean } = {}): string[] {
  const dir = siteDir(meta.name);
  const release = meta.releases.find((r) => r.id === meta.current)!;
  const lines = [
    `mkdir -p ${shq(dir)} && cd ${shq(dir)}`,
    writeFileCmd("site.json", JSON.stringify(meta, null, 2) + "\n"),
    writeFileCmd("docker-compose.yml", siteCompose(meta, proxy)),
    o.env !== undefined ? writeFileCmd(".env", o.env, "600") : "touch .env && chmod 600 .env",
  ];
  if (meta.kind === "static") lines.push(writeFileCmd("nginx.conf", nginxConf(meta.current, !!meta.spa)));
  if (meta.kind !== "image") lines.push(`ln -sfn ${shq("releases/" + meta.current)} current`);
  if (o.build && meta.kind === "dockerfile") {
    lines.push(`log "building image ${release.image}"`, `docker build -q -t ${shq(release.image!)} ${shq("releases/" + meta.current)} >/dev/null`);
  }
  if (o.pull && meta.kind === "image") lines.push(`log "pulling ${release.image}"`, "dc pull -q");
  lines.push(
    `log "starting ${container(meta.name)}"`,
    `{ dc up -d --remove-orphans --quiet-pull && ensure_running ${container(meta.name)}; } || exit 1`,
  );
  // A config-only change (new static release) does not recreate nginx; reload it.
  if (meta.kind === "static") lines.push(`docker exec ${container(meta.name)} nginx -s reload >/dev/null 2>&1 || true`);
  return lines;
}

const dropRelease = (meta: SiteMeta, r: Release) => [
  `rm -rf ${shq(`${siteDir(meta.name)}/releases/${r.id}`)}`,
  ...(meta.kind === "dockerfile" && r.image ? [`docker image rm ${shq(r.image)} >/dev/null 2>&1 || true`] : []),
];

/**
 * Write site.json/compose/nginx.conf for meta.current and (re)start the site.
 * Used by deploy and rollback alike, so both go through the exact same path.
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
  // The undo shell is head + "$u" + tail: $u is what `saved` printed to put .env back.
  let head: string;
  let tail = "";
  const saveEnv = o.prev ? o.env !== undefined : !!o.existed;
  if (saveEnv) lines.push(`u=$(saved ${shq(dir + "/.env")})`);
  if (!o.prev) {
    // `lf sites rm` may have removed it since.
    head = `[ ! -d ${shq(dir)} ] || {\n${removeLines(meta, o.existed).join("\n")}\n`;
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

/** Run `dc <args>` in a site's directory, after an optional setup snippet. */
export async function composeCmd(s: Server, name: string, args: string, before = "") {
  await runScript(s, `${PRELUDE}\ncd ${shq(siteDir(name))}\n${before}\ndc ${args}`);
}

function removeLines(meta: SiteMeta, keepDir = false): string[] {
  const dir = siteDir(meta.name);
  const images = meta.kind === "dockerfile" ? (meta.releases.map((r) => r.image).filter(Boolean) as string[]) : [];
  // keepDir: the dir was there before landfall used it, so take out only landfall's files (.env is the caller's).
  const files = ["site.json", "docker-compose.yml", "nginx.conf", "current", ...meta.releases.map((r) => `releases/${r.id}`)].map(shq).join(" ");
  return [
    `cd ${shq(dir)}`,
    `dc down --remove-orphans >/dev/null 2>&1 || docker rm -f ${container(meta.name)} >/dev/null 2>&1 || true`,
    ...images.map((i) => `docker image rm ${shq(i)} >/dev/null 2>&1 || true`),
    ...(keepDir
      ? [`rm -rf ${files} 2>/dev/null || $SUDO rm -rf ${files}`, "rmdir releases 2>/dev/null || true"]
      : ["cd /", `rm -rf ${shq(dir)} 2>/dev/null || $SUDO rm -rf ${shq(dir)}`]),
  ];
}

/** Deletes a site for good: its releases are gone, so this one cannot be undone. */
export async function removeSite(s: Server, meta: SiteMeta) {
  await runScript(s, [PRELUDE, ...removeLines(meta), `record ${shq(`removed site ${meta.name} (${meta.domains.join(", ")})`)}`].join("\n"));
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

export function parseEnvPairs(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of pairs) {
    const i = p.indexOf("=");
    if (i < 1) fail(`invalid env "${p}", expected KEY=VALUE`);
    out[p.slice(0, i)] = p.slice(i + 1);
  }
  return out;
}
