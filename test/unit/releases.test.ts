import { describe, expect, test } from "vitest";
import type { SiteMeta } from "../../src/core/compose";
import { oldReleases } from "../../src/core/remote";

const site = (current: string, ids: string[]) =>
  ({ name: "blog", current, releases: ids.map((id) => ({ id, at: id, services: [] })) }) as unknown as SiteMeta;
const ids = (m: SiteMeta, o?: Parameters<typeof oldReleases>[1]) => oldReleases(m, o).map((r) => r.id);

describe("releases lf release rm deletes", () => {
  const m = site("20260103000000", ["20260101000000", "20260102000000", "20260103000000", "20260104000000"]);

  test("all but the live one, newest first", () => {
    expect(ids(m)).toEqual(["20260104000000", "20260102000000", "20260101000000"]);
  });

  test("--keep keeps the newest, and the live one anyway", () => {
    expect(ids(m, { keep: 1 })).toEqual(["20260102000000", "20260101000000"]);
    expect(ids(m, { keep: 3 })).toEqual(["20260101000000"]);
    expect(ids(m, { keep: 9 })).toEqual([]);
  });

  test("named ones, never the live one", () => {
    expect(ids(m, { ids: ["20260101000000", "20260103000000"] })).toEqual(["20260101000000"]);
  });
});
