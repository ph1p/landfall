import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { failedHook, hookLines, readHooks, releaseHooks, serverCall, skipper } from "../../src/core/site/hooks";

const dirs: string[] = [];
const project = (pkg: object, lock = "pnpm-lock.yaml") => {
  const d = fs.mkdtempSync(join(os.tmpdir(), "lf-hooks-"));
  dirs.push(d);
  fs.writeFileSync(join(d, "package.json"), JSON.stringify(pkg));
  fs.writeFileSync(join(d, lock), "");
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const scripts = { lint: "x", test: "x", "db:migrate": "x", smoke: "x" };
const web = [{ name: "web", networks: ["default"], build: true, port: 3000 }];

describe("readHooks", () => {
  test("reads hooks as lists, with the package manager of the lockfile", () => {
    const d = project({ scripts, landfall: { hooks: { prebuild: ["lint"], predeploy: "test", release: "db:migrate" } } });
    expect(readHooks(d)).toEqual({ dir: d, pm: "pnpm", run: { prebuild: ["lint"], predeploy: ["test"], release: ["db:migrate"] } });
  });

  test("no package.json, no landfall section or no hooks: none", () => {
    expect(readHooks(join(os.tmpdir(), "lf-no-such-dir"))).toBeUndefined();
    expect(readHooks(project({ scripts }))).toBeUndefined();
    expect(readHooks(project({ scripts, landfall: { hooks: {} } }))).toBeUndefined();
  });

  test("refuses unknown hooks, missing scripts and wrong shapes", () => {
    expect(() => readHooks(project({ scripts, landfall: { hooks: { predeplo: "test" } } }))).toThrow(/unknown hook "predeplo"/);
    expect(() => readHooks(project({ scripts, landfall: { hooks: { verify: ["smoke", "e2e"] } } }))).toThrow(/runs e2e, which "scripts" does not have/);
    expect(() => readHooks(project({ scripts, landfall: { hooks: { verify: 1 } } }))).toThrow(/script name or a list/);
    expect(() => readHooks(project({ scripts, landfall: { service: 1 } }))).toThrow(/must name a compose service/);
  });
});

describe("readHooks from .landfall.json", () => {
  test("reads shell commands, without a package manager, run in the project folder", () => {
    const h = readHooks("/nowhere", { hookService: "app", hooks: { release: "php artisan migrate --force", verify: ["curl -fs $LANDFALL_URL/up"] } });
    expect(h).toEqual({
      dir: "/nowhere",
      service: "app",
      run: { release: ["php artisan migrate --force"], verify: ["curl -fs $LANDFALL_URL/up"] },
    });
  });

  test("refuses unknown hooks, empty commands and hooks in both files", () => {
    expect(() => readHooks("/nowhere", { hooks: { deploy: "x" } })).toThrow(/\.landfall\.json: unknown hook "deploy"/);
    expect(() => readHooks("/nowhere", { hooks: { verify: [" "] } })).toThrow(/hooks\.verify must be a command or a list/);
    const d = project({ scripts, landfall: { hooks: { predeploy: "test" } } });
    expect(() => readHooks(d, { hooks: { verify: "true" } })).toThrow(/hooks in both package.json .* keep them in one/);
  });

  test("each file names the service of its own hooks", () => {
    const npm = project({ scripts, landfall: { hooks: { release: "db:migrate" } } });
    expect(() => readHooks(npm, { hookService: "web" })).toThrow(/hookService is for \.landfall\.json's hooks/);
    const svc = project({ scripts, landfall: { service: "web" } });
    expect(() => readHooks(svc, { hooks: { release: "true" } })).toThrow(/landfall\.service is for package\.json's hooks/);
    expect(() => readHooks("/nowhere", { hookService: "", hooks: { release: "true" } })).toThrow(/"hookService" must name a compose service/);
  });

  test("package.json in the project's dir first, else in the folder", () => {
    const d = project({ scripts, landfall: { hooks: { predeploy: "test" } } });
    expect(readHooks(d, { dir: "no-such-sub" })?.dir).toBe(d);
  });
});

test("project settings next to the hooks are not hook errors", () => {
  const h = readHooks(project({ scripts: { test: "x" }, landfall: { name: "shop", domains: ["shop.com"], hooks: { predeploy: "test" } } }));
  expect(h?.run).toEqual({ predeploy: ["test"] });
});

describe("skipper", () => {
  test("skips named hooks or all, and notes the skipped ones for the journal", () => {
    const s = skipper({ "skip-hook": ["verify"] });
    expect(s.note()).toBe("");
    expect(s.skips("verify", ["smoke"])).toBe(true);
    expect(s.skips("release", ["db:migrate"])).toBe(false);
    expect(s.note()).toBe(" (skipped hooks: verify)");
    expect(skipper({ "skip-hooks": true }).skips("release", ["db:migrate"])).toBe(true);
  });

  test("refuses a hook that does not exist", () => {
    expect(() => skipper({ "skip-hook": ["verfy"] })).toThrow(/no hook verfy/);
  });
});

describe("releaseHooks", () => {
  const h = { dir: "/p", pm: "npm", run: { prebuild: ["lint"], release: ["db:migrate"], verify: ["smoke"] } };

  test("keeps the server hooks, with the service and its port", () => {
    expect(releaseHooks(h, web, "dockerfile")).toEqual({ pm: "npm", service: "web", port: 3000, run: { release: ["db:migrate"], verify: ["smoke"] } });
  });

  test("local hooks only: nothing to save", () => {
    expect(releaseHooks({ ...h, run: { prebuild: ["lint"] } }, web, "static")).toBeUndefined();
  });

  test("commands keep no package manager, and may run in a static site's container", () => {
    const cmds = { dir: "/p", run: { verify: ["wget -qO- $LANDFALL_URL"] } };
    expect(releaseHooks(cmds, web, "static")).toEqual({ service: "web", port: 3000, run: { verify: ["wget -qO- $LANDFALL_URL"] } });
  });

  test("refuses server hooks on a static site and an unknown service", () => {
    expect(() => releaseHooks(h, web, "static")).toThrow(/static site/);
    expect(() => releaseHooks({ ...h, service: "api" }, web, "compose")).toThrow(/package.json: the hooks' service is api/);
  });
});

describe("hookLines", () => {
  const hooks = { pm: "pnpm", service: "web", port: 3000, run: { release: ["db:migrate", "db:seed"], postdeploy: ["notify"] } };
  const call = (hook: "release" | "postdeploy", vars = {}) => serverCall(hooks, hook, skipper({}), vars);

  test("a blocking hook runs onFail and exits, naming the hook", () => {
    const lines = hookLines(call("release", { LANDFALL_RELEASE: "2" }), "run", "releases/2", ['eval "$undo"']).join("\n");
    expect(lines).toContain("dc run --rm -T --label traefik.enable=false --entrypoint sh -e 'LANDFALL_HOOK=release' -e 'LANDFALL_RELEASE=2' 'web'");
    // One container for the whole list.
    expect(lines).toContain("'pnpm' 'db:migrate' 'db:seed' </dev/null >&2");
    expect(lines).toMatch(/eval "\$undo"\necho 'hook release failed: pnpm run db:migrate, db:seed; --skip-hook release goes on without it' >&2\nexit 1/);
  });

  test("a reporting hook only logs its failure", () => {
    const lines = hookLines(call("postdeploy"), "exec", "current");
    expect(lines.join("\n")).toContain("dc exec -T -e 'LANDFALL_HOOK=postdeploy' -e 'LANDFALL_URL=http://127.0.0.1:3000'");
    expect(lines).not.toContain("exit 1");
  });

  test("shell commands run with sh -c, one after another", () => {
    const cmds = { service: "app", run: { release: ["php artisan migrate --force", "php artisan cache:clear"] } };
    const lines = hookLines(serverCall(cmds, "release", skipper({}), {}), "run", "releases/2", ['eval "$undo"']).join("\n");
    expect(lines).toContain(`'sh' 'php artisan migrate --force' 'php artisan cache:clear' </dev/null >&2`);
    expect(lines).toContain('sh -c "$s"');
    expect(lines).toContain("hook release failed: php artisan migrate --force; php artisan cache:clear");
  });

  test("failedHook finds the hook in an error", () => {
    expect(failedHook("hook verify failed: npm run smoke")).toBe("verify");
    expect(failedHook("ssh: connection refused")).toBeUndefined();
  });
});
