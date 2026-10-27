import fs from "node:fs";
import { basename, resolve } from "node:path";
import { defineCommand, serverOpt } from "../cmd";
import { loadProject, type Server } from "../config";
import { projectName } from "../compose";
import { bytes } from "../facts";
import { requireSite, siteDir } from "../remote";
import { bsdtarFlags, journal, runScript, shq, sshPipe } from "../ssh";
import { PRELUDE } from "../templates";
import { ago, c, confirm, fail, info, ok, step, table } from "../ui";
import { target } from "./sites";

/** Any image with sh, tar, find and chown does; landfall needs nothing of its own on the server. */
export const HELPER = "alpine:3";

export interface Volume {
  /** Docker's name: <project>_<key>. */
  name: string;
  /** The name in compose.yaml (the Compose label), else Docker's name. */
  key: string;
  size?: number;
  mounts: { service: string; path: string }[];
}

export interface Backup {
  file: string;
  size: number;
  time: string;
}

/** Parses listScript's output: `vol`, `mnt`, `size` and `bak` lines. */
export function parseVolumes(out: string): { volumes: Volume[]; backups: Backup[] } {
  const vols = new Map<string, Volume>();
  const vol = (name: string) => vols.get(name) ?? vols.set(name, { name, key: name, mounts: [] }).get(name)!;
  const backups: Backup[] = [];
  for (const line of out.split("\n")) {
    const [kind, a, b, d] = line.split("\t");
    if (kind === "vol" && a) vol(a).key = b || a;
    else if (kind === "mnt" && a) {
      const v = vol(a);
      if (!v.mounts.some((m) => m.service === b && m.path === d)) v.mounts.push({ service: b, path: d });
    } else if (kind === "size" && vols.has(a)) vol(a).size = Number(b);
    else if (kind === "bak" && a) backups.push({ file: a, size: Number(b), time: new Date(Number(d) * 1000).toISOString() });
  }
  return { volumes: [...vols.values()].sort((x, y) => x.key.localeCompare(y.key)), backups: backups.sort((x, y) => y.time.localeCompare(x.time)) };
}

/** Volumes of a Compose project, what mounts them, their sizes and the site's backups. */
export const listScript = (project: string, dir: string) => String.raw`
cd ${shq(dir)}
vols=""
for v in $(docker volume ls -q --filter label=com.docker.compose.project=${shq(project)}); do
  printf 'vol\t%s\t%s\n' "$v" "$(docker volume inspect -f '{{index .Labels "com.docker.compose.volume"}}' "$v")"
  vols="$vols $v"
done
for ctr in $(docker ps -aq --filter label=com.docker.compose.project=${shq(project)}); do
  m=$(docker inspect -f '{{$s := index .Config.Labels "com.docker.compose.service"}}{{range .Mounts}}{{if eq .Type "volume"}}mnt{{"\t"}}{{.Name}}{{"\t"}}{{$s}}{{"\t"}}{{.Destination}}{{"\n"}}{{end}}{{end}}' "$ctr")
  [ -z "$m" ] || { printf '%s\n' "$m"; vols="$vols $(printf '%s\n' "$m" | cut -f2)"; }
done
vols=$(printf '%s\n' $vols | sort -u | tr '\n' ' ')
if [ "$SIZES" = 1 ] && [ -n "$(printf %s "$vols" | tr -d ' ')" ]; then
  args=""; for v in $vols; do args="$args -v $v:/v/$v:ro"; done
  docker run --rm -q $args ${HELPER} sh -c 'cd /v && du -sk *' 2>/dev/null | awk '{ printf "size\t%s\t%d\n", $2, $1 * 1024 }' || true
fi
# Not find -printf: busybox (Alpine servers) lacks it.
for f in backups/*.tar.gz; do
  [ ! -f "$f" ] || printf 'bak\t%s\t%s\t%s\n' "$(basename "$f")" "$(stat -c %s "$f")" "$(stat -c %Y "$f")"
done
`;

/** `blog_content` from `content`, or the full name. */
export function pickVolume(vols: Volume[], name: string | undefined, site: string): Volume {
  if (!vols.length) fail(`${site} has no volumes`);
  if (!name) {
    if (vols.length === 1) return vols[0];
    fail(`which volume of ${site}? ${vols.map((v) => v.key).join(", ")}`);
  }
  const v = vols.find((x) => x.key === name) ?? vols.find((x) => x.name === name);
  if (!v) fail(`${site} has no volume ${name} (${vols.map((x) => x.key).join(", ")})`);
  return v!;
}

const STAMP = /^\d{8}-\d{6}/;
/** `content-20261027-181500.tar.gz`; why = before-push etc. */
export const backupName = (key: string, now = new Date(), why = "") =>
  `${key}-${now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}${why ? `-${why}` : ""}.tar.gz`;
/** A volume's backups, newest first. */
export const backupsOf = (backups: Backup[], key: string) =>
  backups.filter((b) => b.file.startsWith(`${key}-`) && STAMP.test(b.file.slice(key.length + 1)));

/** `docker run` that writes the volume's contents as tar.gz to stdout. Read-only: it never changes the volume. */
export const tarOut = (vol: string) => `docker run --rm -v ${vol}:/v:ro ${HELPER} tar czf - -C /v .`;

/**
 * `docker run` that replaces the volume's contents with the tar.gz on stdin. own: give the files to the
 * owner of the volume's root (an upload from this machine carries your uid; a backup keeps its owners).
 */
