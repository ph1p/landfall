import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { decodeJobInput, encodeJobInput, JOB_INPUT, MAX_JOB_INPUT, readJobInput } from "../../src/core/lib/job-input";

describe("private job input", () => {
  test("round-trips exact values including whitespace, CR/LF, UTF-8, quotes and duplicate keys", async () => {
    const args = ["secret", "blog", "", "KEY=  synthetic  \r\n雪 '\"$=x", "KEY=last"];
    const encoded = encodeJobInput(args);
    expect(decodeJobInput(encoded)).toEqual({ argv: args });
    const bytes = Buffer.from(encoded);
    async function* chunks() {
      for (const byte of bytes) yield Buffer.from([byte]);
    }
    expect(await readJobInput(chunks())).toEqual({ argv: args });
  });

  test.each([
    "",
    "{",
    "null",
    "[]",
    '{"version":2,"argv":["env"]}',
    '{"version":1,"argv":[]}',
    '{"version":1,"argv":[1]}',
    '{"version":1,"argv":["env"],"sudoPassword":1}',
  ])("rejects malformed input without echoing it: %s", (input) => {
    expect(() => decodeJobInput(input)).toThrow("invalid dashboard job input");
  });

  test("carries the sudo password beside argv, never in it", () => {
    const input = decodeJobInput(encodeJobInput(["reboot", "-s", "vps"], "s3cr'et"));
    expect(input).toEqual({ argv: ["reboot", "-s", "vps"], sudoPassword: "s3cr'et" });
    expect(JSON.parse(encodeJobInput(["reboot"]))).not.toHaveProperty("sudoPassword");
  });

  test("bounds both encoding and streamed input", async () => {
    expect(() => encodeJobInput(["x".repeat(MAX_JOB_INPUT)])).toThrow("too large");
    async function* oversized() {
      yield Buffer.alloc(MAX_JOB_INPUT);
      yield Buffer.from("x");
    }
    await expect(readJobInput(oversized())).rejects.toThrow("invalid dashboard job input");
  });

  test("the real startJob child has marker-only argv and receives exact original arguments", () => {
    const args = ["secret", "blog", "KEY=  synthetic\n雪  ", "--password=synthetic"];
    const run = spawnSync(process.execPath, ["--import", "tsx", "test/unit/fixtures/job-worker.ts"], {
      input: JSON.stringify(args),
      encoding: "utf8",
      timeout: 10000,
    });
    expect(run.status, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.lines[0])).toEqual({ actual: [JOB_INPUT], received: { argv: args } });
  });

  test("private CLI dispatch matches direct execution, while ordinary stdin still belongs to the command", () => {
    const dir = fs.mkdtempSync(join(tmpdir(), "lf-job-cli-"));
    const env = { ...process.env, LANDFALL_CONFIG_DIR: dir, LANDFALL_SSH_CONFIG: join(dir, "ssh") };
    const run = (argv: string[], input = "") =>
      spawnSync(process.execPath, ["--import", "tsx", "src/cli/cli.ts", ...argv], { env, input, encoding: "utf8", timeout: 10000 });
    const args = ["config", "--json"];
    const direct = run(args);
    const privateRun = run([JOB_INPUT], encodeJobInput(args));
    expect(direct.status, direct.stderr).toBe(0);
    expect(privateRun.status, privateRun.stderr).toBe(0);
    expect(privateRun.stdout).toBe(direct.stdout);
    const invalid = run([JOB_INPUT], '{"argv":["synthetic-hidden-value"]}');
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).not.toContain("synthetic-hidden-value");
    const conflict = run([JOB_INPUT], encodeJobInput(["env", "blog", "--dotenv=-"]));
    expect(conflict.status).toBe(1);
    expect(conflict.stderr).toContain("cannot read command stdin");
    // Parsing a direct stdin option must not be intercepted as private JSON.
    const normal = run(["auth", "blog", "--password-stdin"], "");
    expect(normal.status).toBe(1);
    expect(normal.stderr).not.toContain("dashboard");
  });
});
