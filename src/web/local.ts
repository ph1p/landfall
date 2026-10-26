import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { configDir, expandHome } from "../config";
import { detectProject } from "../projects";

/** A folder on this machine, its subfolders, and what `lf deploy` would make of it. */
export function browse(path?: string) {
  const dir = resolve(!path || path === "~" ? homedir() : expandHome(path));
  const dirs = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => !e.name.startsWith(".") && (e.isDirectory() || (e.isSymbolicLink() && isDir(join(dir, e.name)))))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
  return { path: dir, parent: dirname(dir) === dir ? null : dirname(dir), home: homedir(), dirs, detected: detectProject(dir) };
}

const isDir = (p: string) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const UPLOADS = join(configDir, "uploads");
const KEEP_MS = 24 * 3600 * 1000;

/** "a/../b//c" → ["a", "b", "c"]: nothing may land outside the upload folder. */
export const safeParts = (rel: string) => rel.split(/[\\/]+/).filter((p) => p && p !== "." && p !== "..");

/** Write an uploaded file, creating its folders. */
async function save(path: string, f: File) {
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, Buffer.from(await f.arrayBuffer()));
}

/**
 * Store dropped files (with their relative paths) or one archive (.zip, .tar, .tar.gz)
 * in a fresh folder, and return the folder to deploy: the single top folder when there is one.
 */
export async function receiveUpload(form: FormData) {
  fs.mkdirSync(UPLOADS, { recursive: true, mode: 0o700 });
  for (const old of fs.readdirSync(UPLOADS)) {
    const p = join(UPLOADS, old);
    if (Date.now() - fs.statSync(p).mtimeMs > KEEP_MS) fs.rmSync(p, { recursive: true, force: true });
  }
  const root = fs.mkdtempSync(join(UPLOADS, "u-"));
  const files = form.getAll("file").filter((f): f is File => f instanceof File);
  if (!files.length) throw new Error("no files in the upload");
  const paths = form.getAll("path").map(String);
  const archive = files.length === 1 && /\.(zip|tar|tgz|tar\.gz)$/i.test(files[0].name);
  if (archive) {
    const file = join(root, ".upload-" + safeParts(files[0].name).pop());
    await save(file, files[0]);
    const out = join(root, "files");
    fs.mkdirSync(out);
    // unzip and tar both refuse entries that climb out with ../, but a link could still point
    // anywhere (and a later entry be written through it): archives with links are refused.
    const zip = /\.zip$/i.test(file);
    if (hasLinks(file, zip)) throw new Error(`${files[0].name} contains symlinks or hard links: upload the folder instead`);
    const r = zip ? spawnSync("unzip", ["-q", file, "-d", out]) : spawnSync("tar", ["-xf", file, "-C", out]);
    if (r.error || r.status !== 0) {
      const t = zip ? spawnSync("tar", ["-xf", file, "-C", out]) : r;
      if (t.error || t.status !== 0) throw new Error(`could not unpack ${files[0].name}`);
    }
    fs.rmSync(file);
    dropLinks(out);
    return { path: topFolder(out), files: countFiles(out) };
  }
  const out = join(root, "files");
  for (const [i, f] of files.entries()) {
    const parts = safeParts(paths[i] || f.name);
    if (!parts.length) continue;
    await save(join(out, ...parts), f);
  }
  return { path: topFolder(out), files: files.length };
}

/** Whether an archive holds links, from its verbose listing (mode column starts with l or h). */
function hasLinks(file: string, zip: boolean): boolean {
  const list = (cmd: string, args: string[]) => {
    const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 256 * 1024 ** 2 });
    return r.error || r.status !== 0 ? undefined : r.stdout;
  };
  // macOS tar (bsdtar) lists zips too; Linux has zipinfo.
  const out = zip ? (list("zipinfo", [file]) ?? list("tar", ["-tvf", file])) : list("tar", ["-tvf", file]);
  if (out === undefined) throw new Error(`could not read ${file.split("/").pop()}`);
  return out.split("\n").some((l) => /^[lh]/.test(l) || / link to /.test(l));
}

/** Remove any link that got through anyway: deploy must only ship what was uploaded. */
function dropLinks(dir: string) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (e.isSymbolicLink()) fs.rmSync(join(e.parentPath, e.name), { force: true });
  }
}

/** Descend through folders that hold nothing but one folder (and macOS litter). */
function topFolder(dir: string): string {
  for (;;) {
    const entries = fs.readdirSync(dir).filter((n) => n !== "__MACOSX" && n !== ".DS_Store");
    if (entries.length !== 1 || !isDir(join(dir, entries[0]))) return dir;
    dir = join(dir, entries[0]);
  }
}

function countFiles(dir: string): number {
  return fs.readdirSync(dir, { withFileTypes: true, recursive: true }).filter((e) => e.isFile()).length;
}

/** A job's working folder: an existing absolute directory. */
export function jobCwd(cwd: unknown): string | undefined {
  if (cwd === undefined || cwd === null || cwd === "") return undefined;
  if (typeof cwd !== "string" || !isAbsolute(cwd) || !isDir(cwd)) throw new Error("cwd must be an existing folder");
  return cwd;
}
