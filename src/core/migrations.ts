import { shq } from "./ssh";
import { JOURNAL, ROOT, STAMP_FILE } from "./templates";
import { type StampStatus, VERSION, versionGt } from "./version";

/**
 * A change that brings a server written by an older landfall up to date (lf server upgrade, lf setup).
 * Ids run 1, 2, 3 … and never change once released. A script is bash on PRELUDE: idempotent, every change
 * journaled with `record`, files backed up with `saved`.
 */
export interface Migration {
  id: number;
  /** The landfall version that brought it. */
  since: string;
  /** What it changes, in a few words. */
  what: string;
  script: string;
  /** Needs root: run it with the admin login. */
  admin?: boolean;
}

export const MIGRATIONS: Migration[] = [];

/** The newest migration this landfall knows. */
export const LATEST_MIGRATION = MIGRATIONS.length;

/**
 * One script that runs the migrations in order. Each runs only when the server lacks it (its level is read on the
 * server, as the script runs), and once done raises the level, journaled.
 */
export const migrateScript = (ms: Migration[] = MIGRATIONS): string =>
  ms
    .map((m) => `# migration ${m.id}: ${m.what}\nif [ "$(_stamp_level)" -lt ${m.id} ]; then\n${m.script}\n_set_migration ${m.id} ${shq(m.what)}\nfi`)
    .join("\n");

/** Shell that prints landfall.json on one line ({} when it is missing), a tab, and the landfall of the journal's last line (its 9th field, see _journal). Nothing where landfall never set the server up. */
export const READ_STAMP = `if [ -d ${ROOT} ]; then printf '%s\\t%s\\n' "$(tr -d '\\n' 2>/dev/null < ${STAMP_FILE} || echo '{}')" "$(tail -n1 ${JOURNAL} 2>/dev/null | cut -f9)"; fi`;

/** The server's landfall as READ_STAMP printed it, compared with this one; undefined where landfall never set the server up. */
export function stampOf(out: string | undefined, ms: Migration[] = MIGRATIONS): StampStatus | undefined {
  if (!out?.trim()) return undefined;
  const [json, last] = out.trim().split("\t");
  let o: Record<string, unknown> = {};
  try {
    const j: unknown = JSON.parse(json);
    if (j && typeof j === "object") o = j as Record<string, unknown>;
  } catch {}
  const migration = typeof o.migration === "number" && Number.isInteger(o.migration) && o.migration >= 0 ? o.migration : 0;
  const newest = typeof o.newest === "string" && o.newest ? o.newest : undefined;
  return {
    version: last?.trim() || undefined,
    newest,
    migration,
    pending: ms.filter((m) => m.id > migration).map(({ id, since, what, admin }) => ({ id, since, what, ...(admin && { admin }) })),
    newer: migration > ms.length || (!!newest && versionGt(newest, VERSION)),
  };
}
