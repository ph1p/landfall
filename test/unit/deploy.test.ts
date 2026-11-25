import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { nextReleaseId, releaseId } from "../../src/cli/commands/deploy";
import { deployRedirects } from "../../src/core/site/domain-plan";
import { detectStaticDir } from "../../src/core/deploy/projects";
import { withRedirects } from "../../src/core/deploy/remembered";
import { slug } from "../../src/core/lib/slug";
import { compile, matches, parseIgnore, uploadList, uploadSize } from "../../src/core/deploy/ignore";
import {
  baseDomain,
  checkImage,
  checkInt,
  environmentOf,
  expandDomain,
  guessDomains,
  loadProject,
  projectSources,
  saveProject,
  withPrimary,
} from "../../src/core/lib/config";
import { dotenvLines, envEntries, envView, maskedEnv, mergeEnv, parseEnvPairs } from "../../src/core/site/dotenv";
import { externals } from "../../src/core/server/overview";
import { envComposeFile } from "../../src/core/site/compose-config";
import { exampleVars, missingVars, requiredVars, wantedVars } from "../../src/core/site/env-vars";

const tmp = () => fs.mkdtempSync(join(tmpdir(), "landfall-test-"));

describe("env", () => {
  test("merge keeps order, replaces, appends, unsets", () => {
    const out = mergeEnv("# c\nA=1\nB=2\n", { B: "3", C: "4" }, ["A"]);
    expect(out).toBe("# c\nB=3\nC=4\n");
  });
  test("merge sets a duplicated key once", () => {
    expect(mergeEnv("A=1\nB=2\nA=3\n", { A: "9" })).toBe("A=9\nB=2\n");
  });
  test("a .env may space around =", () => {
    expect(parseEnvPairs(dotenvLines("KEY = v w\n"))).toEqual({ KEY: "v w" });
  });
  test("values may contain =", () => {
    expect(parseEnvPairs(["URL=a=b"])).toEqual({ URL: "a=b" });
  });
  test("rejects garbage", () => {
    expect(() => parseEnvPairs(["nope"])).toThrow();
  });
  test("entries, masked view and json", () => {
    const text = "# c\nexport A=1\n\nURL=a=b\n";
    expect(envEntries(text)).toEqual([
      { key: "A", value: "1" },
      { key: "URL", value: "a=b" },
    ]);
    expect(maskedEnv(text)).toBe("A=•••••••• (1)\nURL=•••••••• (3)\n");
    expect(envView(text)).toEqual({
      vars: [
        { key: "A", length: 1 },
        { key: "URL", length: 3 },
      ],
    });
    expect(envView(text, true).vars[1]).toEqual({ key: "URL", value: "a=b" });
  });
});

