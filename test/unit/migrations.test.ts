import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseJournal } from "../../src/core/ssh/journal";
import { LATEST_MIGRATION, MIGRATIONS, migrateScript, READ_STAMP, stampOf, type Migration } from "../../src/core/ssh/migrations";
import { PRELUDE, ROOT } from "../../src/core/ssh/templates";
import { stampSummary, VERSION, versionGt } from "../../src/core/lib/version";

const tmp = () => fs.mkdtempSync(join(tmpdir(), "landfall-test-"));

/** Run PRELUDE + body in bash with /opt/landfall moved to dir, as runScript's header would set it up. */
function sh(dir: string, body: string, env: Record<string, string> = {}) {
  const r = spawnSync("bash", ["-c", `set -euo pipefail\n${PRELUDE.replaceAll(ROOT, dir)}\n${body.replaceAll(ROOT, dir)}`], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANDFALL_RUN: "run1",
      LANDFALL_ACTOR: "me@laptop",
      LANDFALL_CMD: "test",
      LANDFALL_CLI: "0.17.0",
      LANDFALL_MIGRATION: "2",
      LANDFALL_UPDATE: "npm i -g landfall@latest",
      ...env,
    },
  });
  return { code: r.status, out: r.stdout.toString(), err: r.stderr.toString() };
}
const stamp = (dir: string) => JSON.parse(fs.readFileSync(join(dir, "landfall.json"), "utf8"));
const writeStamp = (dir: string, s: object) => fs.writeFileSync(join(dir, "landfall.json"), JSON.stringify(s) + "\n");
const journal = (dir: string) => parseJournal(fs.readFileSync(join(dir, "journal.log"), "utf8"));
const bashOk = (script: string) => spawnSync("bash", ["-n"], { input: `${PRELUDE}\n${script}` }).status === 0;

/** Two migrations that each add a file, journaled with its undo. */
const FAKE: Migration[] = [1, 2].map((id) => ({
  id,
  since: "0.17.0",
  what: `adds m${id}`,
  script: `touch ${ROOT}/m${id}\nrecord "added m${id}" "rm -f ${ROOT}/m${id}"`,
}));

