import fs from "node:fs";
import { basename, join, resolve } from "node:path";
import { configDir, environmentOf, expandDomain, loadConfig, loadProject, mainDomain, saveProject, type ProjectConfig } from "./config";
import { analyze, COMPOSE_FILES, localCompose, routePlan, wantedVars, type Analysis, type RequiredVar, type SiteKind } from "./compose";
import { detectBuild, usesBun, type Build } from "./frameworks";
import { detectRuntime, files, head, nodeFrom, nodeStage, packageManager, tail, type Runtime } from "./runtimes";
import { localEnv } from "./remote";


const OUTPUT_DIRS = ["dist", "build", "out", "public", "_site", "site"];

/** Never in a Node.js app's image: local installs and build output (made again inside it). */
const APP_IGNORE = ["node_modules", ".git", ".next", ".nuxt", ".output", ".svelte-kit", ".vinxi", ".react-router", ".tanstack", ".astro"];

/**
 * The app in a folder: another language by its build files (Python, Go, Java, Ruby, PHP, Rust, .NET, Elixir),
 * else a Node.js or Bun server or server-rendering framework. `start` (saved or given) makes any folder one, a Node.js
 * app when nothing else is found. A framework named like its language (Go, Rust, …) is no framework: `tool` is unset.
 */
export function detectApp(root: string, start?: string, b?: Build): Runtime | undefined {
  const app = detectRuntime(root, start) ?? nodeApp(root, start, b ?? detectBuild(root));
  if (!app) return;
  return { ...app, start: start || app.start, tool: app.tool === app.name ? undefined : app.tool };
}

function nodeApp(root: string, start: string | undefined, b: Build): Runtime | undefined {
  start ||= b.start;
  if (!start) return;
  const bun = usesBun(files(root), start);
  const tool = b.start ? b.tool : undefined;
  // A start command of one's own runs the project as it is: nothing the framework would serve with (standalone, prepare, fix) applies.
  const fw = (s: string): Build => (s === b.start ? b : {});
  return {
    name: bun ? "Bun" : "Node.js", tool, build: b.build, start, port: 3000, ignore: APP_IGNORE, fix: fw(start).fix,
    dockerfile: (o) => nodeDockerfile(root, { tool, bun, standalone: fw(o.start).standalone, prepare: fw(o.start).prepare, ...o }),
  };
}

/**
 * A Dockerfile that installs, builds and starts a Node.js or Bun app, for a folder without one.
 * prepare: runs before the build, e.g. to switch SvelteKit to adapter-node.
 * standalone: a second stage takes only Next.js's standalone server (with the few modules it traced), its static files and public/.
 */
export function nodeDockerfile(cwd: string, o: { tool?: string; bun?: boolean; build?: string; start: string; port: number; standalone?: string; prepare?: string }): string {
  const f = files(cwd);
  const bun = o.bun ?? usesBun(f, o.start);
  return [
    head(o.tool),
    ...nodeStage(f, bun, o.standalone && "build"),
    ...(o.prepare ? [`RUN ${o.prepare}`] : []),
    ...(o.build ? [`RUN ${o.build}`] : []),
    ...(o.standalone
      ? [
          "",
          nodeFrom(f, bun),
          "WORKDIR /app",
          `COPY --from=build /app/${o.standalone}/standalone ./`,
          `COPY --from=build /app/${o.standalone}/static ./${o.standalone}/static`,
          ...(f.has("public") ? ["COPY --from=build /app/public ./public"] : []),
        ]
      : []),
    // Set after the build: dev dependencies (the build tools) install, and the frameworks read HOST/PORT.
    tail(o, "NODE_ENV=production HOST=0.0.0.0 HOSTNAME=0.0.0.0"),
  ].join("\n");
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

/** The port the image says it listens on: the last numeric EXPOSE, so a multi-stage file's final stage wins over a dev stage's. */
export function exposedPort(dockerfile: string): number | undefined {
  const all = [...fs.readFileSync(dockerfile, "utf8").matchAll(/^\s*EXPOSE\s+(\d+)/gim)];
  return all.length ? Number(all[all.length - 1][1]) : undefined;
}

export const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63) || "site";

/** One thing found in a project, shown as a chip: its language, its framework or site generator, a tool that installs or builds it. */
export interface Tag {
  label: string;
  role: "language" | "framework" | "tooling";
}

/** Languages by the files their tools keep, in the order mixed folders name them. */
const LANGUAGES: [string, string[]][] = [
  ["Go", ["go.mod"]], ["Rust", ["Cargo.toml"]], ["Java", ["pom.xml", "build.gradle", "build.gradle.kts"]], ["Elixir", ["mix.exs"]],
  ["PHP", ["composer.json", "index.php", "public/index.php"]], ["Python", ["pyproject.toml", "requirements.txt", "Pipfile", "setup.py", "manage.py"]],
  ["Ruby", ["Gemfile"]],
];

