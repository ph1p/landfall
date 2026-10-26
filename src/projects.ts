import fs from "node:fs";
import { basename, join, resolve } from "node:path";
import { configDir, loadProject, saveProject, type ProjectConfig } from "./config";
import { COMPOSE_FILES, type SiteKind } from "./compose";
import { detectRuntime, packageManager, type Runtime } from "./runtimes";

const OUTPUT_DIRS = ["dist", "build", "out", "public", "_site", "site"];

/**
 * How a folder builds: the site generator, where it writes the site, and the command (each when known).
 * start: the framework renders on a server: it runs in a Node.js container with this command instead.
 */
interface Build {
  tool?: string;
  dir?: string;
  build?: string;
  start?: string;
}

/** The first `key: "value"` (or `key = "value"`) in a config file's text, without a leading ./ */
const setting = (text: string, key: string) => text.match(new RegExp(`\\b${key}\\s*[:=]\\s*["'\`]([^"'\`]+)["'\`]`))?.[1].replace(/^\.\//, "");

const reader = (cwd: string) => {
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
  let pkg: any = {};
  try {
    pkg = JSON.parse(read("package.json") || "{}");
  } catch {}
  return { has, read, first, pkg };
};

const configs = (base: string) => ["ts", "mts", "js", "mjs", "cjs"].map((x) => `${base}.${x}`);

/** Packages that make a package.json a server of its own: HTTP, WebSocket and realtime servers. */
const SERVERS = [
  "express", "fastify", "koa", "hono", "@hono/node-server", "@nestjs/core", "h3", "@adonisjs/core", "polka", "restify", "@hapi/hapi", "elysia",
  "@apollo/server", "graphql-yoga", "@feathersjs/feathers", "ws", "socket.io", "uWebSockets.js", "@hocuspocus/server", "y-websocket", "colyseus", "peer",
];

/** Commands that serve files while developing, or a desktop or mobile app: a start script with one is no server. */
const DEV_TOOLS = new Set([
  "vite", "react-scripts", "parcel", "webpack", "webpack-dev-server", "vue-cli-service", "ng", "serve", "http-server", "live-server", "lite-server",
  "browser-sync", "gatsby", "docusaurus", "eleventy", "astro", "hugo", "expo", "react-native", "electron", "electron-forge", "storybook",
  "start-storybook", "tauri", "snowpack", "nuxt", "ember", "next", "hexo", "vuepress", "vitepress", "quasar", "ionic", "slidev",
]);

/** Whether a start script runs a server, not a dev server, a static file server or `npm run dev`. */
function startsServer(script: string) {
  return script.split(/&&|\|\||;/).every((part) => {
    const words = part.trim().split(/\s+/).filter((w) => !/^\w+=/.test(w) && !["npx", "cross-env", "env", "bunx", "pnpx", "dotenv", "--"].includes(w));
    return !DEV_TOOLS.has(words[0] ?? "") && !/\bdev\b/.test(part);
  });
}

/** The generator's output from package.json and its config, the build script with the project's package manager. */
export function detectBuild(cwd: string): Build {
  const { has, read, first, pkg } = reader(cwd);
  const scripts = pkg.scripts ?? {};
  const dep = (n: string) => n in { ...pkg.dependencies, ...pkg.devDependencies };
  // A server without a start script: its main file, or one of the usual names.
  const entry = !scripts.start && SERVERS.some(dep) ? [pkg.main, "server.js", "server.mjs", "index.js", "index.mjs", "app.js", "main.js"].find((f) => f && has(f)) : undefined;
  if (scripts.build || scripts.start || entry) {
    const pm = packageManager(has);
    const build: string | undefined = scripts.build ? pm.run("build") : undefined;
    const bin = (cmd: string) => `./node_modules/.bin/${cmd}`;
    const out = (tool: string, dir: string) => ({ tool, dir, build });
    const server = (tool: string, start: string) => ({ tool, build, start });
    // Nitro (Nuxt, TanStack Start, SolidStart) writes a server that needs nothing else.
    const nitro = ".output/server/index.mjs";
    if (dep("next")) {
      const conf = first(configs("next.config"));
      if (/\boutput\s*:\s*["'`]export["'`]/.test(conf)) return out("Next.js (output: 'export')", setting(conf, "distDir") ?? "out");
      return server("Next.js", `${bin("next")} start`);
    }
    if (dep("nuxt")) return /\bnuxt\s+generate\b/.test(scripts.build ?? "") ? out("Nuxt (nuxt generate)", ".output/public") : server("Nuxt", `node ${nitro}`);
    if (["@tanstack/react-start", "@tanstack/solid-start", "@tanstack/start"].some(dep)) return server("TanStack Start", scripts.start ? pm.run("start") : `node ${nitro}`);
    if (dep("@solidjs/start")) return server("SolidStart", scripts.start ? pm.run("start") : `node ${nitro}`);
    if (dep("@react-router/dev")) {
      if (/\bssr\s*:\s*false\b/.test(first(configs("react-router.config")))) return out("React Router (ssr: false)", "build/client");
      return server("React Router", scripts.start ? pm.run("start") : `${bin("react-router-serve")} ./build/server/index.js`);
    }
    if (dep("@remix-run/dev")) return server("Remix", scripts.start ? pm.run("start") : `${bin("remix-serve")} ./build/server/index.js`);
    if (dep("astro")) {
      const conf = first(configs("astro.config"));
      const dir = setting(conf, "outDir") ?? "dist";
      return dep("@astrojs/node") ? server("Astro (Node adapter)", `node ./${dir}/server/entry.mjs`) : out("Astro", dir);
    }
    if (dep("@sveltejs/kit")) {
      const conf = first(configs("svelte.config"));
      if (dep("@sveltejs/adapter-node") || conf.includes("adapter-node")) return server("SvelteKit (adapter-node)", `node ${setting(conf, "out") ?? "build"}`);
      return out("SvelteKit (adapter-static)", setting(conf, "pages") ?? "build");
    }
    if (dep("@angular/core")) {
      let dir = "dist";
      try {
        const b = Object.values<any>(JSON.parse(read("angular.json")).projects)[0]?.architect?.build;
        const path = b?.options?.outputPath;
        const base = typeof path === "string" ? path : path?.base;
        // The application builder (Angular 17+) puts the site in browser/ below outputPath, the server in server/.
        if (typeof path === "string") dir = /:application$/.test(b.builder ?? "") ? `${path}/browser` : path;
        else if (base) dir = `${base}/browser`;
        if (base && b?.options?.ssr) return server("Angular (SSR)", `node ${base}/server/server.mjs`);
      } catch {}
      return out("Angular", dir);
    }
    if (entry) return server("Node.js", `node ${entry}`);
    if (scripts.start && (SERVERS.some(dep) || startsServer(scripts.start))) return server("Node.js", scripts["start:prod"] ? pm.run("start:prod") : pm.run("start"));
    if (scripts.build) {
      if (dep("gatsby")) return out("Gatsby", "public");
      if (dep("@docusaurus/core")) return out("Docusaurus", "build");
      if (dep("@11ty/eleventy")) return out("Eleventy", setting(first([".eleventy.js", "eleventy.config.js", "eleventy.config.mjs", "eleventy.config.cjs"]), "output") ?? "_site");
      if (dep("react-scripts")) return out("Create React App", "build");
      if (dep("@vue/cli-service")) return out("Vue CLI", setting(read("vue.config.js"), "outputDir") ?? "dist");
      if (dep("vite")) return out("Vite", setting(first(configs("vite.config")), "outDir") ?? "dist");
      if (dep("parcel")) return out("Parcel", "dist");
      return { build };
    }
    return {};
  }
  if (["hugo.toml", "hugo.yaml", "hugo.json"].some(has)) return { tool: "Hugo", dir: "public", build: "hugo --minify" };
  if (has("_config.yml") && read("Gemfile").includes("jekyll")) return { tool: "Jekyll", dir: "_site", build: "bundle exec jekyll build" };
  if (has("mkdocs.yml")) return { tool: "MkDocs", dir: setting(read("mkdocs.yml"), "site_dir") ?? "site", build: "mkdocs build" };
  return {};
}

/** Never in a Node.js app's image: local installs and build output (made again inside it). */
export const APP_IGNORE = ["node_modules", ".git", ".next", ".nuxt", ".output", ".svelte-kit", ".vinxi", ".react-router", ".tanstack", ".astro"];

/** An app landfall writes the Dockerfile for: what runs it, how it builds and starts, its default port. */
export interface App {
  /** The language: Node.js, Python, Go, Java, … */
  runtime: string;
  tool?: string;
  build?: string;
  start: string;
  port: number;
  ignore: string[];
  note?: string;
  secret?: string;
  /** Another language than JavaScript: writes its Dockerfile. */
  other?: Runtime;
}

/**
 * The app in a folder: another language by its build files (Python, Go, Java, Ruby, PHP, Rust, .NET, Elixir, Deno),
 * else a Node.js server or server-rendering framework. `start` (saved or given) makes any folder one, a Node.js app
 * when nothing else is found.
 */
export function detectApp(root: string, start?: string): App | undefined {
  const r = detectRuntime(root);
  if (r) return { runtime: r.name, tool: r.tool, build: r.build, start: start || r.start, port: r.port, ignore: r.ignore, note: r.note, secret: r.secret, other: r };
  const b = detectBuild(root);
  start ||= b.start;
  return start ? { runtime: "Node.js", tool: b.start ? b.tool : undefined, build: b.build, start, port: 3000, ignore: APP_IGNORE } : undefined;
}

/** The Dockerfile that builds and starts an app, with its build and start commands as given. */
export function appDockerfile(cwd: string, app: App, o: { build?: string; start: string; port: number }): string {
  return app.other ? app.other.dockerfile(o) : nodeDockerfile(cwd, { tool: app.tool, ...o });
}

/**
 * A Dockerfile that installs, builds and starts a Node.js app, for a folder without one.
 * The image follows .nvmrc / .node-version; dependencies install in a layer of their own, so a redeploy that
 * changes no dependency skips it, unless install scripts or workspaces need the whole project.
 */
export function nodeDockerfile(cwd: string, o: { tool?: string; build?: string; start: string; port: number }): string {
  const { has, read, pkg } = reader(cwd);
  const pm = packageManager(has);
  const major = (read(".nvmrc") || read(".node-version")).trim().match(/^v?(\d+)/)?.[1] ?? "24";
  const lock = ["bun.lock", "bun.lockb", "pnpm-lock.yaml", "yarn.lock", "package-lock.json"].find(has);
  const scripts = pkg.scripts ?? {};
  const whole = !!pkg.workspaces || ["pnpm-workspace.yaml", ".yarnrc.yml", "patches"].some(has) || ["preinstall", "install", "postinstall", "prepare"].some((s) => s in scripts);
  const install = !has("package.json")
    ? undefined
    : pm.name === "npm" ? (lock ? "npm ci" : "npm install")
    : pm.name === "yarn" ? `yarn install${lock ? " --frozen-lockfile" : ""}`
    : `${pm.name} install${lock ? " --frozen-lockfile" : ""}`;
  const manifests = ["package.json", lock, ...[".npmrc", ".yarnrc", "bunfig.toml"].filter(has)].filter(Boolean);
  return [
    `# Generated by landfall${o.tool ? ` for ${o.tool}` : ""}: \`lf init\` writes it into the project, to change it there.`,
    `FROM node:${major}-slim`,
    "WORKDIR /app",
    ...(pm.name === "bun" || /^bunx?\b/.test(o.start) ? ["RUN npm install -g bun"] : pm.name !== "npm" ? [`RUN corepack enable || npm install -g ${pm.name}`] : []),
    ...(install && !whole ? [`COPY ${manifests.join(" ")} ./`, `RUN ${install}`, "COPY . ."] : ["COPY . .", ...(install ? [`RUN ${install}`] : [])]),
    ...(o.build ? [`RUN ${o.build}`] : []),
    // Set after the build: dev dependencies (the build tools) install, and the frameworks read HOST/PORT.
    `ENV NODE_ENV=production HOST=0.0.0.0 HOSTNAME=0.0.0.0 PORT=${o.port}`,
    `EXPOSE ${o.port}`,
    `CMD ${o.start}`,
    "",
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
  /** The site generator that writes `dir`, e.g. Vite; or the framework that runs the app. */
  tool?: string;
  /** An app without a Dockerfile: the command that starts it (landfall writes the Dockerfile). */
  start?: string;
  /** Such an app's language: Node.js, Python, Go, Java, … */
  runtime?: string;
  /** What such an app needs that landfall cannot know, e.g. a secret in the site's .env. */
  note?: string;
  /** It has a package.json: it could run as a Node.js app. */
  node?: boolean;
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
  const node = has("package.json");
  const app = project?.static ? undefined : detectApp(path, project?.start);
  if (app) {
    const { runtime, tool, start, note } = app;
    return { path, name, kind: "dockerfile", runtime, tool, start, note, build: project?.build ?? app.build, port: project?.port ?? app.port, dir, node, project };
  }
  return { path, name, kind: "static", node, dir, build: project?.build ?? b.build, tool: !project?.dir || project.dir === b.dir ? b.tool : undefined, project };
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
