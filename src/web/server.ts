import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import pkg from "../../package.json";
import { DOMAIN, httpsStatus } from "../commands/access";
import { firewallState } from "../commands/firewall";
import { domainDns, serverSettings, suggestDomains } from "../commands/server";
import { CONFIG_PATH, loadConfig, loadProject, resolveServer, saveConfig } from "../config";
import { changes, listServers, target } from "../dashboard";
import { checkDns, facts, pickIp, serverIps } from "../facts";
import { loadProjects } from "../projects";
import { engineNotes, engineStatus, imageStatus, pkgStatus } from "../updates";
import { browse, jobCwd, receiveUpload } from "./local";
import { startJob, type Job } from "../job";
import { pending, readJournal } from "../journal";
import { overview } from "../remote";
import { setQuiet } from "../ssh";
import { effectiveSsh } from "../sshconfig";
import { DEFAULT_TRAEFIK_IMAGE, JOURNAL, PROXY_FILE, ROOT, SITES, TRAEFIK_DIR } from "../templates";
import { c, openUrl } from "../ui";

interface WebJob {
  id: string;
  argv: string[];
  server?: string;
  startedAt: string;
  /** Leaves something in the journal worth offering to undo. */
  undoable: boolean;
  job: Job;
  listeners: Set<() => void>;
}

// Next to this file in src/web, and copied next to the bundle in dist by the build.
const page = fs.readFileSync(new URL("./index.html", import.meta.url), "utf8");
const MAX_JOBS = 50;
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
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const listeners = new Set<() => void>();
  const job = startJob(argv, () => listeners.forEach((f) => f()), { password: o.password, cwd: o.cwd, env: { LANDFALL_RUN: id } });
  const w: WebJob = { id, argv, server: o.server, startedAt: new Date().toISOString(), undoable: changes(argv), job, listeners };
  jobs.set(id, w);
  for (const [old, j] of jobs) {
    if (jobs.size <= MAX_JOBS) break;
    if (j.job.code !== undefined) jobs.delete(old);
  }
  return w;
}

/** The command as the page shows it: passwords given as flags are masked. */
const shown = (argv: string[]) => argv.map((a, i) => (/^(-p|--([\w-]+-)?password)$/.test(argv[i - 1]) ? "***" : a.replace(/^(--([\w-]+-)?password=).*/, "$1***")));

