import fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const files = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []));
const imports = (file: string) => [...fs.readFileSync(file, "utf8").matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]);

// core is shared by cli and ui, so it must not know either; the ui must not reach into the cli.
describe("layers", () => {
  test.each([
    ["src/core", /\/(cli|ui)\//],
    ["src/ui", /\/cli\//],
  ])("%s imports no %s", (dir, bad) => {
    const hits = files(dir).flatMap((f) =>
      imports(f)
        .filter((s) => s.startsWith(".") && bad.test(s))
        .map((s) => `${f}: ${s}`),
    );
    expect(hits).toEqual([]);
  });

  // Type imports vanish in the build; anything else ends up in the browser bundle, with all it imports.
  test("the page loads only core modules that run in a browser", () => {
    const values = (file: string) => [...fs.readFileSync(file, "utf8").matchAll(/^(?:import|export)(?! type)[^;]*from\s*["']([^"']+)["']/gm)].map((m) => m[1]);
    const nodeOnly = (file: string, seen = new Set<string>()): string | undefined => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const s of values(file)) {
        if (s.startsWith("node:")) return file;
        const hit = s.startsWith(".") ? nodeOnly(resolve(dirname(file), `${s}.ts`), seen) : undefined;
        if (hit) return hit;
      }
    };
    const hits = files("src/ui/app").flatMap((f) =>
      values(f)
        .filter((s) => s.includes("/core/"))
        .map((s) => nodeOnly(resolve(dirname(f), `${s}.ts`)))
        .filter(Boolean)
        .map((core) => `${f}: ${core}`),
    );
    expect(hits).toEqual([]);
  });
});
