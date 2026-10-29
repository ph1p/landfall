import type { Server } from "./config";
import { SITE_LINES, projectName, readSiteLine } from "./compose";
import { runScript } from "./ssh";
import { ROOT, SITES } from "./templates";

/** Two samples a second apart: CPU and network are rates, a single read has none. */
const STATS = String.raw`
set +e
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
kv() { printf '%s=%s\n' "$1" "$2"; }
sample() {
  printf 'T%s\t%s\n' "$1" "$(cut -d' ' -f1 /proc/uptime)"
  printf 'CPU%s\t%s\n' "$1" "$(head -n1 /proc/stat)"
  awk -v n="$1" 'NR > 2 { sub(/:/, " "); printf "NET%s\t%s\t%s\t%s\n", n, $1, $2, $10 }' /proc/net/dev
  # pid, cpu ticks, rss pages, name: the name may hold spaces, so split at ") <state> " after it.
  cat /proc/[0-9]*/stat 2>/dev/null | awk '{ i = match($0, /\) [A-Z] /); p = substr($0, 1, i - 1); split(substr($0, i + 2), a, " "); j = index(p, " ("); print substr(p, 1, j - 1) "\t" (a[12] + a[13]) "\t" a[22] "\t" substr(p, j + 2) }' > "$T/p$1"
}
D=""
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  D=1
  docker stats --no-stream --format 'STAT\t{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}\t{{.BlockIO}}\t{{.PIDs}}' > "$T/stats" 2>/dev/null &
fi
sample 1
sleep 1
sample 2
kv cpus "$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null)"
kv load "$(cut -d' ' -f1-3 /proc/loadavg)"
kv mem "$(awk '/^(MemTotal|MemAvailable|SwapTotal|SwapFree):/ {v[$1] = $2} END {print v["MemTotal:"], v["MemAvailable:"], v["SwapTotal:"], v["SwapFree:"]}' /proc/meminfo)"
kv page "$(getconf PAGESIZE 2>/dev/null || echo 4096)"
kv docker "$D"
df -Pk 2>/dev/null | awk 'NR > 1 && $1 ~ /^\// && $6 !~ /^\/(snap|boot)(\/|$)/ && !seen[$1]++ { print "DISK\t" $6 "\t" $2 "\t" $3 "\t" $4 }'
awk -F'\t' 'NR == FNR { t[$1] = $2; next } ($1 in t) { print "PROC\t" $1 "\t" ($2 - t[$1]) "\t" $3 "\t" $4 }' "$T/p1" "$T/p2" > "$T/procs"
{ sort -t"$(printf '\t')" -k3,3nr "$T/procs" | head -n 8; sort -t"$(printf '\t')" -k4,4nr "$T/procs" | head -n 8; } | sort -u
if [ -n "$D" ]; then
  wait
  cat "$T/stats"
  docker ps -a --format 'CTR\t{{.Names}}\t{{.Status}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.service"}}\t{{.Image}}'
  ids=$(docker ps -aq)
  [ -z "$ids" ] || docker inspect -f 'RST{{"\t"}}{{.Name}}{{"\t"}}{{.RestartCount}}' $ids 2>/dev/null
  ${SITE_LINES}
fi
exit 0
`;

export interface ContainerStats {
  name: string;
  /** The site it belongs to, if landfall deployed it. */
  site?: string;
  project?: string;
  service?: string;
  image: string;
  status: string;
  /** Percent of one core, as `docker stats` shows it: 4 busy cores are 400. */
  cpu: number;
  /** Bytes. */
  mem: number;
  memLimit: number;
  /** Bytes since the container started. */
  net: { rx: number; tx: number };
  block: { read: number; write: number };
  pids: number;
  restarts: number;
}