/** Package managers and build tools by their lockfile or build file. */
const TOOLING: [string, string[]][] = [
  ["uv", ["uv.lock"]], ["Poetry", ["poetry.lock"]], ["Pipenv", ["Pipfile"]], ["pip", ["requirements.txt"]],
  ["Maven", ["pom.xml"]], ["Gradle", ["build.gradle", "build.gradle.kts"]], ["Cargo", ["Cargo.toml"]], ["Bundler", ["Gemfile"]],
  ["Composer", ["composer.json"]], ["Mix", ["mix.exs"]],
];

/**
 * What a folder is made of: its languages, the framework (from `tool`, without its details:
 * "Spring Boot (Maven)" is Spring Boot, "Go (Gin)" is Gin), then its package managers and build tools.
 */
export function detectStack(path: string, runtime?: string, tool?: string): Tag[] {
  const f = files(path);
  const node = f.has("package.json");
  const languages = [
    ...(runtime ? [runtime] : []),
    // Kotlin keeps Java's build files.
    ...LANGUAGES.filter(([l, marks]) => marks.some(f.has) && !(l === "Java" && runtime === "Kotlin")).map(([l]) => l),
    ...(f.has("tsconfig.json") ? ["TypeScript"] : node && !runtime ? ["JavaScript"] : []),
  ];
  const [, base, detail] = tool?.match(/^(.+?)(?: \((.+)\))?$/) ?? [];
  // "Go (Gin)" names Gin; "Java (Maven)" names only a build tool, listed below.
  const framework = base && (languages.includes(base) ? (TOOLING.some(([t]) => t === detail) ? undefined : detail) : base);
  const tooling = [
    ...(node ? [packageManager(f.has, usesBun(f), f.pkg.packageManager).name] : []),
    ...TOOLING.filter(([, marks]) => marks.some(f.has)).map(([t]) => t),
    ...(composeFile(path) ? ["Docker Compose"] : f.has("Dockerfile") ? ["Dockerfile"] : []),
  ];
  const tags: Tag[] = [
    ...languages.map((label) => ({ label, role: "language" as const })),
    ...(framework ? [{ label: framework, role: "framework" as const }] : []),
    ...tooling.map((label) => ({ label, role: "tooling" as const })),
  ];
  // Bun is the runtime and the package manager; Java (Maven) names Maven twice.
  return tags.filter((t, i) => tags.findIndex((u) => u.label.toLowerCase() === t.label.toLowerCase()) === i);
}

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
  /** The site generator that writes `dir`, e.g. Vite; or the framework that runs the app. */
  tool?: string;
  /** An app without a Dockerfile: the command that starts it (landfall writes the Dockerfile). */
  start?: string;
  /** Such an app's language: Node.js, Python, Go, Java, … */
  runtime?: string;
  /** What such an app needs that landfall cannot know, e.g. a secret in the site's .env. */
  note?: string;
  /** Folders in the container kept across deploys: saved, else what the app needs (Rails' SQLite in storage/). */
  volumes?: string[];
  /** It runs without a port or a domain. */
  worker?: boolean;
  /** It has a package.json: it could run as a Node.js app. */
  node?: boolean;
  /** Compose: its services as a deploy reads them (auto mode without x-landfall), or why the file cannot be read. */
  analysis?: Analysis & {
    routes: { service: string; port: number; domains: string[]; main?: boolean }[];
    /** Each service's image or build context and volumes, as the file says: shown before a deploy. */
    about?: Record<string, { image?: string; build?: string; volumes?: string[] }>;
  };
  /** What the site's .env on the server should set: its compose file's `${NAME:?…}`, an example .env's keys (none for static).
   * local: the project's own .env has a value for it, which `deploy --local-env` takes. */
  required?: (RequiredVar & { local?: boolean })[];
  /** Its .landfall.json, when it was deployed before. */
  project?: ProjectConfig;
  /** Its languages, framework and tools, for the chips that show what landfall found. */
  stack: Tag[];
}

/** The project's compose file: set in .landfall.json, or the one `docker compose` would pick. */
export function composeFile(path: string, project?: Partial<ProjectConfig>): string | undefined {
  if (project?.compose) return project.compose;
  if (project?.image || project?.static) return undefined;
  return COMPOSE_FILES.find((f) => fs.existsSync(join(path, f)));
}

/** What `lf deploy` would do with a folder, without running anything. */
/**
 * The local compose file read as a deploy would: routes and private ports, with the site's domains (saved, else
 * `<name>.<server domain>` as on a first deploy) and dotless names under the server's main domain.
 */
