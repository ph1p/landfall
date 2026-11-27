import fs from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { ProjectConfig } from "../lib/config";

/** Never uploaded: secrets, local state, and compose overrides (local-only by convention; landfall writes the server's). */
export const EXCLUDE = [".git", "node_modules", ".DS_Store", ".landfall.json", ".env", ".env.*", ".secrets", "compose.override.*", "docker-compose.override.*"];

/** One line of a .gitignore, compiled. */
export interface Rule {
  re: RegExp;
  neg: boolean;
  dir: boolean;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** gitignore syntax: `#` comments, `!` re-includes, a trailing `/` matches folders only, a slash elsewhere anchors to the file's folder. */
export function compile(line: string): Rule | undefined {
  let p = line.replace(/\r$/, "").replace(/(?<!\\)\s+$/, "");
  if (!p || p.startsWith("#")) return;
  const neg = p.startsWith("!");
  if (neg) p = p.slice(1);
  else if (p.startsWith("\\!") || p.startsWith("\\#")) p = p.slice(1);
  const dir = p.endsWith("/");
  p = p.replace(/\/+$/, "");
  if (!p) return;
  const anchored = p.includes("/");
  p = p.replace(/^\//, "");
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === "*" && p[i + 1] === "*" && (i === 0 || p[i - 1] === "/") && (i + 2 === p.length || p[i + 2] === "/")) {
      // `**/` is any number of folders (none too); a trailing `/**` everything inside.
      re += i + 2 === p.length ? ".*" : "(?:.*/)?";
      i += 2;
    } else if (ch === "*") {
      re += "[^/]*";
      while (p[i + 1] === "*") i++;
    } else if (ch === "?") re += "[^/]";
    else if (ch === "[" && p.indexOf("]", i + 2) > 0) {
      const end = p.indexOf("]", i + 2);
      const body = p.slice(i + 1, end).replace(/\\/g, "\\\\");
      re += `[${body.replace(/^!/, "^")}]`;
      i = end;
    } else if (ch === "\\" && i + 1 < p.length) re += esc(p[++i]);
    else re += esc(ch);
  }
  return { re: new RegExp(`^${anchored ? "" : "(?:.*/)?"}${re}$`), neg, dir };
}

export const parseIgnore = (text: string) =>
  text
    .split("\n")
    .map(compile)
    .filter((r): r is Rule => !!r);

/** The last rule that matches decides: true (ignored), false (re-included by `!`), undefined (no rule matches). */
export function matches(rules: Rule[], path: string, isDir: boolean): boolean | undefined {
  let out: boolean | undefined;
  for (const r of rules) if ((!r.dir || isDir) && r.re.test(path)) out = !r.neg;
  return out;
}

/** A set of rules, matched against paths relative to its folder. */
interface Layer {
  base: string;
  rules: Rule[];
}

export interface Entry {
  path: string;
  size: number;
  dir: boolean;
}

export interface ListOpts {
  /** More default patterns (a runtime's build output, caches). */
  exclude?: string[];
  /** The folder with .landfall.json (default: the uploaded folder itself). */
  project?: string;
  /** .landfall.json's exclude and include, patterns relative to `project`. */
  rules?: Pick<ProjectConfig, "exclude" | "include">;
  /** Also skip what the .gitignore files in the uploaded folder ignore. */
  gitignore?: boolean;
}

/** One folder: its entries sorted by name, and its .gitignore when asked for. */
interface Listing {
  entries: { name: string; dir: boolean; size: number }[];
  gitignore?: string;
}