export interface Stats {
  at: string;
  /** Seconds. */
  uptime: number;
  cpus: number;
  load: [number, number, number];
  /** Percent of all cores together, 0-100. */
  cpu: number;
  /** Bytes. */
  mem: { total: number; available: number; swapTotal: number; swapFree: number };
  disks: { mount: string; total: number; used: number; available: number }[];
  /** Bytes per second, per interface (not loopback, bridges or container veths). */
  net: { iface: string; rx: number; tx: number }[];
  /** The busiest and the biggest processes; cpu in percent of one core. */
  procs: { pid: number; name: string; cpu: number; rss: number }[];
  /** Whether landfall's login can talk to docker. */
  docker: boolean;
  containers: ContainerStats[];
}

const UNITS: Record<string, number> = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 };

/** Docker's sizes: "12.5MiB", "1.2kB", "648B". */
export function parseSize(s: string): number {
  const m = /^([\d.]+)\s*([a-z]*)$/i.exec(s.trim());
  return m ? Math.round(Number(m[1]) * (UNITS[(m[2] || "b").toLowerCase()] ?? 1)) : 0;
}

/** "a / b" of docker stats. */
const pair = (s = "") => s.split(" / ").map(parseSize) as [number, number];

/** Interfaces that carry traffic of the host itself, not of containers or between them. */
const VIRTUAL = /^(lo|veth|docker|br-|virbr|cni|flannel|cali|vxlan)/;

