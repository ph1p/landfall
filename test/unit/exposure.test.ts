import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";

const tmp = fs.mkdtempSync(join(tmpdir(), "lf-exposure-"));
process.env.LANDFALL_CONFIG_DIR = join(tmp, "config");
process.env.LANDFALL_SSH_CONFIG = join(tmp, "ssh_config");
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const x = await import("../../src/core/deploy/exposure");

const write = (root: string, files: Record<string, string>) => {
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(join(root, rel, ".."), { recursive: true });
    fs.writeFileSync(join(root, rel), body);
  }
};

describe("classify", () => {
  test("knows secrets, agent settings and junk, and lets examples and public certificates pass", () => {
    expect(x.classify(".env", false)?.severity).toBe("high");
    expect(x.classify(".env.production", false)?.severity).toBe("high");
    expect(x.classify(".env.example", false)).toBeUndefined();
    expect(x.classify(".git", true)?.severity).toBe("high");
    expect(x.classify(".git", false)).toBeUndefined();
    expect(x.classify(".claude", true)?.severity).toBe("medium");
    expect(x.classify("dump.sql", false)?.severity).toBe("medium");
    expect(x.classify(".DS_Store", false)?.severity).toBe("low");
    expect(x.classify("Thumbs.db", false)?.severity).toBe("low");
    expect(x.classify("cert.pem", false)).toBeUndefined();
    expect(x.classify("server.key", false, true)?.severity).toBe("high");
    expect(x.classify("index.html", false)).toBeUndefined();
  });
});

describe("check", () => {
  test("reports what the upload sends, a flagged folder once, and nothing the defaults leave out", async () => {
    const root = join(tmp, "site");
    write(root, {
      "index.html": "<h1>hi</h1>",
      ".claude/settings.local.json": "{}",
      ".claude/notes.md": "",
      "backup.sql": "",
      "ca.pem": "-----BEGIN CERTIFICATE-----",
      "keys/site.pem": "-----BEGIN PRIVATE KEY-----",
      ".env": "SECRET=1",
      ".DS_Store": "",
      "img/.DS_Store": "",
      "app.log": "",
    });
    const found = (await x.checkFiles(root)).map((f) => `${f.severity} ${f.path}`);
    // .env and .DS_Store are never uploaded (EXCLUDE): only what would really be sent counts.
    expect(found.sort()).toEqual(["high keys/site.pem", "low app.log", "medium .claude/", "medium backup.sql"]);
    expect((await x.checkFiles(root, { rules: { exclude: [".claude/", "*.sql"] } })).map((f) => f.path)).toEqual(["app.log", "keys/site.pem"]);
  });

  test("compose ports: a plain file is unpublished on the server, x-landfall keeps them unless bound to loopback", () => {
    expect(x.composePorts({ services: { db: { image: "postgres", ports: ["5432:5432"] } } })).toEqual([]);
    const ports = x.composePorts({
      services: {
        web: { image: "nginx", "x-landfall": { port: 80 } },
        db: { image: "postgres", ports: ["5432:5432", "127.0.0.1:6379:6379", "[::1]:9000:9000"] },
        game: { image: "mc", ports: ["0.0.0.0:25565:25565/tcp", { target: 8080, published: 8080, host_ip: "127.0.0.1" }, { target: 3306, published: 3306 }] },
        any: { image: "x", ports: [3000] },
      },
    });
    expect(ports.map((p) => `${p.severity} ${p.service} ${p.port}`)).toEqual([
      "high db 5432:5432",
      "medium game 0.0.0.0:25565:25565",
      "high game 3306:3306",
      "medium any random:3000",
    ]);
  });
});

describe("checkProject", () => {
  test("reads .landfall.json and the compose file, and accepts allowed files and ports", async () => {
    const root = join(tmp, "proj");
    write(root, {
      ".landfall.json": JSON.stringify({ exclude: ["*.log"] }),
      "compose.yaml": "services:\n  web:\n    image: nginx\n    x-landfall: { port: 80 }\n  db:\n    image: postgres\n    ports: ['5432:5432']\n",
      ".claude/settings.local.json": "{}",
      "app.log": "",
      "public/.vscode/settings.json": "{}",
    });
    const r = await x.checkProject(root);
    expect(r.compose).toBe("compose.yaml");
    expect([...r.ports.map((p) => `${p.severity} ${p.service}`), ...r.files.map((f) => `${f.severity} ${f.path}`)]).toEqual([
      "high db",
      "medium .claude/",
      "low public/.vscode/",
    ]);
    expect(r.ok).toBe(false);
    const ok = await x.checkProject(root, { allow: [".claude/"], allowPorts: [5432] });
    expect(ok.ok).toBe(true);
    // A folder pattern accepts what is inside it.
    expect((await x.checkProject(root, { allow: ["public/"] })).files.map((f) => f.path)).toEqual([".claude/"]);
    expect((await x.checkProject(root, { allow: [".claude/"], allowPorts: [5432], strict: true })).ok).toBe(false);
  });

  test("compose variables are filled from .env, as on deploy", async () => {
    const root = join(tmp, "vars");
    write(root, {
      ".env": "DB_PORT=5433\nBIND=127.0.0.1\n",
      "compose.yaml":
        "services:\n  web:\n    image: nginx\n    x-landfall: { port: 80 }\n  db:\n    image: postgres\n    ports: ['${DB_PORT}:5432', '${BIND}:6379:6379']\n",
    });
    expect((await x.checkProject(root)).ports.map((p) => `${p.severity} ${p.port}`)).toEqual(["high 5433:5432"]);
  });
});
