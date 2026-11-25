import type { Server } from "../lib/config";
import { currentRelease, projectName, type SiteMeta } from "./meta";
import { siteDomains } from "./routing";
import { AUTODEPLOY_FILES, autodeployMark } from "../deploy/autodeploy";
import { hookLines, hookVars, serverCall, type Skipper } from "./hooks";
import { backupName, backupTo, recreateFrom } from "./volumes";
import { siteDir } from "./site";
import { builtImages, rmImage } from "./releases";
import { rmSplit } from "./switch";
import { cronMark } from "../server/cron";
import { runScript, shq, writeFileCmd } from "../ssh/ssh";
import { HELPER, PRELUDE } from "../ssh/templates";

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

export function removeLines(meta: SiteMeta, o: { keepDir?: boolean; volumes?: boolean } = {}): string[] {
  const dir = siteDir(meta.name);
  const v = o.volumes ? " -v" : "";
  const images = meta.adopted ? [] : meta.releases.flatMap((r) => builtImages(meta.name, r));
  // keepDir: the dir was there before landfall used it, so take out only landfall's files (.env is the caller's).
  const files = ["site.json", "current", "current.new", ...AUTODEPLOY_FILES, ...meta.releases.map((r) => `releases/${r.id}`), ...(o.volumes ? ["volumes"] : [])]
    .map(shq)
    .join(" ");
  const marks = [cronMark(meta.name), autodeployMark(meta.name)].map((m) => `-e ${shq(m)}`).join(" ");
  return [
    `cd ${shq(dir)}`,
    `log ${shq(`stopping ${meta.name}`)}`,
    // Its files go either way: a container that would not stop is said, with how to find it.
    `{ [ -e current ] && (cd -P current && dc down --remove-orphans${v}); } >/dev/null 2>&1 || dc -p ${shq(projectName(meta))} down --remove-orphans${v} >/dev/null 2>&1 || log ${shq(`could not stop ${meta.name}'s containers: docker ps --filter label=com.docker.compose.project=${projectName(meta)}`)}`,
    ...images.map(rmImage),
    rmSplit(meta.name),
    // Scheduled backups stop with the site; those already made stay with the volumes.
    // So do auto-deploys.
    `! command -v crontab >/dev/null || ! crontab -l 2>/dev/null | grep -qF ${marks} || crontab -l | grep -vF ${marks} | crontab - || true`,
    // The containers' users own the volumes' files (postgres is 999): a container deletes them, no sudo needed.
    ...(o.volumes ? [`[ ! -d volumes ] || docker run --rm -q -v "$PWD/volumes:/v" ${HELPER} find /v -mindepth 1 -delete`] : []),
    ...(o.keepDir
      ? [`rmf ${files}`, "rmdir releases 2>/dev/null || true"]
      : // The backups stay (lf volume backup, and lf sites rm --volumes saves each volume there), and the volumes unless deleted.
        [
          `for f in * .[!.]* ..?*; do { [ -e "$f" ] || [ -L "$f" ]; } && [ "$f" != backups ] && ${o.volumes ? "" : '[ "$f" != volumes ] && '}rmf "$f" || true; done`,
          "cd /",
          `rmdir ${shq(dir)} 2>/dev/null || true`,
        ]),
  ];
}

/**
 * Deletes a site for good: its releases are gone, so this cannot be undone. Named volumes
 * (databases, uploads) stay unless `volumes`. An adopted site's own folder is left alone.
 */
/**
 * vols: the site's volumes, deleted with it (--volumes). Each is backed up to its backups folder first and
 * journaled, so lf undo brings them back; a backup that fails stops it all before anything is gone.
 */
/** Removes a site; with `hooks`, the current release's predestroy runs first (minus what it skips). */
export async function removeSite(s: Server, meta: SiteMeta, o: { vols?: { name: string; key: string }[]; hooks?: Skipper } = {}) {
  const r = meta.adopted ? undefined : currentRelease(meta);
  const hook = o.hooks && serverCall(r?.hooks, "predestroy", o.hooks, hookVars(meta.name, { release: r }));
  const what = `removed site ${meta.name} (${siteDomains(meta).join(", ") || "no domains"})${o.vols ? " and its volumes" : ""}${o.hooks?.note() ?? ""}`;
  const dir = siteDir(meta.name);
  const now = new Date();
  const saves = (o.vols ?? []).flatMap((v) => {
    const name = backupName(v.key, now, "before-rm");
    const file = `${dir}/backups/${name}`;
    return [
      `log ${shq(`saving ${v.key} to ${file}`)}`,
      backupTo(v.name, shq(file)),
      `record ${shq(`delete volume ${v.key} of ${meta.name} (backup ${name})`)} ${shq(recreateFrom(v.name, v.key, projectName(meta), file))}`,
    ];
  });
  // predestroy first, in the running container: what fails stops the removal before anything is gone.
  const head = [
    ...(hook ? [`cd ${shq(dir)}`, ...hookLines(hook, "exec", "current")] : []),
    ...(saves.length ? [`cd ${shq(dir)} && mkdir -p backups`, ...saves] : []),
  ];
  await runScript(s, [PRELUDE, ...head, ...removeLines(meta, { volumes: !!o.vols }), `record ${shq(what)}`].join("\n"));
}
