import { spawn } from "node:child_process";
import { OLD_DOTENV } from "./legacy";
import { askpassEnv } from "./login";
import { REPORT } from "./term";

/** How to start this landfall again: node with the same flags (tsx loader in dev) and entry script. */
const self = (): string[] => [process.execPath, ...process.execArgv, process.argv[1]];

/** `--dashboard-password` → `LANDFALL_SECRET_DASHBOARD_PASSWORD`. */
export const secretEnv = (flag: string) => `LANDFALL_SECRET_${flag.toUpperCase().replace(/-/g, "_")}`;

/** --dotenv, or its old name --env-file, with or without =value. */
const isDotenvFlag = (a: string) => new RegExp(`^--(dotenv|${OLD_DOTENV})(=|$)`).test(a);

/** Commands whose KEY=value arguments are .env values. */
/** -p is the password's short flag, except where it is a port (server add, setup, ui). */
export const isPasswordShort = (argv: string[], a: string | undefined) => a === "-p" && !["server", "setup", "ui"].includes(argv[0]);
export const isEnvCmd = (argv: string[]) => argv[0] === "env" || argv[0] === "secret" || (argv[0] === "sites" && argv[1] === "env");
// Secret names may hold dots and dashes too.
export const ENV_PAIR = /^[A-Za-z0-9_][A-Za-z0-9_.-]*=/;

/**
 * Move passwords and .env values off the job's command line, where `ps` would show them:
 * `--x-password v` travels as LANDFALL_SECRET_X_PASSWORD, `env` pairs and deploy's `-e` as a dotenv on stdin (`--dotenv -`).
 */
export function secretsOut(argv: string[]) {
  const args: string[] = [];
  const env: Record<string, string> = {};
  const pairs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // After --: a remote command's own arguments (lf ssh box -- mkdir -p x), not landfall's.
    if (a === "--") {
      args.push(...argv.slice(i));
      break;
    }
    const flag = isPasswordShort(argv, a) ? ["-p", "password"] : a.match(/^--((?:[\w-]+-)?password)(?:=(.*))?$/s);
    if (flag && (flag[2] !== undefined || i + 1 < argv.length)) {
      env[secretEnv(flag[1])] = flag[2] ?? argv[++i];
    } else if (isEnvCmd(argv) && ENV_PAIR.test(a) && !a.includes("\n") && !argv.some(isDotenvFlag)) {
      pairs.push(a);
    } else if (argv[0] === "deploy" && (a === "-e" || a === "--env") && ENV_PAIR.test(argv[i + 1] ?? "") && !argv[i + 1].includes("\n") && !argv.some(isDotenvFlag)) {
      pairs.push(argv[++i]);
    } else args.push(a);
  }
  if (pairs.length) args.push("--dotenv", "-");
  return { args, env, stdin: pairs.length ? pairs.join("\n") + "\n" : undefined };
}

export interface Job {
  argv: string[];
  lines: string[];
  /** Lines cut from the front to stay under MAX_LINES: lines[0] is line number `dropped`. */
  dropped: number;
  /** Exit code once finished; null if it was stopped. */
  code?: number | null;
  stopped?: boolean;
  /** What the command told the UI through report(), merged. */
  report: Record<string, unknown>;
  stop(): void;
}

const SIGNALS = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;
const cleanups = new Set<() => Promise<unknown>>();
let stopping = false;
const stopped = (sig: keyof typeof SIGNALS) => {
  if (stopping) return;
  stopping = true;
  // Bounded: an unreachable server must not keep a stopped lf alive.
  setTimeout(() => process.exit(SIGNALS[sig]), 10_000).unref();
  void Promise.allSettled([...cleanups].map((f) => f())).then(() => process.exit(SIGNALS[sig]));
};

/**
 * Runs f when lf is stopped (Ctrl-C, the web UI's Stop, a closed terminal) before it is called off:
 * a signal skips finally blocks, so a deploy lock would stay for an hour. Returns the call-off.
 */
