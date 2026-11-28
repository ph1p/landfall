import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";

// Every script that recreates Traefik calls f2b_web_refresh after it (traefik_up does), and its undo too:
// a new container writes a new Docker log file, and fail2ban's web jails must follow it.
const dir = mkdtempSync(join(tmpdir(), "lf-f2b-"));
process.env.LANDFALL_CONFIG_DIR = dir;
process.env.LANDFALL_SSH_CONFIG = join(dir, "ssh_config");

const scripts: string[] = [];
vi.mock("../../src/core/ssh/ssh", async (orig) => ({
  ...(await orig<typeof import("../../src/core/ssh/ssh")>()),
  runScript: async (_s: unknown, script: string) => {
    scripts.push(script);
    return { code: 0, stdout: "", stderr: "" };
  },
}));
const { installTraefik, removeTraefik, useProxy } = await import("../../src/core/traefik/traefik");
const { updateImages } = await import("../../src/core/server/updates");
const { PRELUDE } = await import("../../src/core/ssh/templates");

const server = { host: "example.com" } as any;
const parses = (script: string) => execFileSync("bash", ["-n"], { input: script });
/** The record lines of a script, without the PRELUDE that defines the helpers. */
const records = (s: string) =>
  s
    .slice(s.indexOf(PRELUDE) + PRELUDE.length)
    .split("\n")
    .filter((l) => /^\s*record /.test(l));

beforeEach(() => {
  scripts.length = 0;
});

describe("f2b_web_refresh after Traefik is recreated", () => {
  test("lf traefik install: after the start, and in the undo of a reconfiguration", async () => {
    await installTraefik("nope", server, { dashboardUser: "admin", email: "a@example.com" });
    const s = scripts[0];
    parses(s);
    expect(PRELUDE).toMatch(/traefik_up\(\) \{[^\n]*f2b_web_refresh; \}/);
    expect(s).toContain("traefik_up --remove-orphans --quiet-pull");
    const [reconfigured, installed] = records(s);
    expect(reconfigured).toMatch(/traefik_up --remove-orphans"$/);
    // Undoing a first install takes Traefik down: no log left to follow.
    expect(installed).not.toContain("f2b_web_refresh");
  });

  test("lf traefik use and lf traefik remove", async () => {
    await useProxy(server, { container: "proxy", network: "web", entrypoint: "websecure", resolver: "le" });
    await removeTraefik(server);
    for (const s of scripts) parses(s);
    expect(scripts[0].trimEnd().endsWith("f2b_web_refresh")).toBe(true);
    expect(records(scripts[0])[0]).toMatch(/f2b_web_refresh"$/);
    expect(records(scripts[1])[0]).toMatch(/traefik_up --remove-orphans"$/);
  });

  test("lf update images: the proxy, not a site", async () => {
    const base = { ref: "traefik:v3", image: "sha256:a", dir: "/opt/landfall/traefik" };
    await updateImages(server, [
      { ...base, name: "traefik", kind: "traefik", container: "traefik" } as any,
      { ...base, ref: "nginx:1", name: "blog", kind: "site", container: "blog-web-1", service: "web", dir: "/opt/landfall/sites/blog" } as any,
    ]);
    const s = scripts[0];
    parses(s);
    const [proxy, site] = records(s);
    expect(proxy).toContain("f2b_web_refresh");
    expect(site).not.toContain("f2b_web_refresh");
    expect(s).toContain("ensure_running 'traefik' && f2b_web_refresh || exit 1");
    expect(s).toContain("ensure_running 'blog-web-1' || exit 1");
  });
});
