import fs from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { defineCommand, serverOpt } from "../cmd";
import { checkInt, expandHome, loadProject, PROJECT_FILE, saveProject, type Server } from "../../core/config";
import { addVolumeMount, CONTAINER_PATH, projectName, removeVolumeMount, volumeName } from "../../core/compose";
import { bytes } from "../../core/facts";
import { cronMark, lockSite, requireSite, siteDir } from "../../core/remote";
import { bsdtarFlags, journal, runScript, shq, sshPipe, writeFileCmd } from "../../core/ssh";
import { HELPER, PRELUDE } from "../../core/templates";
import { ago, c, confirm, fail, info, interactive, ok, step, table, warn } from "../../core/term";
import { seedFolders, type Entry } from "../../core/ignore";
import { detectProject } from "../../core/projects";
import { onStop } from "../../core/job";
import { backupName, backupsOf, backupTo, pickVolume, pruneBefore, tarIn, tarOut, volumes, whileStopped, type Volume } from "../../core/volumes";
import { target } from "./sites";

/**
 * Site and the arguments after it. The site name is optional inside a project folder: then a first argument
 * that names one of the project's volumes (or backups) is the volume. More than `max` arguments: the first is the site.
 */
async function locate(pos: string[], max: number, server?: string) {
  const project = loadProject(process.cwd())?.name;
  const rest = [...pos];
  let n = rest.length > max || !project ? rest.shift() : undefined;
  if (!n && project && rest.length) {
    const t = target(undefined, server);
    const found = await volumes(t.server, t.site);
    const own = found.volumes.some((v) => v.key === rest[0] || v.name === rest[0]) || found.backups.some((b) => b.file === rest[0]);
    if (own) return { ...t, rest, found };
    n = rest.shift();
  }
  const t = target(n, server);
  return { ...t, rest, found: await volumes(t.server, t.site) };
}

const runs = (line: string) => info(c.dim(`runs: ${line}`));

export const volumeList = defineCommand({
  name: "volumes",
  args: "[name]",
  summary: `List a site's Docker volumes: size, the services that mount them, their backups.`,
  options: { server: serverOpt, json: { type: "boolean", desc: "machine-readable output" } },
  async run([n], o) {
    const { site, server } = target(n, o.server);
    const { volumes: vols, backups, schedule } = await volumes(server, site, true);
    if (o.json) return console.log(JSON.stringify({ volumes: vols, backups, schedule }, null, 2));
    if (!vols.length) return info(`${site} has no volumes`);
    table([
      ["VOLUME", "SIZE", "MOUNTED BY", "BACKUPS"].map((h) => c.dim(h)),
      ...vols.map((v) => {
        const own = backupsOf(backups, v.key);
        return [
          c.bold(v.key) + (v.key !== v.name ? c.dim(` (${v.name})`) : ""),
          v.size === undefined ? "-" : bytes(v.size),
          v.mounts.map((m) => `${m.service}:${m.path}`).join(", ") || c.dim("unused"),
          own.length ? `${own.length}, newest ${ago(own[0].time)}` : c.dim("none"),
        ];
      }),
    ]);
    // Deployed before sites kept them in their folder: the next deploy moves them there.
    const inDocker = vols.filter((v) => !v.dir).map((v) => v.key);
    if (vols.length > inDocker.length) console.log(c.dim(`\nfiles in ${siteDir(site)}/volumes/<volume>`));
    if (inDocker.length) console.log(c.dim(`${vols.length > inDocker.length ? "" : "\n"}in Docker's own storage: ${inDocker.join(", ")}`));
    console.log(c.dim(`\nscheduled backups: ${schedule ?? "none (lf volume backup --schedule daily)"}`));
    if (backups.length) {
      console.log(`\n${c.dim(`backups in ${siteDir(site)}/backups:`)}`);
      table(backups.map((b) => [b.file, bytes(b.size), c.dim(ago(b.time))]));
    }
  },
});

const KEEP_BACKUPS = 7;

