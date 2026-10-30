import { type Server } from "./config";
import { projectName } from "./compose";
import { cronMark, requireSite, siteDir } from "./remote";
import { runScript, shq } from "./ssh";
import { HELPER } from "./templates";
import { fail } from "./term";

export { HELPER };


export interface Volume {
  /** Docker's name: <project>_<key>. */
  name: string;
  /** The name in compose.yaml (the Compose label), else Docker's name. */
  key: string;
  size?: number;
  /** Holds no files: new, or never filled (read with sizes or empty). */
  empty?: boolean;
  mounts: { service: string; path: string }[];
  /** The folder on the server that holds its files, when it lives in the site's folder (volumes/<key>). */
  dir?: string;
}

export interface Backup {
  file: string;
  size: number;
  time: string;
}

/** The last scheduled run, from backup.log: when, and the volumes that failed (none: it went fine). */
export interface LastRun {
  time: string;
  failed: string[];
}

/** Parses listScript's output: `vol`, `mnt`, `size`, `empty`, `bak`, `sched` and `last` lines. */
export function parseVolumes(out: string): { volumes: Volume[]; backups: Backup[]; schedule?: string; lastRun?: LastRun } {
  const vols = new Map<string, Volume>();
  const vol = (name: string) => vols.get(name) ?? vols.set(name, { name, key: name, mounts: [] }).get(name)!;
  const backups: Backup[] = [];
  let schedule: string | undefined;
  let lastRun: LastRun | undefined;
  for (const line of out.split("\n")) {
    const [kind, a, b, d] = line.split("\t");
    if (kind === "vol" && a) {
      vol(a).key = b || a;
      if (d) vol(a).dir = d;
    }
    else if (kind === "mnt" && a) {
      const v = vol(a);
      if (!v.mounts.some((m) => m.service === b && m.path === d)) v.mounts.push({ service: b, path: d });
    } else if (kind === "size" && vols.has(a)) vol(a).size = Number(b);
    else if (kind === "empty" && vols.has(a)) vol(a).empty = true;
    else if (kind === "bak" && a) backups.push({ file: a, size: Number(b), time: new Date(Number(d) * 1000).toISOString() });
    else if (kind === "sched" && a) schedule = a;
    else if (kind === "last" && a) {
      const [, time, failed] = a.match(/^(\S+) (?:ok|failed:?(.*))$/) ?? [];
      if (time) lastRun = { time, failed: failed?.trim().split(/\s+/).filter(Boolean) ?? [] };
    }
  }
  return {
    volumes: [...vols.values()].sort((x, y) => x.key.localeCompare(y.key)),
    backups: backups.sort((x, y) => y.time.localeCompare(x.time)),
    ...(schedule && { schedule }),
    ...(lastRun && { lastRun }),
  };
}

/** Volumes of a Compose project, what mounts them, their sizes and the site's backups. */
export const listScript = (project: string, dir: string, site: string) => String.raw`
cd ${shq(dir)}
# One inspect for all volumes and one for all containers: each docker call is a round trip to the daemon.
vols=$(docker volume ls -q --filter label=com.docker.compose.project=${shq(project)})
[ -z "$vols" ] || docker volume inspect -f 'vol{{"\t"}}{{.Name}}{{"\t"}}{{index .Labels "com.docker.compose.volume"}}{{"\t"}}{{if .Options}}{{index .Options "device"}}{{end}}' $vols
ctrs=$(docker ps -aq --filter label=com.docker.compose.project=${shq(project)})
m=""; [ -z "$ctrs" ] || m=$(docker inspect -f '{{$s := index .Config.Labels "com.docker.compose.service"}}{{range .Mounts}}{{if eq .Type "volume"}}mnt{{"\t"}}{{.Name}}{{"\t"}}{{$s}}{{"\t"}}{{.Destination}}{{"\n"}}{{end}}{{end}}' $ctrs | sed '/^$/d')
[ -z "$m" ] || { printf '%s\n' "$m"; vols="$vols $(printf '%s\n' "$m" | cut -f2)"; }
vols=$(printf '%s\n' $vols | sort -u | tr '\n' ' ')
if { [ "$SIZES" = 1 ] || [ "$EMPTY" = 1 ]; } && [ -n "$(printf %s "$vols" | tr -d ' ')" ]; then
  args=""; for v in $vols; do args="$args -v $v:/v/$v:ro"; done
  docker run --rm -q -e SIZES="$SIZES" $args ${HELPER} sh -c 'cd /v && { [ "$SIZES" != 1 ] || du -sk *; } && for d in *; do [ -n "$(ls -A "$d")" ] || echo "empty $d"; done' 2>/dev/null |
    awk '$1 == "empty" { printf "empty\t%s\n", $2; next } { printf "size\t%s\t%d\n", $2, $1 * 1024 }' || true
fi
# Not find -printf: busybox (Alpine servers) lacks it.
for f in backups/*.tar.gz; do
  [ ! -f "$f" ] || printf 'bak\t%s\t%s\t%s\n' "$(basename "$f")" "$(stat -c %s "$f")" "$(stat -c %Y "$f")"
done
[ ! -f backups/backup.log ] || grep -E '^[0-9-]+T[0-9:]+Z (ok|failed)' backups/backup.log | tail -n 1 | sed 's/^/last\t/'
! command -v crontab >/dev/null || { crontab -l 2>/dev/null || true; } | awk -v m=${shq(cronMark(site) + " ")} 'i = index($0, m) { print "sched\t" substr($0, i + length(m)) }'
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
/** STAMP as a shell glob. */
export const STAMP_GLOB = "[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]";
/** Undo backups kept per volume: each push or restore makes one, and the oldest are past any useful undo. */
export const BEFORE_KEEP = 10;
/** Shell, run in the site's folder: all but the newest BEFORE_KEEP `<key>-<stamp>-before-*` backups of key go, said. */
export const pruneBefore = (key: string) => `k=${shq(key)}; n=0
for old in $(ls -1r backups 2>/dev/null); do
  case "$old" in "$k"-${STAMP_GLOB}-before-*.tar.gz) ;; *) continue ;; esac
  n=$((n + 1)); [ "$n" -le ${BEFORE_KEEP} ] || { rm -f -- "backups/$old" && log "removed the old undo backup $old (the newest ${BEFORE_KEEP} stay)"; }
