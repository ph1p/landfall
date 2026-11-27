import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";

const tmp = fs.mkdtempSync(join(tmpdir(), "lf-analytics-"));
process.env.LANDFALL_CONFIG_DIR = join(tmp, "config");
process.env.LANDFALL_SSH_CONFIG = join(tmp, "ssh_config");
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { PRELUDE } = await import("../../src/core/ssh/templates");
const { shq } = await import("../../src/core/ssh/ssh");
const core = await import("../../src/core/plugins/plugins");
const remote = await import("../../src/plugins/analytics/remote");
const { TRACKER, clientJs } = await import("../../src/plugins/analytics/client");
const { parseCookie, parseDays, parseSteps } = await import("../../src/plugins/analytics");
const { panelBlocks, VIEWS } = await import("../../src/plugins/analytics/panel");
const { everyDay, parseSize, storageText } = await import("../../src/plugins/analytics/shared");
const { statChange } = await import("../../src/core/plugins/print");
const { sparkline, textBar } = await import("../../src/core/lib/format");
type PluginContext = import("../../src/core/plugins/plugin-api").PluginContext;
type State = import("../../src/plugins/analytics/remote").State;

const parses = (script: string) => execFileSync("bash", ["-n"], { input: `${PRELUDE}\n${script}` });

function fakeCtx(reply = "") {
  const calls: string[] = [];
  const ctx = {
    plugin: "analytics",
    name: "web1",
    server: { host: "example.com" },
    script: async (body: string) => {
      calls.push(body);
      return reply;
    },
    shq,
    paths: { root: "/opt/landfall", sites: "/opt/landfall/sites", traefik: "/opt/landfall/traefik" },
    fail: (m: string): never => {
      throw new Error(m);
    },
    log: { step: () => {}, ok: () => {}, info: () => {}, warn: () => {} },
    file: (n: string) => fs.readFileSync(new URL(`../../src/plugins/analytics/${n}`, import.meta.url), "utf8"),
  } as unknown as PluginContext;
  return { ctx, calls };
}

const PROBE = [
  "PROXY\tnetwork=edge entrypoint=https resolver=le",
  "NET\tyes",
  'HOSTS\t{"shop.example.com":"shop","www.shop.example.com":"shop","blog.example.com":"blog"}',
  'SETTINGS\t{"shop":{"cookie":"consent"},"blog":{"cookie":"bogus"}}',
  'STORAGE\t{"keepDays":90,"maxBytes":524288000}',
  'FUNNELS\t[{"site":"shop","name":"buy","steps":["/","/cart"]}]',
  "SITES\tshop blog Bad_Name",
  "CTR\trunning|2026-11-27T10:00:00Z|0|",
  "SIZE\t4096",
  "DOMAIN\tshop.example.com",
  "DOMAIN\tnot a domain",
  "TAG\tshop\tshop.example.com\tyes\t200\t200",
].join("\n");

describe("analytics probe", () => {
  test("parses every line of the probe", () => {
    const st = remote.parseProbe(PROBE);
    expect(st.proxy).toEqual({ network: "edge", entrypoint: "https", resolver: "le" });
    expect(st.enabled).toEqual(["blog", "shop"]);
    expect(st.sites).toEqual(["shop", "blog"]);
    expect(st.domains).toEqual(["shop.example.com"]);
    expect(st.running).toBe(true);
    expect(st.size).toBe(4096);
    expect(st.storage).toEqual({ keepDays: 90, maxBytes: 524288000 });
    expect(st.funnels[0].steps).toEqual(["/", "/cart"]);
    expect(st.tags.shop).toEqual({ host: "shop.example.com", tag: true, page: "200", endpoint: "200" });
    expect(remote.cookieOf(st, "shop")).toBe("consent");
    expect(remote.cookieOf(st, "blog")).toBe("off");
    expect(remote.cookieOf(st, "other")).toBe("off");
  });
  test("reports Docker problems, broken files and query output", () => {
    expect(remote.parseProbe("NODOCKER").docker).toBe("missing");
    expect(remote.parseProbe("NODOCKERACCESS").docker).toBe("noaccess");
    expect(remote.parseProbe("SETTINGS\t{nope").broken).toBe("app/sites.json is not valid JSON");
    expect(remote.parseProbe("CTR\trunning|x|2|").running).toBe(false);
    expect(remote.parseProbe(`${PROBE}\nQUERY\n{"days":7}`).data).toEqual({ days: 7 });
    const err = remote.parseProbe("QUERYERR\nError: boom\n    at x (y.mjs:1)");
    expect(err.queryError).toBe("Error: boom");
  });
  test("the probe script parses and asks for the site's domains", async () => {
    const { ctx, calls } = fakeCtx(PROBE);
    const st = await remote.probe(ctx, { site: "shop", tags: true, query: { op: "report", days: 7 } });
    expect(st.enabled).toEqual(["blog", "shop"]);
    parses(calls[0]);
    expect(calls[0]).toContain("site='shop'");
    expect(calls[0]).toContain("'/opt/landfall/analytics'/app/sites.json");
  });
});

