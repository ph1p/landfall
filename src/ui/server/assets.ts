import fs from "node:fs";
import type { Server } from "node:http";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ViteDevServer } from "vite";

// The page, built by vite into dist/ui next to the bundle. Run from src (tsx), devPages serves it instead (unless LANDFALL_UI_BUILT).
const UI_DIR = [new URL("./ui/", import.meta.url), new URL("../../../dist/ui/", import.meta.url)].find((u) => fs.existsSync(u));
const TYPES: Record<string, string> = { html: "text/html", css: "text/css", js: "text/javascript", svg: "image/svg+xml", json: "application/json" };
const assets = new Map(
  UI_DIR
    ? fs
        .readdirSync(UI_DIR, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => {
          const rel = join(e.parentPath, e.name).slice(fileURLToPath(UI_DIR).length).split(sep).join("/");
          const body = fs.readFileSync(join(e.parentPath, e.name));
          return [rel === "index.html" ? "/" : `/${rel}`, { body, type: `${TYPES[e.name.split(".").pop()!] ?? "application/octet-stream"}; charset=utf-8` }];
        })
    : [],
);

export function asset(pathname: string): Response | undefined {
  const a = assets.get(pathname);
  // Vite puts a content hash in every asset's name: only the page itself has to be fetched again.
  const cache = pathname.startsWith("/assets/") ? "private, max-age=31536000, immutable" : "no-store";
  if (a) return new Response(a.body, { headers: { "content-type": a.type, "cache-control": cache } });
  if (pathname === "/") return new Response("The page is not built: run pnpm build.", { status: 500, headers: { "content-type": "text/plain" } });
  return undefined;
}

/**
 * Run from source (pnpm dev ui), the page comes from vite's dev server, mounted on this one: the current source,
 * reloaded on every change. LANDFALL_UI_BUILT=1 serves the last build (dist/ui) instead, as the published CLI does.
 */
export async function devPages(server: Server): Promise<ViteDevServer | undefined> {
  if (!fileURLToPath(import.meta.url).endsWith(join("src", "ui", "server", "assets.ts")) || process.env.LANDFALL_UI_BUILT) return undefined;
  // vite is a dev dependency, kept out of dist/cli.mjs (tsdown.config.ts); this line never runs there.
  const vite = await import("vite");
  return vite.createServer({
    configFile: fileURLToPath(new URL("../../../vite.config.ts", import.meta.url)),
    server: { middlewareMode: true, hmr: { server } },
    appType: "spa",
    logLevel: "warn",
  });
}
