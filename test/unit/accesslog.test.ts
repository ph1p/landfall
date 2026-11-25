import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, test, vi } from "vitest";

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
const { clearProxyLog, parseAccessLog, parseProxyLog, planAccessLog, readProxyCompose, withAccessLog, withoutAccessLog, writeAccessLog } =
  await import("../../src/core/traefik/accesslog");
const { accessLogIssue, logLimitText } = await import("../../src/core/traefik/traffic-merge");

const server = { host: "example.com" } as any;
const parses = (script: string) => execFileSync("bash", ["-n"], { input: script });

beforeEach(() => {
  scripts.length = 0;
  reply.stdout = "";
});

describe("parseAccessLog", () => {
  const flags = (...xs: string[]) => [...xs.map((x) => `AL\t${x}`), `AF\t${xs.length + 3}`, "AN\t0"].join("\n");
  test("from the container's flags", () => {
    expect(parseAccessLog(flags("--accesslog=true", "--accesslog.format=json"))).toBe("json");
    expect(parseAccessLog(flags("--accessLog.Format=JSON"))).toBe("json");
    expect(parseAccessLog(flags("--accesslog=true"))).toBe("common");
    expect(parseAccessLog(flags("--accesslog"))).toBe("common");
    expect(parseAccessLog(flags())).toBe("off");
    expect(parseAccessLog(flags("--accesslog=false", "--accesslog.format=json"))).toBe("off");
    expect(parseAccessLog(flags("--accesslog.filepath=/logs/access.log", "--accesslog.format=json"))).toBe("file");
    expect(parseAccessLog(flags("--accesslog.filepath=/dev/stdout", "--accesslog.format=json"))).toBe("json");
  });

  test("from TRAEFIK_ variables when there are no flags", () => {
    expect(parseAccessLog("AF\t0\nAE\tTRAEFIK_ACCESSLOG_FORMAT=json\nAN\t2")).toBe("json");
    expect(parseAccessLog("AF\t0\nAN\t3")).toBe("off");
    // Flags win: Traefik reads one source only.
    expect(parseAccessLog("AF\t2\nAE\tTRAEFIK_ACCESSLOG_FORMAT=json\nAN\t1")).toBe("off");
  });

  test("a config file landfall cannot read is unknown", () => {
    expect(parseAccessLog("AF\t0\nAN\t0")).toBe("unknown");
    expect(parseAccessLog(flags("--configfile=/etc/traefik/traefik.yml"))).toBe("unknown");
    expect(parseAccessLog(`${flags("--accesslog.format=json")}\nAM\t/etc/traefik/traefik.yml`)).toBe("unknown");
    expect(parseAccessLog("")).toBe("unknown");
  });
});

// Like a hand-written compose file: quoted flags, comments between them, other services after.
const COMPOSE = `services:
  reverseproxy:
    image: traefik:v3.1
    command:
      - "--api.insecure=false"
      # - "--log.level=DEBUG"
      - "--providers.docker=true"
      - "--entrypoints.web.address=:80" # plain http
    ports:
      - "80:80"
  whoami:
    image: traefik/whoami
`;

describe("withAccessLog", () => {
  test("adds the flags after the last one, keeping everything else byte for byte", () => {
    const r = withAccessLog(COMPOSE, "reverseproxy");
    expect(r).toEqual({
      added: ["--accesslog=true", "--accesslog.format=json"],
      text: COMPOSE.replace(
        `      - "--entrypoints.web.address=:80" # plain http\n`,
        `      - "--entrypoints.web.address=:80" # plain http\n      - "--accesslog=true"\n      - "--accesslog.format=json"\n`,
      ),
    });
  });

  test("plain items stay plain, CRLF stays CRLF, a flag already there is not added twice", () => {
    const text = "services:\r\n  t:\r\n    command:\r\n    - --accesslog=true\r\n    - --providers.docker\r\n";
    expect(withAccessLog(text, "t")).toEqual({ added: ["--accesslog.format=json"], text: `${text}    - --accesslog.format=json\r\n` });
    const done = "services:\n  t:\n    command:\n      - --accesslog\n      - --accesslog.format=json\n";
    expect(withAccessLog(done, "t")).toEqual({ text: done, added: [] });
  });

  test("refuses what it cannot change safely", () => {
    const err = (text: string, svc = "t") => (withAccessLog(text, svc) as { error: string }).error;
    expect(err(COMPOSE, "nope")).toMatch(/no service nope/);
    expect(err("services:\n  t:\n    image: traefik\n")).toMatch(/no command/);
    expect(err("services:\n  t:\n    command: --providers.docker\n")).toMatch(/not a list/);
    expect(err("services:\n  t:\n    command: [--providers.docker]\n")).toMatch(/not a list/);
    expect(err("services:\n  t:\n    command:\n      - --accesslog=false\n")).toMatch(/--accesslog=false/);
    expect(err("services:\n  t:\n    command:\n      - --accesslog.filepath=/x\n")).toMatch(/filepath/);
    expect(err("services:\n  t:\n    command:\n      - --accesslog.format=common\n")).toMatch(/format=common/);
    expect(err("services: [")).toMatch(/not valid YAML/);
  });
});