export const tarIn = (vol: string, own = false) =>
  `docker run --rm -i -v ${vol}:/v ${HELPER} sh -c ${shq(`${own ? "o=$(stat -c %u:%g /v) && " : ""}find /v -mindepth 1 -delete && tar xzf - -C /v${own ? " && chown -R $o /v" : ""}`)}`;

/**
 * Shell that stops the containers using `vol`, runs `steps` (joined with &&: one failing skips the rest) and
 * starts those containers again, also when a step failed. Self-contained: `lf undo` runs it as it is.
 */
export function whileStopped(vol: string, steps: string[]) {
  return [
    `ids=$(docker ps -q --filter volume=${vol})`,
    `[ -z "$ids" ] || docker stop $ids >/dev/null`,
    `if ${steps.join(" && ")}; then rc=0; else rc=1; fi`,
    `[ -z "$ids" ] || docker start $ids >/dev/null`,
    `[ "$rc" = 0 ]`,
  ].join("\n");
}

export async function volumes(server: Server, site: string, sizes = false) {
  const { meta } = await requireSite(server, site);
  const { stdout } = await runScript(server, listScript(projectName(meta), siteDir(site)), { capture: true, env: { SIZES: sizes } });
  return parseVolumes(stdout);
}

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
    const { volumes: vols, backups } = await volumes(server, site, true);
    if (o.json) return console.log(JSON.stringify({ volumes: vols, backups }, null, 2));
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
    if (backups.length) {
      console.log(`\n${c.dim(`backups in ${siteDir(site)}/backups:`)}`);
      table(backups.map((b) => [b.file, bytes(b.size), c.dim(ago(b.time))]));
    }
  },
});

export const volumeBackup = defineCommand({
  name: "volume backup",
  args: "[name] [volume]",
  summary: `Save a volume (default: all of the site's) as a .tar.gz in /opt/landfall/sites/<name>/backups.
The services keep running: for a database, prefer its own dump tool.`,
  options: { server: serverOpt },
  async run(pos, o) {
    const { site, server, rest, found } = await locate(pos, 1, o.server);
    const vols = rest[0] ? [pickVolume(found.volumes, rest[0], site)] : found.volumes;
    if (!vols.length) fail(`${site} has no volumes`);
    for (const v of vols) {
      const file = `backups/${backupName(v.key)}`;
      step(`backup ${v.key} of ${site}`);
      runs(`${tarOut(v.name)} > ${file}`);
      await runScript(server, `cd ${shq(siteDir(site))} && mkdir -p backups\n${tarOut(v.name)} > ${file}.part || { rm -f ${file}.part; exit 1; }\nmv ${file}.part ${file}`);
      ok(`${siteDir(site)}/${file}`);
    }
  },
});

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
      fs.mkdirSync(o.into, { recursive: true });
      await sshPipe(server, remote, ["tar", "-xzf", "-", "-C", resolve(o.into)], "down");
      return ok(`${v.key} of ${site} unpacked into ${o.into}`);
    }
    const file = o.output ?? `${site}-${backupName(v.key)}`;
    if (fs.existsSync(file) && !(await confirm(`${file} exists. Overwrite it?`, false))) fail(`${file} exists: pick another file with -o`);
    await sshPipe(server, remote, { file }, "down");
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
  const undo = `if [ -f ${shq(before)} ] && docker volume inspect ${v.name} >/dev/null 2>&1; then\n${whileStopped(v.name, [`${tarIn(v.name)} < ${shq(before)}`])}\nelse log ${gone}; fi`;
  runs(`${tarIn(v.name, own)} < ${source}`);
  await runScript(
    server,
    `${PRELUDE}
cd ${shq(dir)} && mkdir -p backups
${whileStopped(v.name, [
  `${tarOut(v.name)} > ${shq(before)}`,
  `record ${shq(`${what} (backup ${basename(before)})`)} ${shq(undo)}`,
  `${tarIn(v.name, own)} < ${shq(source)}`,
])}`,
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
    const src = pos.at(-1)!;
    const { site, server, rest, found } = await locate(pos.slice(0, -1), 1, o.server);
    if (!rest[0]) fail("which volume? lf volume push [name] <volume> <folder|file.tar.gz>");
    const v = pickVolume(found.volumes, rest[0], site);
    if (!fs.existsSync(src)) fail(`not found: ${src}`);
    const folder = fs.statSync(src).isDirectory();
    if (!folder && !/\.(tar\.gz|tgz)$/.test(src)) fail(`${src}: pass a folder or a .tar.gz`);
    if (!(await confirm(`Replace the contents of ${v.key} of ${site} with ${src}?${stops(v)}`, false))) fail("cancelled");
    const upload = `${siteDir(site)}/backups/.upload-${journal.run}.tar.gz`;
    step(`upload ${src}`);
    await runScript(server, `mkdir -p ${shq(`${siteDir(site)}/backups`)}`);
    const local = folder ? ["tar", ...(await bsdtarFlags()), "-czf", "-", "-C", src, "."] : { file: src };
    try {
      await sshPipe(server, `cat > ${shq(upload)}`, local, "up");
      step(`replace ${v.key} of ${site}`);
      await replace(server, site, v, upload, { own: true, verb: "push", what: `push ${v.key} of ${site}` });
    } finally {
      await runScript(server, `rm -f ${shq(upload)}`).catch(() => {});
    }
    ok(`${v.key} of ${site} replaced with ${src}`);
  },
});

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
