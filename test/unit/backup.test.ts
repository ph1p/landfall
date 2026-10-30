import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { PRELUDE } from "../../src/core/templates";

// The shell landfall would run on the server, captured instead of sent, then run here against stand-ins.
const scripts: string[] = [];
vi.mock("../../src/core/ssh", async (orig) => ({
  ...(await orig<typeof import("../../src/core/ssh")>()),
  runScript: async (_s: unknown, script: string) => {
    scripts.push(script);
    return { code: 0, stdout: "", stderr: "" };
  },
}));
vi.mock("../../src/core/remote", async (orig) => ({
  ...(await orig<typeof import("../../src/core/remote")>()),
  requireSite: async (_s: unknown, name: string) => ({ meta: { name, releases: [], domains: [] }, env: "", proxy: {} }),
}));
const { backupScript, scheduleBackups } = await import("../../src/cli/commands/volume");
const { listScript, parseVolumes } = await import("../../src/core/volumes");

const server = { host: "example.com" } as any;
let dir: string;
beforeEach(() => {
  scripts.length = 0;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-backup-"));
});

/**
 * Runs a captured script (or an undo line) with crontab, record, pidof and pkg_mgr as stand-ins writing to `dir`, the site
 * folder under it. crontab is a file first on PATH, never the machine's own.
 */
function runHere(script: string) {
  const bin = path.join(dir, "fake");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "crontab"), `#!/bin/sh\ncase "$1" in -l) cat "${dir}/tab" 2>/dev/null ;; -) cat > "${dir}/tab" ;; *) exit 1 ;; esac\n`, { mode: 0o755 });
  const stubs = [`export PATH=${bin}:$PATH`, `record() { printf '%s' "$2" > ${dir}/undo; }`, "pidof() { return 0; }", "pkg_mgr() { echo none; }"].join("\n");
  const s = script.replace(PRELUDE, "").replaceAll("/opt/landfall/sites/", `${dir}/`);
  return execFileSync("bash", ["-c", `set -euo pipefail\n${stubs}\n${s}`], { input: "", encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
}
const tab = () => fs.readFileSync(path.join(dir, "tab"), "utf8");

describe("scheduled backups", () => {
  test("a schedule is one crontab line next to the others, and undo puts back what was there", async () => {
    fs.writeFileSync(path.join(dir, "tab"), "0 1 * * * other job\n");
    await scheduleBackups(server, "blog", "daily", 7);
    runHere(scripts[0]);
    expect(tab()).toMatch(/^0 1 \* \* \* other job\n\d+ 3 \* \* \* sh .*\/blog\/backups\/backup\.sh >>.*backup\.log 2>&1 # landfall backup blog: daily, keep 7\n$/);
    expect(fs.statSync(path.join(dir, "blog/backups/backup.sh")).mode & 0o777).toBe(0o755);

    // Changed: still one line. Then undo goes back to daily, and once more to none.
    const undoNone = fs.readFileSync(path.join(dir, "undo"), "utf8");
    await scheduleBackups(server, "blog", "hourly", 2);
    runHere(scripts[1]);
    expect(tab().match(/landfall backup blog:/g)).toHaveLength(1);
    expect(tab()).toContain("blog: hourly, keep 2");
    runHere(fs.readFileSync(path.join(dir, "undo"), "utf8"));
    expect(tab()).toContain("blog: daily, keep 7");
    runHere(undoNone);
    expect(tab()).toBe("0 1 * * * other job\n");
  });

  test("off removes the line only", async () => {
    fs.writeFileSync(path.join(dir, "tab"), "0 1 * * * other job\n5 3 * * * sh x # landfall backup blog: daily, keep 7\n");
    await scheduleBackups(server, "blog", "off", 7);
    runHere(scripts[0]);
    expect(tab()).toBe("0 1 * * * other job\n");
  });

  test("an unknown schedule is refused before anything runs", async () => {
    await expect(scheduleBackups(server, "blog", "monthly", 7)).rejects.toThrow(/hourly, daily, weekly or off/);
    expect(scripts).toHaveLength(0);
  });

  test("backup.sh saves each volume and keeps the newest of its timestamped backups only", () => {
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    // docker: one volume, blog_data (Compose name data); `run` writes the archive.
    fs.writeFileSync(
      path.join(bin, "docker"),
      `#!/bin/sh\ncase "$1 $2" in "volume ls") echo blog_data ;; "volume inspect") echo data ;; run*) echo archive ;; esac\n`,
      { mode: 0o755 },
    );
    const old = ["data-20200101-000001.tar.gz", "data-20200101-000002.tar.gz", "data-20200101-000003.tar.gz"];
    const keepAlways = ["data-before-push-20200101-000000.tar.gz", "database-20200101-000000.tar.gz"];
    for (const f of [...old, ...keepAlways]) fs.writeFileSync(path.join(dir, f), "");
    const script = backupScript("blog", 2).replace(/^PATH=.*$/m, `PATH="${bin}:$PATH"`);
    fs.writeFileSync(path.join(dir, "backup.sh"), script);
    expect(execFileSync("sh", [path.join(dir, "backup.sh")], { encoding: "utf8" })).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ ok\n$/);
    const left = fs.readdirSync(dir).filter((f) => f.endsWith(".tar.gz")).sort();
    const made = left.filter((f) => /^data-\d{8}-\d{6}\.tar\.gz$/.test(f) && !old.includes(f));
    expect(made).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, made[0]), "utf8")).toBe("archive\n");
    expect(left).toEqual([...keepAlways, made[0], old[2]].sort());
  });

  test("lf volumes lists with and without a crontab", () => {
    const bin = path.join(dir, "fake");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "docker"), "#!/bin/sh\n", { mode: 0o755 });
    // No crontab yet: crontab -l fails, which must not fail the listing.
    const list = () => runHere(`SIZES=0 EMPTY=0\n${listScript("blog", dir, "blog")}`);
    expect(list()).toBe("");
    fs.writeFileSync(path.join(dir, "tab"), "17 3 * * * sh backup.sh # landfall backup blog: daily, keep 7\n");
    expect(list()).toBe("sched\tdaily, keep 7\n");
    // The last status line of backup.log, not the error lines around it.
    fs.mkdirSync(path.join(dir, "backups"), { recursive: true });
    fs.writeFileSync(path.join(dir, "backups/backup.log"), "2026-10-01T03:17:00Z ok\n2026-10-02T03:17:00Z backup of blog_db failed\ntar: error\n2026-10-02T03:17:01Z failed: blog_db blog_x\n");
    expect(list()).toBe("last\t2026-10-02T03:17:01Z failed: blog_db blog_x\nsched\tdaily, keep 7\n");
    expect(parseVolumes(list()).lastRun).toEqual({ time: "2026-10-02T03:17:01Z", failed: ["blog_db", "blog_x"] });
    expect(parseVolumes("last\t2026-10-03T03:17:00Z ok\n").lastRun).toEqual({ time: "2026-10-03T03:17:00Z", failed: [] });
  });

  test("lf volumes reads the schedule", () => {
    expect(parseVolumes("vol\tblog_data\tdata\nsched\tdaily, keep 7\n").schedule).toBe("daily, keep 7");
    expect(parseVolumes("vol\tblog_data\tdata\n").schedule).toBeUndefined();
  });
});