done`;
/** `content-20261027-181500.tar.gz`; why = before-push etc. */
export const backupName = (key: string, now = new Date(), why = "") =>
  `${key}-${now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}${why ? `-${why}` : ""}.tar.gz`;
/** A volume's backups, newest first. */
export const backupsOf = (backups: Backup[], key: string) =>
  backups.filter((b) => b.file.startsWith(`${key}-`) && STAMP.test(b.file.slice(key.length + 1)));

/** `docker run` that writes the volume's contents as tar.gz to stdout. Read-only: it never changes the volume. */
export const tarOut = (vol: string) => `docker run --rm -v ${shq(`${vol}:/v:ro`)} ${HELPER} tar czf - -C /v .`;

/** Images whose files are a database's: copied while it writes, the copy may not open. */
const DB_IMAGES = "postgres|postgis|pgvector|timescale|mysql|mariadb|percona|mongo|redis|valkey|keydb|couchdb|influxdb|clickhouse|neo4j|cassandra|elasticsearch|opensearch";

/**
 * Shell that runs `cmd` (status in $rc) with the running database containers that mount the volume (`vol`, a shell
 * word: "$v" or quoted) paused: their files hold still, a copy like after a power cut, which a database recovers
 * from. Other services keep running. Unpaused when cmd fails too, and when the script is killed. Plain sh.
 */
export function dbPaused(vol: string, cmd: string) {
  return [
    `db=$(for id in $(docker ps -q --filter volume=${vol}); do docker inspect -f '{{.Id}} {{.Config.Image}}' "$id"; done | grep -iE ' [^ ]*(${DB_IMAGES})' | cut -d' ' -f1 || true)`,
    `trap '[ -z "$db" ] || docker unpause $db >/dev/null 2>&1' EXIT; trap 'exit 1' HUP INT TERM`,
    `[ -z "$db" ] || { echo "pausing $(docker inspect -f '{{.Name}}' $db | tr -d / | tr '\\n' ' ')while its volume is copied, so its files hold still" >&2; docker pause $db >/dev/null; }`,
    `if ${cmd}; then rc=0; else rc=1; fi`,
    `[ -z "$db" ] || docker unpause $db >/dev/null; db=""; trap - EXIT HUP INT TERM`,
  ].join("\n");
}

/** Shell that writes the volume's contents to `file` (shell-quoted), whole or not at all; a database using it paused meanwhile. */
export const backupTo = (vol: string, file: string) =>
  `${dbPaused(shq(vol), `${tarOut(vol)} > ${file}.part`)}\n[ "$rc" = 0 ] || { rm -f ${file}.part; exit 1; }\nmv ${file}.part ${file}`;

/**
 * `docker run` that replaces the volume's contents with the tar.gz on stdin. own: give the files to the
 * owner of the volume's root (an upload from this machine carries your uid; a backup keeps its owners).
 */
export const tarIn = (vol: string, own = false) =>
  `docker run --rm -i -v ${shq(`${vol}:/v`)} ${HELPER} sh -c ${shq(`${own ? "o=$(stat -c %u:%g /v) && " : ""}find /v -mindepth 1 -delete && tar xzf - -C /v${own ? " && chown -R $o /v" : ""}`)}`;

/** Shell for lf undo of a deleted volume: create it again, labelled for its Compose project, filled from `file`. */
export function recreateFrom(vol: string, key: string, project: string, file: string) {
  const labels = [`com.docker.compose.project=${project}`, `com.docker.compose.volume=${key}`].map((l) => `--label ${shq(l)}`).join(" ");
  return `if [ -f ${shq(file)} ]; then docker volume create ${labels} ${shq(vol)} >/dev/null && ${tarIn(vol)} < ${shq(file)}; else log ${shq(`${file} is gone, nothing to put back`)}; fi`;
}

/**
 * Shell that stops the containers using `vol`, runs `steps` (joined with &&: one failing skips the rest) and
 * starts those containers again, also when a step failed. Self-contained: `lf undo` runs it as it is.
 */
export function whileStopped(vol: string, steps: string[]) {
  return [
    `ids=$(docker ps -q --filter ${shq(`volume=${vol}`)})`,
    `[ -z "$ids" ] || docker stop $ids >/dev/null`,
    `if ${steps.join(" && ")}; then rc=0; else rc=1; fi`,
    `[ -z "$ids" ] || docker start $ids >/dev/null`,
    `[ "$rc" = 0 ]`,
  ].join("\n");
}

/** sizes: measure each volume, and mark the empty ones; empty: only mark those (no du over a database). */
export async function volumes(server: Server, site: string, sizes = false, empty = false) {
  const { meta } = await requireSite(server, site);
  const project = projectName(meta);
  const { stdout } = await runScript(server, listScript(project, siteDir(site), site), { capture: true, env: { SIZES: sizes, EMPTY: empty } });
  return { ...parseVolumes(stdout), project };
}