export const volumeBackup = defineCommand({
  name: "volume backup",
  args: "[name] [volume]",
  summary: `Save a volume (default: all of the site's) as a .tar.gz in /opt/landfall/sites/<name>/backups.
The services keep running: for a database, prefer its own dump tool.

  lf volume backup blog --schedule daily --keep 14   every night, the newest 14 of each volume kept
  lf volume backup blog --schedule off

A schedule is a line in the login user's crontab running backups/backup.sh, a plain
script that also runs by hand (sh backup.sh).`,
  options: {
    server: serverOpt,
    schedule: { type: "string", desc: "hourly, daily, weekly, or off: back up every volume on a timer" },
    keep: { type: "string", desc: `scheduled backups kept per volume (default ${KEEP_BACKUPS})` },
  },
  async run(pos, o) {
    const { site, server, rest, found } = await locate(pos, 1, o.server);
    if (o.schedule !== undefined) {
      if (rest[0]) fail("--schedule backs up every volume of the site: leave out the volume");
      return scheduleBackups(server, site, o.schedule, checkInt(o.keep ?? KEEP_BACKUPS, "--keep", 1, 1000));
    }
    if (o.keep !== undefined) fail("--keep goes with --schedule");
    const vols = rest[0] ? [pickVolume(found.volumes, rest[0], site)] : found.volumes;
    if (!vols.length) fail(`${site} has no volumes`);
    for (const v of vols) {
      const file = `backups/${backupName(v.key)}`;
      step(`backup ${v.key} of ${site}`);
      runs(`${tarOut(v.name)} > ${file}`);
      await runScript(server, `cd ${shq(siteDir(site))} && mkdir -p backups\n${backupTo(v.name, shq(file))}`);
      ok(`${siteDir(site)}/${file}`);
    }
  },
});

const EVERY: Record<string, (m: number) => string> = { hourly: (m) => `${m} * * * *`, daily: (m) => `${m} 3 * * *`, weekly: (m) => `${m} 3 * * 0` };

/**
 * The script a schedule runs: every volume of the Compose project into a .tar.gz next to it, then all but the
 * newest `keep` of each volume's timestamped backups (not those like `-before-push`) deleted. Plain sh.
 */
export const backupScript = (project: string, keep: number) => `#!/bin/sh
# Written by landfall (lf volume backup --schedule). Runs without it too: sh backup.sh
# Saves every volume of the Compose project ${project} here, keeping the newest ${keep} of each.
PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
cd "$(dirname "$0")" || exit 1
# Its log stays small: past 1 MB it moves to backup.log.1, replacing the one before.
[ "$(wc -c <backup.log 2>/dev/null || echo 0)" -lt 1048576 ] || mv -f backup.log backup.log.1
keep=${keep}
rc=0
for v in $(docker volume ls -q --filter label=com.docker.compose.project=${project}); do
  key=$(docker volume inspect -f '{{index .Labels "com.docker.compose.volume"}}' "$v"); [ -n "$key" ] || key=$v
  f="$key-$(date -u +%Y%m%d-%H%M%S).tar.gz"
  if docker run --rm -v "$v:/v:ro" ${HELPER} tar czf - -C /v . >"$f.part"; then mv "$f.part" "$f"; else rm -f "$f.part"; echo "$(date -u) backup of $v failed" >&2; rc=1; continue; fi
  n=0
  for old in $(ls -1r 2>/dev/null | grep -F "$key-"); do
    case "$old" in "$key"-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9].tar.gz) ;; *) continue ;; esac
    n=$((n + 1)); [ "$n" -le "$keep" ] || rm -f -- "$old"
  done
done
exit $rc
`;

/** Shell: the crontab without the site's line, in $c. */
const cronWithout = (site: string) => `c=$(crontab -l 2>/dev/null | grep -vF ${shq(cronMark(site))} || true)`;
/** Shell: install $c plus `line` (none: just $c) as the crontab. */
const cronSet = (line: string) => `printf '%s\\n%s\\n' "$c" ${line} | sed '/^$/d' | crontab -`;