describe("analytics scripts", () => {
  const st = remote.parseProbe(PROBE);
  test("apply writes every file, journals one undo and checks the endpoint", async () => {
    const { ctx, calls } = fakeCtx("EP\tshop.example.com\t200\n");
    const codes = await remote.apply(ctx, st, { "shop.example.com": "shop" }, { shop: { cookie: "on" } }, "analytics: enabled shop");
    expect(codes).toEqual({ "shop.example.com": "200" });
    const s = calls[0];
    parses(s);
    for (const f of ["README.md", "app/hosts.json", "app/sites.json", "app/server.mjs", "app/query.mjs", "app/client.js"])
      expect(s).toContain(`_put '/opt/landfall/analytics/${f}'`);
    expect(s).toContain("_put '/opt/landfall/analytics'/compose.yml");
    expect(s.match(/^record /gm)).toHaveLength(1);
    expect(s).toContain('"$u1; $u2; $u3; $u4; $u5; $u6; $u7; "');
    expect(s).toContain("dc up -d --quiet-pull");
    // The settings travel base64-encoded.
    expect(s).toContain(Buffer.from(JSON.stringify({ shop: { cookie: "on" } })).toString("base64"));
  });
  test("apply without hosts removes compose.yml and stops the collector", async () => {
    const { ctx, calls } = fakeCtx();
    await remote.apply(ctx, st, {}, {}, "analytics: disabled shop");
    parses(calls[0]);
    expect(calls[0]).toContain("rm -f '/opt/landfall/analytics'/compose.yml");
    expect(calls[0]).not.toContain("dc up -d --quiet-pull");
    expect(calls[0]).toContain("docker rm -f");
  });
  test("funnels are journaled with the old file, purge says it cannot be undone", async () => {
    const f = fakeCtx();
    await remote.writeFunnels(f.ctx, [{ site: "shop", name: "buy", steps: ["/", "/cart"] }], "analytics: funnel buy");
    parses(f.calls[0]);
    expect(f.calls[0]).toMatch(/record 'analytics: funnel buy' "\$u"/);
    const p = fakeCtx('{"deleted":12}');
    expect(await remote.purge(p.ctx, "shop")).toBe(12);
    parses(p.calls[0]);
    expect(p.calls[0]).toMatch(/record 'analytics: deleted the collected data of shop'\s*$/);
  });
  test("storage is journaled with the old file, and removed for the defaults", async () => {
    const f = fakeCtx();
    await remote.writeStorage(f.ctx, { keepDays: 90 }, "analytics: storage kept 90 days");
    parses(f.calls[0]);
    expect(f.calls[0]).toContain("u=$(saved '/opt/landfall/analytics'/app/storage.json)");
    expect(f.calls[0]).toContain("_put '/opt/landfall/analytics/app/storage.json'");
    expect(f.calls[0]).toMatch(/record 'analytics: storage kept 90 days' "\$u"/);
    const d = fakeCtx();
    await remote.writeStorage(d.ctx, {}, "analytics: storage kept 365 days");
    parses(d.calls[0]);
    expect(d.calls[0]).toContain("rm -f '/opt/landfall/analytics'/app/storage.json");
  });
  test("export streams query.mjs's output and records nothing", async () => {
    const calls: { body: string; o?: { capture?: boolean } }[] = [];
    const { ctx } = fakeCtx();
    ctx.script = async (body: string, o?: { capture?: boolean }) => (calls.push({ body, o }), "");
    await remote.exportData(ctx, { site: "shop", format: "jsonl" });
    parses(calls[0].body);
    expect(calls[0].o).toEqual({ capture: false });
    expect(calls[0].body).toContain("node --no-warnings /app/query.mjs");
    expect(calls[0].body).not.toContain("record");
    const q = /lfq '([^']+)'/.exec(calls[0].body)![1];
    expect(JSON.parse(Buffer.from(q, "base64").toString())).toEqual({ op: "export", site: "shop", format: "jsonl" });
  });
});