export function parseStats(out: string, now = new Date()): Stats {
  const v: Record<string, string> = {};
  const t: number[] = [];
  const cpu: number[][] = [];
  const net: Map<string, number[]>[] = [new Map(), new Map()];
  const procs: { pid: number; ticks: number; rss: number; name: string }[] = [];
  const disks: Stats["disks"] = [];
  const stat = new Map<string, string[]>();
  const restarts = new Map<string, number>();
  const ctrs: string[][] = [];
  const sites = new Map<string, string>();
  for (const line of out.split("\n")) {
    const f = line.split("\t");
    const k = f[0];
    if (/^T[12]$/.test(k)) t[+k[1] - 1] = Number(f[1]);
    else if (/^CPU[12]$/.test(k)) cpu[+k[3] - 1] = f[1].trim().split(/\s+/).slice(1).map(Number);
    else if (/^NET[12]$/.test(k)) net[+k[3] - 1].set(f[1], [Number(f[2]), Number(f[3])]);
    else if (k === "PROC") procs.push({ pid: Number(f[1]), ticks: Number(f[2]), rss: Number(f[3]), name: f.slice(4).join("\t") });
    else if (k === "DISK") disks.push({ mount: f[1], total: +f[2] * 1024, used: +f[3] * 1024, available: +f[4] * 1024 });
    else if (k === "STAT") stat.set(f[1], f);
    else if (k === "RST") restarts.set(f[1].replace(/^\//, ""), Number(f[2]) || 0);
    else if (k === "CTR") ctrs.push(f);
    else if (k === "SITE") {
      const meta = readSiteLine(line);
      if (meta) sites.set(projectName(meta), meta.name);
    } else if (line.includes("=")) v[line.slice(0, line.indexOf("="))] = line.slice(line.indexOf("=") + 1).trim();
  }
  const cpus = Number(v.cpus) || 1;
  // /proc/stat: user nice system idle iowait irq softirq steal …; idle time is idle + iowait.
  const total = (c: number[] = []) => c.slice(0, 8).reduce((a, b) => a + (b || 0), 0);
  const idle = (c: number[] = []) => (c[3] || 0) + (c[4] || 0);
  const dTotal = total(cpu[1]) - total(cpu[0]);
  const dIdle = idle(cpu[1]) - idle(cpu[0]);
  const secs = t[1] - t[0] || 1;
  const page = Number(v.page) || 4096;
  const [memTotal = 0, memAvail = 0, swapTotal = 0, swapFree = 0] = (v.mem ?? "").split(/\s+/).map((n) => Number(n) * 1024 || 0);
  const pct = (n: number) => Math.round(n * 10) / 10;
  return {
    at: now.toISOString(),
    uptime: Math.round(t[1] || 0),
    cpus,
    load: (v.load ?? "").split(/\s+/).map((n) => Number(n) || 0).concat([0, 0, 0]).slice(0, 3) as Stats["load"],
    cpu: dTotal > 0 ? pct((100 * (dTotal - dIdle)) / dTotal) : 0,
    mem: { total: memTotal, available: memAvail, swapTotal, swapFree },
    disks,
    net: [...net[1]]
      .filter(([iface]) => !VIRTUAL.test(iface) && net[0].has(iface))
      .map(([iface, [rx, tx]]) => ({ iface, rx: Math.max(0, Math.round((rx - net[0].get(iface)![0]) / secs)), tx: Math.max(0, Math.round((tx - net[0].get(iface)![1]) / secs)) })),
    // Ticks of one process against the ticks one core had in the same time.
    procs: procs
      .map((p) => ({ pid: p.pid, name: p.name, cpu: dTotal > 0 ? pct((100 * p.ticks * cpus) / dTotal) : 0, rss: p.rss * page }))
      .sort((a, b) => b.cpu - a.cpu || b.rss - a.rss),
    docker: v.docker === "1",
    containers: ctrs
      .map(([, name, status = "", project = "", service = "", image = ""]) => {
        const s = stat.get(name) ?? [];
        const [mem, memLimit] = pair(s[3]);
        const [rx, tx] = pair(s[4]);
        const [read, write] = pair(s[5]);
        return {
          name,
          ...(sites.has(project) && { site: sites.get(project) }),
          ...(project && { project, service }),
          image,
          status,
          cpu: parseFloat(s[2] ?? "") || 0,
          mem: mem || 0,
          memLimit: memLimit || 0,
          net: { rx: rx || 0, tx: tx || 0 },
          block: { read: read || 0, write: write || 0 },
          pids: Number(s[6]) || 0,
          restarts: restarts.get(name) ?? 0,
        };
      })
      .sort((a, b) => (a.site ?? a.project ?? "~").localeCompare(b.site ?? b.project ?? "~") || a.name.localeCompare(b.name)),
  };
}

export async function stats(s: Server): Promise<Stats> {
  const { stdout } = await runScript(s, STATS, { capture: true });
  return parseStats(stdout);
}

/** Where the space goes: filesystems, docker's share, sites, volumes and container logs. */
/** Sets S to what reads root-owned files: nothing as root, sudo -n with passwordless sudo. */
export const SUDO_PROBE = `S=""; [ "$(id -u)" -eq 0 ] || { sudo -n true 2>/dev/null && S="sudo -n"; }`;
/** The systemd journal's size as journalctl prints it (120.5M), empty when unknown. Needs SUDO_PROBE. */
export const JOURNAL_USAGE = String.raw`$($S journalctl --disk-usage 2>/dev/null | sed -n 's/.* take up \([0-9.]*[A-Za-z]*\).*/\1/p')`;
/**
 * LOG <container> <KiB> per container, json-file's rotated logs (.1, .2.gz) included; no KiB when unreadable.
 * Needs SUDO_PROBE and docker. One shell reads them all: the files are root's.
 */
export const LOG_SIZES = String.raw`ids=$(docker ps -aq)
[ -z "$ids" ] || docker inspect -f '{{.Name}}{{"\t"}}{{.LogPath}}' $ids 2>/dev/null | $S sh -c 'while IFS="$(printf "\t")" read -r n p; do
  [ -n "$p" ] && printf "LOG\t%s\t%s\n" "${"${n#/}"}" "$([ -r "$p" ] && du -kc "$p" "$p".* 2>/dev/null | tail -n 1 | cut -f1)"
done'`;

export const DISK = String.raw`
set +e
${SUDO_PROBE}
kv() { printf '%s=%s\n' "$1" "$2"; }
kv root "$([ "$(id -u)" -eq 0 ] || [ -n "$S" ] && echo 1)"
df -Pk 2>/dev/null | awk 'NR > 1 && $1 ~ /^\// && $6 !~ /^\/(snap|boot)(\/|$)/ && !seen[$1]++ { print "DISK\t" $6 "\t" $2 "\t" $3 "\t" $4 }'
kv landfall "$($S du -sk ${ROOT} 2>/dev/null | cut -f1)"
for d in ${SITES}/*/; do
  [ -d "$d" ] || continue
  n=$(basename "$d")
  printf 'SITE\t%s\t%s\t%s\t%s\n' "$n" "$($S du -sk "$d" 2>/dev/null | cut -f1)" "$($S du -sk "$d/releases" 2>/dev/null | cut -f1)" "$(ls -1 "$d/releases" 2>/dev/null | wc -l)"
done
kv journald "${JOURNAL_USAGE}"
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  kv docker 1
  docker system df --format 'DF\t{{.Type}}\t{{.TotalCount}}\t{{.Active}}\t{{.Size}}\t{{.Reclaimable}}' 2>/dev/null
  docker system df -v 2>/dev/null | awk '/^VOLUME NAME/ { v = 1; next } v && NF == 0 { v = 0 } v && NF >= 3 { print "VOL\t" $1 "\t" $2 "\t" $NF }'
  ${LOG_SIZES}
fi
exit 0
`;

export interface DiskUsage {
  /** Whether sizes below root-owned folders are complete (root, or passwordless sudo). */
  root: boolean;
  disks: Stats["disks"];
  /** Bytes of /opt/landfall. */
  landfall: number;
  sites: { name: string; size: number; releases: number; releasesSize: number }[];
  /** Bytes the systemd journal takes, 0 when unknown. */
  journald: number;
  docker: boolean;
  /** Images, Containers, Local Volumes, Build Cache. */
  dockerDf: { type: string; count: number; active: number; size: number; reclaimable: number }[];
  volumes: { name: string; links: number; size: number }[];
  /** Container log files; size undefined when they cannot be read. */
  logs: { container: string; size?: number }[];
}

export function parseDisk(out: string): DiskUsage {
  const v: Record<string, string> = {};
  const d: DiskUsage = { root: false, disks: [], landfall: 0, sites: [], journald: 0, docker: false, dockerDf: [], volumes: [], logs: [] };
  for (const line of out.split("\n")) {
    const f = line.split("\t");
    if (f[0] === "DISK") d.disks.push({ mount: f[1], total: +f[2] * 1024, used: +f[3] * 1024, available: +f[4] * 1024 });
    else if (f[0] === "SITE") d.sites.push({ name: f[1], size: (+f[2] || 0) * 1024, releasesSize: (+f[3] || 0) * 1024, releases: +f[4] || 0 });
    else if (f[0] === "DF") d.dockerDf.push({ type: f[1], count: +f[2] || 0, active: +f[3] || 0, size: parseSize(f[4] ?? ""), reclaimable: parseSize((f[5] ?? "").split(" ")[0]) });
    else if (f[0] === "VOL") d.volumes.push({ name: f[1], links: +f[2] || 0, size: parseSize(f[3] ?? "") });
    else if (f[0] === "LOG") d.logs.push({ container: f[1], ...(f[2] && { size: +f[2] * 1024 }) });
    else if (line.includes("=")) v[line.slice(0, line.indexOf("="))] = line.slice(line.indexOf("=") + 1).trim();
  }
  d.root = v.root === "1";
  d.docker = v.docker === "1";
  d.landfall = (+v.landfall || 0) * 1024;
  d.journald = journalSize(v.journald ?? "");
  d.sites.sort((a, b) => b.size - a.size);
  d.volumes.sort((a, b) => b.size - a.size);
  d.logs.sort((a, b) => (b.size ?? -1) - (a.size ?? -1));
  return d;
}

/** journalctl prints binary sizes with a single letter: 120.5M, 1.2G. 0 when unknown. */
export function journalSize(s: string): number {
  const j = /^([\d.]+)([BKMGT]?)/i.exec(s.trim());
  return j ? Math.round(Number(j[1]) * 1024 ** "BKMGT".indexOf((j[2] || "B").toUpperCase())) : 0;
}

export async function diskUsage(s: Server): Promise<DiskUsage> {
  const { stdout } = await runScript(s, DISK, { capture: true });
  return parseDisk(stdout);
}
