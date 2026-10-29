import type { Server } from "./config";
import { builtImage, SITE_LINES, readSiteLine } from "./compose";
import { JOURNAL_USAGE, journalSize, LOG_SIZES, parseSize, SUDO_PROBE } from "./stats";
import { canLogin, closeMux, runScript, shq } from "./ssh";
import { JOURNAL, PRELUDE } from "./templates";

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
`;

/** What `lf prune --logs` empties; only measured then. */
const LOGS_PLAN = String.raw`
${SUDO_PROBE}
printf 'ROOT\t%s\n' "$([ "$(id -u)" -eq 0 ] || [ -n "$S" ] && echo 1)"
${LOG_SIZES}
printf 'JOURNAL\t%s\n' "${JOURNAL_USAGE}"
`;

export interface PruneImage {
  id: string;
  /** repo:tag; none for a dangling image. */
  tags: string[];
  /** Bytes, layers shared with other images included. */
  size: number;
  created: string;
  /** Why it stays; none = it may go. */
  keep?: "used" | "release" | "undo" | "tagged";
}

export interface PrunePlan {
  docker: boolean;
  all: boolean;
  images: PruneImage[];
  /** What `docker system df` calls reclaimable build cache, in bytes. */
  buildCache: number;
  /** Only for --logs. size: bytes of container logs, rotated ones included; journal: 0 when unknown. Both need root. */
  logs?: { root: boolean; size: number; journal: number };
}

export const removable = (p: PrunePlan) => p.images.filter((i) => !i.keep);
export const kept = (p: PrunePlan, why: PruneImage["keep"]) => p.images.filter((i) => i.keep === why);

export function parsePrunePlan(out: string, all = false): PrunePlan {
  const plan: PrunePlan = { docker: true, all, images: [], buildCache: 0 };
  const logs = () => (plan.logs ??= { root: false, size: 0, journal: 0 });
  const byId = new Map<string, PruneImage>();
  const used = new Set<string>();
  const undo = new Set<string>();
  const release = new Set<string>();
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
      if (m) for (const r of m.releases) for (const s of r.services ?? []) if (s.build) release.add(builtImage(m.name, s.name, r.id));
    } else if (f[0] === "DF" && /build/i.test(f[1] ?? "")) plan.buildCache = parseSize((f[2] ?? "").split(" ")[0]);
    else if (f[0] === "ROOT") logs().root = f[1] === "1";
    else if (f[0] === "LOG") logs().size += (+f[2] || 0) * 1024;
    else if (f[0] === "JOURNAL") logs().journal = journalSize(f[1] ?? "");
  }
  for (const img of byId.values()) {
    img.keep = used.has(img.id) ? "used" : img.tags.some((t) => release.has(t)) ? "release" : undo.has(img.id) ? "undo" : img.tags.length && !all ? "tagged" : undefined;
    plan.images.push(img);
  }
  plan.images.sort((a, b) => b.size - a.size);
  return plan;
}

export async function prunePlan(s: Server, all = false, logs = false): Promise<PrunePlan> {
  const { stdout } = await runScript(s, `${PRUNE_PLAN}${logs ? LOGS_PLAN : ""}exit 0\n`, { capture: true });
  return parsePrunePlan(stdout, all);
}

/** Removes what the plan allows, then the build cache. */
export async function prune(s: Server, plan: PrunePlan): Promise<{ images: number; failed: string[] }> {
  const imgs = removable(plan);
  // Tagged images go by tag: an ID with several tags only goes with -f, which would also take kept tags.
  const refs = imgs.flatMap((i) => (i.tags.length ? i.tags : [i.id]));
  const script = [
    PRELUDE,
    "set +e",
    "failed=0",
    ...refs.map((r) => `docker image rm ${shq(r)} >/dev/null 2>&1 || { printf 'FAILED\\t%s\\n' ${shq(r)}; failed=$((failed + 1)); }`),
    `docker builder prune -f${plan.all ? "a" : ""} >/dev/null 2>&1 || true`,
    `record ${shq(`pruned ${imgs.length} images and the build cache`)}`,
    "exit 0",
  ].join("\n");
  const { stdout } = await runScript(s, script, { capture: true });
  const failed = stdout.split("\n").filter((l) => l.startsWith("FAILED\t")).map((l) => l.slice(7));
  return { images: imgs.length, failed };
}

/** Journal kept by `lf prune --logs`. */
export const JOURNAL_KEEP = "100M";

/** At most what the plan frees: image sizes count layers they share, and the journal keeps JOURNAL_KEEP. */
export function reclaimable(p: PrunePlan): number {
  const logs = p.logs ? p.logs.size + Math.max(p.logs.journal - journalSize(JOURNAL_KEEP), 0) : 0;
  return removable(p).reduce((n, i) => n + i.size, 0) + p.buildCache + logs;
}

/**
 * Empties every container's log files and shrinks the systemd journal to JOURNAL_KEEP. Needs root (an admin login).
 * The live file is truncated, not deleted: docker keeps its handle and goes on writing to it. Rotated ones
 * (.1, .2.gz) are deleted: an empty .gz would break `docker logs`, a missing one it skips.
 */
export async function pruneLogs(admin: Server): Promise<void> {
  const script = [
    PRELUDE,
    "set +e",
    String.raw`ids=$($SUDO docker ps -aq 2>/dev/null)`,
    String.raw`[ -z "$ids" ] || $SUDO docker inspect -f '{{.LogPath}}' $ids 2>/dev/null | $SUDO sh -c 'while IFS= read -r p; do [ -n "$p" ] && : > "$p" && rm -f "$p".*; done'`,
    `command -v journalctl >/dev/null 2>&1 && $SUDO journalctl --rotate --vacuum-size=${JOURNAL_KEEP} >/dev/null 2>&1`,
    `record ${shq(`emptied container logs, journal down to ${JOURNAL_KEEP}`)}`,
    "exit 0",
  ].join("\n");
  await runScript(admin, script);
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