describe("analytics uninstall", () => {
  test("removes the collector and the whole directory, journaled without undo", async () => {
    const { ctx, calls } = fakeCtx();
    expect(await remote.uninstall(ctx, false)).toBe(true);
    parses(calls[0]);
    expect(calls[0]).toContain("docker rm -f $id");
    expect(calls[0]).toContain("_as '/opt/landfall' rm -rf '/opt/landfall/analytics'");
    expect(calls[0]).toMatch(/record 'analytics: uninstalled the collector and deleted its data'\s*$/);
  });
  test("--keep-data keeps data/ and funnels.json", async () => {
    const { ctx, calls } = fakeCtx();
    await remote.uninstall(ctx, true);
    parses(calls[0]);
    expect(calls[0]).toContain("! -name data ! -name funnels.json -exec rm -rf {} +");
    expect(calls[0]).not.toContain("rm -rf '/opt/landfall/analytics'\n");
  });
  test("nothing installed", async () => {
    const { ctx } = fakeCtx("NONE\n");
    expect(await remote.uninstall(ctx, false)).toBe(false);
  });
  test("the probe says whether the directory exists, also without Docker", () => {
    expect(remote.parseProbe("INSTALLED\nNODOCKER").installed).toBe(true);
    expect(remote.parseProbe("NET\tyes").installed).toBe(false);
  });
  test("the panel offers Uninstall only when something is installed", () => {
    const off = panelBlocks(remote.parseProbe("NET\tyes"), 7);
    expect(JSON.stringify(off)).not.toContain('"uninstall"');
    const left = panelBlocks(remote.parseProbe("INSTALLED\nNET\tyes"), 7);
    expect(JSON.stringify(left)).toContain('["analytics","uninstall","-y"]');
  });
});

describe("analytics client", () => {
  test("the tracker takes the cookie mode from the collector and knows consent", () => {
    expect(TRACKER).toContain('MODE = "@COOKIE@"');
    expect(TRACKER).toContain("event.consent");
    expect(TRACKER).toContain("globalPrivacyControl");
    expect(TRACKER).toContain('"/_lf/a/e"');
    expect(TRACKER).toContain("timeZone");
    expect(TRACKER).toContain('"sd"');
  });
  test("web-vitals comes first, without its source map", () => {
    const js = clientJs(fakeCtx().ctx);
    expect(js.indexOf("webVitals")).toBeLessThan(js.indexOf("@COOKIE@"));
    expect(js).not.toMatch(/sourceMappingURL/);
  });
});

describe("analytics options", () => {
  const { ctx } = fakeCtx();
  test("--cookie and --days", () => {
    expect(parseCookie(ctx, undefined)).toBeUndefined();
    expect(parseCookie(ctx, "consent")).toBe("consent");
    expect(() => parseCookie(ctx, "yes")).toThrow(/--cookie takes off, on, consent/);
    expect(parseDays(ctx, "30")).toBe(30);
    for (const v of ["0", "401", "1.5", "x"]) expect(() => parseDays(ctx, v)).toThrow(/whole number/);
  });
  test("--max-size and the storage line", () => {
    expect(parseSize("500M")).toBe(500 * 1024 ** 2);
    expect(parseSize("1.5gb")).toBe(1.5 * 1024 ** 3);
    expect(parseSize("2GiB")).toBe(2 * 1024 ** 3);
    expect(parseSize("off")).toBe(0);
    for (const v of ["", "lots", "5X", "-1G"]) expect(parseSize(v)).toBeUndefined();
    expect(storageText({})).toBe("kept 365 days");
    expect(storageText({ keepDays: 30, maxBytes: 2 * 1024 ** 3 })).toBe("kept 30 days, at most 2.0 GB");
  });
  test("funnel steps as words or one string with >", () => {
    expect(parseSteps(["/", "/cart", "/done"])).toEqual(["/", "/cart", "/done"]);
    expect(parseSteps(["/ > /cart >  /done"])).toEqual(["/", "/cart", "/done"]);
  });
  test("every day of the range, also the empty ones", () => {
    const to = Date.UTC(2026, 10, 27, 12) / 1000;
    const days = everyDay({ days: 3, to, daily: [{ day: "2026-11-26", visitors: 4, pageviews: 9 }] });
    expect(days.map((d) => d.day)).toEqual(["2026-11-25", "2026-11-26", "2026-11-27"]);
    expect(days.map((d) => d.visitors)).toEqual([0, 4, 0]);
  });
});

