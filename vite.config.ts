import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// The lf ui page: built next to the CLI bundle (dist/ui), which serves it.
export default defineConfig({
  root: fileURLToPath(new URL("src/ui/app", import.meta.url)),
  base: "/",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: fileURLToPath(new URL("dist/ui", import.meta.url)),
    emptyOutDir: true,
  },
});
