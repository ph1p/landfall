import { files, isLume, packageManager, type Files } from "./runtimes";

/**
 * How a folder builds and serves: the framework, where it writes the site, and the command (each when known).
 * start: the framework renders on a server: it runs in a Node.js container with this command instead.
 * standalone: Next.js's build folder when it writes a standalone server: the image keeps only that server.
 * prepare: run in the image before the build, to make a project that targets another host build for a plain server.
 * fix: what the project has to change before it deploys, said when it does.
 */
export interface Build {
  tool?: string;
  dir?: string;
  build?: string;
  start?: string;
  standalone?: string;
  prepare?: string;
  fix?: string;
}

/** One way a framework serves a folder: the files it writes (dir), or the server it starts (start). */
interface Serve extends Omit<Build, "tool"> {
  /** The variant, shown after the name: Next.js (output: 'export'). */
  mode?: string;
}

/** What a framework's serve() reads from the folder. */
interface Ctx extends Files {
  scripts: Record<string, string>;
  dep(name: string): boolean;
  bun: boolean;
  /** A package.json script, run with the project's package manager. */
  run(script: string): string;
  /** Adds a dev dependency with the project's package manager. */
  add(pkg: string): string;
  /** The build script, run with the project's package manager. */
  build?: string;
  /** A server of its own without a start script: its entry file. */
  entry?: string;
  /** The first of base.ts, .mts, .js, .mjs or .cjs: its name and text. */
  config(base: string): { name?: string; text: string };
}

/**
 * A framework or site generator, found by a dependency or a file only its projects have.
 * serve() picks how it serves this folder; nothing means it is not this one after all, and the next one is tried.
 * To support another: add an entry; the first that serves wins, so the more specific go first.
 */
interface Framework {
  /** Shown as the framework; none for a Node.js server of its own. */
  name?: string;
  deps?: string[];
  files?: string[];
  serve(c: Ctx): Serve | undefined;
}