describe("analytics panel", () => {
  test("offers to turn it on when nothing collects", () => {
    const st = remote.parseProbe("NET\tyes");
    const blocks = panelBlocks(st, 7);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: "note", kind: "info" });
  });
  test("with data: stat tiles, a line chart, sections and bar charts", () => {
    const st: State = remote.parseProbe(PROBE);
    const t = { visitors: 10, returning: 2, sessions: 12, pageviews: 30, bounce: 40, secs: 50 };
    st.data = {
      days: 7,
      from: 0,
      to: Date.UTC(2026, 10, 27) / 1000,
      live: [],
      total: t,
      prevTotal: t,
      sites: [{ site: "shop", ...t }],
      daily: [{ day: "2026-11-27", visitors: 10, pageviews: 30 }],
      pages: [],
      sources: [{ value: "news.example", sessions: 5, bounce: 20 }],
      campaigns: [],
      devices: [],
      browsers: [],
      os: [],
      countries: [],
      langs: [],
      events: [],
      journeys: [],
      funnels: [],
      vitals: { sites: [], devices: [], pages: [] },
    };
    const blocks = panelBlocks(st, 7);
    const types = blocks.map((b) => b.type);
    expect(types).toContain("stats");
    const stats = blocks.find((b) => b.type === "stats");
    if (stats?.type !== "stats") throw new Error("no stats block");
    expect(stats.sub).toMatch(/stored, kept 90 days, at most 500 MB$/);
    // Storage offers presets, the current 500M among them; 90 days is one too.
    st.installed = true;
    const installed = panelBlocks(st, 7).find((b) => b.type === "stats");
    const storage = installed?.type === "stats" ? installed.actions?.find((a) => a.label === "Storage") : undefined;
    const [days, size] = storage?.fields ?? [];
    expect(days).toMatchObject({ type: "select", value: "90", flag: "--keep-days" });
    expect(size).toMatchObject({ type: "select", value: "500M", flag: "--max-size" });
    expect(size.options).toContainEqual({ value: "off", label: "no limit" });
    expect(size.options?.filter((o) => typeof o === "object" && o.value === "500M")).toHaveLength(1);
    // A value set with the CLI joins the list.
    st.storage = { keepDays: 42, maxBytes: 1.5 * 1024 ** 3 };
    const custom = panelBlocks(st, 7).find((b) => b.type === "stats");
    const cf = custom?.type === "stats" ? custom.actions?.find((a) => a.label === "Storage")?.fields : [];
    expect(cf?.[0].options).toContainEqual({ value: "42", label: "42 (now)" });
    expect(cf?.[1]).toMatchObject({ value: "1.5G" });
    const visitors = stats.items.find((s) => s.label === "Visitors");
    expect(visitors).toMatchObject({ value: "10", change: 0 });
    expect(visitors?.spark).toHaveLength(7);
    expect(stats.items.find((s) => s.label === "Bounce rate")).toMatchObject({ value: "40%", lowerIsBetter: true });
    expect(types).toContain("heading");
    const line = blocks.find((b) => b.type === "chart" && b.chart === "line");
    expect(line).toMatchObject({ labels: expect.any(Array) });
    expect(blocks.some((b) => b.type === "chart" && b.chart === "bars")).toBe(true);
    // The plugin's own check accepts the panel views.
    expect(core.checkPlugin({ name: "a", summary: "s", panel: { label: "A", load() {}, views: VIEWS } })).toBe("");
  });

  test("countries with names, when they visit, scroll depth, and loyalty only with a cookie", () => {
    const st: State = remote.parseProbe(PROBE);
    const t = { visitors: 10, returning: 2, sessions: 12, pageviews: 30, bounce: 40, secs: 50 };
    const base = {
      days: 28,
      from: 0,
      to: Date.UTC(2026, 10, 27) / 1000,
      live: [],
      total: t,
      prevTotal: t,
      sites: [{ site: "shop", ...t }],
      daily: [],
      pages: [{ site: "shop", path: "/", views: 3, visitors: 2, entries: 2, exits: 1, bounce: 50, secs: 20, scroll: 64 }],
      sources: [],
      campaigns: [],
      devices: [],
      browsers: [],
      os: [],
      countries: [
        { value: "DE", sessions: 5, bounce: 0 },
        { value: "?", sessions: 1, bounce: 0 },
      ],
      langs: [],
      events: [],
      journeys: [],
      funnels: [],
      vitals: { sites: [], devices: [], pages: [] },
      when: { hours: Array.from({ length: 24 }, (_, h) => h), weekdays: [7, 1, 2, 3, 4, 5, 6] },
    };
    st.data = { ...base, loyalty: null };
    let blocks = panelBlocks(st, 28);
    const countries = blocks.find((b) => b.type === "chart" && b.title?.startsWith("Countries"));
    expect(countries).toMatchObject({ title: "Countries (1)", show: 10 });
    if (countries?.type !== "chart" || countries.chart !== "bars") throw new Error("no countries");
    expect(countries.items[0]?.label).toBe("🇩🇪 Germany");
    expect(countries.items[1]?.label).toBe("unknown");
    const week = blocks.find((b) => b.type === "chart" && b.title === "Day of the week");
    if (week?.type !== "chart" || week.chart !== "bars") throw new Error("no weekdays");
    expect(week.items[0]).toMatchObject({ label: "Monday", value: 1 });
    expect(week.items[6]).toMatchObject({ label: "Sunday", value: 7 });
    expect(blocks.some((b) => b.type === "chart" && b.title === "Hour of the day")).toBe(true);
    const pages = blocks.find((b) => b.type === "table" && b.title === "Pages");
    if (pages?.type !== "table") throw new Error("no pages");
    expect(pages.columns).toContain("Scroll");
    expect(pages.rows[0]?.cells).toContainEqual(expect.objectContaining({ text: "64%" }));
    expect(blocks.some((b) => b.type === "heading" && b.text === "Loyalty")).toBe(false);

    st.data = {
      ...base,
      loyalty: {
        sites: ["shop"],
        visitors: 4,
        sessions: 7,
        visits: [
          { label: "1 visit", visitors: 2 },
          { label: "2 visits", visitors: 2 },
        ],
        cohorts: [
          { week: "2026-11-06", visitors: 3, back: [33, 0, 0] },
          { week: "2026-11-13", visitors: 1, back: [100, 0] },
        ],
        firstSources: [{ value: "(direct)", visitors: 4, returning: 2 }],
      },
    };
    blocks = panelBlocks(st, 28);
    expect(blocks.some((b) => b.type === "heading" && b.text === "Loyalty")).toBe(true);
    const ret = blocks.find((b) => b.type === "table" && b.title === "Retention");
    if (ret?.type !== "table") throw new Error("no retention");
    expect(ret.columns).toEqual(["First week", "Visitors", "+1 wk", "+2 wk", "+3 wk"]);
    expect(ret.rows[1]?.cells.at(-1)).toBe("");
  });
});

