import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";

test("lf tunnels lists live tunnels and drops files of dead ones", async () => {
  vi.stubEnv("LANDFALL_CONFIG_DIR", fs.mkdtempSync(join(tmpdir(), "lf-tunnels-")));
  vi.resetModules();
  const { openTunnels, TUNNELS_DIR, FORWARD_DENIED } = await import("../../src/core/tunnel");
  fs.mkdirSync(TUNNELS_DIR, { recursive: true });
  const t = (pid: number, at: string) => ({ pid, cmd: "tunnel blog", what: "blog", server: "deploy@example.com", url: "http://localhost:3000/", lan: [], at });
  fs.writeFileSync(join(TUNNELS_DIR, `${process.pid}.json`), JSON.stringify(t(process.pid, "2026-10-29T10:00:00Z")));
  // No process has pid 2^22 + 1: above Linux's and macOS's limits.
  fs.writeFileSync(join(TUNNELS_DIR, "4194305.json"), JSON.stringify(t(4194305, "2026-10-29T09:00:00Z")));
  fs.writeFileSync(join(TUNNELS_DIR, "1.json"), "not json");
  expect(openTunnels().map((x) => x.pid)).toEqual([process.pid]);
  expect(fs.readdirSync(TUNNELS_DIR)).toEqual([`${process.pid}.json`]);
  expect(FORWARD_DENIED.test("channel 2: open failed: administratively prohibited: open failed")).toBe(true);
  vi.unstubAllEnvs();
});
