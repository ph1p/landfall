/**
 * Backwards compatibility: what older landfall versions left on servers, in projects and in
 * ~/.landfall/config.json. Everything here goes together, once nothing from before is left:
 * delete this file and src/ui/app/lib/legacy.tsx, then fix what no longer compiles.
 *
 * Besides the imports, that leaves:
 * - compose.ts: isSiteMeta's and currentRelease's isOld checks, SiteState "old", kindOf's "(old)".
 * - deploy.ts: the `old` site it moves (old?.domains/auth/createdAt, `takeover: old`, the id comment).
 * - remote.ts: ApplyOpts.takeover and applySite's takeover branch; siteProject becomes projectName.
 * - sites.ts: sitesInfo's "old" state check; ignore.ts: drop IGNORE_FILE from EXCLUDE and uploadList.
 * - "also --env-file" in the dotenv option texts of deploy.ts and sites.ts; ignore.ts's comments on .landfallignore.
 * - README: --dotenv's old name, volumes of an older landfall (Volumes), .landfallignore (What gets uploaded, Files).
 * - tests: shell.test.ts (--env-file), scripts.test.ts (takeover), releases.test.ts (old site.json),
 *   deploy.test.ts and projects.test.ts (IGNORE_FILE), test/e2e/run.sh (.landfallignore).
 */
import type { Server } from "./config";
import { projectName, volumeDir, type SiteMeta } from "./compose";
import { shq } from "./ssh";
import { HELPER, SITES } from "./templates";

// ---- sites of landfall before Compose sites: one container in the project landfall-<name> ----

/** site.json written by landfall before sites were Compose projects. */
export const isOld = (meta: { v?: number }) => meta.v !== 2;

/** Sites of landfall before Compose sites ran as one container in the project landfall-<name>. */
const oldProject = (name: string) => `landfall-${name}`;

/** The Compose project of an old site; none for the others. */
export const oldSiteProject = (meta: SiteMeta) => (isOld(meta) ? oldProject(meta.name) : undefined);

/** What a command that needs a Compose site says to an old one. */
export const oldSiteError = (name: string) => `${name} was deployed by an older landfall: run \`lf deploy\` in its project once to move it to a Compose project`;

/** Deploy over an old site moves it: the old meta to take over, and none to build on. */
export function splitOld(meta?: SiteMeta): { old?: SiteMeta; prev?: SiteMeta } {
  return meta && isOld(meta) ? { old: meta } : { prev: meta };
}

export const takeoverWarning = (name: string) => `${name} was deployed by an older landfall: this moves it to a Compose project (its old releases go, so it cannot be undone)`;

/** The history line of a takeover: the old layout's releases are not Compose projects, nothing to go back to. */
export const takeoverRecord = (what: string) => `${what} (moved from landfall's old site layout, cannot be undone)`;

/** Shell that takes down an old site's container and removes its files, all but release `keep`. */
export function takeoverLines(old: SiteMeta, keep?: string): string[] {
  const dir = `${SITES}/${old.name}`;
  const images = old.kind === "dockerfile" ? (old.releases as any[]).map((r) => r.image).filter(Boolean) : [];
  return [
    `cd ${shq(dir)}`,
    `log "removing the old container of ${old.name}"`,
    `dc -p ${shq(oldProject(old.name))} down --remove-orphans >/dev/null 2>&1 || docker rm -f ${shq(oldProject(old.name))} >/dev/null 2>&1 || true`,
    `rm -f docker-compose.yml nginx.conf`,
    ...old.releases.filter((r) => r.id !== keep).map((r) => `rm -rf ${shq("releases/" + r.id)}`),
    ...images.map((i) => `docker image rm ${shq(i)} >/dev/null 2>&1 || true`),
  ];
}

/** updates.ts IMAGES, per site.json in $f: an old site's one container, then on to the next site. */
export const OLD_SITE_IMAGES = `if ! grep -q '"v": *2' "$f"; then img site "$n" "landfall-$n" "$d"; continue; fi`;

/** What lf domains says when an old site holds a domain. */
export const OLD_SITE_DOMAINS = "redeploy it first (lf deploy) so it can hand them over";

// ---- volumes in Docker's own storage, before they lived in the site's folder ----

/** Shell that moves the site's volumes still in Docker's storage into its folder; runs `failed` and exits if one cannot. */
export function moveVolumes(meta: SiteMeta, failed: string[] = []): string[] {
  if (meta.adopted) return [];
  return (meta.volumes ?? []).flatMap((k) => {
    const v = shq(`${projectName(meta)}_${k}`);
    const d = shq(volumeDir(meta.name, k));
    return [
      `if docker volume inspect ${v} >/dev/null 2>&1 && [ "$(docker volume inspect -f '{{index .Options "device"}}' ${v})" != ${d} ]; then`,
      `  log ${shq(`moving volume ${k} into ${volumeDir(meta.name, k)}`)}`,
      `  ids=$(docker ps -aq --filter volume=${v}); [ -z "$ids" ] || docker rm -f $ids >/dev/null`,
      `  if ! { docker run --rm -q -v ${v}:/from -v ${d}:/to ${HELPER} cp -a /from/. /to/ && docker volume rm ${v} >/dev/null; }; then`,
      `    log ${shq(`could not move volume ${k}: it is unchanged`)}`,
      ...failed.map((l) => `    ${l}`),
      "    exit 1",
      "  fi",
      "fi",
    ];
  });
}

// ---- traefik set up before the dashboard tunnel ----

export const oldTraefikDashboard = (name: string) => `traefik on ${name} was set up by an older landfall: \`lf traefik setup -s ${name}\` adds the dashboard tunnel`;

// ---- ~/.landfall/config.json and projects ----

/** Servers of earlier versions kept a single `domain`. */
export function serverDomains(servers: Record<string, Server>) {
  for (const s of Object.values(servers) as (Server & { domain?: string })[]) {
    if (s.domain) s.domains = [...new Set([s.domain, ...(s.domains ?? [])])];
    delete s.domain;
  }
}

/** The older place for exclude: still read, its lines go before .landfall.json's exclude. */
export const IGNORE_FILE = ".landfallignore";

// ---- --env-file, --dotenv's old name: node 26 reads --env-file itself wherever it stands, and exits before lf runs ----

export const OLD_DOTENV = "env-file";

/** parseArgs options: --env-file as another spelling of --dotenv. */
export function oldDotenvOption(options: Record<string, unknown>) {
  if (options.dotenv) options[OLD_DOTENV] = options.dotenv;
}

/** Parsed values: --env-file's value as --dotenv's, unless --dotenv was given too. */
export function oldDotenvValue(values: Record<string, unknown>) {
  if (values[OLD_DOTENV] !== undefined) (values.dotenv ??= values[OLD_DOTENV]), delete values[OLD_DOTENV];
}
