import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { defineCommand, parse } from "../../src/cli/cmd";
import { checkEmail, checkLoginName } from "../../src/core/lib/config";
import { secretEnv } from "../../src/core/lib/job";
import { decodeJobInput, encodeJobInput } from "../../src/core/lib/job-input";
import { dotenvLines, parseEnvPairs } from "../../src/core/site/remote";
import { shq, writeFileCmd } from "../../src/core/ssh/ssh";
import { PRELUDE } from "../../src/core/ssh/templates";

const tmp = () => fs.mkdtempSync(join(tmpdir(), "landfall-test-"));

describe("shell quoting", () => {
  test("shq survives single quotes", async () => {
    const nasty = `it's "$(rm -rf /)" \`x\``;
    const out = spawnSync("sh", ["-c", `printf %s ${shq(nasty)}`]).stdout.toString();
    expect(out).toBe(nasty);
  });

  test("writeFileCmd writes bytes exactly, replacing the file, in its mode", () => {
    const dir = tmp();
    const f = join(dir, "f");
    const write = (content: string, mode?: string) =>
      spawnSync("bash", ["-c", `set -euo pipefail\n${PRELUDE}\n${writeFileCmd(f, content, mode)}`], { env: { PATH: process.env.PATH } }).status;
    const content = "a $b `c` 'd'\n\\e\n";
    expect(write("old, and longer than the new content\n")).toBe(0);
    expect(write(content, "600")).toBe(0);
    expect(fs.readFileSync(f, "utf8")).toBe(content);
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    expect(write(content)).toBe(0);
    expect(fs.statSync(f).mode & 0o777).toBe(0o644);
    // No temp file is left behind.
    expect(fs.readdirSync(dir)).toEqual(["f"]);
  });

  test("compose_ok wants compose 2.24 or newer", () => {
    const ok = (v: string) => spawnSync("sh", ["-c", `${PRELUDE}\ncompose_ok ${shq(v)}`]).status === 0;
    expect(["2.24.0", "2.30.1", "2.100.0", "3.0", "10.1"].filter(ok)).toHaveLength(5);
    expect(["", "1.29.2", "2.9.0", "2.19.1", "2.23.9"].filter(ok)).toEqual([]);
  });
});

describe("secrets stay off the command line", () => {
  test("web jobs carry the whole original vector, not a lossy dotenv conversion", () => {
    const args = ["sites", "secret", "blog", "KEY=  synthetic  \r\n", "--dotenv=.env", "KEY=last"];
    expect(decodeJobInput(encodeJobInput(args)).argv).toEqual(args);
  });

  test("password options fall back to LANDFALL_SECRET_*", () => {
    const cmd = defineCommand({ name: "t", summary: "", options: { "dashboard-password": { type: "string", desc: "" } }, async run() {} });
    expect(secretEnv("dashboard-password")).toBe("LANDFALL_SECRET_DASHBOARD_PASSWORD");
    process.env.LANDFALL_SECRET_DASHBOARD_PASSWORD = "from-env";
    try {
      expect(parse(cmd, []).values["dashboard-password"]).toBe("from-env");
      expect(parse(cmd, ["--dashboard-password", "flag"]).values["dashboard-password"]).toBe("flag");
    } finally {
      delete process.env.LANDFALL_SECRET_DASHBOARD_PASSWORD;
    }
  });

  test("dotenv lines", () => {
    expect(parseEnvPairs(dotenvLines("# c\nexport A=1\n\nC=a=b\n"))).toEqual({ A: "1", C: "a=b" });
  });
});

describe("input checks", () => {
  test("login names and emails that reach remote files", () => {
    expect(checkLoginName("admin.me@x")).toBe("admin.me@x");
    expect(() => checkLoginName("a:b")).toThrow();
    expect(() => checkLoginName("a\nb")).toThrow();
    expect(checkEmail("me@example.com")).toBe("me@example.com");
    expect(() => checkEmail("me@example.com'; rm -rf /")).toThrow();
    expect(() => checkEmail("$(id)@x.com")).toThrow();
  });
});
