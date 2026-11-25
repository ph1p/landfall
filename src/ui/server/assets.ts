import fs from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

// The page, built by vite into dist/ui next to the bundle; run from src (tsx), the last build's.
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