describe("environments", () => {
  const read = (d: string) => JSON.parse(fs.readFileSync(join(d, ".landfall.json"), "utf8"));

  test("an environment is the project with its own block on top, domains not inherited", () => {
    const d = tmp();
    saveProject(d, { name: "shop", server: "vps", domains: ["shop.com"], port: 3000 }, "");
    expect(loadProject(d, "staging")).toEqual({ name: "shop-staging", server: "vps", domains: [], port: 3000 });
    saveProject(d, { name: "shop-staging", server: "test", domains: ["staging.shop.com"], port: 3000 }, "staging");
    expect(read(d)).toEqual({
      name: "shop",
      server: "vps",
      domains: ["shop.com"],
      port: 3000,
      environments: { staging: { server: "test", domains: ["staging.shop.com"] } },
    });
    expect(loadProject(d, "staging")).toMatchObject({ name: "shop-staging", server: "test", domains: ["staging.shop.com"] });
    // The project's own deploy rewrites its settings and keeps the environments.
    saveProject(d, { name: "shop", server: "vps", domains: ["www.shop.com"] }, "");
    expect(read(d).environments.staging.server).toBe("test");
    expect(loadProject(d, "")).not.toHaveProperty("port");
    expect(environmentOf(d, "shop-staging")).toBe("staging");
    expect(environmentOf(d, "shop")).toBe("");
    expect(environmentOf(d, "other")).toBeUndefined();
  });

  test("redirects are the project's own: an environment does not inherit them", () => {
    const d = tmp();
    saveProject(d, withRedirects({ name: "shop", server: "vps", domains: ["shop.com"] }, ["www.shop.com"]), "");
    expect(read(d).redirects).toEqual(["www.shop.com"]);
    expect(loadProject(d, "staging")?.redirects).toBeUndefined();
    saveProject(d, { name: "shop-staging", server: "vps", domains: ["staging.shop.com"] }, "staging");
    expect(read(d).redirects).toEqual(["www.shop.com"]);
    expect(read(d).environments.staging).not.toHaveProperty("redirects");
    // No redirects left: the key goes.
    saveProject(d, withRedirects(loadProject(d, "")!, []), "");
    expect(read(d)).not.toHaveProperty("redirects");
  });

  test("a folder first deployed as an environment gets the project name without the suffix", () => {
    const d = tmp();
    saveProject(d, { name: "blog-preview", server: "vps", domains: [] }, "preview");
    expect(read(d)).toEqual({ name: "blog", server: "vps", domains: [], environments: { preview: { domains: [] } } });
    expect(loadProject(d, "preview")?.name).toBe("blog-preview");
  });

  test("package.json's landfall section holds settings too; .landfall.json wins and gets only the rest", () => {
    const d = tmp();
    const pkg = { name: "web", landfall: { name: "shop", server: "vps", port: 3000, hooks: { predeploy: "test" } } };
    fs.writeFileSync(join(d, "package.json"), JSON.stringify(pkg));
    expect(loadProject(d, "")).toEqual({ name: "shop", server: "vps", port: 3000 });
    expect(projectSources(d)).toEqual(["package.json"]);
    // Nothing new to say: no .landfall.json.
    saveProject(d, { name: "shop", server: "vps", port: 3000, domains: [] } as any, "");
    expect(read(d)).toEqual({ domains: [] });
    saveProject(d, { name: "shop", server: "test", port: 3000, domains: ["shop.com"] }, "");
    expect(read(d)).toEqual({ server: "test", domains: ["shop.com"] });
    expect(loadProject(d, "")).toEqual({ name: "shop", server: "test", port: 3000, domains: ["shop.com"] });
    expect(projectSources(d)).toEqual([".landfall.json", "package.json"]);
  });

  test("hooks alone do not make package.json a project", () => {
    const d = tmp();
    fs.writeFileSync(join(d, "package.json"), JSON.stringify({ landfall: { hooks: { predeploy: "test" } } }));
    expect(loadProject(d, "")).toBeUndefined();
    saveProject(d, { name: "x", domains: [] }, "");
    expect(read(d)).toEqual({ name: "x", domains: [] });
  });

  test("the compose file an environment layers on", () => {
    expect(envComposeFile("compose.yaml", "staging")).toBe("compose.staging.yaml");
    expect(envComposeFile("docker-compose.yml", "prod")).toBe("docker-compose.prod.yml");
    expect(envComposeFile("stack", "dev")).toBe("stack.dev.yaml");
  });
});

