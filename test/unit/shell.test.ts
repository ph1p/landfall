import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { defineCommand, parse } from "../../src/cli/cmd";
import { checkEmail, checkLoginName } from "../../src/core/config";
import { secretEnv, secretsOut } from "../../src/core/job";
import { dotenvLines, parseEnvPairs } from "../../src/core/remote";
import { shq, writeFileCmd } from "../../src/core/ssh";
import { PRELUDE } from "../../src/core/templates";

const tmp = () => fs.mkdtempSync(join(tmpdir(), "landfall-test-"));

describe("shell quoting", () => {
  test("shq survives single quotes", async () => {
    const nasty = `it's "$(rm -rf /)" \`x\``;
    const out = spawnSync("sh", ["-c", `printf %s ${shq(nasty)}`]).stdout.toString();
    expect(out).toBe(nasty);
  });

  test("writeFileCmd writes bytes exactly", () => {
    const dir = tmp();
    const content = "a $b `c` 'd'\n\\e\n";
    spawnSync("sh", ["-c", writeFileCmd(join(dir, "f"), content)]);
    expect(fs.readFileSync(join(dir, "f"), "utf8")).toBe(content);
  });

  test("compose_ok wants compose 2.24 or newer", () => {
    const ok = (v: string) => spawnSync("sh", ["-c", `${PRELUDE}\ncompose_ok ${shq(v)}`]).status === 0;
    expect(["2.24.0", "2.30.1", "2.100.0", "3.0", "10.1"].filter(ok)).toHaveLength(5);
    expect(["", "1.29.2", "2.9.0", "2.19.1", "2.23.9"].filter(ok)).toEqual([]);
  });
});

describe("secrets stay off the command line", () => {
  test("web jobs pass passwords as env and env pairs on stdin", () => {
    expect(secretsOut(["deploy", "--auth-password", "s3cret", "-y"])).toEqual({ args: ["deploy", "-y"], env: { LANDFALL_SECRET_AUTH_PASSWORD: "s3cret" }, stdin: undefined });
    expect(secretsOut(["auth", "blog", "--password=a b"]).env).toEqual({ LANDFALL_SECRET_PASSWORD: "a b" });
    expect(secretsOut(["env", "blog", "-s", "x", "A=1", "B=two=2", "-u", "C"])).toEqual({
      args: ["env", "blog", "-s", "x", "-u", "C", "--dotenv", "-"],
      env: {},
      stdin: "A=1\nB=two=2\n",
    });
    // deploy's -e values travel on stdin; its other arguments stay.
    expect(secretsOut(["deploy", "-y", "-e", "A=1", "--env", "B=2", "-n", "C=x"])).toEqual({ args: ["deploy", "-y", "-n", "C=x", "--dotenv", "-"], env: {}, stdin: "A=1\nB=2\n" });
    // Its own --dotenv (or --env-file) wins: -e stays an argument.
    expect(secretsOut(["deploy", "--env-file", ".env", "-e", "A=1"]).args).toEqual(["deploy", "--env-file", ".env", "-e", "A=1"]);
    expect(secretsOut(["deploy", "--dotenv=.env", "-e", "A=1"]).args).toEqual(["deploy", "--dotenv=.env", "-e", "A=1"]);
    expect(secretsOut(["secret", "blog", "tls.key=abc"])).toEqual({ args: ["secret", "blog", "--dotenv", "-"], env: {}, stdin: "tls.key=abc\n" });
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

  test("--env-file is --dotenv's old name", () => {
    const cmd = defineCommand({ name: "t", summary: "", options: { dotenv: { type: "string", desc: "" } }, async run() {} });
    expect(parse(cmd, ["--env-file", "-"]).values).toEqual({ dotenv: "-" });
    expect(parse(cmd, ["--env-file=a", "--dotenv", "b"]).values).toEqual({ dotenv: "b" });
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
