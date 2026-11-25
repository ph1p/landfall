import { execFileSync } from "node:child_process";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { SiteMeta } from "../../src/core/compose";
import { OWN_PROXY } from "../../src/core/templates";

// The shell landfall would run on the server, captured instead of sent.
const scripts: string[] = [];
const reply = { stdout: "20260101120000\n" };
vi.mock("../../src/core/ssh", async (orig) => ({
  ...(await orig<typeof import("../../src/core/ssh")>()),
  runScript: async (_s: unknown, script: string) => {
    scripts.push(script);
    return { code: 0, stdout: reply.stdout, stderr: "" };
  },
}));
const { applySite, discardRelease, lockSite, overview, removeSite, setWeights } = await import("../../src/core/remote");
const { serverCall, skipper } = await import("../../src/core/hooks");

const server = { host: "example.com" } as any;
const release = (id: string) => ({ id, at: "", services: [{ name: "web", networks: ["default"], build: true, port: 8000 }] });
const site = (current: string, ids: string[]): SiteMeta => ({
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

beforeEach(() => {
  scripts.length = 0;
  reply.stdout = "20260101120000\n";
});

describe("deploy scripts", () => {
  test("hooks: release in a one-off container before the switch, verify after the start, both undo on failure", async () => {
    const hooks = { pm: "npm", service: "web", port: 8000, run: { release: ["migrate"], verify: ["smoke"], postdeploy: ["notify"] } };
    const call = (hook: "release" | "verify" | "postdeploy") => serverCall(hooks, hook, skipper({}), { LANDFALL_RELEASE: "2" });
    await applySite(server, site("2", ["1", "2"]), OWN_PROXY, {
      env: "A=1\n",
      build: true,
      prev: site("1", ["1"]),
      hooks: { release: call("release"), verify: call("verify"), post: call("postdeploy") },
      what: "deploy blog release 2",
    });
    const s = scripts[0];
    parses(s);
    const release = at(s, "dc run --rm -T", at(s, "mv -f .env.new .env"));
    const up = at(s, "up -d --wait", release);
    const verify = at(s, "'npm' 'smoke'", up);
    at(s, "'npm' 'notify'", verify);
    expect(s.slice(release, up)).toMatch(/eval "\$undo"[\s\S]*hook release failed/);
    expect(s.slice(verify)).toMatch(/eval "\$undo"[\s\S]*hook verify failed/);
  });

  test("predestroy runs in the running container before anything is removed", async () => {
    const m = site("1", ["1"]);
    m.releases[0].hooks = { pm: "npm", service: "web", run: { predestroy: ["backup"] } };
    await removeSite(server, m, { hooks: skipper({}) });
    const s = scripts[0];
    parses(s);
    const hook = at(s, "dc exec -T");
    expect(at(s, "hook predestroy failed", hook)).toBeLessThan(at(s, "stopping blog", hook));
  });

  test("a redeploy builds with the new .env aside, journals, then switches; a failed start goes back", async () => {
    await applySite(server, site("2", ["1", "2"]), OWN_PROXY, { env: "A=1\n", build: true, pull: true, prev: site("1", ["1"]), what: "deploy blog release 2" });
    const s = scripts[0];
    parses(s);
    // The undo shell (in $undo) has its own site.json and up: each looked for after the step before.
    const build = at(s, "dc --env-file ../../.env.new build --pull");
    const record = at(s, `record 'deploy blog release 2' "$undo"`, build);
    const mv = at(s, "mv -f .env.new .env", record);
    const up = at(s, "up -d --wait", at(s, "site.json", mv));
    expect(at(s, "undo=")).toBeGreaterThan(build);
    expect(s.slice(up)).toMatch(/eval "\$undo"[\s\S]*_journal undo "\$jl"[\s\S]*exit 1/);
  });

  test("rolling: others start first, a changed service gets new containers ready before the old ones stop", async () => {
    const m = site("2", ["1", "2"]);
    m.kind = "compose";
    m.releases[1].services = [{ name: "web", networks: ["default"], port: 8000, update: "rolling", replicas: 2 } as any, { name: "db", networks: ["default"] }];
    await applySite(server, m, OWN_PROXY, { env: "A=1\n", prev: site("1", ["1"]), what: "deploy blog release 2" });
    const s = scripts[0];
    parses(s);
    const others = at(s, "--no-deps 'db'");
    const hash = at(s, "dc config --hash 'web'", others);
    at(s, "awk -v s='web'", hash);
    const scaleUp = at(s, "--no-recreate --scale 'web'=$((n + 2))", hash);
    const ready = at(s, "wait_ready 300 $new", scaleUp);
    const stop = at(s, "docker stop -t 30 $old", ready);
    // The last start covers only the rolling service: the others are up already.
    const last = at(s, "--remove-orphans --no-deps 'web' </dev/null", stop);
    expect(s.slice(at(s, "mv -Tf current.new current"), last).match(/--remove-orphans/g)).toHaveLength(1);
    // A container that does not get ready goes, the old ones stay, the release goes back.
    expect(s.slice(ready, stop)).toMatch(/docker rm -f \$new[\s\S]*eval "\$undo"[\s\S]*exit 1/);
  });

  test("opt-in: no rolling step, wait or split file without x-landfall.update or weight", async () => {
    await applySite(server, site("2", ["1", "2"]), OWN_PROXY, { env: "A=1\n", prev: site("1", ["1"]), what: "deploy blog release 2" });
    const s = scripts[0];
    parses(s);
    expect(s.slice(s.indexOf("mv -f .env.new .env"))).not.toMatch(/wait_ready \d|--no-recreate|config --hash|managed by landfall/);
  });

  test("a traffic split writes the dynamic file, only behind landfall's own Traefik", async () => {
    const m = site("1", ["1"]);
    m.kind = "compose";
    m.releases[0].services = [
      { name: "a", networks: ["default"], port: 80, weight: 90 },
      { name: "b", networks: ["default"], port: 80, weight: 10 },
    ];
    await applySite(server, m, OWN_PROXY, { what: "deploy blog release 1 (new site)" });
    const s = scripts[0];
    parses(s);
    const own = at(s, "managed by landfall");
    at(s, "site-blog.yml", own);
    const b64 = /printf %s '([A-Za-z0-9+/=]+)' \| base64 -d \| _put '[^']*site-blog\.yml'/.exec(s)![1];
    expect(Buffer.from(b64, "base64").toString()).toContain("blog_b@docker");
  });

  test("lf weight rewrites the split file and site.json only: no container starts, undo restores both", async () => {
    const m = site("1", ["1"]);
    m.kind = "compose";
    m.releases[0].services = [
      { name: "a", networks: ["default"], port: 80, weight: 90 },
      { name: "b", networks: ["default"], port: 80, weight: 10 },
    ];
    reply.stdout = JSON.stringify(m);
    await setWeights(server, "blog", { b: 0 }, "weight blog b=0");
    const s = scripts.find((x) => x.includes("record "))!;
    parses(s);
    expect(s).not.toMatch(/\bdc (up|run)|docker (stop|rm)/);
    const own = at(s, "managed by landfall", at(s, "u2=$(saved"));
    const put = at(s, "| _put", own);
    at(s, `record 'weight blog b=0' "$u1"`, at(s, "site.json", put));
    const b64 = /printf %s '([A-Za-z0-9+/=]+)' \| base64 -d \| _put/.exec(s)![1];
    expect(Buffer.from(b64, "base64").toString()).toMatch(/blog_b@docker"\s+weight: 0/);
  });

  test("a new site that fails to start stays for lf undo", async () => {
    await applySite(server, site("1", ["1"]), OWN_PROXY, { build: true, what: "deploy blog release 1 (new site)" });
    parses(scripts[0]);
    expect(scripts[0]).not.toContain('eval "$undo"');
    expect(scripts[0]).toContain("lf undo removes blog");
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
  test("the overview says why Docker does not answer, instead of listing no container", async () => {
    reply.stdout = "READY\t1\nTRAEFIK\t\ttraefik\t\nDOCKER\tpermission denied while trying to connect to the docker API\n";
    const o = await overview(server);
    parses(scripts[0]);
    expect(scripts[0]).toContain("printf 'DOCKER\\t%s\\n'");
    expect(o).toMatchObject({ ready: true, unrouted: [], docker: "permission denied while trying to connect to the docker API" });
    reply.stdout = "READY\t1\nCTR\tweb\tUp 1 second\t\t\tnginx:alpine\t80/tcp\n";
    expect((await overview(server)).docker).toBeUndefined();
  });
});
