// Pure formatting shared by the CLI and the web UI (no node imports), so both say the same.

export const bytes = (n: number) => {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) (n /= 1024), i++;
  return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
};

export const duration = (s: number) => {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  return d ? `${d}d ${h}h` : h ? `${h}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}m`;
};

/** Whole percent of used in total; 0 without a total. */
export const pct = (used: number, total: number) => (total ? Math.round((used / total) * 100) : 0);

/** A duration in milliseconds: 230ms, 1.4s. */
export const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n}ms`);

export const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
