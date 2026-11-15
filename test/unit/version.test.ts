import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import pkg from "../../package.json";

const dir = mkdtempSync(join(tmpdir(), "lf-version-"));
const env = { ...process.env, LANDFALL_CONFIG_DIR: dir, LANDFALL_SSH_CONFIG: join(dir, "ssh") };
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("version output", () => {
  test.each(["version", "--version", "-v"])("%s preserves plain output", (alias) => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli/cli.ts", alias], { env, encoding: "utf8", timeout: 10000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(`${pkg.version}\n`);
  });

  test.each(["version", "--version", "-v"])("%s --json returns one machine-readable version object", (alias) => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli/cli.ts", alias, "--json"], { env, encoding: "utf8", timeout: 10000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({ version: pkg.version });
  });
});
