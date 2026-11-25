import fs from "node:fs";
import { join } from "node:path";
import { configDir, envVar, writeAtomic } from "./config";
import { updateCommand, versionGt } from "./version";

// Once a day landfall asks the npm registry for its newest version and remembers the answer here. The CLI mentions a
// newer one on stderr at most once a day; `lf ui` shows it in its header. Nothing is installed by itself.

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const REGISTRY = "https://registry.npmjs.org/landfall/latest";
export const updateFile = () => join(configDir, "update-check.json");

interface Cache {
  /** Not before this time (ms): a day after an answer, an hour after a try, so an offline machine is not slowed down. */
  next?: number;
  latest?: string;
  /** When the CLI last printed the notice (ms). */
  notified?: number;
}

const read = (): Cache => {
  try {
    return JSON.parse(fs.readFileSync(updateFile(), "utf8")) as Cache;
  } catch {
    return {};
  }
};
const write = (c: Cache) => {
  try {
    fs.mkdirSync(configDir, { recursive: true });
    writeAtomic(updateFile(), JSON.stringify(c) + "\n");
  } catch {
    // A read-only config directory only means asking again next time.
  }
};

/** Off with LANDFALL_NO_UPDATE_CHECK, NO_UPDATE_NOTIFIER or in CI, and when run from source (`pnpm dev`). */
export function updateCheckOff(): boolean {
  const e = process.env;
  if (envVar("NO_UPDATE_CHECK") || e.NO_UPDATE_NOTIFIER || e.CI) return true;
  return (process.argv[1] ?? "").endsWith(".ts");
}

/** Ask the registry when it is due. Never throws; gives up after `timeout` ms. */
export async function refreshUpdate(timeout = 3000): Promise<void> {
  const now = Date.now();
  const cache = read();
  if (now < (cache.next ?? 0)) return;
  write({ ...cache, next: now + HOUR });
  try {
    const res = await fetch(REGISTRY, { signal: AbortSignal.timeout(timeout) });
    if (!res.ok) return;
    const { version } = (await res.json()) as { version?: unknown };
    // Read again: the notice may have been written meanwhile.
    if (typeof version === "string") write({ ...read(), next: Date.now() + DAY, latest: version });
  } catch {
    // Offline or slow: try again in an hour.
  }
}

/** The newest version the registry named, when it is newer than `current`. */
export function availableUpdate(current: string, cache = read()): string | undefined {
  return cache.latest && versionGt(cache.latest, current) ? cache.latest : undefined;
}

/** The line the CLI prints, at most once a day while an update is waiting; undefined otherwise. */
export function updateNotice(current: string): string | undefined {
  const cache = read();
  const latest = availableUpdate(current, cache);
  if (!latest || (cache.notified && Date.now() - cache.notified < DAY)) return undefined;
  write({ ...cache, notified: Date.now() });
  return `landfall ${latest} is available (this is ${current}). Update: ${updateCommand()}`;
}
