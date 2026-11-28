import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-tenant-add-"));
process.env.LANDFALL_CONFIG_DIR = dir;
process.env.LANDFALL_SSH_CONFIG = path.join(dir, "ssh_config");

const init = { value: "other" as string };
const asRoot = vi.fn();
vi.mock("../../src/core/server/facts", async (orig) => ({
  ...(await orig<typeof import("../../src/core/server/facts")>()),
  facts: async () => ({ init: init.value }),
}));
vi.mock("../../src/core/server/users", async (orig) => ({
  ...(await orig<typeof import("../../src/core/server/users")>()),
  usersLogin: async (s: unknown) => s,
}));
vi.mock("../../src/core/server/tenants", async (orig) => ({
  ...(await orig<typeof import("../../src/core/server/tenants")>()),
  readTenants: async () => ({ tenants: [], on: false, left: false, ufw: true }),
  asRoot,
}));

const { tenantAdd } = await import("../../src/cli/commands/tenant");
const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl anna";

describe("lf tenant add", () => {
  test.each([
    ["other", "it runs no systemd"],
    ["openrc", "it runs OpenRC"],
  ])("refuses a server without systemd (%s) before it changes anything", async (value, runs) => {
    init.value = value;
    await expect(tenantAdd.run(["anna"], { server: "box", key: KEY, domain: ["anna.dev"] }, [])).rejects.toThrow(
      new RegExp(`box cannot have tenants: ${runs}, and tenants need systemd.*tenants#requirements`),
    );
    expect(asRoot).not.toHaveBeenCalled();
  });
});
