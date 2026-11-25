import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable, Transform, pipeline } from "node:stream";
import { CliError } from "../../core/lib/term";

export const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store" } });
// A CliError is a refusal or a failed step the user can act on, not a crash in the server.
export const failure = (e: any, status = e instanceof CliError ? 400 : 500) => json({ error: e?.message ?? String(e) }, status);

/** Request bodies: uploads may be a whole project, everything else is a small JSON. */
const MAX_UPLOAD = 512 * 1024 ** 2;
const MAX_BODY = 1024 ** 2;

export function bodyLimit(path: string | undefined): number {
  let pathname: string;
  try {
    pathname = new URL(path ?? "/", "http://127.0.0.1").pathname;
  } catch {
    return MAX_BODY;
  }
  return pathname === "/api/upload" ? MAX_UPLOAD : MAX_BODY;
}

const SECURITY_HEADERS: Record<string, string> = {
  "x-frame-options": "DENY",
  "content-security-policy": "frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

/** The request body, failing once it passes `limit` bytes (a chunked body has no length to check up front). */
function capped(req: IncomingMessage, limit: number): Readable {
  let seen = 0;
  return req.pipe(
    new Transform({
      transform(chunk: Buffer, _enc, done) {
        seen += chunk.length;
        if (seen <= limit) return done(null, chunk);
        // Stop reading: a client that keeps sending must not keep the socket busy.
        req.unpipe();
        req.destroy();
        done(new Error("request too large"));
      },
    }),
  );
}

/** Serve a fetch-style handler with node:http; the request's signal aborts when the client goes away. */
export function listener(handler: (req: Request) => Promise<Response>) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    let r: Response;
    try {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) for (const x of [v ?? []].flat()) headers.append(k, x);
      const limit = bodyLimit(req.url);
      if (Number(req.headers["content-length"]) > limit) {
        res.writeHead(413).end("request too large");
        return;
      }
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : (Readable.toWeb(capped(req, limit)) as ReadableStream);
      r = await handler(
        new Request(`http://${req.headers.host ?? "127.0.0.1"}${req.url}`, {
          method: req.method,
          headers,
          body,
          signal: abort.signal,
          duplex: "half",
        } as RequestInit),
      );
    } catch {
      r = new Response("bad request", { status: 400 });
    }
    for (const [k, v] of r.headers) if (k !== "set-cookie") res.setHeader(k, v);
    const cookies = r.headers.getSetCookie();
    if (cookies.length) res.setHeader("set-cookie", cookies);
    res.writeHead(r.status);
    if (!r.body) return res.end();
    pipeline(Readable.fromWeb(r.body as any), res, () => {});
  };
}
