import fs from "node:fs";
import { basename, join, resolve } from "node:path";
import { configDir, loadProject, saveProject, type ProjectConfig } from "./config";
import type { SiteKind } from "./templates";

const OUTPUT_DIRS = ["dist", "build", "out", "public", "_site", "site"];

/** Pick the folder to publish: explicit, remembered, or the first build output containing index.html. */
export function detectStaticDir(cwd: string): string {
  if (fs.existsSync(join(cwd, "index.html"))) return ".";
  return OUTPUT_DIRS.find((d) => fs.existsSync(join(cwd, d, "index.html"))) ?? ".";
}

export function exposedPort(dockerfile: string): number | undefined {
  const m = fs.readFileSync(dockerfile, "utf8").match(/^\s*EXPOSE\s+(\d+)/im);
  return m ? Number(m[1]) : undefined;
}

export const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63) || "site";

export interface Detected {
  path: string;
  name: string;
  kind: SiteKind;
  /** Static: the folder with index.html, relative; undefined until a build makes it. */
  dir?: string;
  port?: number;
  /** A build script found in package.json, run with the project's package manager. */
  build?: string;
  /** Its .landfall.json, when it was deployed before. */
  project?: ProjectConfig;
}

/** What `lf deploy` would do with a folder, without running anything. */
export function detectProject(path: string): Detected {
  const project = loadProject(path);
  const name = project?.name ?? slug(basename(path));
  if (project?.image && !project.static) return { path, name, kind: "image", port: project.port, project };
  const has = (f: string) => fs.existsSync(join(path, f));
  let build = project?.build;
  if (!build && has("package.json")) {
    try {
      const pkg = JSON.parse(fs.readFileSync(join(path, "package.json"), "utf8"));
      if (pkg.scripts?.build) {
        build = has("bun.lock") || has("bun.lockb") ? "bun run build" : has("pnpm-lock.yaml") ? "pnpm build" : has("yarn.lock") ? "yarn build" : "npm run build";
      }
    } catch {}
  }
  if (!project?.static && has("Dockerfile")) {
    return { path, name, kind: "dockerfile", port: project?.port ?? exposedPort(join(path, "Dockerfile")) ?? 3000, project };
  }
  const found = project?.dir ?? detectStaticDir(path);
  const dir = found !== "." || has("index.html") ? found : undefined;
  return { path, name, kind: "static", dir, build, project };
}

// ---------------------------------------------------------------- remembered projects

export interface Remembered {
  path: string;
  name: string;
  server: string;
  domains: string[];
  kind: SiteKind;
  /** Last deploy. */
  at: string;
}

const PROJECTS = join(configDir, "projects.json");

export function loadProjects(): Remembered[] {
  try {
    return (JSON.parse(fs.readFileSync(PROJECTS, "utf8")) as Remembered[]).filter((p) => fs.existsSync(p.path));
  } catch {
    return [];
  }
}

/** Most recent first; one entry per folder. */
export function rememberProject(p: Omit<Remembered, "at">) {
  const path = resolve(p.path);
  const list = [{ ...p, path, at: new Date().toISOString() }, ...loadProjects().filter((x) => x.path !== path)].slice(0, 50);
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(PROJECTS, JSON.stringify(list, null, 2) + "\n", { mode: 0o600 });
}

/** Keep remembered projects and their .landfall.json in step after a site's domains changed on the server. */
export function updateProjectDomains(server: string, name: string, domains: string[]) {
  const list = loadProjects();
  for (const p of list.filter((p) => p.server === server && p.name === name)) {
    p.domains = domains;
    const cfg = loadProject(p.path);
    if (cfg?.name === name) saveProject(p.path, { ...cfg, domains });
  }
  if (list.length) fs.writeFileSync(PROJECTS, JSON.stringify(list, null, 2) + "\n", { mode: 0o600 });
}
