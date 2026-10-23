import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/cli.ts"],
  platform: "node",
  target: "node22",
  minify: true,
  // The web page is read at runtime from next to the bundle.
  copy: ["src/web/index.html"],
});