function analyzeLocal(path: string, file: string, project?: ProjectConfig): Detected["analysis"] {
  const cfg = loadConfig();
  const server = cfg.servers[project?.server ?? cfg.default ?? ""] ?? (Object.keys(cfg.servers).length === 1 ? Object.values(cfg.servers)[0] : undefined);
  const expand = (d: string) => (server && (d === "@" || !d.includes(".")) && mainDomain(server) ? expandDomain(d, server) : d);
  try {
    const config = localCompose(path, file);
    const a = analyze(config, resolve(path), expand, { auto: true });
    const about = Object.fromEntries(
      Object.entries<any>(config?.services ?? {}).map(([n, s]) => [
        n,
        {
          image: typeof s?.image === "string" ? s.image : undefined,
          build: s?.build ? (typeof s.build === "string" ? s.build : (s.build.context ?? ".")) : undefined,
          volumes: (Array.isArray(s?.volumes) ? s.volumes : []).map((v: any) => (typeof v === "string" ? v : [v?.source, v?.target].filter(Boolean).join(":"))),
        },
      ]),
    );
    const main = server && mainDomain(server);
    const site = project?.domains?.length ? project.domains.map(expand) : main ? [`${project?.name ?? slug(basename(path))}.${main}`] : ["<site domain>"];
    return { ...a, routes: routePlan(a.services, site), about };
  } catch (e: any) {
    return { services: [], errors: [`cannot read ${file}: ${e?.message ?? e}`], warnings: [], notes: [], routes: [] };
  }
}

export function detectProject(path: string): Detected {
  const project = loadProject(path);
  const name = project?.name ?? slug(basename(path));
  const compose = composeFile(path, project);
  // A compose file or Dockerfile decides how it runs; the app inside still names the framework.
  const appStack = () => {
    const app = detectApp(path, project?.start);
    return detectStack(path, app?.name, app?.tool);
  };
  const wanted = (files?: string[]) => {
    try {
      const local = localEnv(path);
      return wantedVars(path, files).map((v) => (local[v.name] ? { ...v, local: true } : v));
    } catch {
      return [];
    }
  };
  if (compose) {
    return { path, name, kind: "compose", compose, analysis: analyzeLocal(path, compose, project), required: wanted([compose]), project, stack: appStack() };
  }
  const runs = { volumes: project?.volumes, worker: project?.worker, required: wanted() };
  if (project?.image && !project.static) return { path, name, kind: "image", port: project.port, ...runs, project, stack: detectStack(path) };
  const has = (f: string) => fs.existsSync(join(path, f));
  if (!project?.static && has("Dockerfile")) {
    return { path, name, kind: "dockerfile", port: project?.port ?? exposedPort(join(path, "Dockerfile")) ?? 3000, ...runs, project, stack: appStack() };
  }
  const b = detectBuild(path);
  const found = project?.dir ?? detectStaticDir(path, b);
  const dir = found !== "." || has("index.html") ? found : undefined;
  const node = has("package.json");
  const app = project?.static ? undefined : detectApp(path, project?.start, b);
  if (app) {
    const { name: runtime, tool, start, fix, note: hint } = app;
    const note = fix ?? hint;
    return { path, name, kind: "dockerfile", runtime, tool, start, note, build: project?.build ?? app.build, port: project?.port ?? app.port, dir, node, ...runs, volumes: project?.volumes ?? app.volumes, project, stack: detectStack(path, runtime, tool) };
  }
  const tool = !project?.dir || project.dir === b.dir ? b.tool : undefined;
  return { path, name, kind: "static", node, dir, build: project?.build ?? b.build, tool, project, stack: detectStack(path, undefined, tool) };
}

// ---------------------------------------------------------------- remembered projects

export interface Remembered {
  path: string;
  name: string;
  server: string;
  domains: string[];
  kind: SiteKind;
  /** The environment of .landfall.json it was deployed as (lf deploy -E). */
  environment?: string;
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
  // One entry per folder and environment: staging and production deploy from the same folder.
  const list = [{ ...p, path, at: new Date().toISOString() }, ...loadProjects().filter((x) => x.path !== path || (x.environment ?? "") !== (p.environment ?? ""))].slice(0, 50);
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(PROJECTS, JSON.stringify(list, null, 2) + "\n", { mode: 0o600 });
}

/** Keep remembered projects and their .landfall.json in step after a site's domains changed on the server. */
export function updateProjectDomains(server: string, name: string, domains: string[]) {
  const list = loadProjects();
  for (const p of list.filter((p) => p.server === server && p.name === name)) {
    p.domains = domains;
    const env = environmentOf(p.path, name);
    const cfg = env === undefined ? undefined : loadProject(p.path, env);
    if (cfg?.name === name) saveProject(p.path, { ...cfg, domains }, env);
  }
  if (list.length) fs.writeFileSync(PROJECTS, JSON.stringify(list, null, 2) + "\n", { mode: 0o600 });
}
