import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { backupName, backupsOf, parseVolumes, pickVolume, tarIn, whileStopped } from "../../src/core/volumes";
import { shq } from "../../src/core/ssh";
import { seedFolders } from "../../src/core/ignore";

describe("volumes", () => {
  test("parseVolumes joins volumes, mounts, sizes and backups", () => {
    const out = [
      "vol\tblog_content\tcontent\t/opt/landfall/sites/blog/volumes/content",
      "vol\tblog_db\tdb\t",
      "mnt\tblog_content\tweb\t/app/content",
      "mnt\tblog_content\tweb\t/app/content",
      "mnt\tshared\tweb\t/shared",
      "size\tblog_content\t4096",
      "bak\tcontent-20261027-181500.tar.gz\t123\t1793125000",
      "bak\tcontent-20261028-090000-before-push.tar.gz\t99\t1793170000",
    ].join("\n");
    const { volumes, backups } = parseVolumes(out);
    expect(volumes.map((v) => [v.key, v.name, v.size, v.mounts.length, v.dir])).toEqual([
      ["content", "blog_content", 4096, 1, "/opt/landfall/sites/blog/volumes/content"],
      ["db", "blog_db", undefined, 0, undefined],
      ["shared", "shared", undefined, 1, undefined],
    ]);
    expect(backups[0].file).toBe("content-20261028-090000-before-push.tar.gz");
    expect(backupsOf(backups, "content")).toHaveLength(2);
    expect(backupsOf(backups, "cont")).toHaveLength(0);
  });

  test("parseVolumes marks the empty volumes", () => {
    const { volumes } = parseVolumes(["vol\tblog_content\tcontent", "vol\tblog_db\tdb", "empty\tblog_content", "empty\tnope"].join("\n"));
    expect(volumes.map((v) => [v.key, !!v.empty])).toEqual([
      ["content", true],
      ["db", false],
    ]);
  });

  test("seedFolders: data folders the upload left out, not dot folders, node_modules or empty ones", () => {
    const dir = fs.mkdtempSync(join(tmpdir(), "lf-seed-"));
    for (const f of ["content/a.md", "uploads/x.png", "src/index.ts", ".cache/x", "node_modules/m/i.js"]) {
      fs.mkdirSync(join(dir, f, ".."), { recursive: true });
      fs.writeFileSync(join(dir, f), "x");
    }
    fs.mkdirSync(join(dir, "empty"));
    const uploaded = [
      { path: "src", dir: true, size: 0 },
      { path: "src/index.ts", dir: false, size: 1 },
      { path: "uploads", dir: true, size: 0 },
      { path: "uploads/x.png", dir: false, size: 1 },
    ];
    expect(seedFolders(dir, uploaded)).toEqual(["content"]);
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
