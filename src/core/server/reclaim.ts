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
  logs?: { root: boolean; size: number; journal: number; noJournal?: boolean };
  /** Networks no container uses, landfall's proxy network aside. They take no disk space. */
  networks: string[];
  /** Only for --volumes: volumes no container mounts, stopped ones included. */
  volumes?: PruneVolume[];
  /** Only for --volumes: folders of removed sites that hold nothing but their backups (lf sites rm keeps them). Bytes. */
  leftovers?: { site: string; size: number }[];
}

/** journalctl prints binary sizes with a single letter: 120.5M, 1.2G. 0 when unknown. */
export function journalSize(s: string): number {
  const j = /^([\d.]+)([BKMGT]?)/i.exec(s.trim());
  return j ? Math.round(Number(j[1]) * 1024 ** "BKMGT".indexOf((j[2] || "B").toUpperCase())) : 0;
}

/** Journal kept by `lf prune --logs`, as journalctl --vacuum-size takes it, and in bytes. */
export const JOURNAL_KEEP = "100M";
export const JOURNAL_KEEP_BYTES = journalSize(JOURNAL_KEEP);

export const removable = (p: PrunePlan) => p.images.filter((i) => !i.keep);
export const kept = (p: PrunePlan, why: PruneImage["keep"]) => p.images.filter((i) => i.keep === why);
export const removableVolumes = (p: PrunePlan) => (p.volumes ?? []).filter((v) => !v.keep);
export const totalSize = (xs: { size: number }[]) => xs.reduce((n, x) => n + x.size, 0);
/** An anonymous volume's 64-hex name, cut like docker cuts IDs. */
export const shortName = (name: string) => (name.length === 64 ? name.slice(0, 12) : name);

/** What the plan removes, less what failed: "3 images and the build cache, 2 volumes, …". */
export function pruneSummary(p: PrunePlan, failed: { what: string }[] = []): string {
  const n = (what: string, k: number) => k - failed.filter((f) => f.what === what).length;
  const vols = removableVolumes(p).length;
  return [
    `${n("image", removable(p).length)} images and the build cache`,
    p.networks.length && `${n("network", p.networks.length)} networks`,
    n("volume", vols) > 0 && `${n("volume", vols)} volumes`,
    n("backups", p.leftovers?.length ?? 0) > 0 && `the backups of ${n("backups", p.leftovers?.length ?? 0)} removed sites`,
    p.logs && (p.logs.noJournal ? "container logs" : `container logs and the journal beyond ${JOURNAL_KEEP}`),
  ]
    .filter(Boolean)
    .join(", ");
}

/** At most what the plan frees: image sizes count layers they share, and the journal keeps JOURNAL_KEEP. */
export function reclaimable(p: PrunePlan): number {
  const logs = p.logs ? p.logs.size + Math.max(p.logs.journal - JOURNAL_KEEP_BYTES, 0) : 0;
  return totalSize(removable(p)) + p.buildCache + logs + totalSize(removableVolumes(p)) + totalSize(p.leftovers ?? []);
}
