/** What `lf prune` plans and frees: no node imports, so the web UI shares it. */

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

/** Journal kept by `lf prune --logs`, as journalctl --vacuum-size takes it, and in bytes. */
export const JOURNAL_KEEP = "100M";
export const JOURNAL_KEEP_BYTES = 100 * 1024 ** 2;

export const removable = (p: PrunePlan) => p.images.filter((i) => !i.keep);
export const kept = (p: PrunePlan, why: PruneImage["keep"]) => p.images.filter((i) => i.keep === why);

/** At most what the plan frees: image sizes count layers they share, and the journal keeps JOURNAL_KEEP. */
export function reclaimable(p: PrunePlan): number {
  const logs = p.logs ? p.logs.size + Math.max(p.logs.journal - JOURNAL_KEEP_BYTES, 0) : 0;
  return removable(p).reduce((n, i) => n + i.size, 0) + p.buildCache + logs;
}
