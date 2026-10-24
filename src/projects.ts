import fs from "node:fs";
import { basename, join, resolve } from "node:path";
import { configDir, loadProject, saveProject, type ProjectConfig } from "./config";
import { COMPOSE_FILES, type SiteKind } from "./compose";

const OUTPUT_DIRS = ["dist", "build", "out", "public", "_site", "site"];

/** How a folder builds: the site generator, where it writes the site, and the command (each when known). */
interface Build {
  tool?: string;
  dir?: string;
  build?: string;
}

/** The first `key: "value"` (or `key = "value"`) in a config file's text, without a leading ./ */
const setting = (text: string, key: string) => text.match(new RegExp(`\\b${key}\\s*[:=]\\s*["'\`]([^"'\`]+)["'\`]`))?.[1].replace(/^\.\//, "");

/** The generator's output from package.json and its config, the build script with the project's package manager. */
export function detectBuild(cwd: string): Build {
  const has = (f: string) => fs.existsSync(join(cwd, f));
  const read = (f: string) => {
    try {
      return fs.readFileSync(join(cwd, f), "utf8");
    } catch {
      return "";
    }
  };
  const first = (files: string[]) => {
    for (const f of files) if (has(f)) return read(f);
    return "";
  };
  const configs = (base: string) => ["ts", "mts", "js", "mjs", "cjs"].map((x) => `${base}.${x}`);
  let pkg: any = {};
  try {
    pkg = JSON.parse(read("package.json") || "{}");
  } catch {}
  if (pkg.scripts?.build) {
    const build = has("bun.lock") || has("bun.lockb") ? "bun run build" : has("pnpm-lock.yaml") ? "pnpm build" : has("yarn.lock") ? "yarn build" : "npm run build";
    const dep = (n: string) => n in { ...pkg.dependencies, ...pkg.devDependencies };
    const out = (tool: string, dir: string) => ({ tool, dir, build });
    if (dep("next")) return out("Next.js (output: 'export')", setting(first(configs("next.config")), "distDir") ?? "out");
    if (dep("nuxt")) return out("Nuxt (nuxt generate)", ".output/public");
    if (dep("astro")) return out("Astro", setting(first(configs("astro.config")), "outDir") ?? "dist");
    if (dep("@sveltejs/kit")) return out("SvelteKit (adapter-static)", setting(first(configs("svelte.config")), "pages") ?? "build");
    if (dep("@angular/core")) {
      let dir = "dist";
      try {
        const b = Object.values<any>(JSON.parse(read("angular.json")).projects)[0]?.architect?.build;
        const path = b?.options?.outputPath;
        // The application builder (Angular 17+) puts the site in browser/ below outputPath.
        if (typeof path === "string") dir = /:application$/.test(b.builder ?? "") ? `${path}/browser` : path;
        else if (path?.base) dir = path.base;
      } catch {}
      return out("Angular", dir);
    }
    if (dep("gatsby")) return out("Gatsby", "public");
    if (dep("@docusaurus/core")) return out("Docusaurus", "build");
    if (dep("@11ty/eleventy")) return out("Eleventy", setting(first([".eleventy.js", "eleventy.config.js", "eleventy.config.mjs", "eleventy.config.cjs"]), "output") ?? "_site");
    if (dep("react-scripts")) return out("Create React App", "build");
    if (dep("@vue/cli-service")) return out("Vue CLI", setting(read("vue.config.js"), "outputDir") ?? "dist");
    if (dep("vite")) return out("Vite", setting(first(configs("vite.config")), "outDir") ?? "dist");
    if (dep("parcel")) return out("Parcel", "dist");
    return { build };
  }
  if (["hugo.toml", "hugo.yaml", "hugo.json"].some(has)) return { tool: "Hugo", dir: "public", build: "hugo --minify" };
  if (has("_config.yml") && read("Gemfile").includes("jekyll")) return { tool: "Jekyll", dir: "_site", build: "bundle exec jekyll build" };
  if (has("mkdocs.yml")) return { tool: "MkDocs", dir: setting(read("mkdocs.yml"), "site_dir") ?? "site", build: "mkdocs build" };
  return {};
}

/**
 * Pick the folder to publish: a site generator's output (even before its first build),
 * else the folder itself with an index.html, else the first build output containing one.
 */
export function detectStaticDir(cwd: string, b = detectBuild(cwd)): string {
  if (b.dir) return b.dir;
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
  /** Compose: its compose file. */
  compose?: string;
  /** Static: the folder with index.html, relative; undefined until a build makes it. */
  dir?: string;
  port?: number;
  /** A build script found in package.json, run with the project's package manager. */
  build?: string;
  /** The site generator that writes `dir`, e.g. Vite. */
  tool?: string;
  /** Its .landfall.json, when it was deployed before. */
  project?: ProjectConfig;
}

/** The project's compose file: set in .landfall.json, or the one `docker compose` would pick. */
export function composeFile(path: string, project?: Partial<ProjectConfig>): string | undefined {
  if (project?.compose) return project.compose;
  if (project?.image || project?.static) return undefined;
  return COMPOSE_FILES.find((f) => fs.existsSync(join(path, f)));
}

/** What `lf deploy` would do with a folder, without running anything. */
export function detectProject(path: string): Detected {
  const project = loadProject(path);
  const name = project?.name ?? slug(basename(path));
  const compose = composeFile(path, project);
  if (compose) return { path, name, kind: "compose", compose, project };
  if (project?.image && !project.static) return { path, name, kind: "image", port: project.port, project };
  const has = (f: string) => fs.existsSync(join(path, f));
  if (!project?.static && has("Dockerfile")) {
    return { path, name, kind: "dockerfile", port: project?.port ?? exposedPort(join(path, "Dockerfile")) ?? 3000, project };
  }
  const b = detectBuild(path);
  const found = project?.dir ?? detectStaticDir(path, b);
  const dir = found !== "." || has("index.html") ? found : undefined;
  return { path, name, kind: "static", dir, build: project?.build ?? b.build, tool: !project?.dir || project.dir === b.dir ? b.tool : undefined, project };
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
