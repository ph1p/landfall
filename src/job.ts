import { spawn } from "node:child_process";
import { askpassEnv } from "./login";

/** How to start this landfall again: node with the same flags (tsx loader in dev) and entry script. */
const self = (): string[] => [process.execPath, ...process.execArgv, process.argv[1]];

export interface Job {
  argv: string[];
  lines: string[];
  /** Lines cut from the front to stay under MAX_LINES: lines[0] is line number `dropped`. */
  dropped: number;
  /** Exit code once finished; null if it was stopped. */
  code?: number | null;
  stopped?: boolean;
  stop(): void;
}

const MAX_LINES = 5000;

/**
 * Run `lf <argv>` as a child with piped output and no terminal, so it never
 * prompts: the dashboard (terminal or web) asks the questions before starting it.
 */
export function startJob(argv: string[], onChange: () => void, opts: { password?: string; env?: Record<string, string>; cwd?: string } = {}): Job {
  const env: Record<string, string | undefined> = { ...process.env, NO_COLOR: "1", ...opts.env };
  if (opts.password) {
    Object.assign(env, askpassEnv(opts.password));
  }
  // Own process group, so stopping it also stops the ssh it started (e.g. `logs -f`).
  const child = spawn(self()[0], [...self().slice(1), ...argv], { stdio: ["ignore", "pipe", "pipe"], env, cwd: opts.cwd, detached: true });
  const job: Job = {
    argv,
    lines: [],
    dropped: 0,
    stop() {
      if (job.code !== undefined) return;
      job.stopped = true;
      try {
        process.kill(-child.pid!, "SIGTERM");
      } catch {}
    },
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const changed = () => (timer ??= setTimeout(() => ((timer = undefined), onChange()), 50));
  const reader = () => {
    let rest = "";
    return {
      push(chunk: string) {
        const parts = (rest + chunk).split("\n");
        rest = parts.pop()!;
        // Progress output redraws with \r: keep only the final state of each line.
        for (const p of parts) job.lines.push(p.slice(p.lastIndexOf("\r", p.length - 2) + 1).replace(/\r$/, ""));
        if (job.lines.length > MAX_LINES) job.dropped += job.lines.splice(0, job.lines.length - MAX_LINES).length;
        changed();
      },
      flush: () => rest && job.lines.push(rest),
    };
  };
  const out = reader();
  const err = reader();
  child.stdout.setEncoding("utf8").on("data", out.push);
  child.stderr.setEncoding("utf8").on("data", err.push);
  child.on("error", (e) => {
    job.lines.push(`error: ${e.message}`);
    job.code = 1;
    onChange();
  });
  child.on("close", (code) => {
    out.flush();
    err.flush();
    job.code = job.stopped ? null : (code ?? 1);
    clearTimeout(timer);
    onChange();
  });
  return job;
}