/** Yields each folder it enters and takes its listing back, so the sync and the async reader share the rules. */
function* walkUpload(root: string, o: ListOpts): Generator<string, Entry[], Listing> {
  const project = o.project && !relative(o.project, root).startsWith("..") ? o.project : root;
  const own: Layer[] = [
    { base: root, rules: parseIgnore([...EXCLUDE, ...(o.exclude ?? [])].join("\n")) },
    { base: project, rules: parseIgnore([...(o.rules?.exclude ?? []), ...(o.rules?.include ?? []).map((x) => `!${x}`)].join("\n")) },
  ];
  const out: Entry[] = [];
  function* walk(dir: string, git: Layer[]): Generator<string, void, Listing> {
    const { entries, gitignore } = yield dir;
    const rules = gitignore ? parseIgnore(gitignore) : [];
    if (rules.length) git = [...git, { base: dir, rules }];
    const layers = [...git, ...own];
    for (const d of entries) {
      const abs = join(dir, d.name);
      let skip: boolean | undefined;
      for (const l of layers) skip = matches(l.rules, relative(l.base, abs).split(sep).join("/"), d.dir) ?? skip;
      if (skip) continue;
      out.push({ path: relative(root, abs).split(sep).join("/"), dir: d.dir, size: d.size });
      if (d.dir) yield* walk(abs, git);
    }
  }
  yield* walk(root, []);
  return out;
}

const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : 1);

function listSync(dir: string, gitignore?: boolean): Listing {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).map((d) => {
    // A symlink is sent as a link, so it counts as a file even when it points at a folder.
    const isDir = d.isDirectory();
    return { name: d.name, dir: isDir, size: isDir ? 0 : fs.lstatSync(join(dir, d.name)).size };
  });
  let text: string | undefined;
  if (gitignore) {
    try {
      text = fs.readFileSync(join(dir, ".gitignore"), "utf8");
    } catch {}
  }
  return { entries: entries.sort(byName), gitignore: text };
}

async function list(dir: string, gitignore?: boolean): Promise<Listing> {
  const [dirents, text] = await Promise.all([
    readdir(dir, { withFileTypes: true }),
    gitignore ? readFile(join(dir, ".gitignore"), "utf8").catch(() => undefined) : undefined,
  ]);
  const entries = await Promise.all(
    dirents.map(async (d) => {
      const isDir = d.isDirectory();
      return { name: d.name, dir: isDir, size: isDir ? 0 : (await lstat(join(dir, d.name))).size };
    }),
  );
  return { entries: entries.sort(byName), gitignore: text };
}

/**
 * What an upload of `root` sends: folders before their contents, paths relative to `root` with `/`.
 * The .gitignore files go first, then the defaults, then .landfall.json's exclude, then
 * include: a later rule wins, so include sends what any of the others leaves out.
 * An ignored folder is not entered, so nothing inside it can come back (as in git).
 */
export async function uploadList(root: string, o: ListOpts = {}): Promise<Entry[]> {
  const walk = walkUpload(root, o);
  let step = walk.next();
  while (!step.done) step = walk.next(await list(step.value, o.gitignore));
  return step.value;
}

/** uploadList for sync callers (project detection). */
export function uploadListSync(root: string, o: ListOpts = {}): Entry[] {
  const walk = walkUpload(root, o);
  let step = walk.next();
  while (!step.done) step = walk.next(listSync(step.value, o.gitignore));
  return step.value;
}

/** Total bytes, and the biggest top-level entries (a folder counts with everything in it). */
export function uploadSize(list: Entry[], top = 3) {
  const by = new Map<string, number>();
  let total = 0;
  for (const e of list) {
    total += e.size;
    const head = e.path.split("/")[0];
    by.set(head, (by.get(head) ?? 0) + e.size);
  }
  const files = list.filter((e) => !e.dir).length;
  const largest = [...by]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .filter(([, n]) => n > 0);
  return { total, files, largest };
}

/**
 * Folders of dir named like a volume that the upload left out (exclude): likely what the volume
 * should hold, as deploys never touch volume data. Data folders only: not dot folders or node_modules.
 */
export function seedFolders(dir: string, uploaded: Entry[]): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules")
    .map((d) => d.name)
    .filter((f) => !uploaded.some((e) => !e.dir && e.path.startsWith(`${f}/`)) && fs.readdirSync(join(dir, f)).length > 0)
    .sort();
}