describe("withoutAccessLog", () => {
  const ON = COMPOSE.replace(
    `      - "--entrypoints.web.address=:80" # plain http\n`,
    `      - "--accesslog=true" # requests\n      - "--entrypoints.web.address=:80" # plain http\n      - "--accessLog.format=json"\n`,
  );
  test("removes only the access log lines, keeping everything else byte for byte", () => {
    expect(withoutAccessLog(ON, "reverseproxy")).toEqual({ removed: ["--accesslog=true", "--accessLog.format=json"], text: COMPOSE });
    expect(withoutAccessLog(COMPOSE, "reverseproxy")).toEqual({ text: COMPOSE, removed: [] });
    const crlf = "services:\r\n  t:\r\n    command:\r\n    - --providers.docker\r\n    - --accesslog\r\n";
    expect(withoutAccessLog(crlf, "t")).toEqual({ removed: ["--accesslog"], text: "services:\r\n  t:\r\n    command:\r\n    - --providers.docker\r\n" });
  });

  test("refuses what it cannot change safely", () => {
    const err = (text: string, svc = "t") => (withoutAccessLog(text, svc) as { error: string }).error;
    expect(err(COMPOSE, "nope")).toMatch(/no service nope/);
    expect(err("services:\n  t:\n    image: traefik\n")).toMatch(/no command/);
    expect(err("services:\n  t:\n    command: [--accesslog]\n")).toMatch(/not a list/);
    expect(err("services:\n  t:\n    command:\n      - --accesslog\n")).toMatch(/would be empty/);
  });
});

describe("the proxy's Docker log", () => {
  test("parseProxyLog reads driver, size cap and size", () => {
    expect(parseProxyLog("LD\tjson-file\nLO\tmax-size=10m\nLO\tmax-file=3\nLP\t/var/lib/docker/x-json.log\nLS\t2048")).toEqual({
      driver: "json-file",
      maxSize: "10m",
      maxFile: 3,
      bytes: 2048 * 1024,
    });
    expect(parseProxyLog("LD\tjson-file\nLS\t")).toEqual({ driver: "json-file" });
    expect(parseProxyLog("AF\t0")).toBeUndefined();
  });

  test("logLimitText", () => {
    expect(logLimitText({ driver: "json-file", maxSize: "10m", maxFile: 3 })).toBe("capped at 10m × 3 files");
    expect(logLimitText({ driver: "local", maxSize: "20m" })).toBe("capped at 20m");
    expect(logLimitText({ driver: "json-file" })).toBe("no size limit");
    expect(logLimitText({ driver: "journald" })).toBe("");
  });
});

describe("accessLogIssue", () => {
  test("what is wrong with the log, and whether lf traefik access-log can fix it", () => {
    expect(accessLogIssue({ accessLog: "json", format: "json" })).toBeUndefined();
    expect(accessLogIssue({ accessLog: "unknown", format: "none" })).toBeUndefined();
    expect(accessLogIssue({ accessLog: "off", format: "none" })).toEqual({ kind: "off", fixable: true });
    expect(accessLogIssue({ accessLog: "file", format: "none" })).toEqual({ kind: "file", fixable: false });
    expect(accessLogIssue({ accessLog: "common", format: "common" })).toEqual({ kind: "common", fixable: true });
    // Plain text from a config file landfall cannot read: the command would refuse.
    expect(accessLogIssue({ accessLog: "unknown", format: "common" })).toEqual({ kind: "common", fixable: false });
  });
});

// The proxy as readProxyCompose returns it: your own Traefik, started from one compose file landfall can read.
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

