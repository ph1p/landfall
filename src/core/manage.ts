import type { Server } from "./config";
import { builtImage, projectName, SITE_LINES, readSiteLine } from "./compose";
import { JOURNAL_USAGE, journalSize, LOG_SIZES, parseSize, SUDO_PROBE } from "./stats";
import { canLogin, closeMux, runScript, shq } from "./ssh";
import { JOURNAL, NETWORK, parseProxy, PRELUDE, PROXY_FILE } from "./templates";
import { JOURNAL_KEEP, removable, removableVolumes, type PruneImage, type PrunePlan, type PruneVolume } from "./reclaim";

/**
 * What `lf prune` may remove. Kept: images any container uses (stopped ones too: `lf start` needs them),
 * images built for a site release (rollback runs them without rebuilding) and image IDs the journal
 * names (undo of `lf update` re-tags the image it replaced, which is dangling by then).
 */
const PRUNE_PLAN = String.raw`
set +e
command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 || { echo "NODOCKER"; exit 0; }
docker image ls -a --no-trunc --format 'IMG\t{{.ID}}\t{{.Repository}}\t{{.Tag}}\t{{.Size}}\t{{.CreatedAt}}'
ids=$(docker ps -aq)
[ -z "$ids" ] || docker inspect -f 'USED{{"\t"}}{{.Image}}' $ids 2>/dev/null
# The undo shell is the last field, base64: decode it to find the image IDs it puts back.
{ cat ${JOURNAL} 2>/dev/null || sudo -n cat ${JOURNAL} 2>/dev/null; } | awk -F'\t' '{ print $NF }' \
  | while IFS= read -r b; do [ -n "$b" ] && printf %s "$b" | base64 -d 2>/dev/null; echo; done \
  | grep -o 'sha256:[0-9a-f]\{64\}' | sort -u | sed 's/^/KEEP\t/'
${SITE_LINES}
docker system df --format 'DF\t{{.Type}}\t{{.Reclaimable}}' 2>/dev/null
docker network ls -q --filter dangling=true --format 'NET\t{{.Name}}' 2>/dev/null
printf 'PROXY\t%s\n' "$(cat ${PROXY_FILE} 2>/dev/null | tr '\n' ' ')"
`;

/** What `lf prune --volumes` deletes: volumes no container mounts. Sizes from df -v, which has no --format on older dockers. */
const VOLUMES_PLAN = String.raw`
echo VOLUMES
for v in $(docker volume ls -q --filter dangling=true 2>/dev/null); do
  printf 'VOL\t%s\t%s\n' "$v" "$(docker volume inspect -f '{{index .Labels "com.docker.compose.project"}}' "$v" 2>/dev/null)"
done
docker system df -v 2>/dev/null | awk '$1 == "VOLUME" && $2 == "NAME" { h = 1; next } h && NF == 0 { exit } h { printf "VOLSZ\t%s\t%s\n", $1, $NF }'
`;

/** What `lf prune --logs` empties; only measured then. */
const LOGS_PLAN = String.raw`
${SUDO_PROBE}
printf 'ROOT\t%s\n' "$([ "$(id -u)" -eq 0 ] || [ -n "$S" ] && echo 1)"
${LOG_SIZES}
printf 'JOURNAL\t%s\n' "${JOURNAL_USAGE}"
`;

export type { PruneImage, PrunePlan, PruneVolume } from "./reclaim";
export { JOURNAL_KEEP, kept, reclaimable, removable, removableVolumes } from "./reclaim";

