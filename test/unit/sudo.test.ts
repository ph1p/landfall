import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const scripts: string[] = [];
let answer = "";
vi.mock("../../src/core/ssh", async (orig) => ({
  ...(await orig<typeof import("../../src/core/ssh")>()),
  canLogin: vi.fn(async () => false),
  runScript: vi.fn(async (_s: unknown, script: string) => (scripts.push(script), { code: 0, stdout: answer, stderr: "" })),
}));

const dir = fs.mkdtempSync(join(tmpdir(), "lf-sudo-"));
process.env.LANDFALL_CONFIG_DIR = dir;
process.env.LANDFALL_SSH_CONFIG = join(dir, "ssh");
const { setSudoPassword, sudoShim } = await import("../../src/core/ssh");
const { adminLogin, rootVia } = await import("../../src/core/privilege");

afterEach(() => {
  setSudoPassword(undefined);
  scripts.length = 0;
});

/** Runs the shim, then `body`, with a fake sudo that prints what the askpass helper says and the args it got. */
function withFakeSudo(body: string): string {
  const run = fs.mkdtempSync(join(tmpdir(), "lf-sudo-run-"));
  fs.mkdirSync(join(run, "bin"));
  fs.writeFileSync(join(run, "bin", "sudo"), `#!/bin/sh\n[ "$1" = -A ] || { echo "no -A"; exit 1; }\nshift\necho "pw=[$("$SUDO_ASKPASS")] args=[$*]"\n`, {
    mode: 0o755,
  });
  const out = execFileSync("bash", ["-c", `set -euo pipefail\n${sudoShim("s3cr'et $HOME")}\n${body}`], {
    env: { ...process.env, PATH: `${join(run, "bin")}:${process.env.PATH}`, TMPDIR: run },
  }).toString();
  // The helper is removed on exit; only the fake sudo stays.
  expect(fs.readdirSync(run)).toEqual(["bin"]);
  return out;
}

describe("sudo password", () => {
  test("sudo and sudo -n answer with the password through the helper", () => {
    if (process.getuid?.() === 0) return;
    const out = withFakeSudo(`sudo -n true\nsudo -n -u bob id\nx=$(sudo docker ps -n 3); echo "$x"\necho "env=[\${LANDFALL_SUDO_PASSWORD:-unset}]"`);
    expect(out).toBe(
      ["pw=[s3cr'et $HOME] args=[true]", "pw=[s3cr'et $HOME] args=[-u bob id]", "pw=[s3cr'et $HOME] args=[docker ps -n 3]", "env=[unset]", ""].join("\n"),
    );
  });

  test("the shim parses and quotes the password", () => {
    const shim = sudoShim("a'b");
    expect(shim).toContain(`_lf_pw='a'\\''b'`);
    execFileSync("bash", ["-n"], { input: shim });
  });

  test("rootVia reads the script's answer", async () => {
    answer = "sudo\n";
    expect(await rootVia({ host: "vps" })).toBe("sudo");
    answer = "\n";
    expect(await rootVia({ host: "vps" })).toBe("");
  });

  test("adminLogin without a terminal names -K", async () => {
    answer = "";
    await expect(adminLogin({ host: "vps", user: "deploy" }, "rebooting")).rejects.toThrow(/-K/);
  });

  test("adminLogin keeps the login when sudo works", async () => {
    answer = "sudo";
    const s = { host: "vps", user: "deploy" };
    expect(await adminLogin(s, "rebooting")).toBe(s);
  });
});