describe("deploy helpers", () => {
  test("detects build output", () => {
    const d = tmp();
    expect(detectStaticDir(d)).toBe(".");
    fs.mkdirSync(join(d, "build"));
    fs.writeFileSync(join(d, "build/index.html"), "");
    expect(detectStaticDir(d)).toBe("build");
    fs.writeFileSync(join(d, "index.html"), "");
    expect(detectStaticDir(d)).toBe(".");
  });
  test("release ids sort chronologically", () => {
    expect(releaseId(new Date("2026-01-02T03:04:05Z"))).toBe("20260102030405");
  });
  test("a second deploy in the same second gets the next id", () => {
    const now = new Date("2026-01-02T03:04:05Z");
    expect(nextReleaseId([], now)).toBe("20260102030405");
    // The server's clock, as lockSite gives it.
    expect(nextReleaseId(["20260102030405"], "20260102030405")).toBe("20260102030406");
    expect(nextReleaseId(["20260102030405", "20260102030406"], now)).toBe("20260102030407");
  });
  test("numbers and images from flags", () => {
    expect(checkInt("8080", "--port", 1, 65535)).toBe(8080);
    expect(checkInt(3000, "--port", 1, 65535)).toBe(3000);
    for (const bad of ["abc", "", "80a", "0", "70000", "1.5"]) expect(() => checkInt(bad, "--port", 1, 65535)).toThrow(/--port/);
    expect(checkImage("ghcr.io/me/app:1.2@sha256:abc")).toBe("ghcr.io/me/app:1.2@sha256:abc");
    for (const bad of ['traefik"; rm -rf /', "x $(id)", "a\nb: c", "-x"]) expect(() => checkImage(bad)).toThrow(/not an image/);
  });
  test("redirects: --redirect, else .landfall.json, else the site's own", () => {
    const base = { none: false, domains: ["shop.com"], name: "shop" };
    expect(deployRedirects({ ...base, args: ["www"], saved: ["old.com"] })).toEqual(["www.shop.com"]);
    expect(deployRedirects({ ...base, saved: ["old.com"], prev: ["www.shop.com"] })).toEqual(["old.com"]);
    expect(deployRedirects({ ...base, prev: ["www.shop.com"] })).toEqual(["www.shop.com"]);
    // A served domain is not also a redirect.
    expect(deployRedirects({ ...base, args: ["www", "shop.com"] })).toEqual(["www.shop.com"]);
    expect(deployRedirects({ ...base, none: true, saved: ["old.com"], prev: ["www.shop.com"] })).toEqual([]);
    expect(() => deployRedirects({ ...base, saved: ["no_pe.com"] })).toThrow(/not a domain: no_pe.com \(redirects in/);
  });
  test("redirects without a domain: kept, unless asked for", () => {
    const base = { none: false, domains: [], name: "shop" };
    expect(deployRedirects({ ...base, saved: ["old.com"], prev: ["www.shop.com"] })).toEqual(["www.shop.com"]);
    expect(deployRedirects({ ...base, none: true, prev: ["www.shop.com"] })).toEqual([]);
    expect(() => deployRedirects({ ...base, args: ["www"] })).toThrow(/would redirect to nothing: shop serves no domain/);
  });
  test("slug", () => {
    expect(slug("My Site.com")).toBe("my-site-com");
    // Cut to 63 at a dash: no trailing dash, which a DNS label (<name>.<domain>) cannot end with.
    expect(slug(`${"a".repeat(62)} tail`)).toBe("a".repeat(62));
  });
});

describe("main domains", () => {
  test("picks the base domain most routed hosts share", () => {
    const hosts = ["example.dev", "www.example.dev", "kcal.example.dev", "kcal.example.dev", "example.net", "www.example.net", "mail.example.dev"];
    expect(guessDomains(hosts)).toEqual([
      { domain: "example.dev", hosts: 4 },
      { domain: "example.net", hosts: 2 },
    ]);
  });
  test("needs two hosts and skips free wildcard DNS", () => {
    expect(guessDomains(["blog.example.com"])).toEqual([]);
    expect(guessDomains(["a.1-2-3-4.sslip.io", "b.1-2-3-4.sslip.io", "x.example.com"])).toEqual([]);
  });
  test("short names use the primary", () => {
    const server = { host: "h", domains: ["example.dev", "example.org"] };
    expect(expandDomain("blog", server)).toBe("blog.example.dev");
    expect(expandDomain("Blog.Example.org", server)).toBe("blog.example.org");
    expect(expandDomain("blog", { host: "h" })).toBe("blog");
    expect(withPrimary(server.domains, "example.org")).toEqual(["example.org", "example.dev"]);
    expect(withPrimary(undefined, "a.dev")).toEqual(["a.dev"]);
  });
  test("keeps co.uk-style suffixes", () => {
    expect(baseDomain("shop.example.co.uk")).toBe("example.co.uk");
    expect(baseDomain("a.b.example.com")).toBe("example.com");
    expect(baseDomain("shop.abc.de")).toBe("abc.de");
    expect(guessDomains(["www.abc.de", "api.abc.de"])).toEqual([{ domain: "abc.de", hosts: 2 }]);
  });
});

describe("externals", () => {
  test("groups routed containers by compose project, skips landfall and the proxy", () => {
    const p = { "com.docker.compose.project": "korro", "com.docker.compose.project.working_dir": "/root/container/korro" };
    const out = externals(
      [
        { name: "korro-korro-1", labels: { ...p, "traefik.http.routers.k.rule": "Host(`korro.app`) || Host(`www.korro.app`, `KORRO.app`)" } },
        { name: "korro-pg-1", labels: p },
        {
          name: "mail",
          labels: { "traefik.http.routers.m.rule": "Host(`mail.x.dev`)", "traefik.http.routers.m-http.rule": "Host(`mail.x.dev`) && PathPrefix(`/`)" },
        },
        { name: "landfall-blog", labels: { "landfall.managed": "true", "traefik.http.routers.b.rule": "Host(`blog.dev`)" } },
        { name: "off", labels: { "traefik.enable": "false", "traefik.http.routers.o.rule": "Host(`o.dev`)" } },
        { name: "traefik", labels: { "traefik.http.routers.d.rule": "Host(`traefik.x.dev`)" } },
      ],
      new Map([
        ["korro-korro-1", "Up 2 hours"],
        ["mail", "Exited (1)"],
      ]),
      "traefik",
    );
    expect(out).toEqual([
      { name: "korro", domains: ["korro.app", "www.korro.app"], status: "Up 2 hours", containers: ["korro-korro-1"], dir: "/root/container/korro" },
      { name: "mail", domains: ["mail.x.dev"], status: "Exited (1)", containers: ["mail"], dir: undefined },
    ]);
  });
});

describe("release source", () => {
  test("the commit, branch and uncommitted changes of a git checkout", async () => {
    const { releaseGit, repoInfo } = await import("../../src/core/deploy/git");
    const gitSource = async (d: string) => {
      const r = await repoInfo(d);
      return r && releaseGit(r);
    };
    const { gitLabel } = await import("../../src/core/site/meta");
    const dir = fs.mkdtempSync(join(tmpdir(), "lf-git-"));
    expect(await gitSource(dir)).toBeUndefined();
    const git = (...a: string[]) => spawnSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...a]);
    git("init", "-q", "-b", "main");
    fs.writeFileSync(join(dir, "a"), "1");
    git("add", "a");
    git("commit", "-qm", "a");
    const g = (await gitSource(dir))!;
    expect(g).toMatchObject({ branch: "main" });
    expect(g.commit).toMatch(/^[0-9a-f]{12}$/);
    expect(g.dirty).toBeUndefined();
    fs.writeFileSync(join(dir, "a"), "2");
    expect(gitLabel(await gitSource(dir))).toBe(`${g.commit} main, uncommitted changes`);
  });
});

