import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { PRELUDE } from "../../src/core/ssh/templates";

// The shell landfall would run on the server, captured instead of sent.
const scripts: string[] = [];
const reply = { stdout: "" };
vi.mock("../../src/core/ssh/ssh", async (orig) => ({
  ...(await orig<typeof import("../../src/core/ssh/ssh")>()),
  runScript: async (_s: unknown, script: string) => {
    scripts.push(script);
    return { code: 0, stdout: reply.stdout, stderr: "" };
  },
}));
const { checkUnknownHosts, fileProvider, planStrictTls, readDynamicDir, STRICT_TLS_FILE, tlsDefaultIn, writeStrictTls } =
  await import("../../src/core/traefik/stricttls");

const server = { host: "example.com" } as any;
const parses = (script: string) => execFileSync("bash", ["-n"], { input: script });

beforeEach(() => {
  scripts.length = 0;
  reply.stdout = "";
});

// Like the compose file of a Traefik set up by hand: quoted flags, a comment, the certificates mounted.
const COMPOSE = `services:
  reverseproxy:
    image: traefik:v3.1
    command:
      - "--providers.docker=true"
      - "--entrypoints.websecure.address=:443" # https
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./letsencrypt:/letsencrypt
`;

const PROXY = {
  container: "traefik-1",
  own: true,
  root: true,
  accessLog: "off" as const,
  files: ["/srv/t/docker-compose.yml"],
  dir: "/srv/t",
  project: "t",
  service: "reverseproxy",
  text: COMPOSE,
  sha256: "abc",
};
const EMPTY = { exists: false, entries: 0, files: [] };

describe("fileProvider", () => {
  test("none yet: adds the flags and a ./dynamic volume", () => {
    expect(fileProvider(COMPOSE, "reverseproxy", "/srv/t")).toEqual({
      hostDir: "/srv/t/dynamic",
      containerDir: "/etc/traefik/dynamic",
      watch: true,
      add: { flags: ["--providers.file.directory=/etc/traefik/dynamic", "--providers.file.watch=true"], volume: "./dynamic:/etc/traefik/dynamic:ro" },
    });
  });

  test("an existing provider folder maps back to the server through its volume", () => {
    const text = COMPOSE.replace(`:443" # https\n`, `:443" # https\n      - --providers.file.directory=/conf/dyn\n`).replace(
      "./letsencrypt:/letsencrypt\n",
      "./letsencrypt:/letsencrypt\n      - /opt/traefik/conf:/conf:ro\n",
    );
    expect(fileProvider(text, "reverseproxy", "/srv/t")).toEqual({ hostDir: "/opt/traefik/conf/dyn", containerDir: "/conf/dyn", watch: false });
    const watched = text.replace("/conf/dyn\n", "/conf/dyn\n      - --providers.file.watch\n");
    expect(fileProvider(watched, "reverseproxy", "/srv/t")).toMatchObject({ watch: true });
  });

  test("refuses config it does not own", () => {
    const err = (text: string) => (fileProvider(text, "reverseproxy", "/srv/t") as { error: string }).error;
    expect(err(COMPOSE.replace(`- "--providers.docker=true"`, `- "--configfile=/etc/traefik/t.yml"`))).toMatch(/--configfile/);
    expect(err(COMPOSE.replace(`- "--providers.docker=true"`, `- "--providers.file.filename=/etc/dyn.yml"`))).toMatch(/one file/);
    expect(err(`${COMPOSE}      - ./traefik.yml:/etc/traefik/traefik.yml:ro\n`)).toMatch(/mounts \/etc\/traefik\/traefik.yml/);
    expect(err(COMPOSE.replace(`- "--providers.docker=true"`, `- "--providers.file.directory=/nowhere"`))).toMatch(/not a folder mounted/);
    expect(err(`${COMPOSE}      - dyn:/etc/traefik/dynamic\n`)).toMatch(/docker volume dyn/);
    expect(err(COMPOSE.replace(/ {4}volumes:\n.*\n.*\n/, ""))).toMatch(/no volumes list/);
    expect(err("services:\n  reverseproxy:\n    image: traefik\n")).toMatch(/configured by a file/);
  });
});

