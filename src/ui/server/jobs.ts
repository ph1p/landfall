import { startJob, type Job } from "../../core/lib/job";
import { newRunId } from "../../core/ssh/ssh";
import { failure, json } from "./http";
import { jobCwd } from "./local";

interface WebJob {
  id: string;
  argv: string[];
  shown: string[];
  server?: string;
  startedAt: string;
  job: Job;
  listeners: Set<() => void>;
  /** As started, for a retry with --force or a sudo password: the page only sees the argv with passwords masked. */
  opts: { server?: string; password?: string; sudoPassword?: string; cwd?: string };
}

/** The CLI supplies its parser policy; the UI server never imports CLI implementation modules. */
export interface JobArgsPolicy {
  validate(argv: string[]): void;
  mask(argv: string[]): string[];
}

const MAX_JOBS = 50;
/** Jobs running at once: each is a process with its own ssh connections. */
const MAX_RUNNING = 20;
const jobs = new Map<string, WebJob>();

/** Commands that make no sense without a terminal, or would start another dashboard. */
const NO_JOB = new Set(["ui", "web"]);

const tooMany = () => [...jobs.values()].filter((j) => j.job.code === undefined).length >= MAX_RUNNING;

function startWebJob(argv: string[], o: WebJob["opts"], policy: JobArgsPolicy): WebJob {
  // The journal credits what the job changes to this id, so it can be undone as one.
  const id = newRunId();
  const listeners = new Set<() => void>();
  policy.validate(argv);
  const job = startJob(argv, () => listeners.forEach((f) => f()), { ...o, env: { LANDFALL_RUN: id } });
  const w: WebJob = { id, argv, shown: policy.mask(argv), server: o.server, startedAt: new Date().toISOString(), job, listeners, opts: o };
  jobs.set(id, w);
  for (const [old, j] of jobs) {
    if (jobs.size <= MAX_JOBS) break;
    if (j.job.code !== undefined) jobs.delete(old);
  }
  return w;
}

const jobInfo = (w: WebJob) => ({
  id: w.id,
  argv: w.shown,
  server: w.server,
  startedAt: w.startedAt,
  code: w.job.code,
  stopped: !!w.job.stopped,
  report: w.job.report,
});

export const jobList = () => [...jobs.values()].reverse().map(jobInfo);

export function stopJobs() {
  for (const w of jobs.values()) w.job.stop();
}

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
        signal.removeEventListener("abort", close);
        try {
          ctl.close();
        } catch {}
      };
      // Gone before the stream started: abort would never fire.
      if (signal.aborted) return close();
      w.listeners.add(push);
      signal.addEventListener("abort", close);
      push();
    },
    cancel: () => close(),
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
}

const optional = (v: unknown, what: string) => {
  if (v !== undefined && v !== null && typeof v !== "string") throw new Error(`${what} must be a string`);
  return (v || undefined) as string | undefined;
};

export async function jobsApi(req: Request, name: string | undefined, sub: string | undefined, policy: JobArgsPolicy): Promise<Response> {
  const method = req.method;
  if (method === "POST" && !name) {
    const body = (await req.json()) as { argv?: unknown; server?: unknown; password?: unknown; sudoPassword?: unknown; cwd?: unknown };
    const argv = body.argv;
    if (!Array.isArray(argv) || !argv.length || !argv.every((a) => typeof a === "string") || NO_JOB.has(argv[0])) {
      return failure("argv must be a list of landfall arguments", 400);
    }
    if (tooMany()) return failure(`${MAX_RUNNING} jobs are already running: wait for one to finish or stop one`, 429);
    let opts: WebJob["opts"];
    try {
      opts = {
        server: optional(body.server, "server"),
        password: optional(body.password, "password"),
        sudoPassword: optional(body.sudoPassword, "sudoPassword"),
        cwd: jobCwd(body.cwd),
      };
    } catch (e) {
      return failure(e, 400);
    }
    return json(jobInfo(startWebJob(argv, opts, policy)));
  }
  const w = name ? jobs.get(name) : undefined;
  if (!w) return failure(name ? `no job ${name}` : "not found", 404);
  if (method === "GET" && sub === "events") return jobEvents(w, Number(new URL(req.url).searchParams.get("from")) || 0, req.signal);
  if (method === "GET" && !sub) return json({ ...jobInfo(w), lines: w.job.lines, from: w.job.dropped });
  if (method === "POST" && sub === "force") {
    if (w.job.code === undefined || w.argv.includes("--force")) return failure("only a finished job without --force", 400);
    if (tooMany()) return failure("too many jobs running", 429);
    return json(jobInfo(startWebJob([...w.argv, "--force"], w.opts, policy)));
  }
  // The same job again with the login's sudo password (what -K asks for), handed over beside argv.
  if (method === "POST" && sub === "sudo") {
    const { sudoPassword } = (await req.json()) as { sudoPassword?: unknown };
    if (w.job.code === undefined) return failure("only a finished job", 400);
    if (typeof sudoPassword !== "string" || !sudoPassword) return failure("no sudo password given", 400);
    if (tooMany()) return failure("too many jobs running", 429);
    return json(jobInfo(startWebJob(w.argv, { ...w.opts, sudoPassword }, policy)));
  }
  if (method === "POST" && sub === "stop") {
    w.job.stop();
    return json(jobInfo(w));
  }
  return failure("not found", 404);
}