const jobInfo = (w: WebJob) => ({
  id: w.id,
  argv: shown(w.argv),
  server: w.server,
  startedAt: w.startedAt,
  undoable: w.undoable,
  code: w.job.code,
  stopped: !!w.job.stopped,
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
          send(`data: ${JSON.stringify({ from: start, lines: lines.slice(start - dropped) })}\n\n`);
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

async function api(req: Request, path: string[]): Promise<Response> {
  const [what, name, sub] = path;
  const method = req.method;

  if (what === "state" && method === "GET") {
    const cfg = loadConfig();
    return json({
      version: pkg.version,
      cwd: process.cwd(),
      project: loadProject(process.cwd()) ?? null,
      projects: loadProjects(),
      defaultImage: DEFAULT_TRAEFIK_IMAGE,
      paths: { root: ROOT, sites: SITES, traefik: TRAEFIK_DIR, journal: JOURNAL, proxy: PROXY_FILE },
      servers: listServers().map((e) => ({ ...e, target: target(e.name), saved: cfg.servers[e.name] ?? null })),
      jobs: [...jobs.values()].reverse().map(jobInfo),
    });
  }

  if (what === "servers" && name) {
    const { server } = resolveServer(name);
    if (method === "GET" && !sub) return json(await overview(server));
    if (method === "GET" && sub === "firewall") {
      const { login, probe, ...fw } = await firewallState(server);
      return json({ ...fw, asRoot: effectiveSsh(login).user === "root" });
    }
    if (method === "GET" && sub === "config") {
      const settings = serverSettings(name);
      const [dns, suggest] = await Promise.all([Promise.all(settings.domains.map((d) => domainDns(server, d))), suggestDomains(server)]);
      return json({ ...settings, dns, suggest });
    }
    if (method === "GET" && sub === "history") {
      const runs = (await readJournal(server)).reverse();
      return json(runs.map((r) => ({ ...r, pending: pending(r).length })));
    }
    if (method === "GET" && sub === "facts") {
      const f = await facts(server);
      const ips = await serverIps(server, f);
      return json({ ...f, ips, sslipIp: pickIp(ips) ?? null });
    }
    if (method === "GET" && sub === "updates") {
      const refresh = new URL(req.url).searchParams.get("refresh") === "1";
      const packages = await pkgStatus(server, refresh);
      const engine = await engineStatus(server);
      return json({ packages, images: await imageStatus(server), engine: { ...engine, ...engineNotes(engine) } });
    }
    if (method === "GET" && sub === "dns") {
      const domains = (new URL(req.url).searchParams.get("domains") ?? "").split(",").filter((d) => DOMAIN.test(d)).slice(0, 50);
      const ips = await serverIps(server);
      const [dns, https] = await Promise.all([checkDns(domains, ips), Promise.all(domains.map(httpsStatus))]);
      return json({ ips, domains: dns.map((d, i) => ({ ...d, https: https[i] })) });
    }
    if (method === "POST" && sub === "default") {
      const cfg = loadConfig();
      cfg.servers[name] ??= { host: name };
      cfg.default = name;
      saveConfig(cfg);
      return json({ ok: true });
    }
  }

  if (what === "jobs") {
    if (method === "POST" && !name) {
      const body = (await req.json()) as { argv?: unknown; server?: string; password?: string; cwd?: unknown };
      const argv = body.argv;
      if (!Array.isArray(argv) || !argv.length || !argv.every((a) => typeof a === "string") || NO_JOB.has(argv[0])) {
        return failure("argv must be a list of landfall arguments", 400);
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
    if (w && method === "POST" && sub === "stop") {
      w.job.stop();
      return json(jobInfo(w));
    }
  }

  if (what === "fs" && method === "GET") return json(browse(new URL(req.url).searchParams.get("path") ?? undefined));
  if (what === "projects" && method === "GET") return json(loadProjects());
  if (what === "upload" && method === "POST") {
    const up = await receiveUpload(await req.formData());
    return json({ ...up, detected: browse(up.path).detected });
  }

  if (what === "open" && method === "POST") {
    const { url } = (await req.json()) as { url?: string };
    if (!url || !/^https?:\/\//.test(url)) return failure("not a web address", 400);
    openUrl(url);
    return json({ ok: true });
  }

  return failure("not found", 404);
}


const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

const cookieToken = (req: Request) =>
  (req.headers.get("cookie") ?? "")
    .split(/;\s*/)
    .find((p) => p.startsWith("landfall="))
    ?.slice("landfall=".length) ?? "";

/**
 * The web dashboard: a local page that runs landfall's commands.
 * It runs commands as `lf` child processes, exactly like typing them, and streams their output.
 */
export async function webUi(o: { port: number; open: boolean }): Promise<number> {
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
    if (url.pathname === "/") return new Response(page, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    if (url.pathname.startsWith("/api/")) {
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
  const err = await new Promise<NodeJS.ErrnoException | undefined>((done) => {
    server.once("error", done);
    server.listen(o.port, "127.0.0.1", () => done(undefined));
  });
  if (err) {
    if (err.code !== "EADDRINUSE") throw err;
    // Most likely lf ui already runs there: same token, so just open it.
    const link = `http://127.0.0.1:${o.port}/login?t=${secret}`;
    const alive = await fetch(`http://127.0.0.1:${o.port}/api/state`, { headers: { cookie: `landfall=${secret}` } }).then((r) => r.ok, () => false);
    if (!alive) {
      console.error(`${c.red("error:")} port ${o.port} is in use; pick another with --port`);
      return 1;
    }
    console.log(`lf ui already runs: ${c.cyan(link)}`);
    if (o.open) openUrl(link);
    return 0;
  }

  const link = `http://127.0.0.1:${(server.address() as AddressInfo).port}/login?t=${secret}`;
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
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
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
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : (Readable.toWeb(req) as ReadableStream);
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
