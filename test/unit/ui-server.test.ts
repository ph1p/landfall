import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { guard } from "../../src/ui/server/auth";
import { bodyLimit, listener } from "../../src/ui/server/http";

const SECRET = "s".repeat(48);
const req = (path: string, headers: Record<string, string> = {}, method = "GET") =>
  new Request(`http://127.0.0.1:4777${path}`, { method, headers: { host: "127.0.0.1:4777", ...headers } });
const loggedIn = { cookie: `landfall=${SECRET}` };

describe("ui server guard", () => {
  test("refuses foreign hosts (DNS rebinding) and foreign or opaque origins", () => {
    expect(guard(req("/", { ...loggedIn, host: "evil.example:4777" }), SECRET)?.status).toBe(403);
    expect(guard(req("/", { ...loggedIn, origin: "http://evil.example" }), SECRET)?.status).toBe(403);
    expect(guard(req("/", { ...loggedIn, origin: "http://127.0.0.1:5000" }), SECRET)?.status).toBe(403);
    expect(guard(req("/", { ...loggedIn, origin: "null" }), SECRET)?.status).toBe(403);
    expect(guard(req("/", { ...loggedIn, origin: "http://127.0.0.1:4777" }), SECRET)).toBeUndefined();
  });

  test("needs the token: as the login link, then as the cookie", async () => {
    expect(guard(req("/"), SECRET)?.status).toBe(401);
    expect(guard(req("/", { cookie: "landfall=wrong" }), SECRET)?.status).toBe(401);
    expect(guard(req("/login?t=wrong"), SECRET)?.status).toBe(403);
    const login = guard(req(`/login?t=${SECRET}`), SECRET)!;
    expect(login.status).toBe(303);
    expect(login.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict");
    expect(await guard(req("/ping"), SECRET)!.text()).not.toContain(SECRET);
  });

  test("api requests only from the page itself", () => {
    expect(guard(req("/api/state", { ...loggedIn, "sec-fetch-site": "same-site" }), SECRET)?.status).toBe(403);
    expect(guard(req("/api/state", { ...loggedIn, "sec-fetch-site": "cross-site" }), SECRET)?.status).toBe(403);
    expect(guard(req("/api/state", { ...loggedIn, "sec-fetch-site": "same-origin" }), SECRET)).toBeUndefined();
    expect(guard(req("/api/state", loggedIn), SECRET)).toBeUndefined();
  });
});

describe("ui server http", () => {
  test("only the upload route takes a large body, however its path is spelled", () => {
    expect(bodyLimit("/api/upload")).toBeGreaterThan(bodyLimit("/api/jobs"));
    expect(bodyLimit("/api/upload?x=1")).toBe(bodyLimit("/api/upload"));
    expect(bodyLimit("/api/upload/../jobs")).toBe(bodyLimit("/api/jobs"));
    expect(bodyLimit("/api/upload/%2e%2e/jobs")).toBe(bodyLimit("/api/jobs"));
    expect(bodyLimit("/api/uploadx")).toBe(bodyLimit("/api/jobs"));
  });

  let server: Server;
  let port: number;
  beforeAll(async () => {
    server = createServer(listener(async (r) => new Response(r.body ? await r.text() : "ok")));
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => server.close());

  const send = (path: string, body?: string, headers: Record<string, string | number> = {}) =>
    new Promise<{ status: number; headers: Record<string, unknown>; text: string }>((done, fail) => {
      const r = request({ host: "127.0.0.1", port, path, method: body === undefined ? "GET" : "POST", headers }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => done({ status: res.statusCode!, headers: res.headers, text }));
      });
      r.on("error", fail);
      r.end(body);
    });

  test("every answer refuses framing and sniffing", async () => {
    const r = await send("/");
    expect(r.status).toBe(200);
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(r.headers["content-security-policy"]).toBe("frame-ancestors 'none'");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
  });

  test("a body past the limit is refused up front", async () => {
    const r = await send("/api/upload/../jobs", "x", { "content-length": 2 * 1024 ** 2 });
    expect(r.status).toBe(413);
  });
});

describe("ui server jobs", () => {
  const policy = { validate: () => {}, mask: (a: string[]) => a };
  const post = (body: unknown) => new Request("http://127.0.0.1/api/jobs", { method: "POST", body: JSON.stringify(body) });

  test("refuses what is not a job before starting one", async () => {
    const { jobsApi } = await import("../../src/ui/server/jobs");
    expect((await jobsApi(post({ argv: ["ui"] }), undefined, undefined, policy)).status).toBe(400);
    expect((await jobsApi(post({ argv: [1] }), undefined, undefined, policy)).status).toBe(400);
    expect((await jobsApi(post({ argv: ["status"], password: { a: 1 } }), undefined, undefined, policy)).status).toBe(400);
    expect((await jobsApi(post({ argv: ["status"], cwd: "relative" }), undefined, undefined, policy)).status).toBe(400);
    expect((await jobsApi(new Request("http://127.0.0.1/api/jobs/nope"), "nope", undefined, policy)).status).toBe(404);
  });
});
