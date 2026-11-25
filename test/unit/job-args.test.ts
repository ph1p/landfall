import { describe, expect, test } from "vitest";
import { maskJobArgs, validateJobArgs } from "../../src/cli/job-args";
import { aliases, commands, find } from "../../src/cli/registry";
import { tokenize } from "../../src/cli/cmd";

describe("command registry", () => {
  test("every canonical command and alias resolves with the original prefix length", () => {
    for (const cmd of commands) {
      const words = cmd.name.split(" ");
      expect(find([...words, "--help"])).toMatchObject({ cmd, prefix: words.length, rest: ["--help"] });
    }
    for (const [alias, canonical] of Object.entries(aliases)) {
      const words = alias.split(" ");
      expect(find([...words, "--help"])).toMatchObject({ cmd: { name: canonical }, prefix: words.length, rest: ["--help"] });
    }
    expect(find(["unknown"]).cmd).toBeUndefined();
  });
});

describe("job display masking", () => {
  test.each([
    [
      ["deploy", "--env", "KEY=synthetic-hidden"],
      ["deploy", "--env", "KEY=***"],
    ],
    [
      ["deploy", "--env=KEY=synthetic-hidden"],
      ["deploy", "--env=KEY=***"],
    ],
    [
      ["deploy", "--env=synthetic-hidden"],
      ["deploy", "--env=***"],
    ],
    [
      ["deploy", "-eKEY=synthetic-hidden"],
      ["deploy", "-eKEY=***"],
    ],
    [
      ["deploy", "-yeKEY=synthetic-hidden"],
      ["deploy", "-yeKEY=***"],
    ],
    [
      ["deploy", "--dotenv=.env", "-e", "KEY=synthetic-hidden"],
      ["deploy", "--dotenv=.env", "-e", "KEY=***"],
    ],
    [
      ["sites", "secret", "blog", "KEY=synthetic-hidden\n雪"],
      ["sites", "secret", "blog", "KEY=***"],
    ],
    [
      ["sites", "env", "blog", "KEY=synthetic-hidden=a"],
      ["sites", "env", "blog", "KEY=***"],
    ],
    [
      ["env", "blog", "KEY="],
      ["env", "blog", "KEY=***"],
    ],
    [
      ["auth", "blog", "--password=synthetic-hidden"],
      ["auth", "blog", "--password=***"],
    ],
    [
      ["sites", "auth", "blog", "-p", "synthetic-hidden"],
      ["sites", "auth", "blog", "-p", "***"],
    ],
    [
      ["users", "password", "bob", "-ypsynthetic-hidden"],
      ["users", "password", "bob", "-yp***"],
    ],
    [
      ["registry", "login", "ghcr.io", "-u", "me", "--password", "synthetic-hidden"],
      ["registry", "login", "ghcr.io", "-u", "me", "--password", "***"],
    ],
    [
      ["auth", "blog", "--password="],
      ["auth", "blog", "--password=***"],
    ],
    [
      ["deploy", "--auth-password", "synthetic-hidden\r\n"],
      ["deploy", "--auth-password", "***"],
    ],
  ])("masks supported syntax %j", (argv, expected) => {
    const before = [...argv];
    expect(maskJobArgs(argv)).toEqual(expected);
    expect(JSON.stringify(maskJobArgs(argv))).not.toContain("synthetic-hidden");
    expect(argv).toEqual(before);
  });

  test.each([
    ["server", "add", "box", "-p", "2222"],
    ["setup", "box", "-p2222"],
    ["secret", "blog", "--file", "KEY=/tmp/key"],
    ["deploy", "-n", "my-site", "-d", "example.com"],
    ["ssh", "box", "--", "mkdir", "-p", "/srv/x"],
    ["scale", "blog", "web=3", "worker=default", "-s", "box", "-y"],
    ["weight", "blog", "stable=90", "canary=10", "-y"],
  ])("preserves nonsensitive arguments %j", (...argv) => {
    expect(maskJobArgs(argv)).toEqual(argv);
  });

  test("masks the credentials in a repository URL", () => {
    expect(maskJobArgs(["deploy", "--git", "https://bot:synthetic-hidden@git.example.com/a/b.git#main"])).toEqual([
      "deploy",
      "--git",
      "https://***@git.example.com/a/b.git#main",
    ]);
    expect(maskJobArgs(["deploy", "--git=https://synthetic-hidden@git.example.com/a.git"])).toEqual(["deploy", "--git=https://***@git.example.com/a.git"]);
  });

  test.each([
    ["unknown", "synthetic-hidden"],
    ["deploy", "--unknown=synthetic-hidden"],
    ["auth", "--password"],
  ])("fails closed for invalid arguments %j", (...argv) => {
    expect(maskJobArgs(argv)).toEqual(["[invalid command arguments hidden]"]);
  });

  test("duplicate options and positional terminators follow Node parsing", () => {
    const args = ["deploy", "-e", "KEY=synthetic-hidden", "--env=KEY=last"];
    expect(maskJobArgs(args)).toEqual(["deploy", "-e", "KEY=***", "--env=KEY=***"]);
    expect(tokenize(find(args).cmd!, find(args).rest).values.env).toEqual(["KEY=synthetic-hidden", "KEY=last"]);
    expect(maskJobArgs(["secret", "blog", "--", "KEY=synthetic-hidden"])).toEqual(["secret", "blog", "--", "KEY=***"]);
  });

  test("rejects UI command stdin but keeps file and remote passthrough semantics", () => {
    for (const args of [
      ["env", "blog", "--dotenv", "-"],
      ["deploy", "--dotenv=-"],
      ["users", "passwd", "bob", "--password-stdin"],
    ]) {
      expect(() => validateJobArgs(args)).toThrow("cannot read command stdin");
    }
    expect(() => validateJobArgs(["deploy", "--dotenv=.env", "--env=KEY=synthetic"])).not.toThrow();
    expect(() => validateJobArgs(["ssh", "box", "--", "echo", "--dotenv=-"])).not.toThrow();
    expect(() => validateJobArgs(["ui"])).toThrow("invalid dashboard command");
  });
});