describe("tlsDefaultIn", () => {
  test("finds tls.options.default in YAML and TOML", () => {
    expect(tlsDefaultIn([{ name: "a.yml", text: "http: {}\n" }])).toBeUndefined();
    expect(tlsDefaultIn([{ name: "tls.yml", text: "tls:\n  options:\n    default:\n      sniStrict: true\n" }])).toEqual({ name: "tls.yml", strict: true });
    expect(tlsDefaultIn([{ name: "tls.yml", text: "tls:\n  options:\n    default:\n      minVersion: VersionTLS12\n" }])).toEqual({
      name: "tls.yml",
      strict: false,
    });
    expect(tlsDefaultIn([{ name: "t.toml", text: "[tls.options.default]\n  sniStrict = true\n" }])).toEqual({ name: "t.toml", strict: true });
    expect(tlsDefaultIn([{ name: "bad.yml", text: "a: [" }])).toBeUndefined();
  });
});

describe("planStrictTls", () => {
  const prov = fileProvider(COMPOSE, "reverseproxy", "/srv/t");
  if ("error" in prov) throw new Error(prov.error);

  test("on adds the provider to the compose file and recreates", () => {
    const plan = planStrictTls(PROXY, prov, EMPTY, true);
    expect(plan).toMatchObject({ on: true, path: "/srv/t/dynamic/landfall-tls.yml", reload: "recreate" });
    expect((plan as { compose: string }).compose).toBe(
      COMPOSE.replace(
        `:443" # https\n`,
        `:443" # https\n      - "--providers.file.directory=/etc/traefik/dynamic"\n      - "--providers.file.watch=true"\n`,
      ).replace("./letsencrypt:/letsencrypt\n", "./letsencrypt:/letsencrypt\n      - ./dynamic:/etc/traefik/dynamic:ro\n"),
    );
  });

  test("a watched folder needs only the file", () => {
    const watched = { hostDir: "/srv/t/dyn", containerDir: "/dyn", watch: true };
    expect(planStrictTls(PROXY, watched, EMPTY, true)).toMatchObject({ reload: "none" });
    expect(planStrictTls(PROXY, watched, EMPTY, true)).not.toHaveProperty("compose");
    expect(planStrictTls(PROXY, { ...watched, watch: false }, EMPTY, true)).toMatchObject({ reload: "restart" });
  });

  test("leaves sniStrict set elsewhere alone", () => {
    const watched = { hostDir: "/srv/t/dyn", containerDir: "/dyn", watch: true };
    const theirs = { exists: true, entries: 1, files: [{ name: "tls.yml", text: "tls:\n  options:\n    default:\n      sniStrict: true\n" }] };
    expect(planStrictTls(PROXY, watched, theirs, true)).toEqual({ already: "/srv/t/dyn/tls.yml already sets sniStrict" });
    expect((planStrictTls(PROXY, watched, theirs, false) as any).error).toMatch(/not by landfall/);
    const loose = { exists: true, entries: 1, files: [{ name: "tls.yml", text: "tls:\n  options:\n    default:\n      minVersion: VersionTLS12\n" }] };
    expect((planStrictTls(PROXY, watched, loose, true) as any).error).toMatch(/without sniStrict/);
    // A ./dynamic that is there but not mounted: landfall does not mount what it did not write.
    expect((planStrictTls(PROXY, prov, { exists: true, entries: 2, files: [] }, true) as any).error).toMatch(/not mounted/);
  });

  test("off removes only landfall's file", () => {
    const watched = { hostDir: "/srv/t/dyn", containerDir: "/dyn", watch: true };
    const ours = { exists: true, entries: 1, files: [{ name: "landfall-tls.yml", text: STRICT_TLS_FILE }] };
    expect(planStrictTls(PROXY, watched, ours, false)).toMatchObject({ on: false, path: "/srv/t/dyn/landfall-tls.yml", reload: "none" });
    expect(planStrictTls(PROXY, watched, EMPTY, false)).toEqual({ already: "traefik-1 has no sniStrict from landfall" });
    expect(planStrictTls(PROXY, watched, ours, true)).toEqual({ already: "/srv/t/dyn/landfall-tls.yml already sets sniStrict" });
  });

  test("needs one compose file it can read", () => {
    expect(planStrictTls({ ...PROXY, files: [] }, prov, EMPTY, true)).toEqual({ error: "traefik-1 was not started by Docker Compose" });
  });
});

