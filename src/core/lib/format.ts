// Pure formatting shared by the CLI and the web UI (no node imports), so both say the same.

export const bytes = (n: number) => {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) ((n /= 1024), i++);
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

/** `one` for a single thing, `many` for more: verbs and pronouns after a list (`is`/`are`, `it`/`them`). */
export const oneOrMany = (n: number, one: string, many: string) => (n > 1 ? many : one);
export const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** A bar of width cells for v of max, in eighths. */
export function textBar(v: number, max: number, width = 24): string {
  if (!(max > 0) || !(v > 0)) return "";
  const eighths = Math.max(1, Math.round((v / max) * width * 8));
  return "█".repeat(Math.floor(eighths / 8)) + (eighths % 8 ? "▏▎▍▌▋▊▉"[(eighths % 8) - 1] : "");
}
const SPARK = "▁▂▃▄▅▆▇█";
/** One character per value, its height relative to the largest. */
export const sparkline = (values: number[]) => {
  const max = Math.max(0, ...values);
  return values.map((v) => (max > 0 && v > 0 ? SPARK[Math.min(7, Math.floor((v / max) * 7.999))] : " ")).join("");
};

/** A change in percent as +12% or -3%; null (nothing to compare with) as new. */
export const changeText = (c: number | null) => (c == null ? "new" : `${c > 0 ? "+" : ""}${c}%`);
