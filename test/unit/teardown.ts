import fs from "node:fs";
import type { TestProject } from "vitest/node";

// Removes the run's temp folder (vitest.config.ts) with everything the tests left in it.
export default (project: TestProject) => () => {
  const dir = project.config.env.TMPDIR;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
};
