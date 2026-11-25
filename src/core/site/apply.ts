import type { Server } from "../lib/config";
import { currentRelease, SECRETS_DIR, type SiteMeta } from "./meta";
import { autodeployLines, autodeployPath } from "../deploy/autodeploy";
import type { Skipper } from "./hooks";
import { siteDir, withSite } from "./site";
import { dropRelease, newestFirst } from "./releases";
import { removeLines } from "./lifecycle";
import { siteLines, splitLines, splitPath, switchJournal, type SiteHooks, type SiteLinesOpts } from "./switch";
import { runScript, shq, writeFileCmd } from "../ssh/ssh";
import { PRELUDE, type Proxy } from "../ssh/templates";

export interface ApplyOpts extends Pick<SiteLinesOpts, "env" | "files" | "recreate" | "build" | "pull" | "hooks"> {
  keep?: number;
  /** The site as it was before, so the journal can put it back; none = new site. */
  prev?: SiteMeta;
  /** Journal line, e.g. "deploy blog release 20250101-120000". */
  what: string;
  /** A new site whose dir was already there (leftovers, or someone's files): undo removes only what landfall wrote. */
  existed?: boolean;
}

/**
 * lf weight: site.json and the split file only. Traefik's file provider reloads it, so no container restarts.
 * The weights must belong to a split of the current release (the caller checks).
 */
export async function setWeights(s: Server, name: string, weights: Record<string, number>, what: string): Promise<SiteMeta> {
  return withSite(s, name, { deployed: "change the traffic split of" }, async ({ meta, proxy }) => {
    meta.weights = { ...meta.weights, ...weights };
    meta.updatedAt = new Date().toISOString();
    const lines = [
      PRELUDE,
      `cd ${shq(siteDir(name))}`,
      "u1=$(saved site.json) || exit 1",
      `u2=$(saved ${shq(splitPath(name))}) || exit 1`,
      // The split file first: it checks that landfall's own Traefik reads it.
      ...splitLines(meta, currentRelease(meta)!),
      writeFileCmd("site.json", JSON.stringify(meta, null, 2) + "\n"),
      ...(meta.autodeploy ? ["u3=$(saved autodeploy.sh) || exit 1", ...autodeployLines(meta, proxy)] : []),
      `record ${shq(what)} "$u1"${shq("\n")}"$u2"${meta.autodeploy ? `${shq("\n")}"$u3"` : ""}`,
    ];
    await runScript(s, lines.join("\n"));
    return meta;
  });
}

/** Change a deployed site in place (domains, login, current release) and apply it; undo restores it as it was. */
export async function changeSite(
  s: Server,
  name: string,
  proxy: Proxy,
  what: string,
  change: (m: SiteMeta) => void,
  o: Pick<ApplyOpts, "files" | "recreate"> & {
    /** The hooks of the change, from site.json as read under the lock: before it and after it. */
    hooks?: (before: SiteMeta, after: SiteMeta) => SiteHooks | undefined;
    /** Its skips go into the journal line. */
    skip?: Skipper;
  } = {},
): Promise<SiteMeta> {
  return withSite(s, name, {}, async ({ meta }) => {
    const prev = structuredClone(meta);
    change(meta);
    meta.updatedAt = new Date().toISOString();
    const hooks = o.hooks?.(prev, meta);
    await applySite(s, meta, proxy, { files: o.files, recreate: o.recreate, hooks, keep: meta.releases.length, prev, what: what + (o.skip?.note() ?? "") });
    return meta;
  });
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
  // The undo shell is head + "$u" + tail: $u is what `saved` printed to put .env back.
  let head: string;
  let tail = "";
  const saveEnv = o.prev ? o.env !== undefined : !!o.existed;
  if (saveEnv) lines.push(`u=$(saved ${shq(dir + "/.env")})`);
  const files = Object.keys(o.files ?? {});
  if (files.some((f) => f.startsWith(`${SECRETS_DIR}/`))) lines.push(`install -d -m 700 ${shq(`${dir}/${SECRETS_DIR}`)}`);
  files.forEach((f, i) => lines.push(`f${i}=$(saved ${shq(`${dir}/${f}`)})`));
  // autodeploy.sh is generated from site.json: undo puts back the one that matched the old site.json.
  const auto = !!o.prev && !!meta.autodeploy;
  if (auto) lines.push(`ad=$(saved ${shq(autodeployPath(meta.name))})`);
  const restore = [...(saveEnv ? ['"$u"'] : []), ...files.map((_, i) => `"$f${i}"`), ...(auto ? ['"$ad"'] : [])].join(shq("\n"));
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
    // `lf release rm` may have deleted the release it went back to.
    head += `[ -d ${shq(`${dir}/releases/${old.current}`)} ] || { log ${shq(`release ${old.current} of ${meta.name} was removed since, nothing to go back to`)}; exit 0; }\n`;
    tail = "\n" + [...siteLines(back, proxy, { recreate: o.recreate }), ...added.flatMap((r) => dropRelease(meta, r))].join("\n");
  }
  lines.push(...siteLines(meta, proxy, { ...o, ...switchJournal(meta.name, o.what, `${shq(head)}${restore}${shq(tail)}`, !!o.prev) }));
  lines.push(...autodeployLines(meta, proxy));
  // Said, not only done: a release that goes is one rollback can no longer reach.
  if (pruned.length)
    lines.push(`log ${shq(`removing old release${pruned.length > 1 ? "s" : ""} ${pruned.map((r) => r.id).join(", ")} of ${meta.name} (keeping ${keep})`)}`);
  for (const r of pruned) lines.push(...dropRelease(meta, r));
  // A pull or build that moved a tag leaves the old image untagged: nothing can run it any more.
  if (o.pull || o.build)
    lines.push(
      `freed=$(docker image prune -f 2>/dev/null | sed -n 's/^Total reclaimed space: //p') || true; case "$freed" in ""|0B) ;; *) log "removed untagged images: $freed" ;; esac`,
    );
  // Build cache stays a week, for fast rebuilds: older layers only fill the disk.
  if (o.build) lines.push(`docker builder prune -f --filter until=168h >/dev/null 2>&1 || true`);
  await runScript(s, lines.join("\n"));
}
