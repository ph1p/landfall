import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Transform } from "node:stream";
import pkg from "../../../package.json";
import { CONFIG_PATH, DOMAIN, LOGIN_NAME, MIN_PASSWORD, loadConfig, loadProject, resolveServer } from "../../core/config";
import { changes, listServers, reachAll, target } from "../../core/dashboard";
import { loadProjects } from "../../core/projects";
import { browse, jobCwd, receiveUpload } from "./local";
import { ENV_PAIR, isEnvCmd, isPasswordShort, secretsOut, startJob, type Job } from "../../core/job";
import { SITE_NAME, envView, overview, readSecrets, requireSite, validName } from "../../core/remote";
import { parseSince } from "../../core/traffic";
import { volumes } from "../../core/volumes";
import { USER_NAME } from "../../core/users";
import { configView, defaultsView, savedView, diskView, dnsView, factsView, firewallView, historyView, pruneView, scanView, statsView, systemView, trafficView, certsView, updatesView, usersView } from "../../core/views";
import { newRunId, setQuiet } from "../../core/ssh";
import { DEFAULT_TRAEFIK_IMAGE, JOURNAL, PROXY_FILE, ROOT, SITES, TRAEFIK_DIR } from "../../core/templates";
import { c, openUrl } from "../../core/term";

interface WebJob {
  id: string;
  argv: string[];
  server?: string;
  startedAt: string;
  /** Leaves something in the journal worth offering to undo. */
  undoable: boolean;
  job: Job;
  listeners: Set<() => void>;
  /** As started, for a retry with --force: the page only sees the argv with passwords masked. */
  opts: { server?: string; password?: string; cwd?: string };
}

// The page, built by vite into dist/ui next to the bundle; run from src (tsx), the last build's.
const UI_DIR = [new URL("./ui/", import.meta.url), new URL("../../../dist/ui/", import.meta.url)].find((u) => fs.existsSync(u));
const TYPES: Record<string, string> = { html: "text/html", css: "text/css", js: "text/javascript", svg: "image/svg+xml", json: "application/json" };
const assets = new Map(
  UI_DIR
    ? fs.readdirSync(UI_DIR, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => {
        const rel = join(e.parentPath, e.name).slice(fileURLToPath(UI_DIR).length).split(sep).join("/");
        const body = fs.readFileSync(join(e.parentPath, e.name));
        return [rel === "index.html" ? "/" : `/${rel}`, { body, type: `${TYPES[e.name.split(".").pop()!] ?? "application/octet-stream"}; charset=utf-8` }];
      })
    : [],
);
const MAX_JOBS = 50;
/** Jobs running at once: each is a process with its own ssh connections. */
const MAX_RUNNING = 20;
/** Request bodies: uploads may be a whole project, everything else is a small JSON. */
const MAX_UPLOAD = 512 * 1024 ** 2;
const MAX_BODY = 1024 ** 2;
const jobs = new Map<string, WebJob>();

/** Commands that make no sense without a terminal, or would start another dashboard. */
const NO_JOB = new Set(["ui", "web"]);