describe("planAccessLog", () => {
  test("needs one compose file on the server", () => {
    expect(planAccessLog({ ...PROXY, files: [] })).toEqual({ error: "traefik-1 was not started by Docker Compose" });
    expect((planAccessLog({ ...PROXY, files: ["a.yml", "b.yml"] }) as any).error).toMatch(/several compose files/);
    expect((planAccessLog({ ...PROXY, text: undefined }) as any).error).toMatch(/not on the server/);
    expect(planAccessLog(PROXY)).toMatchObject({ on: true, file: "/srv/t/docker-compose.yml", changed: ["--accesslog=true", "--accesslog.format=json"] });
  });

  test("off removes the flags, and refuses when they are not what turns the log on", () => {
    const on = (withAccessLog(COMPOSE, "reverseproxy") as { text: string }).text;
    expect(planAccessLog({ ...PROXY, accessLog: "json", text: on }, false)).toMatchObject({
      on: false,
      text: COMPOSE,
      changed: ["--accesslog=true", "--accesslog.format=json"],
    });
    expect((planAccessLog({ ...PROXY, accessLog: "json" }, false) as any).error).toMatch(/not set by flags/);
    expect(planAccessLog(PROXY, false)).toMatchObject({ changed: [] });
  });

  test("a file the login cannot read needs root, not another machine", () => {
    expect(planAccessLog({ ...PROXY, root: false, text: undefined, sha256: undefined })).toEqual({ error: "/srv/t/docker-compose.yml needs root to read" });
  });
});

describe("remote scripts", () => {
  test("readProxyCompose reads labels, flags and the compose file", async () => {
    const labels = {
      "com.docker.compose.project": "t",
      "com.docker.compose.service": "reverseproxy",
      "com.docker.compose.project.working_dir": "/srv/t",
      "com.docker.compose.project.config_files": "/srv/t/docker-compose.yml",
    };
    reply.stdout = `OWN\nROOT\nCTR\ttraefik-1\nLABELS\t${JSON.stringify(labels)}\nAF\t3\nAN\t0\nLD\tjson-file\nLP\t/x.log\nLS\t4\nYAML\t${Buffer.from(COMPOSE).toString("base64")}\n`;
    const p = await readProxyCompose(server);
    parses(scripts[0]);
    expect(p).toMatchObject({
      container: "traefik-1",
      own: true,
      root: true,
      accessLog: "off",
      files: ["/srv/t/docker-compose.yml"],
      dir: "/srv/t",
      project: "t",
      service: "reverseproxy",
      text: COMPOSE,
      log: { driver: "json-file", bytes: 4096 },
    });
    expect(p!.sha256).toBe(createHash("sha256").update(COMPOSE).digest("hex"));
    reply.stdout = "NOPROXY\n";
    expect(await readProxyCompose(server)).toBeUndefined();
  });

  test("writeAccessLog checks the file did not change, journals, then recreates only the service", async () => {
    const plan = planAccessLog(PROXY);
    if ("error" in plan) throw new Error(plan.error);
    await writeAccessLog(server, plan);
    const s = scripts[0];
    parses(s);
    const order = [
      "sha256sum",
      "= 'abc' ]",
      'u=$(saved "$f")',
      "base64 -d",
      "record 'turned on the JSON access log",
      "up -d 'reverseproxy'",
      "ensure_running 'traefik-1'",
    ];
    const at = order.map((x) => s.indexOf(x));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(s).toContain("-p 't' --project-directory '/srv/t' -f '/srv/t/docker-compose.yml'");
  });

  test("writeAccessLog off journals turning it off", async () => {
    const plan = planAccessLog({ ...PROXY, accessLog: "json", text: (withAccessLog(COMPOSE, "reverseproxy") as { text: string }).text }, false);
    if ("error" in plan) throw new Error(plan.error);
    await writeAccessLog(server, plan);
    parses(scripts[0]);
    expect(scripts[0]).toContain("record 'turned off the access log of traefik traefik-1");
  });

  test("clearProxyLog empties only a json-file log, then journals it", async () => {
    await clearProxyLog(server, "traefik-1");
    const s = scripts[0];
    parses(s);
    const order = ["docker inspect", '[ "$t" = json-file ]', ': > "$1" && rm -f "$1".*', "record 'emptied the log of traefik traefik-1'"];
    const at = order.map((x) => s.indexOf(x));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });
});
