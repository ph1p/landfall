import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { backupName, backupsOf, parseVolumes, pickVolume, tarIn, whileStopped } from "../../src/core/volumes";
import { shq } from "../../src/core/ssh";

describe("volumes", () => {
  test("parseVolumes joins volumes, mounts, sizes and backups", () => {
    const out = [
      "vol\tblog_content\tcontent",
      "vol\tblog_db\tdb",
      "mnt\tblog_content\tweb\t/app/content",
      "mnt\tblog_content\tweb\t/app/content",
      "mnt\tshared\tweb\t/shared",
      "size\tblog_content\t4096",
      "bak\tcontent-20261027-181500.tar.gz\t123\t1793125000",
      "bak\tcontent-20261028-090000-before-push.tar.gz\t99\t1793170000",
    ].join("\n");
    const { volumes, backups } = parseVolumes(out);
    expect(volumes.map((v) => [v.key, v.name, v.size, v.mounts.length])).toEqual([
      ["content", "blog_content", 4096, 1],
      ["db", "blog_db", undefined, 0],
      ["shared", "shared", undefined, 1],
    ]);
    expect(backups[0].file).toBe("content-20261028-090000-before-push.tar.gz");
    expect(backupsOf(backups, "content")).toHaveLength(2);
    expect(backupsOf(backups, "cont")).toHaveLength(0);
  });

  test("pickVolume by compose name or docker name; asks when there are several", () => {
    const vols = parseVolumes("vol\tblog_content\tcontent\nvol\tblog_db\tdb").volumes;
    expect(pickVolume(vols, "content", "blog").name).toBe("blog_content");
    expect(pickVolume(vols, "blog_db", "blog").key).toBe("db");
    expect(() => pickVolume(vols, undefined, "blog")).toThrow(/which volume of blog\? content, db/);
    expect(() => pickVolume(vols, "media", "blog")).toThrow(/no volume media/);
    expect(pickVolume(vols.slice(0, 1), undefined, "blog").key).toBe("content");
  });

  test("backupName sorts by time and names the volume", () => {
    const t = new Date("2026-10-27T18:15:00Z");
    expect(backupName("content", t)).toBe("content-20261027-181500.tar.gz");
    expect(backupName("content", t, "before-push")).toBe("content-20261027-181500-before-push.tar.gz");
  });

  test("whileStopped starts the containers again when a step fails, and fails itself", () => {
    const dir = fs.mkdtempSync(join(tmpdir(), "lf-vol-"));
    const docker = `docker() { echo "$*" >> ${shq(join(dir, "log"))}; [ "$1" != ps ] || echo abc; }`;
    const run = (steps: string[]) => spawnSync("bash", ["-c", `set -euo pipefail\n${docker}\n${whileStopped("blog_content", steps)}`]).status;
    expect(run(["true", "false", "echo never >> " + shq(join(dir, "log"))])).not.toBe(0);
    expect(run(["true"])).toBe(0);
    const log = fs.readFileSync(join(dir, "log"), "utf8").trim().split("\n");
    expect(log).toEqual(["ps -q --filter volume=blog_content", "stop abc", "start abc", "ps -q --filter volume=blog_content", "stop abc", "start abc"]);
    expect(tarIn("v", true)).toContain("chown -R $o /v");
    expect(tarIn("v")).not.toContain("chown");
  });
});