export function parsePrunePlan(out: string, all = false): PrunePlan {
  const plan: PrunePlan = { docker: true, all, images: [], buildCache: 0, networks: [] };
  const logs = () => (plan.logs ??= { root: false, size: 0, journal: 0 });
  const byId = new Map<string, PruneImage>();
  const used = new Set<string>();
  const undo = new Set<string>();
  const release = new Set<string>();
  const projects = new Set<string>();
  const vols = new Map<string, PruneVolume>();
  const volSize = new Map<string, number>();
  const nets: string[] = [];
  let proxyNet = NETWORK;
  for (const line of out.split("\n")) {
    const f = line.split("\t");
    if (f[0] === "NODOCKER") plan.docker = false;
    else if (f[0] === "IMG" && f[1]) {
      const img = byId.get(f[1]) ?? { id: f[1], tags: [], size: parseSize(f[4] ?? ""), created: f[5] ?? "" };
      if (f[2] && f[2] !== "<none>" && f[3] && f[3] !== "<none>") img.tags.push(`${f[2]}:${f[3]}`);
      byId.set(f[1], img);
    } else if (f[0] === "USED" && f[1]) used.add(f[1]);
    else if (f[0] === "KEEP" && f[1]) undo.add(f[1]);
    else if (f[0] === "SITE") {
      const m = readSiteLine(line);
      if (m) projects.add(projectName(m));
      if (m) for (const r of m.releases) for (const s of r.services ?? []) if (s.build) release.add(builtImage(m.name, s.name, r.id));
    } else if (f[0] === "DF" && /build/i.test(f[1] ?? "")) plan.buildCache = parseSize((f[2] ?? "").split(" ")[0]);
    else if (f[0] === "ROOT") logs().root = f[1] === "1";
    else if (f[0] === "LOG") logs().size += (+f[2] || 0) * 1024;
    else if (f[0] === "JOURNAL") logs().journal = journalSize(f[1] ?? "");
    else if (f[0] === "NET" && f[1]) nets.push(f[1]);
    else if (f[0] === "PROXY") proxyNet = parseProxy(f[1] ?? "")?.network ?? NETWORK;
    else if (f[0] === "VOLUMES") plan.volumes = [];
    else if (f[0] === "VOL" && f[1]) vols.set(f[1], { name: f[1], ...(f[2] && { project: f[2] }), size: 0 });
    else if (f[0] === "VOLSZ" && f[1]) volSize.set(f[1], parseSize(f[2] ?? ""));
  }
  // landfall's proxy network and the one ensure_network makes: deploys expect them, even while no container is on them.
  plan.networks = nets.filter((n) => n !== proxyNet && n !== NETWORK);
  if (plan.volumes) {
    for (const v of vols.values()) {
      v.size = volSize.get(v.name) ?? 0;
      if (v.project && projects.has(v.project)) v.keep = "site";
      plan.volumes.push(v);
    }
    plan.volumes.sort((a, b) => b.size - a.size);
  }
  for (const img of byId.values()) {
    img.keep = used.has(img.id) ? "used" : img.tags.some((t) => release.has(t)) ? "release" : undo.has(img.id) ? "undo" : img.tags.length && !all ? "tagged" : undefined;
    plan.images.push(img);
  }
  plan.images.sort((a, b) => b.size - a.size);
  return plan;
}

export async function prunePlan(s: Server, o: { all?: boolean; logs?: boolean; volumes?: boolean } = {}): Promise<PrunePlan> {
  const { stdout } = await runScript(s, `${PRUNE_PLAN}${o.logs ? LOGS_PLAN : ""}${o.volumes ? VOLUMES_PLAN : ""}exit 0\n`, { capture: true });
  return parsePrunePlan(stdout, o.all);
}

/**
 * Removes what the plan allows in one go: images, the build cache, unused networks, with --volumes
 * the volumes, with --logs the logs. `s` must be an admin login (adminLogin) when the plan has logs.
 * Logs: the live file is truncated, not deleted: docker keeps its handle and goes on writing to it.
 * Rotated ones (.1, .2.gz) are deleted: an empty .gz would break `docker logs`, a missing one it skips.
 */