export async function scheduleBackups(server: Server, site: string, every: string, keep: number) {
  if (every !== "off" && !EVERY[every]) fail(`--schedule takes hourly, daily, weekly or off, not ${every}`);
  const { meta } = await requireSite(server, site);
  const dir = `${siteDir(site)}/backups`;
  const mark = cronMark(site);
  // A minute of its own per site: not every server's backups at 03:00 sharp.
  const minute = [...site].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 60, 7);
  const [head, tail] = cronSet("@").split(" @ ");
  const line = every === "off" ? "" : `${EVERY[every](minute)} sh ${dir}/backup.sh >>${dir}/backup.log 2>&1 ${mark} ${every}, keep ${keep}`;
  const { stdout } = await runScript(
    server,
    [
      PRELUDE,
      `command -v crontab >/dev/null || { echo "the server has no cron: install it (cron, cronie or busybox crond) to schedule backups" >&2; exit 1; }`,
      // busybox crontab (Alpine) gives a user other than root a crontab only when setuid.
      `[ "$(id -u)" = 0 ] || [ "$(pkg_mgr)" != apk ] || pkg_has busybox-suid || pkg_install busybox-suid || true`,
      `old=$(crontab -l 2>/dev/null | grep -F ${shq(mark)} || true)`,
      ...(line ? [`mkdir -p ${shq(dir)}`, writeFileCmd(`${dir}/backup.sh`, backupScript(projectName(meta), keep), "755")] : []),
      cronWithout(site),
      `${cronSet(line ? shq(line) : '""')} || { echo "could not change the crontab of $(id -un): a server without setuid crontab (Alpine: apk add busybox-suid) lets only root have one" >&2; exit 1; }`,
      // Undo puts back the line that was there (or none); backup.sh stays, it does nothing on its own.
      `record ${shq(line ? `schedule backups of ${site} ${every}, keep ${keep}` : `stop scheduled backups of ${site}`)} ${shq(`${cronWithout(site)}; ${head} `)}"$(printf %q "$old")"${shq(` ${tail}`)}`,
      `[ -z ${shq(line)} ] || pidof crond >/dev/null || pidof cron >/dev/null || echo nocron`,
    ].join("\n"),
    { capture: true },
  );
  if (!line) return ok(`no scheduled backups of ${site}`);
  ok(`${site}'s volumes are backed up ${every}, the newest ${keep} of each kept in ${dir}`);
  info(c.dim(`runs: ${dir}/backup.sh from the crontab of ${server.user ?? "the login user"} (log: ${dir}/backup.log)`));
  if (stdout.includes("nocron")) warn("cron is not running on the server: start it (Alpine: rc-service crond start), or nothing runs");
}

export const volumePull = defineCommand({
  name: "volume pull",
  args: "[name] [volume]",
  summary: `Download a volume as a .tar.gz, or unpack it into a folder (--into).
Reads the live volume (read-only, the services keep running), or one of its backups (--backup).`,
  options: {
    server: serverOpt,
    into: { type: "string", desc: "unpack into this folder instead of saving the archive" },
    output: { type: "string", short: "o", desc: "archive file (default: <name>-<volume>-<time>.tar.gz here)" },
    backup: { type: "string", short: "b", desc: "a backup's file name (see `lf volumes`); latest = the newest" },
  },
  async run(pos, o) {
    const { site, server, rest, found } = await locate(pos, 1, o.server);
    const v = pickVolume(found.volumes, rest[0], site);
    let remote = tarOut(v.name);
    if (o.backup) {
      const own = backupsOf(found.backups, v.key);
      const b = o.backup === "latest" ? own[0] : found.backups.find((x) => x.file === o.backup || x.file === `${o.backup}.tar.gz`);
      if (!b) fail(o.backup === "latest" ? `${v.key} of ${site} has no backups` : `no backup ${o.backup} (lf volumes ${site})`);
      remote = `cat ${shq(`${siteDir(site)}/backups/${b!.file}`)}`;
    }
    runs(remote);
    if (o.into) {
      const into = expandHome(o.into);
      fs.mkdirSync(into, { recursive: true });
      await sshPipe(server, remote, ["tar", "-xzf", "-", "-C", resolve(into)], "down");
      return ok(`${v.key} of ${site} unpacked into ${o.into}`);
    }
    const file = expandHome(o.output ?? `${site}-${backupName(v.key)}`);
    if (fs.existsSync(file) && !(await confirm(`${file} exists. Overwrite it?`, false))) fail(`${file} exists: pick another file with -o`);
    // Under another name until it is whole: a cut-off download must not pass for a backup.
    const part = `${file}.part`;
    const off = onStop(async () => fs.rmSync(part, { force: true }));
    try {
      await sshPipe(server, remote, { file: part }, "down");
      fs.renameSync(part, file);
    } finally {
      off();
      fs.rmSync(part, { force: true });
    }
    ok(`${v.key} of ${site} saved to ${file} (${bytes(fs.statSync(file).size)})`);
  },
});