/** The first `key: "value"` (or `key = "value"`) in a config file's text, without a leading ./ */
const setting = (text: string, key: string) => text.match(new RegExp(`\\b${key}\\s*[:=]\\s*["'\`]([^"'\`]+)["'\`]`))?.[1].replace(/^\.\//, "");

const bin = (cmd: string) => `./node_modules/.bin/${cmd}`;
const below = (root: string, dir: string) => (root === "." ? dir : `${root}/${dir}`);
/** Nitro (Nuxt, TanStack Start, SolidStart, Analog) writes a server that needs nothing else. */
const NITRO = ".output/server/index.mjs";
/** The project's own start script, else the framework's server. */
const ownStart = (c: Ctx, server: string) => (c.scripts.start ? c.run("start") : server);

/** Packages that make a package.json a server of its own: HTTP, WebSocket and realtime servers. */
const SERVERS = [
  "express",
  "fastify",
  "koa",
  "hono",
  "@hono/node-server",
  "@nestjs/core",
  "h3",
  "@adonisjs/core",
  "polka",
  "restify",
  "@hapi/hapi",
  "elysia",
  "@apollo/server",
  "graphql-yoga",
  "@feathersjs/feathers",
  "ws",
  "socket.io",
  "uWebSockets.js",
  "@hocuspocus/server",
  "y-websocket",
  "colyseus",
  "peer",
];

/** Commands that serve files while developing, or a desktop or mobile app: a start script with one is no server. */
const DEV_TOOLS = new Set([
  "vite",
  "react-scripts",
  "parcel",
  "webpack",
  "webpack-dev-server",
  "vue-cli-service",
  "ng",
  "serve",
  "http-server",
  "live-server",
  "lite-server",
  "browser-sync",
  "gatsby",
  "docusaurus",
  "eleventy",
  "astro",
  "hugo",
  "expo",
  "react-native",
  "electron",
  "electron-forge",
  "storybook",
  "start-storybook",
  "tauri",
  "snowpack",
  "nuxt",
  "ember",
  "next",
  "hexo",
  "vuepress",
  "vitepress",
  "quasar",
  "ionic",
  "slidev",
]);

const NODE_ENTRIES = ["server.js", "server.mjs", "index.js", "index.mjs", "app.js", "main.js"];
const BUN_ENTRIES = ["index.ts", "server.ts", "app.ts", "main.ts", "src/index.ts", "src/server.ts"];

/** A Bun project: its lockfile, its config, its types or Elysia; or a start command run with Bun. */
export function usesBun({ has, pkg }: Pick<Files, "has" | "pkg">, start = "") {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  return (
    ["bun.lock", "bun.lockb", "bunfig.toml"].some(has) ||
    ["@types/bun", "bun-types", "elysia"].some((d) => d in deps) ||
    (pkg.packageManager ?? "").startsWith("bun@") ||
    [start, pkg.scripts?.start ?? ""].some((s) => /^bunx?\b/.test(s))
  );
}

/** Whether a start script runs a server, not a dev server, a static file server or `npm run dev`. */
function startsServer(script: string) {
  return script.split(/&&|\|\||;/).every((part) => {
    const words = part
      .trim()
      .split(/\s+/)
      .filter((w) => !/^\w+=/.test(w) && !["npx", "cross-env", "env", "bunx", "pnpx", "dotenv", "--"].includes(w));
    return !DEV_TOOLS.has(words[0] ?? "") && !/\bdev\b/.test(part);
  });
}

/** The folder a docs generator's build script names (vitepress build docs), else the project. */
const docsRoot = (c: Ctx, cli: string) =>
  (c.build && c.scripts.build?.match(new RegExp(`\\b${cli}\\s+build\\s+([^\\s-]\\S*)`))?.[1].replace(/^\.\/|\/$/g, "")) || ".";

/** Site generators that only write files: by a dependency (and a build script), their output folder. */
const SITES: [name: string, deps: string[], dir: string | ((c: Ctx) => string)][] = [
  ["Gatsby", ["gatsby"], "public"],
  ["Docusaurus", ["@docusaurus/core"], "build"],
  [
    "Eleventy",
    ["@11ty/eleventy"],
    (c) => setting(c.first([".eleventy.js", "eleventy.config.js", "eleventy.config.mjs", "eleventy.config.cjs"]), "output") ?? "_site",
  ],
  ["Create React App", ["react-scripts"], "build"],
  ["VitePress", ["vitepress"], (c) => below(docsRoot(c, "vitepress"), ".vitepress/dist")],
  ["VuePress", ["vuepress"], (c) => below(docsRoot(c, "vuepress"), ".vuepress/dist")],
  ["Hexo", ["hexo"], (c) => setting(c.read("_config.yml"), "public_dir") ?? "public"],
  ["Slidev", ["@slidev/cli"], "dist"],
  ["Stencil", ["@stencil/core"], "www"],
  ["Ember", ["ember-cli"], "dist"],
  ["Preact CLI", ["preact-cli"], "build"],
  ["Quasar", ["@quasar/app-vite", "@quasar/app-webpack"], "dist/spa"],
  ["Rsbuild", ["@rsbuild/core"], "dist"],
  ["Vue CLI", ["@vue/cli-service"], (c) => setting(c.read("vue.config.js"), "outputDir") ?? "dist"],
  ["Vite", ["vite"], (c) => setting(c.config("vite.config").text, "outDir") ?? "dist"],
  ["Parcel", ["parcel"], "dist"],
];

/** Generators outside Node.js: by a file of theirs, the folder they write and the command that builds it. */
const GENERATORS: Framework[] = [
  { name: "Hugo", files: ["hugo.toml", "hugo.yaml", "hugo.json"], serve: () => ({ dir: "public", build: "hugo --minify" }) },
  {
    name: "Jekyll",
    files: ["_config.yml"],
    serve: (c) => (c.read("Gemfile").includes("jekyll") ? { dir: "_site", build: "bundle exec jekyll build" } : undefined),
  },
  { name: "MkDocs", files: ["mkdocs.yml"], serve: (c) => ({ dir: setting(c.read("mkdocs.yml"), "site_dir") ?? "site", build: "mkdocs build" }) },
  {
    name: "Zola",
    files: ["zola.toml", "config.toml"],
    serve: (c) =>
      c.has("zola.toml") || (c.has("templates") && /^base_url\s*=/m.test(c.read("config.toml"))) ? { dir: "public", build: "zola build" } : undefined,
  },
  { name: "mdBook", files: ["book.toml"], serve: (c) => ({ dir: setting(c.read("book.toml"), "build-dir") ?? "book", build: "mdbook build" }) },
  {
    name: "Pelican",
    files: ["pelicanconf.py"],
    serve: (c) => ({
      dir: "output",
      build: `pelican ${setting(c.read("pelicanconf.py"), "PATH") ?? "content"} -s ${c.has("publishconf.py") ? "publishconf.py" : "pelicanconf.py"}`,
    }),
  },
  {
    name: "Lume",
    files: ["_config.ts", "_config.js"],
    serve: (c) => (isLume(c) ? { dir: setting(c.first(["_config.ts", "_config.js"]), "dest") ?? "_site", build: "deno task build" } : undefined),
  },
];

/**
 * Node.js and Bun frameworks, server-rendering ones first: a folder with both a server and a
 * site generator (Express serving a Vite app) is a server. The site generators need a build script.
 */
const FRAMEWORKS: Framework[] = [
  {
    name: "Next.js",
    deps: ["next"],
    serve: (c) => {
      const conf = c.config("next.config").text;
      const output = conf.match(/\boutput\s*:\s*["'`](\w+)["'`]/)?.[1];
      if (output === "export") return { mode: "output: 'export'", dir: setting(conf, "distDir") ?? "out" };
      if (output === "standalone")
        return { mode: "output: 'standalone'", start: `${c.bun ? "bun" : "node"} server.js`, standalone: setting(conf, "distDir") ?? ".next" };
      // A start script that runs a file of its own (`node server.ts`) is a custom server: it serves Next.js itself.
      const own = c.scripts.start?.trim();
      if (own && !/^next\s+start\b/.test(own)) return { mode: "custom server", start: /^(node|bun)\s+[\w./-]+$/.test(own) ? own : c.run("start") };
      return { start: `${bin("next")} start` };
    },
  },
  {
    name: "Nuxt",
    deps: ["nuxt"],
    serve: (c) => {
      // nuxt generate, or Nitro's static preset, writes only files; the bun preset's server runs on Bun.
      const preset = setting(c.config("nuxt.config").text, "preset");
      if (/\bnux[ti]\s+generate\b/.test(c.scripts.build ?? "") || preset === "static") return { mode: "nuxt generate", dir: ".output/public" };
      return { start: `${preset === "bun" ? "bun" : "node"} ${NITRO}` };
    },
  },
  {
    name: "TanStack Start",
    deps: ["@tanstack/react-start", "@tanstack/solid-start", "@tanstack/start"],
    serve: (c) => ({ start: ownStart(c, `node ${NITRO}`) }),
  },
  { name: "SolidStart", deps: ["@solidjs/start"], serve: (c) => ({ start: ownStart(c, `node ${NITRO}`) }) },
  {
    name: "Analog",
    deps: ["@analogjs/platform"],
    serve: (c) =>
      /\bstatic\s*:\s*true\b/.test(c.config("vite.config").text)
        ? { mode: "static", dir: "dist/analog/public" }
        : { start: "node dist/analog/server/index.mjs" },
  },
  {
    name: "React Router",
    deps: ["@react-router/dev"],
    serve: (c) =>
      /\bssr\s*:\s*false\b/.test(c.config("react-router.config").text)
        ? { mode: "ssr: false", dir: "build/client" }
        : { start: ownStart(c, `${bin("react-router-serve")} ./build/server/index.js`) },
  },
  { name: "Remix", deps: ["@remix-run/dev"], serve: (c) => ({ start: ownStart(c, `${bin("remix-serve")} ./build/server/index.js`) }) },
  {
    name: "Astro",
    deps: ["astro"],
    serve: (c) => {
      const dir = setting(c.config("astro.config").text, "outDir") ?? "dist";
      return c.dep("@astrojs/node") ? { mode: "Node adapter", start: `node ./${dir}/server/entry.mjs` } : { dir };
    },
  },
  {
    name: "SvelteKit",
    deps: ["@sveltejs/kit"],
    serve: (c) => {
      const conf = c.config("svelte.config");
      const uses = (a: string) => c.dep(a) || c.dep(`@sveltejs/${a}`) || conf.text.includes(a);
      const out = setting(conf.text, "out") ?? "build";
      if (uses("adapter-node")) return { mode: "adapter-node", start: `node ${out}` };
      if (uses("svelte-adapter-bun")) return { mode: "adapter-bun", start: `bun ./${out}/index.js` };
      if (uses("adapter-static")) return { mode: "adapter-static", dir: setting(conf.text, "pages") ?? "build" };
      // adapter-auto (or a host's own adapter) builds nothing a plain server runs: the image builds with adapter-node.
      const adapter = conf.text.match(/["'](@sveltejs\/adapter-[\w-]+|svelte-adapter-[\w-]+)["']/)?.[1] ?? "@sveltejs/adapter-auto";
      return {
        mode: `${adapter.replace(/^@sveltejs\//, "")}, built with adapter-node`,
        start: c.bun ? "bun ./build/index.js" : "node build",
        prepare: conf.name && `${c.add("@sveltejs/adapter-node")} && sed -i 's#${adapter}#@sveltejs/adapter-node#' ${conf.name}`,
      };
    },
  },
  {
    name: "Qwik City",
    deps: ["@builder.io/qwik-city"],
    serve: (c) => {
      // The adapter in adapters/<name>/ decides: static files, or a server entry that build.server writes to server/.
      for (const [a, mode] of [
        ["express", "Express"],
        ["node-server", "Node"],
        ["fastify", "Fastify"],
      ]) {
        if (c.has(`adapters/${a}`)) return { mode, start: `node server/entry.${a}` };
      }
      if (c.has("adapters/static")) return { mode: "static", dir: "dist" };
      return {
        start: "node server/entry.express",
        fix: `Qwik City needs an adapter to run on a server: ${c.run("qwik add")} (pick Node.js Express Server, or Static Site)`,
      };
    },
  },
  {
    name: "Angular",
    deps: ["@angular/core"],
    serve: (c) => {
      let dir = "dist";
      try {
        const b = Object.values<any>(JSON.parse(c.read("angular.json")).projects)[0]?.architect?.build;
        const path = b?.options?.outputPath;
        const base = typeof path === "string" ? path : path?.base;
        // The application builder (Angular 17+) puts the site in browser/ below outputPath, the server in server/.
        if (typeof path === "string") dir = (b.builder ?? "").endsWith(":application") ? `${path}/browser` : path;
        else if (base) dir = `${base}/browser`;
        if (base && b?.options?.ssr) return { mode: "SSR", start: `node ${base}/server/server.mjs` };
      } catch {}
      return { dir };
    },
  },
  // Adonis compiles to build/, which runs with the project's node_modules.
  { name: "AdonisJS", deps: ["@adonisjs/core"], serve: (c) => (c.build ? { start: "node build/bin/server.js" } : undefined) },
  {
    // A server of its own: its entry file, or a start script that runs no dev server.
    serve: (c) => {
      if (c.entry) return { start: `${c.bun ? "bun" : "node"} ${c.entry}` };
      if (c.scripts.start && (SERVERS.some(c.dep) || startsServer(c.scripts.start)))
        return { start: c.scripts["start:prod"] ? c.run("start:prod") : c.run("start") };
    },
  },
  ...SITES.map(([name, deps, dir]): Framework => ({ name, deps, serve: (c) => (c.build ? { dir: typeof dir === "string" ? dir : dir(c) } : undefined) })),
];

function context(cwd: string): Ctx {
  const f = files(cwd);
  const pkg = f.pkg;
  const scripts: Record<string, string> = pkg.scripts ?? {};
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const dep = (n: string) => n in deps;
  const bun = usesBun(f);
  const pm = packageManager(f.has, bun, pkg.packageManager);
  // A server without a start script: its main file, or one of the usual names; Bun runs TypeScript as is.
  const entries = bun ? [pkg.module, pkg.main, ...BUN_ENTRIES, ...NODE_ENTRIES] : [pkg.main, ...NODE_ENTRIES];
  const entry = scripts.start ? undefined : entries.find((e) => e && f.has(e) && (SERVERS.some(dep) || (bun && /\bBun\.serve\b/.test(f.read(e)))));
  return Object.assign(f, {
    scripts,
    dep,
    bun,
    entry,
    run: pm.run,
    add: pm.add,
    build: scripts.build ? pm.run("build") : undefined,
    config: (base: string) => {
      const name = ["ts", "mts", "js", "mjs", "cjs"].map((x) => `${base}.${x}`).find(f.has);
      return { name, text: name ? f.read(name) : "" };
    },
  });
}

const found = (fw: Framework, c: Ctx) => (fw.deps ?? []).some(c.dep) || (fw.files ?? []).some(c.has) || (!fw.deps && !fw.files);

/** The framework in a folder and how it serves: the first entry of FRAMEWORKS (then GENERATORS) that does. */
export function detectBuild(cwd: string): Build {
  const c = context(cwd);
  const pick = (list: Framework[]): Build | undefined => {
    for (const fw of list) {
      const s = found(fw, c) ? fw.serve(c) : undefined;
      if (!s) continue;
      const { mode, ...rest } = s;
      return { tool: fw.name && (mode ? `${fw.name} (${mode})` : fw.name), build: c.build, ...rest };
    }
  };
  // A package.json counts once it builds or starts something.
  const node = c.build || c.scripts.start || c.entry ? pick(FRAMEWORKS) : undefined;
  return node ?? pick(GENERATORS) ?? (c.build ? { build: c.build } : {});
}
