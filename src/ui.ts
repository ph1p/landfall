import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import stringWidth from "string-width";

/** All of stdin, for secrets passed as --*-stdin / `-` instead of on the command line (where `ps` shows them). */
export const readStdin = async () => {
  if (process.stdin.isTTY) fail("expected the value on stdin, e.g. printf %s \"$SECRET\" | lf …");
  let out = "";
  for await (const chunk of process.stdin) out += chunk;
  return out;
};
/** --password-stdin's line, else --password: undefined when neither was given. */
export const passwordOption = async (o: { password?: string; "password-stdin"?: boolean }): Promise<string | undefined> =>
  o["password-stdin"] ? (await readStdin()).replace(/\r?\n$/, "") : o.password;

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);

export const c = {
  bold: wrap("1"),
  dim: wrap("2"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  blue: wrap("34"),
  cyan: wrap("36"),
};

export const step = (msg: string) => console.error(`${c.cyan("==>")} ${c.bold(msg)}`);
export const ok = (msg: string) => console.error(`${c.green("✓")} ${msg}`);
export const info = (msg: string) => console.error(`  ${msg}`);
export const warn = (msg: string) => console.error(`${c.yellow("!")} ${msg}`);

export class CliError extends Error {}
/** Starts a marker line on stderr: what follows is JSON for the web UI, not text to show. */
export const REPORT = "\x1e";

/**
 * Tell the web UI (which runs lf as a job) a fact it acts on, such as a tunnel's address, instead
 * of it reading the text output. Outside a web job this prints nothing.
 */
export function report(data: Record<string, unknown>) {
  if (process.env.LANDFALL_REPORT) process.stderr.write(`${REPORT}${JSON.stringify(data)}\n`);
}

export const fail = (msg: string): never => {
  throw new CliError(msg);
};

let assumeYes = false;
export const setAssumeYes = (v: boolean) => (assumeYes = v);
/** A person can answer prompts (TTY, no -y). */
export const interactive = () => !assumeYes && !!process.stdin.isTTY;

export async function ask(question: string, def?: string): Promise<string> {
  if (assumeYes || !process.stdin.isTTY) {
    if (def !== undefined) return def;
    fail(`missing value for "${question}" (no TTY; pass it as a flag)`);
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(`${c.blue("?")} ${question}${def ? c.dim(` (${def})`) : ""} `)).trim();
    return answer || def || "";
  } finally {
    rl.close();
  }
}

/** Like confirm, but defaults to no and never auto-accepts (-y, no TTY): for steps that can break things. */
export async function confirmRisky(question: string): Promise<boolean> {
  if (assumeYes || !process.stdin.isTTY) return false;
  return confirm(question, false);
}

/**
 * For changes that take something away. Without a terminal it refuses instead of assuming, unless -y.
 * With `typed`, the person has to type that name (for what cannot be undone).
 */
export async function confirmRemoval(question: string, typed?: string): Promise<void> {
  if (assumeYes) return;
  if (!process.stdin.isTTY) fail(`${question} Pass -y to confirm (no terminal to ask).`);
  if (typed) {
    if ((await ask(`${question} Type ${c.bold(typed)} to confirm:`)) !== typed) fail("cancelled");
  } else if (!(await confirm(question, false))) fail("cancelled");
}

export async function confirm(question: string, def = true): Promise<boolean> {
  if (assumeYes) return true;
  if (!process.stdin.isTTY) fail(`${question} Pass -y to confirm (no terminal to ask).`);
  const answer = (await ask(`${question} ${def ? "[Y/n]" : "[y/N]"}`, def ? "y" : "n")).toLowerCase();
  return answer.startsWith("y");
}

export function table(rows: string[][]) {
  if (!rows.length) return;
  // stringWidth ignores ANSI colors.
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => stringWidth(r[i] ?? ""))));
  for (const r of rows) {
    console.log(r.map((cell, i) => cell + " ".repeat(widths[i] - stringWidth(cell))).join("  ").trimEnd());
  }
}

export const ago = (iso: string) => {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

/** Like ask, but nothing is echoed. */
export async function askSecret(question: string): Promise<string> {
  if (assumeYes || !process.stdin.isTTY) fail(`missing value for "${question}" (no TTY; pass it as a flag)`);
  process.stderr.write(`${c.blue("?")} ${question} `);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  let value = "";
  try {
    return await new Promise<string>((done, reject) => {
      const onData = (buf: Buffer) => {
        for (const ch of buf.toString("utf8")) {
          if (ch === "\r" || ch === "\n") return stdin.off("data", onData), done(value);
          if (ch === "\u0003") return stdin.off("data", onData), reject(new CliError("cancelled"));
          if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
          else value += ch;
        }
      };
      stdin.on("data", onData);
    });
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
    process.stderr.write("\n");
  }
}

export function openUrl(url: string) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  spawn(cmd, [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}