/** The login token survives restarts, so a bookmarked or still-open page keeps working. */
function token(): string {
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

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store" } });
const failure = (e: any, status = 500) => json({ error: e?.message ?? String(e) }, status);

function startWebJob(argv: string[], o: { server?: string; password?: string; cwd?: string }): WebJob {
  // The journal credits what the job changes to this id, so it can be undone as one.
  const id = newRunId();
  const listeners = new Set<() => void>();
  const { args, env, stdin } = secretsOut(argv);
  const job = startJob(args, () => listeners.forEach((f) => f()), { password: o.password, cwd: o.cwd, stdin, env: { ...env, LANDFALL_RUN: id } });
  const w: WebJob = { id, argv, server: o.server, startedAt: new Date().toISOString(), undoable: changes(argv), job, listeners, opts: o };
  jobs.set(id, w);
  for (const [old, j] of jobs) {
    if (jobs.size <= MAX_JOBS) break;
    if (j.job.code !== undefined) jobs.delete(old);
  }
  return w;
}

/** The command as the page shows it: passwords given as flags, `lf env` and deploy `-e` values, are masked. */
const shown = (argv: string[]) =>
  argv.map((a, i) =>
    isPasswordShort(argv, argv[i - 1]) || /^--([\w-]+-)?password$/.test(argv[i - 1])
      ? "***"
      : (isEnvCmd(argv) || (argv[0] === "deploy" && /^(-e|--env)$/.test(argv[i - 1]))) && ENV_PAIR.test(a)
        ? a.replace(/=.*/s, "=***")
        : a.replace(/^(--([\w-]+-)?password=).*/, "$1***"),
  );

const jobInfo = (w: WebJob) => ({
  id: w.id,
  argv: shown(w.argv),
  server: w.server,
  startedAt: w.startedAt,
  undoable: w.undoable,
  code: w.job.code,
  stopped: !!w.job.stopped,
  report: w.job.report,
});

/** Server-sent events: the job's lines from `from` on, then `done` with the exit code. */
function jobEvents(w: WebJob, from: number, signal: AbortSignal): Response {
  const enc = new TextEncoder();
  let sent = from;
  let close = () => {};
  const stream = new ReadableStream({
    start(ctl) {
      const send = (s: string) => ctl.enqueue(enc.encode(s));
      const push = () => {
        const { lines, dropped, code } = w.job;
        const start = Math.max(sent, dropped);
        if (dropped + lines.length > start) {
          send(`data: ${JSON.stringify({ from: start, lines: lines.slice(start - dropped), report: w.job.report })}\n\n`);
          sent = dropped + lines.length;
        }
        if (code !== undefined) {
          send(`event: done\ndata: ${JSON.stringify(jobInfo(w))}\n\n`);
          close();
        }
      };
      // Proxies and browsers drop silent connections; a comment line keeps `logs -f` open.
      const beat = setInterval(() => send(": beat\n\n"), 15000);
      close = () => {
        clearInterval(beat);
        w.listeners.delete(push);
        try {
          ctl.close();
        } catch {}
      };
      w.listeners.add(push);
      signal.addEventListener("abort", close);
      push();
    },
    cancel: () => close(),
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
}

/** What /api/state sends: everything the page needs before it shows a thing. */
export function state() {
  const cfg = loadConfig();
  return {
    version: pkg.version,
    cwd: process.cwd(),
    project: loadProject(process.cwd()) ?? null,
    projects: loadProjects(),
    defaultImage: DEFAULT_TRAEFIK_IMAGE,
    // The CLI's own input rules, so forms reject what the command would.
    rules: { loginName: LOGIN_NAME.source, userName: USER_NAME.source, minPassword: MIN_PASSWORD, domain: DOMAIN.source, siteName: SITE_NAME.source },
    paths: { root: ROOT, sites: SITES, traefik: TRAEFIK_DIR, journal: JOURNAL, proxy: PROXY_FILE },
    defaults: defaultsView(),
    servers: listServers().map((e) => ({ ...e, target: target(e.name), saved: savedView(cfg.servers[e.name]) })),
    jobs: [...jobs.values()].reverse().map(jobInfo),
  };
}

async function api(req: Request, path: string[]): Promise<Response> {
  const [what, name, sub] = path;
  const method = req.method;

  if (what === "state" && method === "GET") return json(state());

  // Separate from state: logging in to every server takes seconds, the list should not wait.
  if (what === "reach" && method === "GET") {
    return json(await reachAll(listServers().map((e) => e.name), new URL(req.url).searchParams.get("fresh") === "1"));
  }

  if (what === "servers" && name) {
    const { server } = resolveServer(name);
    if (method === "GET" && !sub) return json(await overview(server));
    // The same views `--json` prints.
    if (method === "GET" && sub === "firewall") return json(await firewallView(server));
    if (method === "GET" && sub === "config") return json(await configView(name, server));
    if (method === "GET" && sub === "history") return json(await historyView(server));
    if (method === "GET" && sub === "facts") return json(await factsView(name, server));
    if (method === "GET" && sub === "stats") return json(await statsView(server));
    if (method === "GET" && sub === "disk") return json(await diskView(server));
    if (method === "GET" && sub === "prune") return json(await pruneView(server));
    if (method === "GET" && sub === "system") return json(await systemView(name, server));
    if (method === "GET" && sub === "users") return json(await usersView(server));
    if (method === "GET" && sub === "updates") return json(await updatesView(server, new URL(req.url).searchParams.get("refresh") === "1"));
    if (method === "GET" && sub === "scan") return json(await scanView(server, new URL(req.url).searchParams.get("others") === "1"));
    if (method === "GET" && sub === "traffic") return json(await trafficView(server, parseSince(new URL(req.url).searchParams.get("since") ?? "24h")));
    if (method === "GET" && sub === "certs") return json(await certsView(server));
    if (method === "GET" && sub === "env") {
      const q = new URL(req.url).searchParams;
      const { env } = await requireSite(server, validName(q.get("site") ?? ""), { deployed: "manage the .env of" });
      return json(envView(env, q.get("reveal") === "1"));
    }
    if (method === "GET" && sub === "secrets") {
      const site = validName(new URL(req.url).searchParams.get("site") ?? "");
      await requireSite(server, site, { deployed: "manage the secrets of" });
      // Names and sizes only: no route ever sends a secret's content.
      return json({ vars: (await readSecrets(server, site)).map((x) => ({ key: x.key, length: x.size })) });
    }
    if (method === "GET" && sub === "volumes") {
      // lf volumes --json: sizes, mounts and backups.
      return json(await volumes(server, validName(new URL(req.url).searchParams.get("site") ?? ""), true));
    }
    if (method === "GET" && sub === "dns") {
      const domains = (new URL(req.url).searchParams.get("domains") ?? "").split(",").filter((d) => DOMAIN.test(d)).slice(0, 50);
      return json(await dnsView(server, domains));
    }
  }

  if (what === "jobs") {
    if (method === "POST" && !name) {
      const body = (await req.json()) as { argv?: unknown; server?: string; password?: string; cwd?: unknown };
      const argv = body.argv;
      if (!Array.isArray(argv) || !argv.length || !argv.every((a) => typeof a === "string") || NO_JOB.has(argv[0])) {
        return failure("argv must be a list of landfall arguments", 400);
      }
      if ([...jobs.values()].filter((j) => j.job.code === undefined).length >= MAX_RUNNING) {
        return failure(`${MAX_RUNNING} jobs are already running: wait for one to finish or stop one`, 429);
      }
      let cwd: string | undefined;
      try {
        cwd = jobCwd(body.cwd);
      } catch (e) {
        return failure(e, 400);
      }
      return json(jobInfo(startWebJob(argv, { server: body.server, password: body.password || undefined, cwd })));
    }
    const w = name ? jobs.get(name) : undefined;
    if (name && !w) return failure(`no job ${name}`, 404);
    if (w && method === "GET" && sub === "events") {
      return jobEvents(w, Number(new URL(req.url).searchParams.get("from")) || 0, req.signal);
    }
    if (w && method === "GET" && !sub) return json({ ...jobInfo(w), lines: w.job.lines, from: w.job.dropped });
    if (w && method === "POST" && sub === "force") {
      if (w.job.code === undefined || w.argv.includes("--force")) return failure("only a finished job without --force", 400);
      if ([...jobs.values()].filter((j) => j.job.code === undefined).length >= MAX_RUNNING) return failure("too many jobs running", 429);
      return json(jobInfo(startWebJob([...w.argv, "--force"], w.opts)));
    }
    if (w && method === "POST" && sub === "stop") {
      w.job.stop();
      return json(jobInfo(w));
    }
  }

  if (what === "fs" && method === "GET") return json(browse(new URL(req.url).searchParams.get("path") ?? undefined));
  if (what === "upload" && method === "POST") {
    const up = await receiveUpload(await req.formData());
    return json({ ...up, detected: browse(up.path).detected });
  }

  return failure("not found", 404);
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

const fingerprint = (secret: string) => createHash("sha256").update(`landfall-ui:${secret}`).digest("hex");

/** webUi's port when none is given; taken by something else, the next free one after it. */
const DEFAULT_PORT = 4777;

/**
 * The web dashboard: a local page that runs landfall's commands.
 * It runs commands as `lf` child processes, exactly like typing them, and streams their output.
 */
export async function webUi(o: { port?: number; open: boolean }): Promise<number> {
  setQuiet(true);
  const secret = token();
  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    // Only this machine's browser: a page elsewhere that resolves its own name to 127.0.0.1
    // (DNS rebinding) sends its own Host, and cross-site requests carry a foreign Origin.
    const host = req.headers.get("host") ?? "";
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return new Response("forbidden host", { status: 403 });
    const origin = req.headers.get("origin");
    if (origin && new URL(origin).host !== host) return new Response("forbidden origin", { status: 403 });

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
    const asset = assets.get(url.pathname);
    // Vite puts a content hash in every asset's name: only the page itself has to be fetched again.
    const cache = url.pathname.startsWith("/assets/") ? "private, max-age=31536000, immutable" : "no-store";
    if (asset) return new Response(asset.body, { headers: { "content-type": asset.type, "cache-control": cache } });
    if (url.pathname === "/") return new Response("The page is not built: run pnpm build.", { status: 500, headers: { "content-type": "text/plain" } });
    if (url.pathname.startsWith("/api/")) {
      // SameSite=Strict still sends the cookie from other ports of 127.0.0.1 (same site), and an <img> sends
      // no Origin: only this page's own requests (or non-browser clients, which send no Sec-Fetch-Site) get in.
      const site = req.headers.get("sec-fetch-site");
      if (site && site !== "same-origin" && site !== "none") return new Response("forbidden", { status: 403 });
      try {
        return await api(req, url.pathname.slice(5).split("/").filter(Boolean).map(decodeURIComponent));
      } catch (e) {
        return failure(e);
      }
    }
    return new Response("not found", { status: 404 });
  };

  const server = createServer(listener(handler));
  // No timeouts: job output streams stay open as long as the job runs, uploads can be large.
  server.requestTimeout = 0;
  const listen = (port: number) =>
    new Promise<NodeJS.ErrnoException | undefined>((done) => {
      server.once("error", done);
      server.listen(port, "127.0.0.1", () => (server.off("error", done), done(undefined)));
    });
  // An lf ui on a taken port has the same token, so it answers it: then just open that one.
  const running = (port: number) =>
    fetch(`http://127.0.0.1:${port}/ping`).then(
      async (r) => r.ok && (await r.text()) === fingerprint(secret),
      () => false,
    );
  const want = o.port ?? DEFAULT_PORT;
  // An explicit --port or nothing; the default port, else the next free one after it, else any.
  const ports = o.port !== undefined ? [want] : [...Array.from({ length: 20 }, (_, i) => want + i), 0];
  let err: NodeJS.ErrnoException | undefined;
  for (const port of ports) {
    if (!(err = await listen(port))) break;
    if (err.code !== "EADDRINUSE") throw err;
    if (await running(port)) {
      const link = `http://127.0.0.1:${port}/login?t=${secret}`;
      console.log(`lf ui already runs: ${c.cyan(link)}`);
      if (o.open) openUrl(link);
      return 0;
    }
  }
  if (err) {
    console.error(`${c.red("error:")} port ${want} is in use by another program; pick another with --port`);
    return 1;
  }
  const port = (server.address() as AddressInfo).port;
  if (port !== want) console.log(c.dim(`port ${want} is in use by another program: using ${port}`));

  const link = `http://127.0.0.1:${port}/login?t=${secret}`;
  console.log(`${c.bold("lf ui")} ${c.dim(pkg.version)} on ${c.cyan(link)}`);
  console.log(c.dim("Only this machine can reach it, and only with that link. Ctrl-C stops it (and any running commands)."));
  if (o.open) openUrl(link);

  return new Promise((resolve) => {
    const stop = () => {
      for (const w of jobs.values()) w.job.stop();
      server.closeAllConnections();
      server.close();
      resolve(0);
    };
    // SIGHUP: the terminal closed. Without it the jobs outlive the UI.
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(sig, stop);
    // Under tsx (pnpm dev) a killed wrapper leaves this process to launchd, still on its port.
    // Not otherwise: `nohup lf ui &` loses its shell on purpose.
    if (process.execArgv.some((a) => a.includes("tsx"))) {
      const parent = process.ppid;
      setInterval(() => process.ppid !== parent && stop(), 1000).unref();
    }
  });
}

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
function listener(handler: (req: Request) => Promise<Response>) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    let r: Response;
    try {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) for (const x of [v ?? []].flat()) headers.append(k, x);
      const limit = req.url?.startsWith("/api/upload") ? MAX_UPLOAD : MAX_BODY;
      if (Number(req.headers["content-length"]) > limit) {
        res.writeHead(413).end("request too large");
        return;
      }
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : (Readable.toWeb(capped(req, limit)) as ReadableStream);
      r = await handler(new Request(`http://${req.headers.host ?? "127.0.0.1"}${req.url}`, { method: req.method, headers, body, signal: abort.signal, duplex: "half" } as RequestInit));
    } catch {
      r = new Response("bad request", { status: 400 });
    }
    for (const [k, v] of r.headers) if (k !== "set-cookie") res.setHeader(k, v);
    const cookies = r.headers.getSetCookie();
    if (cookies.length) res.setHeader("set-cookie", cookies);
    res.writeHead(r.status);
    if (!r.body) return res.end();
    const out = Readable.fromWeb(r.body as any);
    res.on("close", () => out.destroy());
    out.pipe(res);
  };
}