describe("remote scripts", () => {
  test("readDynamicDir lists the folder and decodes its files", async () => {
    reply.stdout = `N\t2\nF\ttls.yml\t${Buffer.from("tls: {}\n").toString("base64")}\n`;
    expect(await readDynamicDir(server, "/srv/t/dynamic")).toEqual({ exists: true, entries: 2, files: [{ name: "tls.yml", text: "tls: {}\n" }] });
    parses(scripts[0]);
    reply.stdout = "NODIR\n";
    expect(await readDynamicDir(server, "/srv/t/dynamic")).toEqual(EMPTY);
  });

  test("on with a new provider: file, compose, journal, recreate, in that order", async () => {
    const prov = fileProvider(COMPOSE, "reverseproxy", "/srv/t");
    if ("error" in prov) throw new Error(prov.error);
    const plan = planStrictTls(PROXY, prov, EMPTY, true);
    if (!("on" in plan)) throw new Error("no plan");
    await writeStrictTls(server, plan);
    const s = scripts[0];
    parses(s);
    const order = [
      'mkdir -p "$h"',
      'v=$(saved "$t")',
      "_put '/srv/t/dynamic/landfall-tls.yml'",
      "= 'abc' ]",
      'u=$(saved "$f")',
      'undo="$u && $v"',
      "record 'traefik traefik-1 refuses",
      "up -d 'reverseproxy'",
      "ensure_running 'traefik-1'",
    ];
    const at = order.map((x) => s.indexOf(x));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    // The undo recreates traefik with the old compose file too.
    expect(s).toMatch(/record '[^']+' "\$undo"' && if \[ -r/);
  });

  test("off in a watched folder removes the file and reloads nothing", async () => {
    const watched = { hostDir: "/srv/t/dyn", containerDir: "/dyn", watch: true };
    const plan = planStrictTls(PROXY, watched, { exists: true, entries: 1, files: [{ name: "landfall-tls.yml", text: STRICT_TLS_FILE }] }, false);
    if (!("on" in plan)) throw new Error("no plan");
    await writeStrictTls(server, plan);
    const s = scripts[0];
    parses(s);
    expect(s).toContain('_as "$h" rm -f "$t"');
    expect(s).toContain("record 'traefik traefik-1 answers unknown hosts again (/srv/t/dyn/landfall-tls.yml)' \"$undo\"\n");
    expect(s).not.toContain("mkdir");
    expect(s.slice(PRELUDE.length)).not.toContain("up -d");
    expect(s).not.toContain("ensure_running 'traefik-1'");
  });

  test("restart when the folder is not watched", async () => {
    const plan = planStrictTls(PROXY, { hostDir: "/srv/t/dyn", containerDir: "/dyn", watch: false }, EMPTY, true);
    if (!("on" in plan)) throw new Error("no plan");
    await writeStrictTls(server, plan);
    parses(scripts[0]);
    expect(scripts[0]).toContain(`"$undo"' && docker restart '\\''traefik-1'\\'' >/dev/null'`);
    expect(scripts[0]).toContain("docker restart 'traefik-1' >/dev/null\nsleep 2");
  });
});

describe("checkUnknownHosts", () => {
  test("a closed port is unreachable", async () => {
    const srv = net.createServer();
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as net.AddressInfo).port;
    await new Promise((r) => srv.close(r));
    expect(await checkUnknownHosts("127.0.0.1", { port })).toMatchObject({ state: "unreachable", error: "ECONNREFUSED" });
  });

  test("traefik's self-signed certificate is the default cert", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-tls-"));
    const [key, cert] = [path.join(dir, "k.pem"), path.join(dir, "c.pem")];
    execFileSync(
      "openssl",
      ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=TRAEFIK DEFAULT CERT"],
      { stdio: "ignore" },
    );
    const srv = tls.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    try {
      expect(await checkUnknownHosts("127.0.0.1", { port: (srv.address() as net.AddressInfo).port })).toEqual({
        state: "default-cert",
        subject: "TRAEFIK DEFAULT CERT",
      });
    } finally {
      srv.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
