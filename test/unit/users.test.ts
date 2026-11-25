import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { setAssumeYes } from "../../src/core/lib/term";

const removePassword = vi.fn();

vi.mock("../../src/cli/target", () => ({ serverTarget: () => ({ name: "vps", server: { host: "vps" } }) }));
vi.mock("../../src/core/server/users", async (actual) => ({
  ...(await actual<typeof import("../../src/core/server/users")>()),
  usersLogin: async () => ({}),
  listUsers: async () => ({ sudo: true, accounts: [{ name: "anna", uid: 1000, sudo: true, nopasswd: false, password: "set", keys: 1, login: true }] }),
  removePassword: (...a: unknown[]) => removePassword(...a),
}));

const { usersPasswd } = await import("../../src/cli/commands/users");

beforeEach(() => removePassword.mockReset());
afterEach(() => setAssumeYes(false));

test("users passwd --remove of a sudo user is refused under -y; --force removes it", async () => {
  setAssumeYes(true);
  await expect(usersPasswd.run(["anna"], { remove: true }, [])).rejects.toThrow(/--force/);
  expect(removePassword).not.toHaveBeenCalled();
  await usersPasswd.run(["anna"], { remove: true, force: true }, []);
  expect(removePassword).toHaveBeenCalledOnce();
});