describe("migrations", () => {
  test("ids run 1, 2, 3 … and each names a released version", () => {
    expect(MIGRATIONS.map((m) => m.id)).toEqual(MIGRATIONS.map((_, i) => i + 1));
    expect(LATEST_MIGRATION).toBe(MIGRATIONS.length);
    for (const m of MIGRATIONS) expect(m.since).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("the scripts parse", () => {
    expect(bashOk(migrateScript(FAKE))).toBe(true);
    expect(bashOk(migrateScript())).toBe(true);
  });

  test("migrateScript runs what the server lacks, raising the level, journaled", () => {
    const dir = tmp();
    writeStamp(dir, { newest: "0.17.0", migration: 1 });
    const r = sh(dir, migrateScript(FAKE));
    expect(r.code).toBe(0);
    expect(r.err).not.toContain("warning");
    expect(stamp(dir)).toEqual({ newest: "0.17.0", migration: 2 });
    expect(fs.existsSync(join(dir, "m1"))).toBe(false);
    expect(fs.existsSync(join(dir, "m2"))).toBe(true);
    expect(journal(dir).flatMap((x) => x.steps.map((s) => s.what))).toEqual(["added m2", "landfall migration 2: adds m2"]);
  });

  test("setup: a fresh server is stamped once, at the latest level; an existing one runs what it lacks", () => {
    // As BOOTSTRAP: a fresh server sets _stamp_fresh, then journals its first change.
    const run = (dir: string, fresh: boolean) => sh(dir, `${fresh ? "_stamp_fresh=$LANDFALL_MIGRATION\n" : ""}record "set up"\n${migrateScript(FAKE)}`);
    const fresh = tmp();
    const r = run(fresh, true);
    expect(r.code).toBe(0);
    expect(stamp(fresh)).toEqual({ newest: "0.17.0", migration: 2 });
    expect(fs.existsSync(join(fresh, "m1"))).toBe(false);
    expect(journal(fresh).flatMap((x) => x.steps.map((s) => s.what))).toEqual(["set up"]);

    // No landfall.json and no _stamp_fresh: written by landfall before 0.17, so level 0.
    const old = tmp();
    expect(run(old, false).code).toBe(0);
    expect(stamp(old).migration).toBe(2);
    expect(fs.readFileSync(join(old, "journal.log"), "utf8")).toContain("landfall migration 2");
    // Up to date: nothing runs again.
    const before = fs.readFileSync(join(old, "journal.log"), "utf8");
    expect(sh(old, migrateScript(FAKE)).code).toBe(0);
    expect(fs.readFileSync(join(old, "journal.log"), "utf8")).toBe(before);
  });

  test("undoing a migration sets the level back and keeps newest", () => {
    const dir = tmp();
    writeStamp(dir, { newest: "0.17.0", migration: 0 });
    expect(sh(dir, migrateScript(FAKE.slice(0, 1))).code).toBe(0);
    const step = journal(dir)[0].steps.at(-1)!;
    expect(step.what).toBe("landfall migration 1: adds m1");
    // A later, newer lf changed the server; then the migration is undone.
    expect(sh(dir, `record "y"`, { LANDFALL_CLI: "0.18.0", LANDFALL_RUN: "run2" }).code).toBe(0);
    expect(sh(dir, step.undo!, { LANDFALL_CLI: "0.18.0", LANDFALL_RUN: "run3" }).code).toBe(0);
    expect(stamp(dir)).toEqual({ newest: "0.18.0", migration: 0 });
  });
});

describe("the server stamp", () => {
  test("ver_gt compares dotted versions and ignores a prerelease suffix", () => {
    const gt = (a: string, b: string) => sh(tmp(), `ver_gt ${a} ${b}`).code === 0;
    expect(gt("0.16.0", "0.9.3")).toBe(true);
    expect(gt("1.0.0", "0.99.99")).toBe(true);
    expect(gt("0.9.3", "0.16.0")).toBe(false);
    expect(gt("0.17.0", "0.17.0")).toBe(false);
    expect(gt("0.17.0-beta.1", "0.17.0")).toBe(false);
    expect(gt("0.17.1", "0.17")).toBe(true);
    expect(gt("0.17.0", "''")).toBe(true);
    expect(gt("''", "0.17.0")).toBe(false);
  });

  test("the first journaled change stamps the server and adds the version to the journal", () => {
    const dir = tmp();
    const r = sh(dir, `record "one" "true"; record "two" "true"`);
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
    expect(stamp(dir)).toEqual({ newest: "0.17.0", migration: 0 });
    expect(journal(dir)[0].landfall).toBe("0.17.0");
    // Nothing journaled, nothing stamped.
    const quiet = tmp();
    expect(sh(quiet, `true`).code).toBe(0);
    expect(fs.existsSync(join(quiet, "landfall.json"))).toBe(false);
  });

  test("a newer lf raises newest; an older one warns once per run and leaves it", () => {
    const dir = tmp();
    writeStamp(dir, { newest: "0.18.0", migration: 1 });
    const r = sh(dir, `record "x"; record "y"`);
    expect(r.err.match(/warning/g)).toHaveLength(1);
    expect(r.err).toContain("a newer landfall changed this server (0.18.0, migration 1), yours is 0.17.0");
    expect(stamp(dir)).toEqual({ newest: "0.18.0", migration: 1 });
    // Another script of the same lf run does not warn again; the next run does.
    expect(sh(dir, `record "z"`).err).toBe("");
    expect(sh(dir, `record "z"`, { LANDFALL_RUN: "run2" }).err).toContain("warning");
    expect(sh(dir, `record "z"`, { LANDFALL_CLI: "0.19.0", LANDFALL_RUN: "run3" }).err).toBe("");
    expect(stamp(dir).newest).toBe("0.19.0");
  });

  test("a server with migrations this lf does not know warns to update lf", () => {
    const dir = tmp();
    writeStamp(dir, { newest: "0.17.0", migration: 5 });
    expect(sh(dir, `record "x"`).err).toContain("migration 5), yours is 0.17.0 (migration 2)");
    expect(stamp(dir).migration).toBe(5);
  });
});

describe("reading the stamp", () => {
  test("READ_STAMP and stampOf: the file, and the landfall of the journal's last line", () => {
    const dir = tmp();
    expect(sh(dir, `record "x"`, { LANDFALL_CLI: VERSION }).code).toBe(0);
    const out = sh(dir, READ_STAMP).out;
    expect(stampOf(out, FAKE)).toEqual({ version: VERSION, newest: VERSION, migration: 0, pending: FAKE.map(({ script: _, ...m }) => m), newer: false });
    fs.rmSync(join(dir, "landfall.json"));
    expect(stampOf(sh(dir, READ_STAMP).out)).toMatchObject({ version: VERSION, migration: 0 });
    expect(sh(join(dir, "nope"), READ_STAMP).out).toBe("");
  });

  test("stampOf: nothing printed means landfall never set the server up; junk reads as unknown", () => {
    expect(stampOf("")).toBeUndefined();
    expect(stampOf("not json\t")).toEqual({ version: undefined, newest: undefined, migration: 0, pending: [], newer: false });
    expect(stampOf(`{"migration":"x"}\t`)?.migration).toBe(0);
  });

  test("newer, and its summary", () => {
    const now = stampOf(`{"newest":"${VERSION}","migration":${LATEST_MIGRATION}}\t${VERSION}`)!;
    expect(now.newer).toBe(false);
    expect(stampSummary(now, "upd")).toEqual({ text: `${VERSION} · migration ${LATEST_MIGRATION}` });
    const ahead = stampOf(`{"newest":"99.0.0","migration":0}\t99.0.0`)!;
    expect(ahead.newer).toBe(true);
    expect(stampSummary(ahead, "upd").note).toBe(`a newer landfall (99.0.0) changed it, yours is ${VERSION}: upd`);
    expect(stampOf(`{"migration":${LATEST_MIGRATION + 1}}\t`)!.newer).toBe(true);
    const behind = stampOf(`{}\t`, FAKE)!;
    expect(stampSummary(behind, "upd")).toEqual({ text: "unknown · migration 0", note: "2 upgrades pending: lf server upgrade" });
  });

  test("versionGt", () => {
    expect(versionGt("0.16.0", "0.9.3")).toBe(true);
    expect(versionGt("0.17.0", "0.17.0")).toBe(false);
    expect(versionGt("0.17.0-beta.1", "0.17.0")).toBe(false);
    expect(versionGt("1.0", "0.99.1")).toBe(true);
  });
});

describe("the journal's version column", () => {
  test("lines with and without it parse", () => {
    const b = Buffer.from("true").toString("base64");
    const text = [
      ["2026-01-01T00:00:00Z", "old", "a@b", "u", "deploy", "do", "x", b].join("\t"),
      ["2026-01-02T00:00:00Z", "new", "a@b", "u", "deploy", "do", "y", b, "0.17.0"].join("\t"),
    ].join("\n");
    const [old, nu] = parseJournal(text);
    expect(old.landfall).toBeUndefined();
    expect(nu.landfall).toBe("0.17.0");
    expect(nu.steps[0].undo).toBe("true");
  });
});

describe("runScript", () => {
  test("tells every script which landfall runs it and the migrations it knows", async () => {
    const dir = tmp();
    const out = join(dir, "script");
    fs.writeFileSync(join(dir, "ssh"), `#!/bin/sh\ncat > ${out}\n`, { mode: 0o755 });
    fs.writeFileSync(join(dir, "ssh_config"), "");
    const env = { PATH: process.env.PATH, LANDFALL_SSH_CONFIG: process.env.LANDFALL_SSH_CONFIG, LANDFALL_CONFIG_DIR: process.env.LANDFALL_CONFIG_DIR };
    Object.assign(process.env, { PATH: `${dir}:${process.env.PATH}`, LANDFALL_SSH_CONFIG: join(dir, "ssh_config"), LANDFALL_CONFIG_DIR: dir });
    try {
      const { runScript } = await import("../../src/core/ssh/ssh");
      await runScript({ name: "box", host: "127.0.0.1", user: "deploy" } as never, "true", { capture: true });
    } finally {
      for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    }
    const script = fs.readFileSync(out, "utf8");
    expect(script).toContain(`LANDFALL_CLI='${VERSION}'`);
    expect(script).toContain(`LANDFALL_MIGRATION='${LATEST_MIGRATION}'`);
  });
});
