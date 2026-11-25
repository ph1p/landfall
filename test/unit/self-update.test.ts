import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-update-"));
process.env.LANDFALL_CONFIG_DIR = dir;
const { availableUpdate, newer, refreshUpdate, updateCommand, updateFile, updateNotice } = await import("../../src/core/self-update");

const cache = () => JSON.parse(fs.readFileSync(updateFile(), "utf8"));
const answer = (version: string) => vi.fn(async () => new Response(JSON.stringify({ version }), { status: 200 }));

beforeEach(() => fs.rmSync(updateFile(), { force: true }));
afterEach(() => vi.unstubAllGlobals());

describe("self-update", () => {
  it("compares versions", () => {
    expect(newer("0.15.0", "0.14.2")).toBe(true);
    expect(newer("1.10.0", "1.9.9")).toBe(true);
    expect(newer("0.14.2", "0.14.2")).toBe(false);
    expect(newer("0.14.1", "0.14.2")).toBe(false);
  });

  it("asks the registry at most once a day", async () => {
    const f = answer("9.0.0");
    vi.stubGlobal("fetch", f);
    await refreshUpdate();
    await refreshUpdate();
    expect(f).toHaveBeenCalledTimes(1);
    expect(cache().latest).toBe("9.0.0");
    expect(availableUpdate("0.14.2")).toBe("9.0.0");
    expect(availableUpdate("9.0.0")).toBeUndefined();
  });

  it("stays quiet when the registry cannot be reached", async () => {
    const f = vi.fn(async () => Promise.reject(new Error("offline")));
    vi.stubGlobal("fetch", f);
    await expect(refreshUpdate()).resolves.toBeUndefined();
    // Offline: asks again in an hour, not on the next run.
    await refreshUpdate();
    expect(f).toHaveBeenCalledTimes(1);
    expect(cache().latest).toBeUndefined();
    expect(updateNotice("0.14.2")).toBeUndefined();
  });

  it("prints the notice once a day", async () => {
    vi.stubGlobal("fetch", answer("9.0.0"));
    await refreshUpdate();
    expect(updateNotice("0.14.2")).toMatch(/^landfall 9\.0\.0 is available \(this is 0\.14\.2\)\. Update: /);
    expect(updateNotice("0.14.2")).toBeUndefined();
  });

  it("names the package manager it was installed with", () => {
    expect(updateCommand("/usr/local/lib/node_modules/landfall/dist/cli.mjs")).toBe("npm i -g landfall@latest");
    expect(updateCommand("/Users/me/Library/pnpm/global/5/node_modules/landfall/dist/cli.mjs")).toBe("pnpm add -g landfall@latest");
    expect(updateCommand("/home/me/.bun/install/global/node_modules/landfall/dist/cli.mjs")).toBe("bun add -g landfall@latest");
  });
});
