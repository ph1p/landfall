import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { Server } from "../../src/core/config";

// The certs script runs for real in local bash, as runScript sends it (set -euo pipefail), against a fake docker
// whose only mount is the directory named by the server's user: "root" sees the acme.json, "deploy" does not.
const dir = fs.mkdtempSync(join(tmpdir(), "lf-certs-"));
const bin = join(dir, "bin");
const mounts: Record<string, string> = { root: join(dir, "letsencrypt"), deploy: join(dir, "missing") };
const runs: string[] = [];

vi.mock("../../src/core/ssh", async (orig) => ({
  ...(await orig<typeof import("../../src/core/ssh")>()),
  runScript: async (s: Server, script: string) => {
    runs.push(s.user!);
    const r = spawnSync("bash", ["-c", `set -euo pipefail\n${script}`], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MOUNTS: mounts[s.user!] },
    });
    return { stdout: r.stdout, stderr: r.stderr, code: r.status ?? 1 };
  },
}));
vi.mock("../../src/core/privilege", () => ({ rootLogin: async (s: Server) => ({ ...s, user: "root" }) }));

const { certs } = await import("../../src/core/traffic");

beforeAll(() => {
  fs.mkdirSync(bin);
  fs.writeFileSync(join(bin, "docker"), '#!/bin/sh\n[ "$1" = inspect ] && [ "$2" = -f ] && echo "$MOUNTS /var/run/docker.sock"\nexit 0\n', { mode: 0o755 });
  fs.mkdirSync(mounts.root);
  const pem = join(dir, "c.pem");
  const key = join(dir, "k.pem");
  const r = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", pem, "-days", "30", "-subj", "/CN=app.test"]);
  if (r.status !== 0) throw new Error(`openssl failed: ${r.stderr}`);
  const certificate = fs.readFileSync(pem).toString("base64");
  // Far larger than a pipe buffer, with "Certificates" early: grep -q would quit before printf is done.
  const acme = { le: { Certificates: [{ domain: { main: "app.test" }, certificate, key: "A".repeat(300_000) }] } };
  fs.writeFileSync(join(mounts.root, "acme.json"), JSON.stringify(acme, null, 2));
});

describe("certs", () => {
  const server: Server = { host: "srv", user: "deploy" } as Server;

  test("reads a large acme.json under pipefail, through the root login when the mount is out of reach", async () => {
    runs.length = 0;
    const r = await certs(server);
    expect(runs).toEqual(["deploy", "root"]);
    expect(r.denied).toEqual([]);
    expect(r.acme).toEqual([join(mounts.root, "acme.json")]);
    expect(r.certs.map((c) => [c.domains, c.source])).toEqual([[["app.test"], "acme"]]);
  });

  test("a readable mount needs no root login", async () => {
    runs.length = 0;
    const r = await certs({ ...server, user: "root" });
    expect(runs).toEqual(["root"]);
    expect(r.certs).toHaveLength(1);
  });
});