/** Shared by push and restore: back up, journal the way back, then replace. */
async function replace(server: Server, site: string, v: Volume, source: string, o: { own: boolean; verb: string; what: string }) {
  const { own, what } = o;
  const dir = siteDir(site);
  const before = `${dir}/backups/${backupName(v.key, new Date(), `before-${o.verb}`)}`;
  // `lf sites rm --volumes` takes the volume and the backup: skip, as `docker run -v` would create an empty volume.
  const gone = shq(`${v.name} was removed since, nothing to put back`);
  const undo = `if [ -f ${shq(before)} ] && docker volume inspect ${shq(v.name)} >/dev/null 2>&1; then\n${whileStopped(v.name, [`${tarIn(v.name)} < ${shq(before)}`])}\nelse log ${gone}; fi`;
  runs(`${tarIn(v.name, own)} < ${source}`);
  await runScript(
    server,
    `${PRELUDE}
cd ${shq(dir)} && mkdir -p backups
${whileStopped(v.name, [
  `${tarOut(v.name)} > ${shq(before)}`,
  `record ${shq(`${what} (backup ${basename(before)})`)} ${shq(undo)}`,
  `${tarIn(v.name, own)} < ${shq(source)}`,
])}
${pruneBefore(v.key)}`,
  );
  info(c.dim(`previous contents: ${before} (lf undo puts them back)`));
}

function stops(v: Volume) {
  const svcs = [...new Set(v.mounts.map((m) => m.service))];
  return svcs.length ? ` ${svcs.join(", ")} stop${svcs.length === 1 ? "s" : ""} meanwhile.` : "";
}

export const volumePush = defineCommand({
  name: "volume push",
  args: "[name] <volume> <folder|file.tar.gz>",
  summary: `Replace a volume's contents with a local folder or .tar.gz.
Backs the volume up first and journals it (lf undo restores it). The services using it stop meanwhile.
Files get the owner of the volume's root folder.`,
  options: { server: serverOpt },
  async run(pos, o) {
    if (pos.length < 2) fail("lf volume push [name] <volume> <folder|file.tar.gz>");
    // ~ too: the UI passes the path as typed, with no shell to expand it.
    const src = expandHome(pos.at(-1)!);
    const { site, server, rest, found } = await locate(pos.slice(0, -1), 1, o.server);
    if (!rest[0]) fail("which volume? lf volume push [name] <volume> <folder|file.tar.gz>");
    const v = pickVolume(found.volumes, rest[0], site);
    if (!fs.existsSync(src)) fail(`not found: ${src}`);
    const folder = fs.statSync(src).isDirectory();
    if (!folder && !/\.(tar\.gz|tgz)$/.test(src)) fail(`${src}: pass a folder or a .tar.gz`);
    if (!(await confirm(`Replace the contents of ${v.key} of ${site} with ${src}?${stops(v)}`, false))) fail("cancelled");
    await pushVolume(server, site, v, src, folder);
  },
});

