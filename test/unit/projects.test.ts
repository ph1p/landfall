import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { detectApp, detectStaticDir, nodeDockerfile } from "../../src/core/projects";
import { detectBuild } from "../../src/core/frameworks";
import { nodeMajor } from "../../src/core/runtimes";
import { baseImages, detectProject } from "../../src/core/projects";
import { safeParts } from "../../src/ui/server/local";

const tmp = () => fs.mkdtempSync(join(tmpdir(), "landfall-test-"));

describe("folders and access", () => {
  test("detects what a folder deploys as", () => {
    const d = tmp();
    fs.writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { build: "vite build" } }));
    fs.writeFileSync(join(d, "pnpm-lock.yaml"), "");
    expect(detectProject(d)).toMatchObject({ kind: "static", build: "pnpm build", dir: undefined });
    fs.mkdirSync(join(d, "dist"));
    fs.writeFileSync(join(d, "dist/index.html"), "");
    expect(detectProject(d)).toMatchObject({ kind: "static", dir: "dist" });
    fs.writeFileSync(join(d, "Dockerfile"), "FROM x\nEXPOSE 8080\n");
    expect(detectProject(d)).toMatchObject({ kind: "dockerfile", port: 8080, images: [{ ref: "x", service: "app", base: true }] });
  });

  test("the images a deploy pulls", () => {
    // Own stages and scratch are no images; ARG defaults fill the FROM.
    expect(
      baseImages("ARG NODE=24\nFROM node:${NODE}-slim AS build\nFROM build AS test\nfrom --platform=linux/amd64 nginx:alpine\nFROM scratch\nFROM node:24-slim"),
    ).toEqual(["node:24-slim", "nginx:alpine"]);
    const d = tmp();
    fs.mkdirSync(join(d, "web"));
    fs.writeFileSync(join(d, "web/Web.Dockerfile"), "FROM python:3.13-slim\n");
    fs.writeFileSync(join(d, "compose.yaml"), "services:\n  web:\n    build: { context: web, dockerfile: Web.Dockerfile }\n  db:\n    image: postgres:17\n");
    expect(detectProject(d).images).toEqual([
      { ref: "python:3.13-slim", service: "web", base: true },
      { ref: "postgres:17", service: "db" },
    ]);
    const s = tmp();
    fs.writeFileSync(join(s, "index.html"), "");
    expect(detectProject(s).images).toEqual([{ ref: "nginx:alpine", service: "web" }]);
  });

  test("names a folder's languages, framework and tools", () => {
    const labels = (d: string) => detectProject(d).stack.map((t) => `${t.role}:${t.label}`);
    const v = tmp();
    fs.writeFileSync(join(v, "package.json"), JSON.stringify({ scripts: { build: "vite build" }, devDependencies: { vite: "7" } }));
    fs.writeFileSync(join(v, "tsconfig.json"), "{}");
    fs.writeFileSync(join(v, "pnpm-lock.yaml"), "");
    expect(labels(v)).toEqual(["language:TypeScript", "framework:Vite", "tooling:pnpm"]);
    const py = tmp();
    fs.writeFileSync(join(py, "pyproject.toml"), "[project]\ndependencies = ['fastapi']\n");
    fs.writeFileSync(join(py, "uv.lock"), "");
    fs.writeFileSync(join(py, "main.py"), "app = FastAPI()\n");
    expect(labels(py)).toEqual(["language:Python", "framework:FastAPI", "tooling:uv"]);
    const j = tmp();
    fs.writeFileSync(join(j, "pom.xml"), "<project></project>");
    fs.writeFileSync(join(j, "Dockerfile"), "FROM x\n");
    // "Java (Maven)" names no framework, and Maven only once
    expect(labels(j)).toEqual(["language:Java", "tooling:Maven", "tooling:Dockerfile"]);
    // a compose file runs it, but the framework still shows
    const n = tmp();
    fs.writeFileSync(join(n, "package.json"), JSON.stringify({ scripts: { build: "next build", start: "next start" }, dependencies: { next: "16" } }));
    fs.writeFileSync(join(n, "compose.yaml"), "services:\n  web:\n    build: .\n");
    expect(labels(n)).toContain("framework:Next.js");
    fs.writeFileSync(join(n, "compose.yaml"), "services:\n  web:\n    build: .\n    environment: { PW: ${PW:?set PW} }\n");
    expect(detectProject(n).required).toEqual([{ name: "PW", from: "compose.yaml", message: "set PW", strict: true }]);
    // the project's own .env has it: deploy --local-env may take it, an empty value counts as none
    fs.writeFileSync(join(n, ".env"), 'PW=""\n');
    expect(detectProject(n).required?.[0].local).toBeUndefined();
    fs.writeFileSync(join(n, ".env"), "# local\nexport PW=secret\n");
    expect(detectProject(n).required?.[0]).toMatchObject({ name: "PW", local: true });
    fs.rmSync(join(n, ".env"));
    fs.writeFileSync(join(n, "compose.yaml"), "services:\n  web:\n    build: .\n    volumes: [data:/data]\n  db: { image: postgres }\n");
    expect(detectProject(n).analysis?.about).toEqual({ web: { build: ".", volumes: ["data:/data"] }, db: { image: "postgres", volumes: [] } });
    // a folder named like the volume fills it only when the upload leaves it out, and it has files
    fs.mkdirSync(join(n, "data"));
    fs.writeFileSync(join(n, "data", "a.txt"), "x");
    expect(detectProject(n).seeds).toBeUndefined();
    fs.writeFileSync(join(n, ".landfall.json"), JSON.stringify({ exclude: ["/data/"] }));
    expect(detectProject(n).seeds).toEqual(["data"]);
  });
  test("the publish folder comes from the site generator, before its first build", () => {
    const d = tmp();
    const pkg = (deps: Record<string, string>, scripts: Record<string, string> = { build: "x" }) =>
      fs.writeFileSync(join(d, "package.json"), JSON.stringify({ scripts, devDependencies: deps }));
    fs.writeFileSync(join(d, "index.html"), "<script type=module src=/main.js>");
    pkg({ vite: "7" });
    expect(detectStaticDir(d)).toBe("dist");
    expect(detectProject(d)).toMatchObject({ kind: "static", dir: "dist", tool: "Vite", build: "npm run build" });
    fs.writeFileSync(join(d, "vite.config.ts"), "export default { build: { outDir: './www' } }");
    expect(detectBuild(d)).toEqual({ tool: "Vite", dir: "www", build: "npm run build" });
    pkg({ "@sveltejs/kit": "2", "@sveltejs/adapter-static": "3", vite: "7" });
    expect(detectStaticDir(d)).toBe("build");
    pkg({ next: "15" });
    fs.writeFileSync(join(d, "next.config.mjs"), "export default { output: 'export' }");
    expect(detectStaticDir(d)).toBe("out");
    fs.rmSync(join(d, "next.config.mjs"));
    pkg({ astro: "5" });
    expect(detectStaticDir(d)).toBe("dist");
    // no build script: a plain folder with its index.html
    fs.writeFileSync(join(d, "package.json"), JSON.stringify({ devDependencies: { vite: "7" } }));
    expect(detectStaticDir(d)).toBe(".");
    pkg({ vitepress: "1" }, { build: "vitepress build docs" });
    expect(detectStaticDir(d)).toBe("docs/.vitepress/dist");
    pkg({ vitepress: "1" }, { build: "vitepress build" });
    expect(detectStaticDir(d)).toBe(".vitepress/dist");
    pkg({ hexo: "7" });
    expect(detectBuild(d)).toMatchObject({ tool: "Hexo", dir: "public" });
    pkg({ "@quasar/app-vite": "2" });
    expect(detectStaticDir(d)).toBe("dist/spa");
    const z = tmp();
    fs.writeFileSync(join(z, "book.toml"), "[book]\ntitle = 'x'\n");
    expect(detectBuild(z)).toEqual({ tool: "mdBook", dir: "book", build: "mdbook build" });
    fs.rmSync(join(z, "book.toml"));
    fs.writeFileSync(join(z, "config.toml"), "base_url = 'https://x.dev'\n");
    fs.mkdirSync(join(z, "templates"));
    expect(detectBuild(z)).toEqual({ tool: "Zola", dir: "public", build: "zola build" });
    const h = tmp();
    fs.writeFileSync(join(h, "hugo.toml"), "title = 'x'");
    expect(detectProject(h)).toMatchObject({ kind: "static", dir: "public", tool: "Hugo", build: "hugo --minify" });
  });
  test("server-rendering frameworks run as Node.js apps", () => {
    const d = tmp();
    const pkg = (deps: Record<string, string>, scripts: Record<string, string> = { build: "x" }) =>
      fs.writeFileSync(join(d, "package.json"), JSON.stringify({ scripts, dependencies: deps }));
    const start = () => detectBuild(d).start;
    pkg({ next: "15" });
    expect(detectBuild(d)).toEqual({ tool: "Next.js", build: "npm run build", start: "./node_modules/.bin/next start" });
    // output: 'standalone' runs the server Next.js writes; the image keeps only it, its static files and public/
    fs.writeFileSync(join(d, "next.config.ts"), "export default { output: 'standalone' }");
    fs.mkdirSync(join(d, "public"));
    expect(detectBuild(d)).toEqual({ tool: "Next.js (output: 'standalone')", build: "npm run build", start: "node server.js", standalone: ".next" });
    const img = detectApp(d)!.dockerfile({ build: "npm run build", start: "node server.js", port: 3000 });
    expect(img).toContain("FROM node:24-slim AS build\n");
    expect(img).toContain(
      "RUN npm run build\n\nFROM node:24-slim\nWORKDIR /app\nCOPY --from=build /app/.next/standalone ./\nCOPY --from=build /app/.next/static ./.next/static\nCOPY --from=build /app/public ./public\n",
    );
    expect(img).toMatch(/HOSTNAME=0\.0\.0\.0 PORT=3000\nEXPOSE 3000\nCMD node server\.js\n$/);
    // a start command of one's own runs in the whole project
    expect(detectApp(d, "npm start")!.dockerfile({ start: "npm start", port: 3000 })).not.toContain("COPY --from=build");
    fs.rmSync(join(d, "next.config.ts"));
    fs.rmSync(join(d, "public"), { recursive: true });
    // a start script running a file of its own is a custom server
    pkg({ next: "16" }, { build: "next build", start: "node scripts/serve.ts" });
    expect(detectBuild(d)).toMatchObject({ tool: "Next.js (custom server)", start: "node scripts/serve.ts" });
    pkg({ next: "16" }, { build: "next build", start: "NODE_ENV=production tsx server.ts" });
    expect(start()).toBe("npm start");
    pkg({ next: "16" }, { build: "next build", start: "next start -p 3000" });
    expect(start()).toBe("./node_modules/.bin/next start");
    pkg({ nuxt: "4" }, { build: "nuxt build" });
    expect(start()).toBe("node .output/server/index.mjs");
    pkg({ nuxt: "4" }, { build: "nuxt generate" });
    expect(detectBuild(d)).toEqual({ tool: "Nuxt (nuxt generate)", dir: ".output/public", build: "npm run build" });
    pkg({ "@tanstack/react-start": "1", vite: "7" }, { build: "vite build", start: "node .output/server/index.mjs" });
    expect(detectBuild(d)).toMatchObject({ tool: "TanStack Start", start: "npm start" });
    pkg({ "@sveltejs/kit": "2", "@sveltejs/adapter-node": "5" });
    expect(start()).toBe("node build");
    pkg({ astro: "5", "@astrojs/node": "9" });
    expect(start()).toBe("node ./dist/server/entry.mjs");
    pkg({ "@react-router/dev": "7" });
    expect(start()).toBe("./node_modules/.bin/react-router-serve ./build/server/index.js");
    fs.writeFileSync(join(d, "react-router.config.ts"), "export default { ssr: false }");
    expect(detectBuild(d)).toEqual({ tool: "React Router (ssr: false)", dir: "build/client", build: "npm run build" });
    pkg({ "@sveltejs/kit": "2", "svelte-adapter-bun": "0" });
    expect(start()).toBe("bun ./build/index.js");
    // adapter-auto builds nothing a server runs: the image switches it to adapter-node first
    pkg({ "@sveltejs/kit": "2", "@sveltejs/adapter-auto": "6" });
    fs.writeFileSync(join(d, "svelte.config.js"), "import adapter from '@sveltejs/adapter-auto';\nexport default { kit: { adapter: adapter() } };");
    expect(detectBuild(d)).toMatchObject({ tool: "SvelteKit (adapter-auto, built with adapter-node)", start: "node build" });
    expect(detectApp(d)!.dockerfile({ build: "npm run build", start: "node build", port: 3000 })).toContain(
      "COPY . .\nRUN npm install -D @sveltejs/adapter-node && sed -i 's#@sveltejs/adapter-auto#@sveltejs/adapter-node#' svelte.config.js\nRUN npm run build\n",
    );
    fs.rmSync(join(d, "svelte.config.js"));
    pkg({ "@analogjs/platform": "1" });
    expect(start()).toBe("node dist/analog/server/index.mjs");
    pkg({ "@adonisjs/core": "6" }, { build: "node ace build", start: "node bin/server.js" });
    expect(detectBuild(d)).toMatchObject({ tool: "AdonisJS", start: "node build/bin/server.js" });
    // Nuxt's server on Bun, or its static preset
    pkg({ nuxt: "4" }, { build: "nuxt build" });
    fs.writeFileSync(join(d, "nuxt.config.ts"), "export default defineNuxtConfig({ nitro: { preset: 'bun' } })");
    expect(start()).toBe("bun .output/server/index.mjs");
    fs.writeFileSync(join(d, "nuxt.config.ts"), "export default defineNuxtConfig({ nitro: { preset: 'static' } })");
    expect(detectBuild(d)).toMatchObject({ tool: "Nuxt (nuxt generate)", dir: ".output/public" });
    fs.rmSync(join(d, "nuxt.config.ts"));
    // Qwik City: its adapter decides
    pkg({ "@builder.io/qwik-city": "1" });
    fs.mkdirSync(join(d, "adapters/express"), { recursive: true });
    expect(start()).toBe("node server/entry.express");
    fs.rmSync(join(d, "adapters"), { recursive: true });
    fs.mkdirSync(join(d, "adapters/static"), { recursive: true });
    expect(detectBuild(d)).toMatchObject({ tool: "Qwik City (static)", dir: "dist" });
    fs.rmSync(join(d, "adapters"), { recursive: true });
    // without an adapter it cannot deploy: it says how to add one, unless a start command of one's own is given
    expect(detectApp(d)!.fix).toMatch(/needs an adapter.*npm run qwik add/);
    expect(detectApp(d, "node srv.js")!.fix).toBeUndefined();
    // a server of its own needs no build script
    pkg({ express: "5" }, { start: "node server.js" });
    expect(detectBuild(d)).toEqual({ tool: undefined, build: undefined, start: "npm start" });
    expect(detectProject(d)).toMatchObject({ kind: "dockerfile", runtime: "Node.js", tool: undefined, start: "npm start", port: 3000, node: true });
    // saved as static, it stays static; a saved start command makes any folder an app
    fs.writeFileSync(join(d, ".landfall.json"), JSON.stringify({ name: "x", domains: [], static: true }));
    expect(detectProject(d)).toMatchObject({ kind: "static", node: true });
    expect(detectProject(d).start).toBeUndefined();
    pkg({ vite: "7" });
    fs.writeFileSync(join(d, ".landfall.json"), JSON.stringify({ name: "x", domains: [], start: "node srv.js", port: 8080 }));
    expect(detectProject(d)).toMatchObject({ kind: "dockerfile", start: "node srv.js", tool: undefined, port: 8080, build: "npm run build" });
    // saved volumes and worker come back, for an app as for a Dockerfile
    fs.writeFileSync(join(d, ".landfall.json"), JSON.stringify({ name: "x", domains: [], start: "node worker.js", worker: true, volumes: ["/app/data"] }));
    expect(detectProject(d)).toMatchObject({ kind: "dockerfile", worker: true, volumes: ["/app/data"] });
    fs.writeFileSync(join(d, "Dockerfile"), "FROM x\n");
    expect(detectProject(d)).toMatchObject({ kind: "dockerfile", worker: true, volumes: ["/app/data"] });
    // saved empty (--volume ''): no volumes, not the app's defaults
    const rails = tmp();
    fs.writeFileSync(join(rails, "Gemfile"), "gem 'rails'\ngem 'sqlite3'\n");
    fs.mkdirSync(join(rails, "config"));
    fs.writeFileSync(join(rails, "config/application.rb"), "");
    fs.writeFileSync(join(rails, "config/database.yml"), "production:\n  database: storage/production.sqlite3\n");
    expect(detectProject(rails).volumes).toEqual(["/app/storage"]);
    fs.writeFileSync(join(rails, ".landfall.json"), JSON.stringify({ name: "x", domains: [], volumes: [] }));
    expect(detectProject(rails).volumes).toEqual([]);
  });

  test("the Dockerfile for a Node.js app", () => {
    const d = tmp();
    fs.writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { build: "next build" } }));
    fs.writeFileSync(join(d, "pnpm-lock.yaml"), "");
    fs.writeFileSync(join(d, ".nvmrc"), "v22.11.0\n");
    const f = nodeDockerfile(d, { tool: "Next.js", build: "pnpm build", start: "./node_modules/.bin/next start", port: 3000 });
    expect(f).toContain("FROM node:22-slim\n");
    expect(f).toContain(
      "RUN corepack enable || (npm install -g corepack && corepack enable)\nCOPY package.json pnpm-lock.yaml ./\nRUN pnpm install --frozen-lockfile\nCOPY . .\nRUN pnpm build\n",
    );
    expect(f).toMatch(/ENV NODE_ENV=production .*PORT=3000\nEXPOSE 3000\nCMD \.\/node_modules\/\.bin\/next start\n$/);
    // install scripts need the whole project; no lockfile, no npm ci
    fs.rmSync(join(d, "pnpm-lock.yaml"));
    fs.rmSync(join(d, ".nvmrc"));
    fs.writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { postinstall: "nuxt prepare" } }));
    const g = nodeDockerfile(d, { start: "node .output/server/index.mjs", port: 3000 });
    expect(g).toContain("FROM node:24-slim\nWORKDIR /app\nCOPY . .\nRUN npm install\nENV");
  });

  test("Node.js version and package manager from package.json", () => {
    expect(["", ">=18", "^24.1", "24.x", "lts"].map(nodeMajor)).toEqual([undefined, "24", "24", "24", undefined]);
    expect([">=25", "^22.12.0", "20.x || 22.x", ">=20 <23", "22.4.1", "~26.1", "18 - 20", "^18"].map(nodeMajor)).toEqual([
      "26",
      "22",
      "22",
      "22",
      "22",
      "26",
      "20",
      "18",
    ]);
    const d = tmp();
    fs.writeFileSync(join(d, "package.json"), JSON.stringify({ engines: { node: ">=25" }, packageManager: "pnpm@10.4.1+sha512.abc" }));
    const f = nodeDockerfile(d, { start: "node server.js", port: 3000 });
    expect(f).toContain("FROM node:26-slim\n");
    // no lockfile: packageManager says which one, corepack runs its pinned version
    expect(f).toContain("RUN corepack enable || (npm install -g corepack && corepack enable)\nCOPY package.json ./\nRUN pnpm install\n");
    fs.writeFileSync(join(d, ".nvmrc"), "22\n");
    expect(nodeDockerfile(d, { start: "node server.js", port: 3000 })).toContain("FROM node:22-slim\n");
  });

  test("websocket and plain Node.js servers", () => {
    const d = tmp();
    const pkg = (o: object) => fs.writeFileSync(join(d, "package.json"), JSON.stringify(o));
    // a server dependency and an entry file, no scripts at all
    pkg({ dependencies: { ws: "8" } });
    fs.writeFileSync(join(d, "server.js"), "");
    expect(detectBuild(d)).toEqual({ tool: undefined, build: undefined, start: "node server.js" });
    fs.rmSync(join(d, "server.js"));
    fs.mkdirSync(join(d, "src"));
    fs.writeFileSync(join(d, "src/main.js"), "");
    pkg({ main: "src/main.js", dependencies: { "socket.io": "4" } });
    expect(detectBuild(d).start).toBe("node src/main.js");
    // any start script that is not a dev server runs as an app
    pkg({ scripts: { start: "NODE_ENV=production node dist/index.js" } });
    expect(detectBuild(d).start).toBe("npm start");
    for (const dev of ["vite", "npx serve -s build", "react-scripts start", "npm run dev"]) {
      pkg({ scripts: { start: dev } });
      expect(detectBuild(d).start).toBeUndefined();
    }
  });

  test("Bun", () => {
    const d = tmp();
    fs.writeFileSync(join(d, "package.json"), JSON.stringify({ module: "index.ts", devDependencies: { "@types/bun": "1" }, packageManager: "bun@1.2.21" }));
    fs.writeFileSync(join(d, "index.ts"), "Bun.serve({ fetch: () => new Response('ok') })");
    fs.writeFileSync(join(d, "bun.lock"), "");
    const app = detectApp(d)!;
    expect(app).toMatchObject({ name: "Bun", tool: undefined, start: "bun index.ts", port: 3000 });
    const f = app.dockerfile({ start: app.start, port: 3000 });
    expect(f).toContain("FROM oven/bun:1.2.21-slim\nWORKDIR /app\nCOPY package.json bun.lock ./\nRUN bun install --frozen-lockfile\n");
    expect(f).toContain("CMD bun index.ts\n");
    // a script, not a server
    fs.writeFileSync(join(d, "index.ts"), "console.log('hi')");
    expect(detectApp(d)).toBeUndefined();
    // Elysia runs on Bun only, and so does a start script with bun
    fs.rmSync(join(d, "bun.lock"));
    fs.writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { start: "bun src/index.ts" }, dependencies: { elysia: "1" } }));
    expect(detectApp(d)).toMatchObject({ name: "Bun", tool: undefined, start: "bun run start" });
    fs.writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { start: "bun src/index.ts" }, dependencies: { hono: "4" } }));
    expect(detectApp(d)).toMatchObject({ name: "Bun", start: "bun run start" });
    fs.writeFileSync(join(d, "bun.lock"), "");
    // a Next.js app with Bun's lockfile runs on Bun's image
    fs.writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { build: "next build", start: "next start" }, dependencies: { next: "15" } }));
    expect(detectApp(d)).toMatchObject({ name: "Bun", tool: "Next.js", build: "bun run build" });
  });

  test("Deno", () => {
    const d = tmp();
    // Fresh 2: its build writes the server to _fresh/
    fs.writeFileSync(
      join(d, "deno.json"),
      JSON.stringify({ tasks: { dev: "vite", build: "vite build", start: "deno serve -A _fresh/server.js" }, imports: { fresh: "jsr:@fresh/core@^2" } }),
    );
    const fresh = detectApp(d)!;
    expect(fresh).toMatchObject({ name: "Deno", tool: "Fresh", build: "deno task build", start: "deno serve -A --port $PORT _fresh/server.js", port: 8000 });
    expect(fresh.dockerfile({ build: fresh.build, start: fresh.start, port: 8000 })).toContain(
      "FROM denoland/deno:2\nWORKDIR /app\nCOPY . .\nRUN deno install\nRUN deno task build\n",
    );
    // a start task that watches is for developing: the entry runs instead
    fs.writeFileSync(join(d, "deno.json"), JSON.stringify({ tasks: { start: "deno run --watch -A main.ts" }, imports: { hono: "jsr:@hono/hono@^4" } }));
    fs.writeFileSync(join(d, "main.ts"), "Deno.serve(() => new Response('hi'))");
    expect(detectApp(d)).toMatchObject({ name: "Deno", tool: "Hono", start: "deno run -A main.ts", build: undefined });
    fs.writeFileSync(join(d, "deno.json"), JSON.stringify({ tasks: { start: "deno run -A main.ts" } }));
    expect(detectApp(d)).toMatchObject({ name: "Deno", tool: undefined, start: "deno task start" });
    // Lume builds a site: static, built with its task
    fs.writeFileSync(join(d, "deno.json"), JSON.stringify({ imports: { "lume/": "https://deno.land/x/lume@v2/" }, tasks: { build: "deno task lume" } }));
    fs.writeFileSync(join(d, "_config.ts"), "import lume from 'lume/mod.ts';\nexport default lume();");
    expect(detectProject(d)).toMatchObject({ kind: "static", tool: "Lume", dir: "_site", build: "deno task build" });
  });

  test("other languages", () => {
    const app = (fs_: Record<string, string>) => {
      const d = tmp();
      for (const [f, body] of Object.entries(fs_)) {
        fs.mkdirSync(join(d, f, ".."), { recursive: true });
        fs.writeFileSync(join(d, f), body);
      }
      const a = detectApp(d)!;
      return { ...a, file: a?.dockerfile({ build: a.build, start: a.start, port: a.port }) };
    };
    const flask = app({ "requirements.txt": "flask\n", "app.py": "from flask import Flask\napp = Flask(__name__)\n" });
    expect(flask).toMatchObject({ name: "Python", tool: "Flask", port: 8000, start: "gunicorn app:app --bind 0.0.0.0:$PORT" });
    expect(flask.file).toContain("FROM python:3.13-slim");
    expect(app({ "requirements.txt": "fastapi\n", "main.py": "app = FastAPI()\n" }).start).toMatch(/^uvicorn main:app /);
    expect(app({ "requirements.txt": "django\n", "manage.py": "", "mysite/wsgi.py": "" }).start).toMatch(/^gunicorn mysite\.wsgi/);

    const go = app({ "go.mod": "module x\n\ngo 1.23.4\n", "main.go": "package main\nfunc main() {}\n" });
    expect(go).toMatchObject({ name: "Go", port: 8080, start: "app" });
    expect(go.file).toContain("FROM golang:1.23");
    // Hugo sites carry a go.mod too
    expect(app({ "go.mod": "module x\n", "hugo.toml": "" }).name).not.toBe("Go");

    const rust = app({ "Cargo.toml": '[package]\nname = "srv"\n', "src/main.rs": "fn main() {}" });
    expect(rust).toMatchObject({ name: "Rust", start: "srv" });
    expect(rust.file).toContain("cp target/release/srv /out/");

    const spring = app({
      "pom.xml": "<parent><artifactId>spring-boot-starter-parent</artifactId></parent><properties><java.version>17</java.version></properties>",
    });
    expect(spring).toMatchObject({ name: "Java", tool: "Spring Boot (Maven)", start: "java -jar app.jar", build: "mvn -B -DskipTests package" });
    expect(spring.file).toContain("FROM maven:3-eclipse-temurin-17 AS build");
    expect(spring.file).toContain("FROM eclipse-temurin:17-jre");
    const ktor = app({
      "build.gradle.kts": 'plugins { kotlin("jvm") }\ndependencies { implementation("io.ktor:ktor-server-netty") }\nkotlin { jvmToolchain(22) }',
      gradlew: "",
    });
    expect(ktor).toMatchObject({ name: "Kotlin", build: "./gradlew --no-daemon buildFatJar" });
    expect(ktor.file).toContain("FROM eclipse-temurin:25-jdk AS build");
    expect(app({ "build.gradle": "apply plugin: 'com.android.application'" }).name).toBeUndefined();

    expect(app({ "Api.csproj": '<Project Sdk="Microsoft.NET.Sdk.Web"><TargetFramework>net9.0</TargetFramework></Project>' })).toMatchObject({
      name: ".NET",
      start: "dotnet Api.dll",
    });
    expect(app({ Gemfile: "gem 'rails'\n", "config/application.rb": "" })).toMatchObject({ name: "Ruby", secret: "RAILS_MASTER_KEY" });
    expect(app({ "composer.json": '{"require":{"laravel/framework":"11"}}', "public/index.php": "", artisan: "" })).toMatchObject({
      name: "PHP",
      port: 80,
      secret: "APP_KEY",
    });
    expect(app({ "mix.exs": ":phoenix" }).name).toBe("Elixir");
    // a Procfile names the start command
    expect(app({ "requirements.txt": "", Procfile: "web: python -m srv --port $PORT\n" }).start).toBe("python -m srv --port $PORT");
    // a start command given makes any entry an app of its language
    const bot = tmp();
    fs.writeFileSync(join(bot, "requirements.txt"), "discord.py\n");
    expect(detectApp(bot, "python bot.py")).toMatchObject({ name: "Python", start: "python bot.py" });
    // Rails 8 on SQLite: storage/ outlives deploys and the database is prepared on start
    const rails = app({
      Gemfile: "gem 'rails'\ngem 'sqlite3'\n",
      "config/application.rb": "",
      "config/database.yml": "production:\n  database: storage/production.sqlite3\n",
    });
    expect(rails).toMatchObject({ volumes: ["/app/storage"], start: expect.stringMatching(/^bundle exec rails db:prepare && /) });
  });

  test("upload paths stay inside", () => {
    expect(safeParts("../../etc//passwd")).toEqual(["etc", "passwd"]);
    expect(safeParts("site\\a/./b.html")).toEqual(["site", "a", "b.html"]);
  });
});
