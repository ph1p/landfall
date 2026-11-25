import { execFileSync } from "node:child_process";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { SiteMeta } from "../../src/core/site/compose";

const scripts: string[] = [];
vi.mock("../../src/core/ssh/ssh", async (orig) => ({
  ...(await orig<typeof import("../../src/core/ssh/ssh")>()),
  runScript: async (_s: unknown, script: string) => {
    scripts.push(script);
    return { code: 0, stdout: "", stderr: "" };
  },
}));
const { readRedirectsLine, writeRedirects, REDIRECTS_FILE } = await import("../../src/core/traefik/server-redirects");
const { parseRedirects, redirectTarget, redirectsFile } = await import("../../src/core/traefik/redirects");
const { planDomains } = await import("../../src/core/site/domain-plan");

const server = { host: "example.com" } as any;
const parses = (script: string) => execFileSync("bash", ["-n"], { input: script });
/** The file as the server prints it back: comments dropped, on one line. */
const readBack = (file: string) =>
  file
    .split("\n")
    .filter((l) => !l.startsWith("#"))
    .join("");

beforeEach(() => void (scripts.length = 0));

describe("server redirects", () => {
  test("the file reads back as written, path kept or not", () => {
    const list = [
      { host: "old.example.com", to: "https://example.com/blog", permanent: true, path: true },
      { host: "promo.example.com", to: "https://example.com/sale?src=promo", permanent: false, path: false },
    ];
    const file = redirectsFile(list);
    expect(file.startsWith("# managed by landfall")).toBe(true);
    expect(parseRedirects(readBack(file))).toEqual(list);
    const doc = JSON.parse(readBack(file));
    expect(doc.http.routers["redirect-old_example_com"]).toMatchObject({ rule: "Host(`old.example.com`)", service: "noop@internal" });
    expect(doc.http.middlewares["redirect-old_example_com"].redirectRegex.replacement).toBe("https://example.com/blog${1}");
  });

  test("a file edited by hand is reported, not parsed", () => {
    const r = readRedirectsLine("abc", JSON.stringify({ http: { routers: { mine: { rule: "Host(`x.com`)" } } } }));
    expect(r.list).toEqual([]);
    expect(r.error).toContain(REDIRECTS_FILE);
  });

  test("targets: https added, trailing slash dropped, no query with the path kept", () => {
    expect(redirectTarget("www.a.com", "a.com", true)).toBe("https://a.com");
    expect(redirectTarget("www.a.com", "https://a.com/docs/", true)).toBe("https://a.com/docs");
    expect(redirectTarget("www.a.com", "http://a.com/x?y=1", false)).toBe("http://a.com/x?y=1");
    expect(() => redirectTarget("www.a.com", "a.com/x?y=1", true)).toThrow(/query/);
    expect(() => redirectTarget("www.a.com", "ftp://a.com", true)).toThrow(/http/);
    expect(() => redirectTarget("www.a.com", "https://a.com/$1", true)).toThrow(/\$/);
    expect(() => redirectTarget("a.com", "https://a.com", true)).toThrow(/itself/);
  });

  test("the write checks the file was not changed, saves it for undo and records the change", async () => {
    await writeRedirects(
      server,
      { list: [], sha: "f".repeat(64) },
      [{ host: "a.com", to: "https://b.com", permanent: true, path: true }],
      "added redirect a.com",
    );
    const [s] = scripts;
    parses(s);
    expect(s).toContain("sha256sum -c");
    expect(s.indexOf("u=$(saved")).toBeLessThan(s.indexOf("record 'added redirect a.com'"));
    await writeRedirects(server, { list: [] }, [], "removed");
    parses(scripts[1]);
    expect(scripts[1]).toContain(`[ ! -e '${REDIRECTS_FILE}' ]`);
    expect(scripts[1]).toContain(`rm -f '${REDIRECTS_FILE}'`);
  });
});

describe("planDomains", () => {
  const meta = (domains: string[], redirects?: string[]) => ({ name: "blog", domains, redirects }) as SiteMeta;
  const id = (d: string) => d;

  test("a bare redirect name is a subdomain of the first domain", () => {
    const p = planDomains(meta(["a.com"]), { redirect: ["www"] }, id);
    expect(p).toMatchObject({ domains: ["a.com"], redirects: ["www.a.com"], changed: true, addedRedirects: ["www.a.com"], dropped: [] });
  });

  test("a served domain turns into a redirect; --rm takes it off both lists", () => {
    expect(planDomains(meta(["a.com", "www.a.com"]), { redirect: ["www.a.com"] }, id)).toMatchObject({
      domains: ["a.com"],
      redirects: ["www.a.com"],
      dropped: [],
    });
    expect(planDomains(meta(["a.com"], ["www.a.com"]), { rm: ["www"] }, id)).toMatchObject({ domains: ["a.com"], redirects: [], changed: true, missing: [] });
  });

  test("nothing to redirect to, unknown names and no change", () => {
    expect(() => planDomains(meta([]), { redirect: ["www.a.com"] }, id)).toThrow(/redirect to nothing/);
    expect(planDomains(meta(["a.com"]), { rm: ["b.com"] }, id)).toMatchObject({ changed: false, missing: ["b.com"] });
  });
});
