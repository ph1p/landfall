import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/cli.ts"],
  platform: "node",
  target: "node22",
  minify: true,
});
