import { execFileSync } from "node:child_process";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { SiteMeta } from "../../src/core/site/compose";
import { fail } from "../../src/core/lib/fail";
import { OWN_PROXY } from "../../src/core/ssh/templates";

// The shell landfall would run on the server, captured instead of sent.
const scripts: string[] = [];
// What the server answers a script that matches, else the lock's timestamp.
const answers: [RegExp, string][] = [];
vi.mock("../../src/core/ssh/ssh", async (orig) => ({
  ...(await orig<typeof import("../../src/core/ssh/ssh")>()),
  runScript: async (_s: unknown, script: string) => {
    scripts.push(script);
    return { code: 0, stdout: answers.find(([re]) => re.test(script))?.[1] ?? "20260101120000\n", stderr: "" };
  },
}));
const { applySite, removeSite, SEP } = await import("../../src/core/site/remote");
const { skipper } = await import("../../src/core/site/hooks");
const ad = await import("../../src/core/deploy/autodeploy");

const server = { host: "example.com" } as any;
const parses = (script: string) => execFileSync("bash", ["-n"], { input: script });
const release = (id: string, build = true) => ({
  id,
  at: "",
  services: [{ name: "web", networks: ["default"], build, port: 8000 }],
  git: { commit: "abc1234", sha: "abc1234def5678abc1234def5678abc1234def56", branch: "main" },
});
const site = (o: Partial<SiteMeta> = {}): SiteMeta => ({
  name: "shop-test",
  kind: "dockerfile",
  domains: ["shop.test"],
  current: "2",
  releases: [release("1"), release("2")],
  createdAt: "",
  updatedAt: "",
  autodeploy: { env: "test", every: "5m", rule: { branch: ["main", "release/*"] }, url: "git@github.com:acme/shop.git", dir: "" },
  ...o,
});

beforeEach(() => {
  scripts.length = 0;
  answers.length = 0;
});

describe("cron schedule", () => {
  test("minutes and hours", () => {
    expect(ad.cronSchedule("1m", "a")).toBe("* * * * *");
    expect(ad.cronSchedule("5m", "a")).toBe("*/5 * * * *");
    expect(ad.cronSchedule("1h", "a")).toMatch(/^\d+ \* \* \* \*$/);
    expect(ad.cronSchedule("6h", "a")).toMatch(/^\d+ \*\/6 \* \* \*$/);
    expect(ad.cronSchedule("1h", "a")).toBe(ad.cronSchedule("1h", "a"));
  });
  test.each(["0m", "60m", "24h", "5", "1d", ""])("refuses %j", (every) => {
    expect(() => ad.cronSchedule(every, "a")).toThrow(/--every/);
  });
  test("the line runs the script and carries the mark", () => {
    const line = ad.cronLine("shop-test", "5m");
    expect(line).toContain("bash /opt/landfall/sites/shop-test/autodeploy.sh");
    expect(line).toContain(ad.autodeployMark("shop-test"));
  });
});

describe("blocker", () => {
  test("a built release from a commit can deploy itself", () => {
    expect(ad.autodeployBlocker(site())).toBeUndefined();
  });
  test.each([
    ["adopted", { adopted: true }, /adopted/],
    ["static", { kind: "static" }, /static site/],
    ["no release", { releases: [], current: undefined }, /no release/],
    ["no commit", { releases: [{ ...release("2"), git: undefined }] }, /git commit/],
    ["no build", { releases: [release("2", false)] }, /builds no image/],
  ] as const)("%s", (_, o, why) => {
    expect(ad.autodeployBlocker(site(o as Partial<SiteMeta>))).toMatch(why);
  });
});

describe("script", () => {
  test("parses, guards the config, and holds no key", () => {
    const s = ad.autodeployScript(site(), OWN_PROXY);
    parses(s);
    expect(s).toContain("set -euo pipefail");
    expect(s).toContain("diff --quiet");
    expect(s).toContain("package.json");
    expect(s).toContain(".landfall.json");
    expect(s).toContain("git@github.com:acme/shop.git");
    expect(s).not.toMatch(/PRIVATE KEY/);
  });
  test("tags: newest version first, pre-releases left out", () => {
    const s = ad.autodeployScript(site({ autodeploy: { ...site().autodeploy!, rule: { tag: ["v*"] } } }), OWN_PROXY);
    parses(s);
    expect(s).toContain("v:refname");
  });
  test("a site that cannot deploy itself gets a stub that logs why", () => {
    const [line] = ad.autodeployLines(site({ releases: [release("2", false)] }), OWN_PROXY);
    parses(line);
    expect(line).toContain("autodeploy.sh");
  });
  test("no setting, no lines", () => {
    expect(ad.autodeployLines(site({ autodeploy: undefined }), OWN_PROXY)).toEqual([]);
  });
});