describe("ago", () => {
  test("says how long ago, then the date", async () => {
    const { ago } = await import("../../src/core/lib/ago");
    const now = Date.parse("2026-03-01T12:00:00Z");
    expect(ago("2026-03-01T11:59:30Z", now)).toBe("just now");
    expect(ago("2026-03-01T11:15:00Z", now)).toBe("45m ago");
    expect(ago("2026-02-27T12:00:00Z", now)).toBe("2d ago");
    expect(ago("2025-12-24T12:00:00Z", now)).toBe("2025-12-24");
    expect(ago("not a date", now)).toBe("");
  });
});

describe("upload filtering", () => {
  const m = (pattern: string, path: string, dir = false) => matches(parseIgnore(pattern), path, dir);
  test("gitignore patterns", () => {
    expect(m("*.log", "a/b/x.log")).toBe(true);
    expect(m("/build", "build", true)).toBe(true);
    expect(m("/build", "src/build", true)).toBeUndefined();
    expect(m("data/", "data")).toBeUndefined();
    expect(m("data/", "x/data", true)).toBe(true);
    expect(m("a/*.txt", "a/x.txt")).toBe(true);
    expect(m("a/*.txt", "a/b/x.txt")).toBeUndefined();
    expect(m("**/cache", "x/y/cache", true)).toBe(true);
    expect(m("a/**/z", "a/z")).toBe(true);
    expect(m("a/**/z", "a/b/c/z")).toBe(true);
    expect(m("logs/**", "logs/a/b")).toBe(true);
    expect(m("logs/**", "logs", true)).toBeUndefined();
    expect(m("x[0-9].png", "x7.png")).toBe(true);
    expect(m("x?.png", "x.png")).toBeUndefined();
    expect(m("*.env\n!keep.env", "keep.env")).toBe(false);
    expect(m("\\#not-comment", "#not-comment")).toBe(true);
    expect(m("a.b", "aXb")).toBeUndefined();
    expect(compile("# comment")).toBeUndefined();
    expect(compile("   ")).toBeUndefined();
  });

  test("uploadList: defaults, --gitignore, exclude and include", () => {
    const root = fs.mkdtempSync(join(tmpdir(), "lf-ignore-"));
    const put = (p: string, body = "x") => (fs.mkdirSync(join(root, p, ".."), { recursive: true }), fs.writeFileSync(join(root, p), body));
    put("index.html");
    put(".env", "SECRET=1");
    put("node_modules/a/index.js");
    put("data/big.bin", "x".repeat(1000));
    put("dist/app.js");
    put("logs/a.log");
    put("sub/.gitignore", "*.tmp\n");
    put("sub/keep.txt");
    put("sub/x.tmp");
    put(".gitignore", "dist/\nlogs/\n");
    const rules = { exclude: ["data/"], include: ["node_modules"] };
    const paths = (o = {}) => uploadList(root, { rules, ...o }).map((e) => e.path);
    expect(paths()).toEqual([
      ".gitignore",
      "dist",
      "dist/app.js",
      "index.html",
      "logs",
      "logs/a.log",
      "node_modules",
      "node_modules/a",
      "node_modules/a/index.js",
      "sub",
      "sub/.gitignore",
      "sub/keep.txt",
      "sub/x.tmp",
    ]);
    expect(paths({ gitignore: true })).not.toContain("dist");
    expect(paths({ gitignore: true })).not.toContain("sub/x.tmp");
    expect(paths({ gitignore: true })).toContain("sub/keep.txt");
    // A subfolder upload (a static site's dist/) never matches its own root, and exclude is relative to the project.
    expect(uploadList(join(root, "dist"), { project: root, gitignore: true, rules: { exclude: ["dist/app.js"] } }).map((e) => e.path)).toEqual([]);
    expect(uploadList(join(root, "dist"), { gitignore: true }).map((e) => e.path)).toEqual(["app.js"]);
    // include beats .landfall.json's exclude, the defaults and .gitignore.
    const own = (rules: object) => uploadList(root, { gitignore: true, rules }).map((e) => e.path);
    expect(own({ exclude: ["index.html", "sub/"] })).toEqual([".gitignore", "data", "data/big.bin"]);
    expect(own({ exclude: ["sub/", "/data"], include: ["dist/", ".env", "node_modules"] })).toEqual([
      ".env",
      ".gitignore",
      "dist",
      "dist/app.js",
      "index.html",
      "node_modules",
      "node_modules/a",
      "node_modules/a/index.js",
    ]);
    // A folder left out is not looked into: a file in it does not come back alone.
    expect(own({ include: ["logs/a.log"] })).not.toContain("logs/a.log");
    const size = uploadSize(uploadList(root, { exclude: ["sub"] }));
    expect(size.largest[0]).toEqual(["data", 1000]);
    expect(size.files).toBe(5);
  });
});