/** Upload a folder or .tar.gz and replace the volume's contents with it (backed up first, lf undo). */
async function pushVolume(server: Server, site: string, v: Volume, src: string, folder: boolean) {
  const upload = `${siteDir(site)}/backups/.upload-${journal.run}.tar.gz`;
  step(`upload ${src}`);
  await runScript(server, `mkdir -p ${shq(`${siteDir(site)}/backups`)}`);
  const local = folder ? ["tar", ...(await bsdtarFlags()), "-czf", "-", "-C", src, "."] : { file: src };
  const drop = () => runScript(server, `rm -f ${shq(upload)}`);
  const off = onStop(drop);
  try {
    await sshPipe(server, `cat > ${shq(upload)}`, local, "up");
    step(`replace ${v.key} of ${site}`);
    await replace(server, site, v, upload, { own: true, verb: "push", what: `push ${v.key} of ${site}` });
  } finally {
    off();
    await drop().catch(() => warn(`could not remove ${upload} on the server: delete it by hand`));
  }
  ok(`${v.key} of ${site} replaced with ${src}`);
}

/** After a deploy: fill each empty volume from its local folder (fill: without asking), else say how. */
export async function offerSeed(server: Server, site: string, dir: string, uploaded: Entry[], fill = false) {
  const folders = seedFolders(dir, uploaded);
  if (!folders.length) return;
  const found = await volumes(server, site, false, true);
  for (const v of found.volumes.filter((x) => x.empty && folders.includes(x.key))) {
    const src = `./${relative(process.cwd(), join(dir, v.key)).split(sep).join("/")}`;
    const cmd = `lf volume push ${site} ${v.key} ${src}`;
    if (fill || (interactive() && (await confirm(`Volume ${v.key} is empty, and ${src} is left out of the upload. Fill the volume with it?${stops(v)}`, true)))) await pushVolume(server, site, v, src, true);
    else info(`volume ${v.key} is empty; ${src} was not uploaded: fill it with ${c.cyan(cmd)}, or deploy with --fill-volumes`);
  }
}

export const volumeRestore = defineCommand({
  name: "volume restore",
  args: "[name] [volume] [backup]",
  summary: `Replace a volume's contents with one of its backups (default: the newest).
Backs the current contents up first and journals it (lf undo reverts the restore).`,
  options: { server: serverOpt },
  async run(pos, o) {
    const { site, server, rest, found } = await locate(pos, 2, o.server);
    // `lf volume restore blog content-2026….tar.gz`: a backup's name says its volume.
    const byFile = rest.length === 1 ? found.backups.find((b) => b.file === rest[0]) : undefined;
    const of = byFile && found.volumes.find((x) => backupsOf([byFile], x.key).length);
    if (byFile && !of) fail(`${byFile.file} belongs to none of the volumes of ${site}`);
    const v = of || pickVolume(found.volumes, rest[0], site);
    const own = backupsOf(found.backups, v.key);
    const name = byFile?.file ?? rest[1];
    const b = name ? own.find((x) => x.file === name || x.file === `${name}.tar.gz`) : own[0];
    if (!b) fail(name ? `${v.key} of ${site} has no backup ${name} (lf volumes ${site})` : `${v.key} of ${site} has no backups`);
    if (!(await confirm(`Replace the contents of ${v.key} of ${site} with ${b!.file} (${ago(b!.time)})?${stops(v)}`, false))) fail("cancelled");
    step(`restore ${v.key} of ${site} from ${b!.file}`);
    await replace(server, site, v, `${siteDir(site)}/backups/${b!.file}`, { own: false, verb: "restore", what: `restore ${v.key} of ${site} from ${b!.file}` });
    ok(`${v.key} of ${site} restored from ${b!.file}`);
  },
});

/** The project in this folder, which `lf volume add/rm` edit (none without a .landfall.json): it must deploy `site`, if one is named. */
function here(site: string | undefined) {
  const cwd = process.cwd();
  if (!loadProject(cwd)) return undefined;
  const d = detectProject(cwd);
  if (site && site !== d.name) fail(`this folder deploys ${d.name}, not ${site}: run it in the folder that deploys ${site}`);
  return d;
}

const redeployHint = (more = "") => info(`redeploy to apply it: ${c.cyan("lf deploy")}${more}`);

