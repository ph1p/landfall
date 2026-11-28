import { shq } from "../lib/quote";

/** Ends a site's line in the crontab (lf volume backup --schedule): what finds it again. */
export const cronMark = (site: string) => `# landfall backup ${site}:`;
/** Shell: the crontab without the lines that hold mark, in $c. */
export const cronWithout = (mark: string) => `c=$(crontab -l 2>/dev/null | grep -vF ${shq(mark)} || true)`;
/** Shell: install $c plus `line` (a shell word; none: just $c) as the crontab. */
export const cronSet = (line: string) => `printf '%s\\n%s\\n' "$c" ${line} | sed '/^$/d' | crontab -`;

/** A minute of its own per site (0–59): not every server's jobs at :00 sharp. */
export const cronMinute = (site: string) => [...site].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 60, 7);

/** Shell that succeeds when a cron daemon runs. */
export const CRON_RUNNING = "pidof crond >/dev/null || pidof cron >/dev/null";

/**
 * Putting `line` (empty: none) into the login's crontab in place of the line marked `mark`, in three parts:
 * `check` goes before any other change (it refuses a server without cron, to `purpose`, and keeps the old line),
 * `set` changes the crontab, and `undo` is a shell word for record that puts back the old line (or none).
 */
export function cronChange(mark: string, line: string, purpose: string) {
  const [head, tail] = cronSet("@").split(" @ ");
  return {
    check: [
      ...(line
        ? [
            `command -v crontab >/dev/null || { echo "the server has no cron: install it (cron, cronie or busybox crond) to ${purpose}" >&2; exit 1; }`,
            `! grep -qsxF "$(id -un)" /etc/cron.deny || { echo "the admin of this server turned cron off for $(id -un): you cannot ${purpose}" >&2; exit 1; }`,
            // busybox crontab (Alpine) gives a user other than root a crontab only when setuid.
            `[ "$(id -u)" = 0 ] || [ "$(pkg_mgr)" != apk ] || pkg_has busybox-suid || ! can_root || pkg_install busybox-suid || true`,
          ]
        : []),
      `old=$(crontab -l 2>/dev/null | grep -F ${shq(mark)} || true)`,
    ],
    set: [
      "if command -v crontab >/dev/null; then",
      `  ${cronWithout(mark)}`,
      `  ${cronSet(line ? shq(line) : '""')} || { echo "could not change the crontab of $(id -un): busybox crontab (Alpine) lets only root have one unless setuid; install busybox-suid as root (apk add busybox-suid)" >&2; exit 1; }`,
      "fi",
    ],
    undo: `${shq(`${cronWithout(mark)}; ${head} `)}"$(printf %q "$old")"${shq(` ${tail}`)}`,
  };
}
