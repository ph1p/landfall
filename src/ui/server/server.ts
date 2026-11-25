import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { VERSION } from "../../core/lib/version";
import { pruneUploads } from "./local";
import { setQuiet } from "../../core/ssh/ssh";
import { c, openUrl } from "../../core/lib/term";
import { api } from "./api";
import { asset } from "./assets";
import { fingerprint, guard, token } from "./auth";
import { failure, listener } from "./http";
import { stopJobs, type JobArgsPolicy } from "./jobs";

/** Server reads still running, by path and query. */
const reads = new Map<string, Promise<Response>>();

/** webUi's port when none is given; taken by something else, the next free one after it. */
const DEFAULT_PORT = 4777;

/**
 * The web dashboard: a local page that runs landfall's commands.
 * It runs commands as `lf` child processes, exactly like typing them, and streams their output.
 */
export async function webUi(o: { port?: number; open: boolean; args: JobArgsPolicy }): Promise<number> {
  setQuiet(true);
  try {
    pruneUploads();
  } catch {}
  const secret = token();
  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const refused = guard(req, secret);
    if (refused) return refused;
    const page = asset(url.pathname);
    if (page) return page;
    if (url.pathname.startsWith("/api/")) {
      const answer = () => api(req, url.pathname.slice(5).split("/").filter(Boolean).map(decodeURIComponent), o.args).catch((e) => failure(e));
      if (req.method !== "GET" || !url.pathname.startsWith("/api/servers/")) return answer();
      // The same read asked again while it runs (a poll, a second tab): one ssh run answers both.
      const key = url.pathname + url.search;
      let read = reads.get(key);
      if (!read) reads.set(key, (read = answer().finally(() => reads.delete(key))));
      return (await read).clone();
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
  console.log(`${c.bold("lf ui")} ${c.dim(VERSION)} on ${c.cyan(link)}`);
  console.log(c.dim("Only this machine can reach it, and only with that link. Ctrl-C stops it (and any running commands)."));
  if (o.open) openUrl(link);

  return new Promise((resolve) => {
    const stop = () => {
      stopJobs();
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