export const volumeAdd = defineCommand({
  name: "volume add",
  args: "[name] [service:]<path>",
  summary: `Keep a folder of a container across deploys and rollbacks, in a named volume.
Writes it into this folder's project: compose.yaml gets the mount and the volume (plain Compose),
an app, Dockerfile or image keeps the path in .landfall.json. Redeploy to apply.

  lf volume add /app/data                          the app's /app/data, as volume app-data
  lf volume add web:/data/content --as content     a service of compose.yaml`,
  options: { as: { type: "string", desc: "compose.yaml: the volume's name (default: from the path, /app/data: app-data)" } },
  async run(pos, o) {
    if (!pos.length || pos.length > 2) fail("lf volume add [name] [service:]<path>");
    const d = here(pos.length > 1 ? pos[0] : undefined) ?? fail(`no ${PROJECT_FILE} here: run it in the folder that deploys the site (deploy it once first)`);
    const spec = pos.at(-1)!;
    const m = /^([\w.-]+):(.*)$/.exec(spec);
    const path = m ? m[2] : spec;
    if (!CONTAINER_PATH.test(path)) fail(`a volume goes on a folder in the container, like /app/data: not ${path}`);
    if (d.kind === "static") fail("a static site has no container to keep folders of: deploy an app, a Dockerfile or a compose.yaml");
    if (d.kind === "compose") {
      const services = d.analysis?.services.map((x) => x.name) ?? [];
      const service = m?.[1] ?? (services.length === 1 ? services[0] : fail(`which service? lf volume add <service>:${path} (${services.join(", ")})`));
      const file = join(d.path, d.compose!);
      const { compose, key } = addVolumeMount(fs.readFileSync(file, "utf8"), service, path, o.as);
      fs.writeFileSync(file, compose);
      ok(`${d.compose}: ${service} keeps ${path} in volume ${key}`);
      return redeployHint();
    }
    if (m && m[1] !== "app") fail(`an app has one service, app: lf volume add ${path}`);
    if (o.as && o.as !== volumeName(path)) fail(`an app's volume is named after its path (${volumeName(path)}): --as is for compose.yaml`);
    const have = d.volumes ?? [];
    if (have.some((v) => volumeName(v) === volumeName(path))) fail(`the app already keeps ${path} (volume ${volumeName(path)})`);
    saveProject(d.path, { ...d.project!, volumes: [...have, path] });
    ok(`${PROJECT_FILE}: the app keeps ${path} in volume ${volumeName(path)}`);
    redeployHint();
  },
});

export const volumeRemove = defineCommand({
  name: "volume rm",
  args: "[name] <volume>",
  summary: `Stop keeping a volume: take its mounts out of this folder's compose.yaml (or .landfall.json).
Its data stays on the server, listed as unused, until --data deletes it. --data needs a volume no
container uses (redeploy first), backs it up to the site's backups folder and journals it: lf undo
brings it back.

  lf volume rm content            unmount it; lf deploy applies that
  lf volume rm content --data     then delete the data on the server`,
  options: { server: serverOpt, data: { type: "boolean", desc: "also delete the volume on the server (backed up first)" }, service: { type: "string", desc: "compose.yaml: only unmount it from this service" } },
  async run(pos, o) {
    if (!pos.length || pos.length > 2) fail("lf volume rm [name] <volume>");
    const key = pos.at(-1)!;
    const site = pos.length > 1 ? pos[0] : undefined;
    // --data alone works anywhere: a folder that deploys another site only skips the unmount.
    const d = o.data ? here(undefined) : here(site);
    const edited = !!d && (!site || site === d.name) && unmount(d, key, o.service);
    if (!edited && !o.data) fail(d ? `this folder's project does not mount ${key}` : `no ${PROJECT_FILE} here: run it in the folder that deploys the site, or pass --data to delete an unused volume's data`);
    if (!o.data) return redeployHint(c.dim(`; the data stays on the server (lf volume rm ${key} --data deletes it)`));
    if (o.service) fail("--data deletes the whole volume: leave out --service");
    const t = target(site, o.server);
    const found = await volumes(t.server, t.site);
    const v = pickVolume(found.volumes, key, t.site);
    const users = [...new Set(v.mounts.map((x) => x.service))];
    if (users.length) {
      const why = `${v.key} is still used by ${users.join(", ")} on the server`;
      if (edited) return redeployHint(`, then delete its data: ${c.cyan(`lf volume rm ${key} --data`)} (${why})`);
      fail(`${why}: remove it from the compose file and redeploy first`);
    }
    if (!(await confirm(`Delete volume ${v.key} of ${t.site} and its data? A backup is kept, lf undo brings it back.`, false))) fail("cancelled");
    await deleteVolume(t.server, t.site, v, found.project);
  },
});