export function onStop(f: () => Promise<unknown>): () => void {
  // Only while there is something to clean up: lf ui and tunnels handle these signals their own way.
  if (!cleanups.size) for (const sig of Object.keys(SIGNALS)) process.on(sig, stopped);
  cleanups.add(f);
  return () => {
    cleanups.delete(f);
    if (!cleanups.size) for (const sig of Object.keys(SIGNALS)) process.off(sig, stopped);
  };
}

/**
 * In a job: stop it, and the ssh it started, once the lf ui that started it is gone. A job runs
 * detached (own session), so a killed UI or a closed terminal would otherwise leave it running,
 * e.g. a tunnel still holding its local port.
 */
export function exitWithParent() {
  const parent = Number(process.env.LANDFALL_PARENT);
  // Only this process watches: what it starts (another lf, say) has a different parent.
  delete process.env.LANDFALL_PARENT;
  if (!parent) return;
  setInterval(() => {
    if (process.ppid === parent) return;
    try {
      process.kill(-process.pid, "SIGTERM");
    } catch {
      process.exit(1);
    }
  }, 1000).unref();
}

const MAX_LINES = 5000;
const MAX_LINE = 10_000;
const clip = (l: string) => (l.length > MAX_LINE ? l.slice(0, MAX_LINE) + "…" : l);

/**
 * Run `lf <argv>` as a child with piped output and no terminal, so it never
 * prompts: the web dashboard asks the questions before starting it.
 */
export function startJob(argv: string[], onChange: () => void, opts: { password?: string; env?: Record<string, string>; cwd?: string; stdin?: string } = {}): Job {
  const env: Record<string, string | undefined> = { ...process.env, NO_COLOR: "1", LANDFALL_REPORT: "1", LANDFALL_PARENT: String(process.pid), ...opts.env };
  if (opts.password) {
    Object.assign(env, askpassEnv(opts.password));
  }
  // Own process group, so stopping it also stops the ssh it started (e.g. `logs -f`).
  const child = spawn(self()[0], [...self().slice(1), ...argv], { stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"], env, cwd: opts.cwd, detached: true });
  child.stdin?.on("error", () => {}).end(opts.stdin);
  const job: Job = {
    argv,
    lines: [],
    dropped: 0,
    report: {},
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
        // A line that never ends must not grow without bound either.
        if (rest.length > MAX_LINE) parts.push(rest), (rest = "");
        // Progress output redraws with \r: keep only the final state of each line.
        for (const p of parts) {
          if (p.startsWith(REPORT)) {
            try {
              Object.assign(job.report, JSON.parse(p.slice(1)));
            } catch {}
            continue;
          }
          job.lines.push(clip(p.slice(p.lastIndexOf("\r", p.length - 2) + 1).replace(/\r$/, "")));
        }
        if (job.lines.length > MAX_LINES) job.dropped += job.lines.splice(0, job.lines.length - MAX_LINES).length;
        changed();
      },
      flush: () => rest && job.lines.push(clip(rest)),
    };
  };
  const out = reader();
  const err = reader();
  child.stdout!.setEncoding("utf8").on("data", out.push);
  child.stderr!.setEncoding("utf8").on("data", err.push);
  child.on("error", (e) => {
    job.lines.push(`error: ${e.message}`);
    job.code = 1;
    onChange();
  });
  // A multiplexed ssh hands its output to the shared ControlMaster, which outlives the stopped job and
  // keeps writing (`logs -f`): close our end, so it gets EPIPE and the job finishes.
  child.on("exit", () => job.stopped && (child.stdout!.destroy(), child.stderr!.destroy()));
  child.on("close", (code) => {
    out.flush();
    err.flush();
    job.code = job.stopped ? null : (code ?? 1);
    clearTimeout(timer);
    onChange();
  });
  return job;
}
