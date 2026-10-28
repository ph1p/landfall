import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/cli/cli.ts"],
  platform: "node",
  target: "node22",
  minify: true,
});