/** Take the volume `key` out of the project's config; false when it has none. */
function unmount(d: ReturnType<typeof detectProject>, key: string, service?: string): boolean {
  if (d.kind === "compose") {
    const file = join(d.path, d.compose!);
    const { compose, from } = removeVolumeMount(fs.readFileSync(file, "utf8"), key, service);
    if (!from.length) return false;
    fs.writeFileSync(file, compose);
    ok(`${d.compose}: ${from.join(", ")} no longer mount${from.length === 1 ? "s" : ""} ${key}`);
    return true;
  }
  const have = d.volumes ?? [];
  const gone = have.filter((p) => volumeName(p) === key);
  if (!gone.length) return false;
  if (service && service !== "app") fail(`an app has one service, app: leave out --service`);
  saveProject(d.path, { ...d.project!, volumes: have.filter((p) => !gone.includes(p)) });
  ok(`${PROJECT_FILE}: the app no longer keeps ${gone.join(", ")}`);
  return true;
}

/** Back a volume up, journal how to bring it back (with its Compose labels, so compose up adopts it), then delete it. */
async function deleteVolume(server: Server, site: string, v: Volume, project: string) {
  const dir = siteDir(site);
  const file = `${dir}/backups/${backupName(v.key, new Date(), "before-rm")}`;
  const labels = [`com.docker.compose.project=${project}`, `com.docker.compose.volume=${v.key}`].map((l) => `--label ${shq(l)}`).join(" ");
  const undo = `if [ -f ${shq(file)} ]; then docker volume create ${labels} ${shq(v.name)} >/dev/null && ${tarIn(v.name)} < ${shq(file)}; else log ${shq(`${file} is gone, nothing to put back`)}; fi`;
  step(`delete ${v.key} of ${site}`);
  runs(`${tarOut(v.name)} > ${file}; docker volume rm ${v.name}${v.dir ? `; rm -rf ${v.dir}` : ""}`);
  // Under the deploy lock: site.json is rewritten below, and a deploy in between would be lost.
  const lock = await lockSite(server, site);
  try {
    // In the site's folder: its files go too, and site.json stops binding it (undo puts it back in Docker's; a deploy moves it in again).
    const { meta } = v.dir ? await requireSite(server, site) : { meta: undefined };
    const rest = meta?.volumes?.filter((k) => k !== v.key);
    await runScript(
      server,
      `${PRELUDE}
cd ${shq(dir)} && mkdir -p backups
${backupTo(v.name, shq(file))}
# Journaled once backed up: a step below that fails still leaves lf undo a way back.
record ${shq(`delete volume ${v.key} of ${site} (backup ${basename(file)})`)} ${shq(undo)}
docker volume rm ${shq(v.name)} >/dev/null
${v.dir ? `docker run --rm -v ${shq(`${v.dir}:/v`)} ${HELPER} find /v -mindepth 1 -delete && rmdir ${shq(v.dir)}` : ""}
${meta && rest ? writeFileCmd("site.json", JSON.stringify({ ...meta, volumes: rest.length ? rest : undefined }, null, 2) + "\n") : ""}`,
    );
  } finally {
    await lock.unlock();
  }
  ok(`${v.key} of ${site} deleted`);
  info(c.dim(`its contents: ${file} (lf undo puts them back)`));
}
