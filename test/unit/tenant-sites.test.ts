import { execFileSync } from "node:child_process";
import { describe, expect, test, vi } from "vitest";
import type { Overview } from "../../src/core/server/overview";

vi.mock("../../src/core/server/tenant", () => ({ freshTenant: async (_: string, s: unknown) => s }));

const { claimDomains } = await import("../../src/core/site/claim");
const { traefikCompose } = await import("../../src/core/ssh/templates");
const { relayScript } = await import("../../src/core/ssh/tunnel");
const { routeYaml } = await import("../../src/core/server/tenants");
const { covers } = await import("../../src/core/lib/domain-match");

const bashOk = (script: string) => execFileSync("bash", ["-n"], { input: script });

const empty = (tenants?: Overview["tenants"]) => ({ sites: [], others: [], redirects: { list: [] }, ...(tenants && { tenants }) }) as unknown as Overview;
const anna = { host: "vps", user: "anna", tenant: { uid: 1001, root: "/opt/landfall/tenants/anna", port: 20000, domains: ["anna.dev", "*.anna.dev"] } };
const proxy = { network: "web", entrypoint: "websecure", resolver: "le" } as never;

describe("domains on a server with tenants", () => {
  test("a tenant routes only its own domains", async () => {
    await expect(claimDomains(anna, "vps", { site: "blog" }, ["anna.dev", "blog.anna.dev"], proxy, { overview: empty() })).resolves.toBeTypeOf("function");
    await expect(claimDomains(anna, "vps", { site: "blog" }, ["blog.anna.dev", "bob.dev"], proxy, { overview: empty() })).rejects.toThrow(
      /bob\.dev is not among your domains on vps/,
    );
    await expect(claimDomains(anna, "vps", { site: "blog" }, ["a.b.anna.dev"], proxy, { overview: empty() })).rejects.toThrow(/not among your domains/);
  });

  test("the admin cannot route what a tenant holds", async () => {
    const all = empty([{ user: "anna", domains: ["anna.dev", "*.anna.dev"] }]);
    await expect(claimDomains({ host: "vps" }, "vps", { site: "x" }, ["shop.anna.dev"], proxy, { overview: all })).rejects.toThrow(
      /shop\.anna\.dev belongs to tenant anna; lf tenant domains anna --rm/,
    );
    await expect(claimDomains({ host: "vps" }, "vps", "redirect", ["admin.dev"], proxy, { overview: all })).resolves.toBeTypeOf("function");
  });

  test("covers: a name, or one level below a wildcard", () => {
    expect(covers("anna.dev", "anna.dev")).toBe(true);
    expect(covers("*.anna.dev", "x.anna.dev")).toBe(true);
    expect(covers("*.anna.dev", "anna.dev")).toBe(false);
    expect(covers("x.anna.dev", "*.anna.dev")).toBe(false);
  });

  test("the route says its domains in a line the admin's overview reads", () => {
    expect(routeYaml("anna", 20000, ["anna.dev", "*.anna.dev"])).toContain("\n# domains: anna.dev *.anna.dev\n");
  });
});

describe("a tenant's Traefik", () => {
  const t = { uid: 1001, port: 20000, trustedIP: "10.0.2.100" };
  const y = traefikCompose({ image: "traefik:v3.6", staging: false, http3: true, hostNetwork: true, tenant: t });

  test("listens on loopback only, behind the central one", () => {
    expect(y).toContain('"127.0.0.1:20000:443"');
    expect(y).not.toContain('"80:80"');
    expect(y).not.toContain("network_mode: host");
    expect(y).not.toContain("--entrypoints.web.");
    expect(y).not.toContain("http3");
    expect(y).toContain("--entrypoints.websecure.proxyProtocol.trustedIPs=10.0.2.100");
  });

  test("proves domains over TLS and reads its own Docker", () => {
    expect(y).toContain("--certificatesresolvers.le.acme.tlschallenge=true");
    expect(y).not.toContain("httpchallenge");
    expect(y).toContain("/run/user/1001/docker.sock:/var/run/docker.sock:ro");
    expect(y).toContain("${LANDFALL_SUBNET:-127.0.0.1/32}");
  });

  test("without a tenant: ports 80 and 443, the HTTP challenge, the system socket", () => {
    const own = traefikCompose({ image: "traefik:v3.6", staging: false });
    expect(own).toContain('"80:80"');
    expect(own).toContain("httpchallenge.entrypoint=web");
    expect(own).toContain("/var/run/docker.sock:/var/run/docker.sock:ro");
    expect(own).not.toContain("trustedIPs");
  });
});

describe("a tunnel into a rootless Docker", () => {
  test("the relay script parses and publishes on loopback only", () => {
    const s = relayScript("lf-tunnel-ab12", "10.89.0.5", 5432);
    bashOk(s);
    expect(s).toContain("-p 127.0.0.1::5432");
    expect(s).toContain("TCP:'10.89.0.5':5432");
    expect(s).toContain("docker port 'lf-tunnel-ab12' 5432/tcp");
  });
});

describe("deploy checks for a tenant", async () => {
  const { analyze } = await import("../../src/core/site/analyze");
  const config = {
    services: {
      web: { "x-landfall": { port: 80 } },
      raw: { network_mode: "host", privileged: true },
      pub: { "x-landfall": { publish: true }, ports: [{ target: 80, published: "80" }] },
    },
  };
  test("warn about what rootless Docker does differently", () => {
    const w = analyze(config, "/x", undefined, { tenant: true }).warnings.join("\n");
    expect(w).toContain("your own network namespace");
    expect(w).toContain("raw is privileged");
    expect(w).toContain("cannot bind ports below 1024");
  });
  test("say nothing of it to the admin", () => {
    const w = analyze(config, "/x").warnings.join("\n");
    expect(w).toContain("binds ports on the server itself");
    expect(w).not.toMatch(/privileged|below 1024|rootless/);
  });
});