describe("applySite and removeSite", () => {
  test("a deploy writes autodeploy.sh only when the site has auto-deploy", async () => {
    await applySite(server, site(), OWN_PROXY, { prev: site({ current: "1" }), what: "deploy shop-test release 2" });
    await applySite(server, site({ autodeploy: undefined }), OWN_PROXY, { prev: site({ current: "1", autodeploy: undefined }), what: "deploy" });
    const [on, off] = scripts;
    parses(on);
    expect(on).toContain("autodeploy.sh");
    expect(off).not.toContain("autodeploy.sh");
  });
  test("removing the site strips the cron line", async () => {
    await removeSite(server, site(), { hooks: skipper({}) });
    const s = scripts[0];
    parses(s);
    expect(s).toContain("landfall autodeploy shop-test:");
  });
});

describe("status", () => {
  test("last seen, log and cron line", () => {
    const out = "abc123 deployed 2026-01-01T12:00:00Z main\n@@log\n== one\n== two\n@@cron\n*/5 * * * * bash x # landfall autodeploy s: every 5m\n";
    const st = ad.parseAutodeployStatus(out);
    expect(st.last).toEqual({ sha: "abc123", result: "deployed", at: "2026-01-01T12:00:00Z", ref: "main" });
    expect(st.log).toEqual(["== one", "== two"]);
    expect(st.cron).toContain("every 5m");
  });
  test("nothing yet", () => {
    expect(ad.parseAutodeployStatus("@@log\n@@cron\n")).toEqual({ log: [] });
  });
  test("the status script parses", () => {
    const s = ad.autodeployStatusScript("shop-test");
    parses(s);
    expect(s).toContain("# landfall autodeploy shop-test:");
  });
  test("one script reads the status and the setting", async () => {
    answers.push([/@@site/, `abc123 deployed 2026-01-01T12:00:00Z main\n@@log\n== one\n@@cron\n@@site\n${JSON.stringify(site())}\n`]);
    const v = await ad.readAutodeploy(server, "web", "shop-test");
    expect(scripts).toHaveLength(1);
    expect(v).toMatchObject({ site: "shop-test", server: "web", enabled: true, every: "5m", log: ["== one"], last: { sha: "abc123" } });
    expect(v.cron).toBeUndefined();
  });
  test("--now: one script that names a missing site or setting", () => {
    const s = ad.autodeployNowScript("shop-test");
    parses(s);
    expect(s).toContain(`|| exit ${ad.NOW_NO_SITE}`);
    expect(s).toContain("shop-test does not deploy itself: turn it on with --every 5m first");
    expect(s).toMatch(/exec bash '\/opt\/landfall\/sites\/shop-test\/autodeploy.sh' -v$/);
  });
});

describe("setAutodeploy", () => {
  const read = (m: SiteMeta) => answers.push([/landfall--8</, [JSON.stringify(m), "", "", "1", ""].join(SEP)]);

  test("build sees the site read under the lock; nothing to change writes nothing", async () => {
    read(site({ autodeploy: undefined }));
    let seen: SiteMeta | undefined;
    const r = await ad.setAutodeploy(server, "shop-test", false, (m) => void (seen = m));
    expect(r).toBeUndefined();
    expect(seen?.name).toBe("shop-test");
    // lock, read, unlock: no write.
    expect(scripts).toHaveLength(3);
    expect(scripts.filter((s) => s.includes("landfall--8<"))).toHaveLength(1);
  });
  test("off: site.json, the script and the cron line in one journaled script", async () => {
    read(site());
    const r = await ad.setAutodeploy(server, "shop-test", false, () => ({ what: "stop auto-deploy of shop-test" }));
    expect(r?.autodeploy).toBeUndefined();
    const w = scripts.find((s) => s.includes("record 'stop auto-deploy of shop-test'"))!;
    parses(w);
    expect(w).toContain("rmf autodeploy.sh");
    expect(scripts).toHaveLength(4);
  });
  test("a failing build leaves the lock", async () => {
    read(site());
    await expect(ad.setAutodeploy(server, "shop-test", false, () => fail("how often? --every 5m (1m–59m or 1h–23h)"))).rejects.toThrow(/how often/);
    expect(scripts.at(-1)).toMatch(/^rm -rf .*\.shop-test\.deploying'$/);
  });
});
