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

/** Parses listScript's output: `vol`, `mnt`, `size`, `empty`, `bak` and `sched` lines. */
export function parseVolumes(out: string): { volumes: Volume[]; backups: Backup[]; schedule?: string } {
  const vols = new Map<string, Volume>();
  const vol = (name: string) => vols.get(name) ?? vols.set(name, { name, key: name, mounts: [] }).get(name)!;
  const backups: Backup[] = [];
  let schedule: string | undefined;
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
  }
  return {
    volumes: [...vols.values()].sort((x, y) => x.key.localeCompare(y.key)),
    backups: backups.sort((x, y) => y.time.localeCompare(x.time)),
    ...(schedule && { schedule }),
  };
}

/** Volumes of a Compose project, what mounts them, their sizes and the site's backups. */
export const listScript = (project: string, dir: string, site: string) => String.raw`
cd ${shq(dir)}
vols=""
for v in $(docker volume ls -q --filter label=com.docker.compose.project=${shq(project)}); do
  printf 'vol\t%s\t%s\n' "$v" "$(docker volume inspect -f '{{index .Labels "com.docker.compose.volume"}}{{"\t"}}{{if .Options}}{{index .Options "device"}}{{end}}' "$v")"
  vols="$vols $v"
done
for ctr in $(docker ps -aq --filter label=com.docker.compose.project=${shq(project)}); do
  m=$(docker inspect -f '{{$s := index .Config.Labels "com.docker.compose.service"}}{{range .Mounts}}{{if eq .Type "volume"}}mnt{{"\t"}}{{.Name}}{{"\t"}}{{$s}}{{"\t"}}{{.Destination}}{{"\n"}}{{end}}{{end}}' "$ctr")
  [ -z "$m" ] || { printf '%s\n' "$m"; vols="$vols $(printf '%s\n' "$m" | cut -f2)"; }
done
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
/** Undo backups kept per volume: each push or restore makes one, and the oldest are past any useful undo. */
export const BEFORE_KEEP = 10;
/** Shell, run in the site's folder: all but the newest BEFORE_KEEP `<key>-<stamp>-before-*` backups of key go, said. */
export const pruneBefore = (key: string) => `k=${shq(key)}; n=0
for old in $(ls -1r backups 2>/dev/null); do
  case "$old" in "$k"-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]-before-*.tar.gz) ;; *) continue ;; esac
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

/** Shell that writes the volume's contents to `file` (shell-quoted), whole or not at all. */
export const backupTo = (vol: string, file: string) =>
  `${tarOut(vol)} > ${file}.part || { rm -f ${file}.part; exit 1; }\nmv ${file}.part ${file}`;

/**
 * `docker run` that replaces the volume's contents with the tar.gz on stdin. own: give the files to the
 * owner of the volume's root (an upload from this machine carries your uid; a backup keeps its owners).
 */
export const tarIn = (vol: string, own = false) =>
  `docker run --rm -i -v ${shq(`${vol}:/v`)} ${HELPER} sh -c ${shq(`${own ? "o=$(stat -c %u:%g /v) && " : ""}find /v -mindepth 1 -delete && tar xzf - -C /v${own ? " && chown -R $o /v" : ""}`)}`;

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
