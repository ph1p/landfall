import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { defineConfig } from "tsdown";

const base = { platform: "node", target: "node22" } as const;

// A built-in plugin's files (what ctx.file reads): everything in its folder that is not code, copied with its folder
// layout to dist/plugins/<name>/. The analytics browser script also needs web-vitals from node_modules.
const pluginFiles = readdirSync("src/plugins", { recursive: true, withFileTypes: true })
  .filter((f) => f.isFile() && f.parentPath !== "src/plugins" && !/\.tsx?$/.test(f.name))
  .map((f) => ({ from: join(f.parentPath, f.name), to: join("dist/plugins", relative("src/plugins", f.parentPath)) }));
const vitals = "node_modules/web-vitals/dist/web-vitals.iife.js";

export default defineConfig([
  {
    ...base,
    entry: ["src/cli/cli.ts"],
    minify: true,
    // Types are for the plugin entry only (package.json exports would switch them on here too).
    dts: false,
    copy: [...pluginFiles, ...(existsSync(vitals) ? [{ from: vitals, to: "dist/plugins/analytics" }] : [])],
  },
  // landfall/plugin: definePlugin and the plugin types, for plugin authors' editors and type checks.
  {
    ...base,
    entry: { plugin: "src/core/plugins/plugin-api.ts" },
    dts: { tsconfig: "tsconfig.plugin.json" },
    clean: false,
  },
]);
