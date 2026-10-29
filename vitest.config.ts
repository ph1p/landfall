import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// The tests' temp folders go under one folder per run, which the global teardown removes.
const tmp = fs.mkdtempSync(join(tmpdir(), "landfall-tests-"));

// Its own config, so vitest does not run from vite.config.ts's root (the lf ui page).
export default defineConfig({
  test: { env: { TMPDIR: tmp }, globalSetup: "test/unit/teardown.ts" },
});
