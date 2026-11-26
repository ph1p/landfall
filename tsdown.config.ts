import { defineConfig } from "tsdown";

const base = { platform: "node", target: "node22" } as const;

export default defineConfig([
  {
    ...base,
    entry: ["src/cli/cli.ts"],
    minify: true,
    // Types are for the plugin entry only (package.json exports would switch them on here too).
    dts: false,
  },
  // landfall/plugin: definePlugin and the plugin types, for plugin authors' editors and type checks.
  {
    ...base,
    entry: { plugin: "src/core/plugins/plugin-api.ts" },
    dts: { tsconfig: "tsconfig.plugin.json" },
    clean: false,
  },
]);
