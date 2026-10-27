/** "5m ago", or the date once it is a month old. Shared by the CLI and the web UI, so both say the same. */
export function ago(iso: string | Date, now = Date.now()): string {
  const s = (now - new Date(iso).getTime()) / 1000;
  if (!isFinite(s)) return "";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toISOString().slice(0, 10);
}