test("the variables a compose file requires", () => {
  const vars = requiredVars(
    `# \${IN_COMMENT:?no}
services:
  a:
    environment:
      PW: \${PW:?set PW}
      OPT: \${OPT?}
      KEEP: $\${ESCAPED:?no}
      DEF: \${DEF:-x}
    image: x:\${PW:?again}
`,
    "compose.yaml",
  );
  expect(vars).toEqual([
    { name: "PW", from: "compose.yaml", message: "set PW", strict: true },
    { name: "OPT", from: "compose.yaml", message: undefined, strict: false },
  ]);
  expect(missingVars(vars, {}).map((v) => v.name)).toEqual(["PW", "OPT"]);
  // Empty counts only for ${NAME?}.
  expect(missingVars(vars, { PW: "", OPT: "" }).map((v) => v.name)).toEqual(["PW"]);
  expect(missingVars(vars, { PW: "s3cret", OPT: "" })).toEqual([]);
});

test("the variables an example .env lists", () => {
  const vars = exampleVars(
    `# Stripe's secret key
STRIPE_KEY=
export PORT=3000
# DEBUG=1
QUOTED="a # b"
EMPTY= # left for you

STRIPE_KEY=again
`,
    ".env.example",
  );
  expect(vars).toEqual([
    { name: "STRIPE_KEY", from: ".env.example", message: "Stripe's secret key", strict: false, optional: true },
    { name: "PORT", from: ".env.example", message: undefined, strict: false, optional: true, example: "3000" },
    { name: "QUOTED", from: ".env.example", message: undefined, strict: false, optional: true, example: "a # b" },
    { name: "EMPTY", from: ".env.example", message: undefined, strict: false, optional: true },
  ]);
  // Set once, even empty, it is asked for no more.
  expect(missingVars(vars, { STRIPE_KEY: "", PORT: "80" }).map((v) => v.name)).toEqual(["QUOTED", "EMPTY"]);
});

test("what a deploy wants in the .env", () => {
  const dir = tmp();
  fs.writeFileSync(join(dir, ".env.sample"), "API_KEY=\nPW=\n");
  // An app, Dockerfile or image reads the .env: the example counts.
  expect(wantedVars(dir).map((v) => v.name)).toEqual(["API_KEY", "PW"]);
  // A compose project only with an env_file; its own requirement wins.
  fs.writeFileSync(join(dir, "compose.yaml"), 'services:\n  a:\n    image: x\n    environment: { PW: "${PW:?set PW}" }\n');
  expect(wantedVars(dir, ["compose.yaml"])).toEqual([{ name: "PW", from: "compose.yaml", message: "set PW", strict: true }]);
  fs.appendFileSync(join(dir, "compose.yaml"), "    env_file: .env\n");
  expect(wantedVars(dir, ["compose.yaml"]).map((v) => `${v.name}:${v.from}`)).toEqual(["PW:compose.yaml", "API_KEY:.env.sample"]);
});
