import { describe, expect, test, vi } from "vitest";
import type { Server } from "../../src/core/lib/config";

const servers: Record<string, Server> = {
  admin: { host: "admin.example" } as Server,
  shared: { host: "shared.example", tenant: { uid: 1001, root: "/home/t/landfall", port: 8081, domains: ["*.t.example"] } } as Server,
};

vi.mock("../../src/core/lib/config", async (orig) => ({
  ...(await orig<typeof import("../../src/core/lib/config")>()),
  resolveServer: (name: string) => ({ name, server: servers[name] }),
}));
vi.mock("../../src/core/views/views", async (orig) => ({
  ...(await orig<typeof import("../../src/core/views/views")>()),
  firewallView: async () => ({ rules: [] }),
}));

const { READS, api } = await import("../../src/ui/server/api");
const { SECTIONS, SECTION_IF, SAME_FOR_TENANTS, URLS, showSection, tenantMay } = await import("../../src/ui/app/lib/sections");
const { CAPS, tenantCaps } = await import("../../src/core/server/facts");

const DENY = ["firewall", "users", "system", "updates", "tenants"];

describe("ui server reads", () => {
  test("every read declares whether a tenant login may see it", () => {
    for (const [route, read] of Object.entries(READS)) expect(["allow", "deny"], route).toContain(read.tenant);
  });

  test("only the admin's views are closed to tenants", () => {
    const denied = Object.entries(READS)
      .filter(([, r]) => r.tenant === "deny")
      .map(([k]) => k);
    expect(denied.sort()).toEqual([...DENY].sort());
    expect(READS.facts.tenant).toBe("allow");
    expect(READS[""].tenant).toBe("allow");
  });

  const get = (path: string[]) => api(new Request(`http://127.0.0.1/api/${path.join("/")}`), path, {} as never);

  test("a tenant login gets 403 on an admin view; a normal server does not", async () => {
    const t = await get(["servers", "shared", "firewall"]);
    expect(t.status).toBe(403);
    expect((await t.json()).error).toBe("this view needs the server's admin; shared is a tenant login");
    const a = await get(["servers", "admin", "firewall"]);
    expect(a.status).toBe(200);
    expect(await a.json()).toEqual({ rules: [] });
  });

  test("an unknown route is still not found", async () => {
    expect((await get(["servers", "admin", "nope"])).status).toBe(404);
    expect((await get(["servers", "admin", "constructor"])).status).toBe(404);
  });
});

describe("what a tenant login sees in the web UI", () => {
  const all = Object.fromEntries(CAPS.map((c) => [c, true])) as Record<(typeof CAPS)[number], boolean>;
  const core = SECTIONS.map(([t]) => t).filter((t): t is keyof typeof URLS => t in URLS);

  test("every section says whether a tenant sees it", () => {
    for (const t of core) expect(t in SECTION_IF || SAME_FOR_TENANTS.includes(t), `${t}: add it to SECTION_IF or SAME_FOR_TENANTS`).toBe(true);
  });

  test("a section a tenant sees reads only what the server lets a tenant read", () => {
    const k = tenantCaps({ can: all, why: {} }).can;
    const shown = core.filter((t) => showSection(t, k, true));
    expect(shown).not.toContain("tenants");
    expect(shown).not.toContain("users");
    for (const t of shown) expect(READS[URLS[t].slice(1)]?.tenant, t).toBe("allow");
  });

  test("tenantMay: the CLI's allowlist, aliases and plugin commands", () => {
    expect(tenantMay(["deploy", ".", "-s", "x"])).toBe(true);
    expect(tenantMay(["sites", "logs", "blog"])).toBe(true);
    expect(tenantMay(["volume", "backup", "rm", "blog", "data"])).toBe(true);
    expect(tenantMay(["setup", "x", "--check"])).toBe(false);
    expect(tenantMay(["tenant", "add", "anna"])).toBe(false);
    expect(tenantMay(["server", "upgrade", "x"])).toBe(false);
    expect(tenantMay(["firewall", "allow", "80"])).toBe(false);
    expect(tenantMay(["analytics", "show"], ["analytics"])).toBe(true);
  });
});
