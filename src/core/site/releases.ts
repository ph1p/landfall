import { parse as parseYaml } from "yaml";
import type { Server } from "../lib/config";
import { builtImage, SECRETS_DIR, type Release, type SiteMeta } from "./meta";
import { exposedPorts } from "./analyze";
import { COMPOSE_FILES, OVERRIDE_FILES } from "./compose-config";
import { SEP, siteDir, withSite } from "./site";
import { runScript, shq, writeFileCmd } from "../ssh/ssh";
import { PRELUDE } from "../ssh/templates";
import { fail } from "../lib/term";

/** Release ids are timestamps, so newest first is a reverse string sort. */
export const newestFirst = (meta: SiteMeta) => [...meta.releases].sort((a, b) => b.id.localeCompare(a.id));

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

/** The TCP ports an image EXPOSEs, lowest first; the server pulls it first when it lacks it. */
export async function imagePorts(s: Server, image: string): Promise<number[]> {
  const script = [
    PRELUDE,
    `$DOCKER image inspect ${shq(image)} >/dev/null 2>&1 || $DOCKER pull -q ${shq(image)} >&2`,
    `$DOCKER image inspect --format '{{range $p, $_ := .Config.ExposedPorts}}{{$p}} {{end}}' ${shq(image)}`,
  ].join("\n");
  const { stdout } = await runScript(s, script, { capture: true });
  return exposedPorts(stdout);
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

/** Shell: remove a built image, quietly; one still in use stays. */
export const rmImage = (i: string) => `docker image rm ${shq(i)} >/dev/null 2>&1 || true`;

/** Images the services of release `r` built. */
export const builtImages = (name: string, r: Release) => r.services.filter((s) => s.build).map((s) => builtImage(name, s.name, r.id));

export const dropRelease = (meta: SiteMeta, r: Release) => [`rmf ${shq(`${siteDir(meta.name)}/releases/${r.id}`)}`, ...builtImages(meta.name, r).map(rmImage)];

/** Releases `lf release rm` takes: the given ids, else all but the `keep` newest (like a deploy's --keep). Never the live one. */
export function oldReleases(meta: SiteMeta, o: { ids?: string[]; keep?: number } = {}): Release[] {
  return newestFirst(meta).filter((r, i) => r.id !== meta.current && (o.ids?.length ? o.ids.includes(r.id) : i >= (o.keep ?? 0)));
}

/**
 * Delete releases of a site: their folders and the images built for them. Not reversible: they are gone for rollback.
 * Read again under the deploy lock, so a deploy or rollback in between is not undone by an old site.json.
 */
export async function removeReleases(s: Server, name: string, ids: string[]): Promise<Release[]> {
  return withSite(s, name, { deployed: "remove releases of" }, async ({ meta }) => {
    const gone = oldReleases(meta, { ids });
    if (!gone.length) return [];
    meta.releases = meta.releases.filter((r) => !gone.includes(r));
    const what = `removed release${gone.length > 1 ? "s" : ""} ${gone.map((r) => r.id).join(", ")} of ${name} (cannot be undone)`;
    // site.json first: it never names a release whose folder is gone.
    const lines = [
      PRELUDE,
      `cd ${shq(siteDir(name))}`,
      writeFileCmd("site.json", JSON.stringify(meta, null, 2) + "\n"),
      ...gone.flatMap((r) => dropRelease(meta, r)),
      `record ${shq(what)}`,
    ];
    await runScript(s, lines.join("\n"));
    return gone;
  });
}
