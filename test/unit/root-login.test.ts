import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../src/core/ssh", async (orig) => ({
  ...(await orig<typeof import("../../src/core/ssh")>()),
  canLogin: vi.fn(async () => true),
}));

const dir = fs.mkdtempSync(join(tmpdir(), "lf-root-"));
process.env.LANDFALL_CONFIG_DIR = dir;
process.env.LANDFALL_SSH_CONFIG = join(dir, "ssh");
const { CONFIG_PATH, loadConfig } = await import("../../src/core/config");
const { sameMachineLogins } = await import("../../src/core/sshconfig");
const { serverConfig } = await import("../../src/cli/commands/server");

const SSH = `Host vps
  HostName 203.0.113.7
  User deploy
Host vps-root
  HostName 203.0.113.7
  User root
Host vps-admin
  HostName 203.0.113.7
  User ops
Host vps-other-port
  HostName 203.0.113.7
  Port 2222
  User root
Host elsewhere
  HostName 198.51.100.1
  User root
`;

beforeEach(() => {
  for (const file of fs.readdirSync(dir)) fs.rmSync(join(dir, file), { recursive: true, force: true });
  fs.writeFileSync(join(dir, "ssh"), SSH);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ servers: { vps: { host: "vps" } } }), { mode: 0o600 });
});

describe("root login", () => {
  test("finds the other Hosts for the same machine, root first", () => {
    expect(sameMachineLogins({ host: "vps" })).toEqual([
      { alias: "vps-root", user: "root" },
      { alias: "vps-admin", user: "ops" },
    ]);
  });

  test("lf server config --root-login saves, checks and forgets the alias", async () => {
    const out = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await serverConfig.run(["vps"], { "root-login": "vps-root" }, []);
      expect(loadConfig().servers.vps).toEqual({ host: "vps", rootAlias: "vps-root" });
      await expect(serverConfig.run(["vps"], { "root-login": "elsewhere" }, [])).rejects.toThrow("not vps");
      await expect(serverConfig.run(["vps"], { "root-login": "vps" }, [])).rejects.toThrow("own login");
      await serverConfig.run(["vps"], { "root-login": "auto" }, []);
      expect(loadConfig().servers.vps).toEqual({ host: "vps" });
    } finally {
      out.mockRestore();
    }
  });
});