export async function prune(s: Server, plan: PrunePlan): Promise<{ images: number; volumes: number; failed: { what: string; name: string }[] }> {
  const imgs = removable(plan);
  const vols = removableVolumes(plan);
  // Tagged images go by tag: an ID with several tags only goes with -f, which would also take kept tags.
  const refs = imgs.flatMap((i) => (i.tags.length ? i.tags : [i.id]));
  const rm = (what: string, r: string) => `docker ${what} rm ${shq(r)} >/dev/null 2>&1 || printf 'FAILED\\t${what}\\t%s\\n' ${shq(r)}`;
  const done = [
    `${imgs.length} images and the build cache`,
    plan.networks.length && `${plan.networks.length} networks`,
    vols.length && `${vols.length} volumes`,
  ].filter(Boolean);
  const script = [
    PRELUDE,
    "set +e",
    ...refs.map((r) => rm("image", r)),
    `docker builder prune -f${plan.all ? "a" : ""} >/dev/null 2>&1 || true`,
    ...plan.networks.map((n) => rm("network", n)),
    ...vols.map((v) => rm("volume", v.name)),
    ...(plan.logs
      ? [
          String.raw`ids=$($SUDO docker ps -aq 2>/dev/null)`,
          String.raw`[ -z "$ids" ] || $SUDO docker inspect -f '{{.LogPath}}' $ids 2>/dev/null | $SUDO sh -c 'while IFS= read -r p; do [ -n "$p" ] && : > "$p" && rm -f "$p".*; done'`,
          `command -v journalctl >/dev/null 2>&1 && $SUDO journalctl --rotate --vacuum-size=${JOURNAL_KEEP} >/dev/null 2>&1`,
        ]
      : []),
    `record ${shq(`pruned ${done.join(", ")}${plan.logs ? `; emptied container logs, journal down to ${JOURNAL_KEEP}` : ""}`)}`,
    "exit 0",
  ].join("\n");
  const { stdout } = await runScript(s, script, { capture: true });
  const failed = stdout.split("\n").filter((l) => l.startsWith("FAILED\t")).map((l) => {
    const [, what, name] = l.split("\t");
    return { what, name };
  });
  return { images: imgs.length, volumes: vols.length, failed };
}

const RUNNING = `docker ps --format '{{.Names}}' 2>/dev/null || sudo -n docker ps --format '{{.Names}}' 2>/dev/null || true`;

export async function running(s: Server): Promise<string[]> {
  const { stdout } = await runScript(s, RUNNING, { capture: true });
  return stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

export const REBOOT = String.raw`
log "rebooting"
record "rebooted"
(sleep 2; $SUDO systemctl reboot 2>/dev/null || $SUDO reboot) >/dev/null 2>&1 &
`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Reboots and waits until ssh answers again and the containers that ran before run again.
 * `s` must be a login with root or passwordless sudo (adminLogin).
 */
export async function reboot(s: Server, o: { timeout: number; onWait?: (phase: "down" | "ssh" | "containers") => void }) {
  const before = await running(s).catch(() => [] as string[]);
  const start = Date.now();
  await runScript(s, PRELUDE + REBOOT);
  // The shared connection still points at the old boot: later calls would hang on it until it times out.
  await closeMux(s);
  o.onWait?.("down");
  const deadline = start + o.timeout * 1000;
  // Wait for it to go down first, or a quick check would still reach the old boot.
  while (Date.now() < deadline && Date.now() - start < 60_000 && (await canLogin(s))) await sleep(2000);
  o.onWait?.("ssh");
  let back = false;
  while (Date.now() < deadline) {
    if ((back = await canLogin(s))) break;
    await sleep(5000);
  }
  if (!back) return { back: false, seconds: Math.round((Date.now() - start) / 1000), missing: before };
  const seconds = Math.round((Date.now() - start) / 1000);
  o.onWait?.("containers");
  // Docker starts them on boot (restart: unless-stopped); give it up to a minute, within the timeout.
  let missing = before;
  const until = Math.min(deadline, Date.now() + 60_000);
  for (;;) {
    const now = new Set(await running(s).catch(() => [] as string[]));
    missing = before.filter((n) => !now.has(n));
    if (!missing.length || Date.now() >= until) break;
    await sleep(5000);
  }
  return { back: true, seconds, missing };
}
