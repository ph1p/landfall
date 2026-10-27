import { execFileSync } from "node:child_process";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { SiteMeta } from "../../src/compose";
import { OWN_PROXY } from "../../src/templates";

// The shell landfall would run on the server, captured instead of sent.
const scripts: string[] = [];
vi.mock("../../src/ssh", async (orig) => ({
  ...(await orig<typeof import("../../src/ssh")>()),
  runScript: async (_s: unknown, script: string) => {
    scripts.push(script);
    return { code: 0, stdout: "20260101120000\n", stderr: "" };
  },
}));
const { applySite, discardRelease, lockSite } = await import("../../src/remote");

const server = { host: "example.com" } as any;
const release = (id: string) => ({ id, at: "", services: [{ name: "web", networks: ["default"], build: true, port: 8000 }] });
const site = (current: string, ids: string[]): SiteMeta => ({
  v: 2,
  name: "blog",
  kind: "dockerfile",
  domains: ["blog.test"],
  current,
  releases: ids.map(release),
  createdAt: "",
  updatedAt: "",
});
/** bash -n: the script parses. */
const parses = (script: string) => execFileSync("bash", ["-n"], { input: script });
/** Where `needle` first is in the script, from `from` on. */
const at = (script: string, needle: string, from = 0) => {
  const i = script.indexOf(needle, from);
  expect(i, needle).toBeGreaterThanOrEqual(0);
  return i;
};

beforeEach(() => void (scripts.length = 0));

describe("deploy scripts", () => {
  test("a redeploy builds with the new .env aside, journals, then switches; a failed start goes back", async () => {
    await applySite(server, site("2", ["1", "2"]), OWN_PROXY, { env: "A=1\n", build: true, pull: true, prev: site("1", ["1"]), what: "deploy blog release 2" });
    const s = scripts[0];
    parses(s);
    // The undo shell (in $undo) has its own site.json and up: each looked for after the step before.
    const build = at(s, "dc --env-file ../../.env.new build -q");
    const record = at(s, `record 'deploy blog release 2' "$undo"`, build);
    const mv = at(s, "mv -f .env.new .env", record);
    const up = at(s, "up -d --wait", at(s, "site.json", mv));
    expect(at(s, "undo=")).toBeGreaterThan(build);
    expect(s.slice(up)).toMatch(/eval "\$undo"[\s\S]*_journal undo "\$jl"[\s\S]*exit 1/);
  });

  test("a new site that fails to start stays for lf undo", async () => {
    await applySite(server, site("1", ["1"]), OWN_PROXY, { build: true, what: "deploy blog release 1 (new site)" });
    parses(scripts[0]);
    expect(scripts[0]).not.toContain('eval "$undo"');
    expect(scripts[0]).toContain("lf undo removes blog");
  });

  test("a takeover takes the old container down only after the build", async () => {
    const old = { name: "blog", kind: "dockerfile", domains: [], current: "0", releases: [{ id: "0" }] } as any;
    await applySite(server, site("1", ["1"]), OWN_PROXY, { build: true, takeover: old, what: "deploy blog release 1" });
    parses(scripts[0]);
    expect(at(scripts[0], "dc build -q")).toBeLessThan(at(scripts[0], "removing the old container"));
  });

  test("discarding a release keeps the one current points at, and removes its images", async () => {
    await discardRelease(server, "blog", "2", ["blog-web:2"]);
    parses(scripts[0]);
    expect(at(scripts[0], `"$(readlink current 2>/dev/null)" != 'releases/2'`)).toBeLessThan(at(scripts[0], "rmf 'releases/2'"));
    expect(scripts[0]).toContain("docker image rm 'blog-web:2'");
  });

  test("the deploy lock is one folder per site, and gives the server's clock", async () => {
    const lock = await lockSite(server, "blog");
    parses(scripts[0]);
    expect(lock.now).toBe("20260101120000");
    expect(scripts[0]).toContain("mkdir '/opt/landfall/sites/.blog.deploying'");
    await lock.unlock();
    expect(scripts[1]).toBe("rm -rf '/opt/landfall/sites/.blog.deploying'");
  });
});
