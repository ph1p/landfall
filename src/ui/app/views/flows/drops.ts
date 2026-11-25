import { plural, errorMessage } from "../../lib/store";
import { bytes } from "../../../../core/lib/format";
import type { Detected, Redeploy } from "../../lib/types";
import { toast } from "../../ui/toast";
import { D } from "../../ui/dialog";
import { slugify } from "./names";
import { deployDialog } from "./deploy-dialog";

// Dropped folders: walk the entries (skipping dependencies and VCS data), then upload with relative paths.
type Pair = [File, string];

const SKIP = new Set(["node_modules", ".git", ".DS_Store", "__MACOSX"]);

export const skipped = (rel: string) => rel.split("/").some((x) => SKIP.has(x));

async function droppedFiles(roots: FileSystemEntry[]) {
  const out: Pair[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (SKIP.has(entry.name)) return;
    if (entry.isFile) out.push([await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej)), prefix + entry.name]);
    else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (let batch; (batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej))).length;) {
        for (const e of batch) await walk(e, `${prefix}${entry.name}/`);
      }
    }
  };
  for (const r of roots) await walk(r, "");
  return out;
}

export async function upload(pairs: Pair[], label = "site", site?: Redeploy) {
  if (!pairs.length) return toast("Nothing to upload");
  const fd = new FormData();
  for (const [f, path] of pairs) (fd.append("file", f), fd.append("path", path));
  toast(`Uploading ${plural(pairs.length, "file")}, ${bytes(pairs.reduce((n, [f]) => n + f.size, 0))}…`);
  try {
    const r = await fetch("/api/upload", { method: "POST", body: fd });
    const data: { files: number; detected: Detected; error?: string } = await r.json().catch(() => ({ error: `${r.status} ${r.statusText}` }));
    if (!r.ok) throw new Error(data.error);
    toast(`Uploaded ${plural(data.files, "file")}`);
    deployDialog(data.detected, { upload: true, files: data.files, name: slugify(label), site });
  } catch (e) {
    toast(`Upload failed: ${errorMessage(e)}`);
  }
}

/** A folder or .zip dropped anywhere on the page deploys it. */
export function listenForDrops() {
  const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes("Files");
  addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    document.body.classList.add("dragging");
  });
  addEventListener("dragleave", (e) => {
    if (!e.relatedTarget) document.body.classList.remove("dragging");
  });
  addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    document.body.classList.remove("dragging");
    // Entries must be taken while the event is live.
    const dt = e.dataTransfer!;
    const roots = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter((x): x is FileSystemEntry => !!x);
    const label = roots[0]?.name ?? dt.files[0]?.name;
    const files = roots.length ? droppedFiles(roots) : Promise.resolve([...dt.files].map((f): Pair => [f, f.name]));
    const site = D.node ? D.site : undefined;
    files.then(
      (pairs) => upload(pairs, label, site),
      (err) => toast(errorMessage(err)),
    );
  });
}