describe("plugin charts and views", () => {
  const panel = (views: unknown) => ({ name: "a", summary: "s", panel: { label: "A", load() {}, views } });
  test("checkPlugin checks the panel views", () => {
    expect(core.checkPlugin(panel([{ id: "7", label: "7 days" }]))).toBe("");
    expect(core.checkPlugin(panel([]))).toMatch(/list of/);
    expect(core.checkPlugin(panel([{ id: "Bad", label: "x" }]))).toMatch(/needs an id/);
    expect(
      core.checkPlugin(
        panel([
          { id: "a", label: "x" },
          { id: "a", label: "y" },
        ]),
      ),
    ).toMatch(/different ids/);
  });
  test("stat changes as text: the good way green, the other red", () => {
    expect(statChange({ label: "a", value: 1 })).toBe("");
    expect(statChange({ label: "a", value: 1, change: null })).toContain("new");
    expect(statChange({ label: "a", value: 1, change: 12 })).toContain("+12%");
    expect(statChange({ label: "a", value: 1, change: -3, lowerIsBetter: true })).toContain("-3%");
  });
  test("text bars and sparklines", () => {
    expect(textBar(0, 10)).toBe("");
    expect(textBar(10, 10, 4)).toBe("████");
    expect(textBar(1, 10, 4)).toBe("▍");
    expect(sparkline([0, 1, 2, 4])).toHaveLength(4);
    expect(sparkline([0, 0])).toBe("  ");
    expect(sparkline([0, 8]).at(-1)).toBe("█");
  });
});
