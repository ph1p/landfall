import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_PATH } from "../../core/lib/config";

/** The login token survives restarts, so a bookmarked or still-open page keeps working. */
export function token(): string {
  const file = join(dirname(CONFIG_PATH), "ui-token");
  try {
    const t = fs.readFileSync(file, "utf8").trim();
    if (t.length >= 32) return t;
  } catch {}
  const t = randomBytes(24).toString("hex");
  fs.mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, t + "\n", { mode: 0o600 });
  return t;
}

const same = (a: string, b: string) => {
  // Bytes, not characters: timingSafeEqual throws on buffers of different length.
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const cookieToken = (req: Request) =>
  (req.headers.get("cookie") ?? "")
    .split(/;\s*/)
    .find((p) => p.startsWith("landfall="))
    ?.slice("landfall=".length) ?? "";

export const fingerprint = (secret: string) => createHash("sha256").update(`landfall-ui:${secret}`).digest("hex");

const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

const originHost = (origin: string) => {
  try {
    return new URL(origin).host;
  } catch {
    return undefined;
  }
};

export function guard(req: Request, secret: string): Response | undefined {
  const url = new URL(req.url);
  // Only this machine's browser: a page elsewhere that resolves its own name to 127.0.0.1
  // (DNS rebinding) sends its own Host, and cross-site requests carry a foreign Origin.
  const host = req.headers.get("host") ?? "";
  if (!LOCAL_HOST.test(host)) return new Response("forbidden host", { status: 403 });
  const origin = req.headers.get("origin");
  if (origin !== null && originHost(origin) !== host) return new Response("forbidden origin", { status: 403 });

  // Another lf ui of this user answers with the same hash; the token itself never leaves (see `running`).
  if (url.pathname === "/ping") return new Response(fingerprint(secret));
  if (url.pathname === "/login") {
    if (!same(url.searchParams.get("t") ?? "", secret)) return new Response("wrong or missing token, use the link lf ui printed", { status: 403 });
    return new Response(null, {
      status: 303,
      headers: { location: "/", "set-cookie": `landfall=${secret}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000` },
    });
  }
  if (!same(cookieToken(req), secret)) {
    return new Response("Open the link `lf ui` printed (it logs this browser in).", { status: 401, headers: { "content-type": "text/plain" } });
  }
  if (url.pathname.startsWith("/api/")) {
    // SameSite=Strict still sends the cookie from other ports of 127.0.0.1 (same site), and an <img> sends
    // no Origin: only this page's own requests (or non-browser clients, which send no Sec-Fetch-Site) get in.
    const site = req.headers.get("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "none") return new Response("forbidden", { status: 403 });
  }
  return undefined;
}
