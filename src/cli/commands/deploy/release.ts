export const releaseId = (d = new Date()) => d.toISOString().replace(/[-:T]/g, "").slice(0, 14);

/** A release id not in `taken`: ids have one-second resolution, so a second deploy within it moves on a second. */
export function nextReleaseId(taken: string[], now: Date | string = new Date()): string {
  // A release id itself: the server's clock (lockSite).
  if (typeof now === "string") now = /^\d{14}$/.test(now) ? new Date(now.replace(/^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)$/, "$1-$2-$3T$4:$5:$6Z")) : new Date();
  let t = now.getTime();
  while (taken.includes(releaseId(new Date(t)))) t += 1000;
  return releaseId(new Date(t));
}
