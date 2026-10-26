import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/cli.ts"],
  platform: "node",
  target: "node22",
  minify: true,
  // The web page and its scripts are read at runtime from next to the bundle.
  copy: ["src/web/ui"],
});
