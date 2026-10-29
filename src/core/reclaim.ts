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

export interface PruneVolume {
  name: string;
  /** Compose project it was made for; none for an anonymous or hand-made volume. */
  project?: string;
  /** Bytes; 0 when docker could not tell. */
  size: number;
  /** A site that still exists owns it: unmounted on purpose (lf volume rm keeps the data), or its containers are gone for now. */
  keep?: "site";
}

export interface PrunePlan {
  docker: boolean;
  all: boolean;
  images: PruneImage[];
  /** What `docker system df` calls reclaimable build cache, in bytes. */
  buildCache: number;
  /** Only for --logs. size: bytes of container logs, rotated ones included; journal: 0 when unknown. Both need root. */
  logs?: { root: boolean; size: number; journal: number };
  /** Networks no container uses, landfall's proxy network aside. They take no disk space. */
  networks: string[];
  /** Only for --volumes: volumes no container mounts, stopped ones included. */
  volumes?: PruneVolume[];
}

/** Journal kept by `lf prune --logs`, as journalctl --vacuum-size takes it, and in bytes. */
export const JOURNAL_KEEP = "100M";
export const JOURNAL_KEEP_BYTES = 100 * 1024 ** 2;

export const removable = (p: PrunePlan) => p.images.filter((i) => !i.keep);
export const kept = (p: PrunePlan, why: PruneImage["keep"]) => p.images.filter((i) => i.keep === why);
export const removableVolumes = (p: PrunePlan) => (p.volumes ?? []).filter((v) => !v.keep);

/** At most what the plan frees: image sizes count layers they share, and the journal keeps JOURNAL_KEEP. */
export function reclaimable(p: PrunePlan): number {
  const logs = p.logs ? p.logs.size + Math.max(p.logs.journal - JOURNAL_KEEP_BYTES, 0) : 0;
  const sum = (xs: { size: number }[]) => xs.reduce((n, x) => n + x.size, 0);
  return sum(removable(p)) + p.buildCache + logs + sum(removableVolumes(p));
}
