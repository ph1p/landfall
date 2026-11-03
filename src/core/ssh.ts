import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import { hostname, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";
import { envVar, expandHome, type Server } from "./config";
import { bytes } from "./format";
import type { Entry } from "./ignore";
import { ROOT } from "./templates";
import { c, CliError, fail, REPORT } from "./term";

let quiet = false;
/** Dashboard mode: ssh never prompts and its stderr goes into the error instead of the screen. */
export const setQuiet = (v: boolean) => (quiet = v);

/** Single-quote a string for POSIX sh. */
export const shq = (s: string | number) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export interface SshOpts {
  /** Allocate a TTY (interactive commands). */
  tty?: boolean;
  /** Never prompt for passwords; fail instead. */
  batch?: boolean;
  /** Skip connection multiplexing (needed to honestly test key auth). */
  noMux?: boolean;
}

/** LANDFALL_SSH_CONFIG points landfall (and the ssh it runs) at another config file, e.g. in tests. */
// ssh refuses a -F file that does not exist; until landfall writes the first Host block, there is nothing to read.
const sshConfigFlag = (f = envVar("SSH_CONFIG")) => (f ? ["-F", fs.existsSync(f) ? f : "/dev/null"] : []);

/** `user@host`, or just the host/alias when ssh config supplies the user. */
export const dest = (s: Server) => {
  // Last in the ssh args: a leading "-" would turn a host name into an option (-oProxyCommand=…).
  if (/^-|\s/.test(s.host) || (s.user && /^-|\s/.test(s.user))) fail(`not a server: ${s.user ? `${s.user}@` : ""}${s.host}`);
  return s.user ? `${s.user}@${s.host}` : s.host;
};

/** Flags that select the target (config file, port, key) — shared by ssh, ssh -G and ssh-copy-id. */
export function targetArgs(s: Server): string[] {
  const a = [...sshConfigFlag(), "-o", "StrictHostKeyChecking=accept-new"];
  if (s.port) a.push("-p", String(s.port));
  if (s.key) a.push("-i", expandHome(s.key), "-o", "IdentitiesOnly=yes");
  return a;
}

let muxDir: string | undefined;
/** Short, per-user socket dir: unix sockets cap at 104 bytes, which a long $HOME/.ssh can exceed. */
function controlDir() {
  if (!muxDir) {
    muxDir = join(process.platform === "darwin" ? "/tmp" : tmpdir(), `landfall-${userInfo().uid}`);
    fs.mkdirSync(muxDir, { recursive: true, mode: 0o700 });
  }
  return muxDir;
}

/** ssh's options without the destination: what rsync's -e takes. */
function sshOptions(s: Server, o: SshOpts = {}): string[] {
  const a = [...targetArgs(s), "-o", "ServerAliveInterval=15"];
  if (o.batch || quiet) a.push("-o", "BatchMode=yes", "-o", "ConnectTimeout=10");
  // Reuse one TCP/SSH session across the many calls a deploy makes.
  if (o.noMux) a.push("-o", "ControlPath=none");
  else a.push("-o", "ControlMaster=auto", "-o", `ControlPath=${controlDir()}/%C`, "-o", "ControlPersist=60");
  a.push(o.tty ? "-t" : "-T");
  return a;
}

const sshArgs = (s: Server, o: SshOpts = {}) => [...sshOptions(s, o), dest(s)];

/** Close the multiplexed session to `s`, if one lingers (it keeps a login of that user alive). */
export function closeMux(s: Server): Promise<void> {
  return new Promise((resolve) => {
    const args = [...targetArgs(s), "-o", `ControlPath=${controlDir()}/%C`, "-O", "exit", dest(s)];
    spawn("ssh", args, { stdio: "ignore" })
      .on("close", () => resolve())
      .on("error", () => resolve());
  });
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

// A captured run prints nothing while the server works: after a moment a "waiting for <host>" line says so,
// so a slow read never looks like a hang. Terminal only, on stderr, and gone once the run ends.
const STARTED = "landfall:started";
const waits = new Map<object, { host: string; since: number }>();
let ticker: NodeJS.Timeout | undefined;
let drawn = false;
const erase = () => drawn && ((drawn = false), origErr("\r\x1b[K"));
const origErr = (s: string) => origWrite.err.call(process.stderr, s);
const origWrite = { out: process.stdout.write, err: process.stderr.write };
function draw() {
  const w = [...waits.values()].sort((a, b) => a.since - b.since)[0];
  const secs = w ? Math.round((Date.now() - w.since) / 1000) : 0;
  if (secs < 2) return void erase();
  origErr(`\r\x1b[K${c.dim(`  waiting for ${w.host}… ${secs}s`)}`);
  drawn = true;
}
function waitStart(key: object, host: string) {
  waits.set(key, { host, since: Date.now() });
  if (ticker) return;
  // Anything else written meanwhile goes on a clean line.
  process.stdout.write = ((...a: Parameters<typeof process.stdout.write>) => (erase(), origWrite.out.apply(process.stdout, a))) as typeof process.stdout.write;
  process.stderr.write = ((...a: Parameters<typeof process.stderr.write>) => (erase(), origWrite.err.apply(process.stderr, a))) as typeof process.stderr.write;
  ticker = setInterval(draw, 1000);
  ticker.unref();
}
function waitEnd(key: object) {
  if (!waits.delete(key) || waits.size) return;
  clearInterval(ticker);
  ticker = undefined;
  erase();
  process.stdout.write = origWrite.out;
  process.stderr.write = origWrite.err;
}

function spawnP(
  cmd: string,
  args: string[],
  opts: SpawnOptions & { input?: string; capture?: boolean; silent?: boolean; waitFor?: string },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      ...opts,
      stdio: [opts.input !== undefined ? "pipe" : "inherit", opts.capture ? "pipe" : "inherit", quiet || opts.silent || opts.waitFor ? "pipe" : "inherit"],
    });
    let stdout = "";
    let stderr = "";
    // Decoded as a stream: a UTF-8 character split across two chunks stays whole.
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    // ssh may exit (no login, host down) before it read all its input: that shows in its exit code, not as EPIPE.
    child.stdin?.on("error", () => {});
    child.stdout?.on("data", (d) => (stdout += d));
    // waitFor: stderr is passed on line by line; the script's first line says the login is done (no prompt can follow).
    let part = "";
    const pass = (l: string) => {
      if (l === STARTED) return waitStart(child, opts.waitFor!);
      stderr += l + "\n";
      process.stderr.write(l + "\n");
      // Counts the quiet since the last line, not since the start.
      const w = waits.get(child);
      if (w) w.since = Date.now();
    };
    child.stderr?.on("data", (d: string) => {
      if (!opts.waitFor) return void (stderr += d);
      const lines = (part + d).split("\n");
      part = lines.pop()!;
      lines.forEach(pass);
    });
    child.on("error", (e) => (waitEnd(child), reject(e)));
    child.on("close", (code) => {
      waitEnd(child);
      if (part) ((stderr += part), process.stderr.write(part));
      resolve({ code: code ?? 1, stdout, stderr });
    });
    if (opts.input !== undefined) child.stdin!.end(opts.input);
  });
}

/**
 * Non-interactive ssh gets a short PATH: Synology's Container Manager (and other add-on packages)
 * put docker in /usr/local/bin, which only login shells have.
 */
const REMOTE_PATH = `PATH="$PATH:/usr/local/sbin:/usr/local/bin"`;

/** Run an interactive command (or a login shell when cmd is empty). */
export async function sshExec(s: Server, cmd: string[] = []): Promise<number> {
  const { code } = await spawnP("ssh", [...sshArgs(s, { tty: process.stdin.isTTY }), ...(cmd.length ? [`${REMOTE_PATH};`, ...cmd] : [])], {});
  return code;
}

/** Id of one landfall run in the journal: undo groups a run's changes by it. */
export const newRunId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * What the server journal credits a change to. One landfall invocation is one run;
 * the dashboard passes LANDFALL_RUN to its jobs so it can offer to undo them.
 */
export const journal = {
  run: process.env.LANDFALL_RUN || newRunId(),
  actor: `${userInfo().username}@${hostname().split(".")[0]}`,
  cmd: "",
};

export interface ScriptOpts {
  env?: Record<string, string | number | boolean | undefined>;
  capture?: boolean;
  /** Run the script as root through passwordless sudo. */
  sudo?: boolean;
}

/**
 * Run a bash script on the server. The script travels over stdin, variables are
 * prepended as shell-quoted assignments so no value is ever interpolated raw.
 */
// Parallel first connections race for the ControlMaster socket, and each loser opens a session of its own.
// So the first call to a server runs alone and the rest wait for it; then they share its connection.
// ControlPersist=60 closes it after a minute idle, so a server counts as warm a little less than that.
// The wait ends after a few seconds anyway: the connection is up by then, and a slow or stuck first
// script (apt update, a hung docker) must not hold every other call to that server.
const warm = new Map<string, { ready: Promise<unknown>; until: number }>();
const WARM_MS = 50_000;
const GATE_MS = 3_000;

async function shared<T>(s: Server, run: () => Promise<T>): Promise<T> {
  const key = `${dest(s)}:${s.port ?? 22}`;
  const w = warm.get(key);
  if (w && Date.now() < w.until) {
    await w.ready;
    return run().finally(() => (w.until = Math.max(w.until, Date.now() + WARM_MS)));
  }
  const ready = run();
  const entry = { ready: Promise.race([ready.catch(() => {}), new Promise((r) => setTimeout(r, GATE_MS).unref())]), until: Infinity };
  warm.set(key, entry);
  try {
    return await ready;
  } finally {
    entry.until = Date.now() + WARM_MS;
  }
}

export async function runScript(s: Server, script: string, o: ScriptOpts = {}): Promise<RunResult> {
  const env = { LANDFALL_RUN: journal.run, LANDFALL_ACTOR: journal.actor, LANDFALL_CMD: journal.cmd, LANDFALL_REPORT: process.env.LANDFALL_REPORT, ...o.env };
  const header = Object.entries(env)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${shq(typeof v === "boolean" ? (v ? 1 : 0) : v!)}`)
    .join("\n");
  const waitFor = o.capture && process.stderr.isTTY && !quiet ? s.host : undefined;
  const res = await shared(s, () =>
    spawnP("ssh", [...sshArgs(s), o.sudo ? "sudo -n bash -s" : "bash -s"], {
      input: `set -euo pipefail\n${REMOTE_PATH}\n${header}\n${waitFor ? `echo ${STARTED} >&2\n` : ""}${script}\n`,
      capture: o.capture,
      waitFor,
    }),
  );
  // Quiet runs capture stderr: pass the script's report lines on all the same. A waited-for run showed them already.
  const lines = waitFor ? [] : res.stderr.trim().split("\n");
  for (const l of lines) if (l.startsWith(REPORT)) process.stderr.write(l + "\n");
  if (res.code !== 0) {
    const why = lines.filter((l) => !l.startsWith(REPORT)).at(-1);
    fail(`remote command failed on ${s.host} (exit ${res.code})${why ? `: ${why}` : ""}`);
  }
  return res;
}

/** Can we log in with keys alone? */
export async function canLogin(s: Server): Promise<boolean> {
  const { code } = await spawnP("ssh", [...sshArgs(s, { batch: true, noMux: true }), "true"], { capture: true, silent: true });
  return code === 0;
}

export interface Reach {
  /** ok: key login works · login: sshd answers but refuses the login · down: no ssh at all */
  state: "ok" | "login" | "down";
  detail: string;
  ms: number;
}

/** One key-only ssh login, so it also works through ProxyJump and where ICMP is blocked. */
export function reach(s: Server, timeout = 5): Promise<Reach> {
  const t0 = Date.now();
  // Our ConnectTimeout comes first: for -o options ssh keeps the first value.
  const args = [...targetArgs(s), "-o", `ConnectTimeout=${timeout}`, "-o", "BatchMode=yes", "-o", "ControlPath=none", "-T", dest(s), "true"];
  return new Promise((resolve) => {
    const done = (state: Reach["state"], detail: string) => resolve({ state, detail, ms: Date.now() - t0 });
    const child = spawn("ssh", args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr!.on("data", (d) => (err += d));
    // ConnectTimeout covers the TCP connect only; a host that accepts and then stalls is cut here.
    const kill = setTimeout(() => child.kill(), (timeout + 5) * 1000);
    child.on("error", (e) => (clearTimeout(kill), done("down", e.message)));
    child.on("close", (code) => {
      clearTimeout(kill);
      const line =
        err
          .trim()
          .split("\n")
          .filter((l) => !l.startsWith("Warning: Permanently added"))
          .pop() ?? "";
      if (code === 0) done("ok", "key login works");
      else if (code === null) done("down", "no answer");
      else if (/resolve|not known|nodename|no address/i.test(line)) done("down", "host name not found");
      else if (/timed out|refused|no route|unreachable|network is down/i.test(line)) done("down", line.replace(/^ssh: /, ""));
      else done("login", line || `ssh exited ${code}`);
    });
  });
}

/**
 * Whether landfall logs in to s and has set it up there; the connection stays open for what follows.
 * ssh exits 255 for any failure of its own: only a refused login is "no-login", the rest (unreachable,
 * a changed host key) is an error with ssh's own words, since lf setup would not help.
 */
export async function setUpState(s: Server): Promise<"ready" | "bare" | "no-login"> {
  const { code, stderr } = await spawnP("ssh", [...sshArgs(s, { batch: true }), `test -d ${ROOT}`], { capture: true, silent: true });
  if (code !== 255) return code === 0 ? "ready" : "bare";
  if (/permission denied|too many authentication failures/i.test(stderr)) return "no-login";
  const why = stderr
    .trim()
    .split("\n")
    .filter((l) => !/^warning:/i.test(l))
    .at(-1);
  return fail(`cannot connect to ${s.host}${why ? `: ${why}` : ""}`);
}

/** Passes bytes through and, on a terminal, shows how many went so far (at most every 200 ms). */
function meter(label: string): Transform {
  const tty = process.stderr.isTTY;
  let n = 0;
  let last = 0;
  const show = () => process.stderr.write(`\r\x1b[2K  ${c.dim(`${label} ${bytes(n)}`)}`);
  return new Transform({
    transform(chunk: Buffer, _, done) {
      n += chunk.length;
      if (tty && Date.now() - last > 200) ((last = Date.now()), show());
      done(null, chunk);
    },
    flush(done) {
      if (tty) (show(), process.stderr.write("\n"));
      done();
    },
  });
}

let bsdtar: string[] | undefined;
/** bsdtar (macOS) would otherwise embed xattr headers GNU tar warns about. */
export async function bsdtarFlags(): Promise<string[]> {
  if (!bsdtar) {
    const { stdout } = await spawnP("tar", ["--version"], { capture: true });
    bsdtar = stdout.includes("bsdtar") ? ["--no-xattrs", "--no-mac-metadata", "--no-acls"] : [];
  }
  return bsdtar;
}

let localRsync: Promise<boolean> | undefined;
let rsync3 = false;
const hasRsync = () =>
  (localRsync ??= spawnP("rsync", ["--version"], { capture: true, silent: true }).then(
    (r) => ((rsync3 = /version 3\./.test(r.stdout)), r.code === 0),
    () => false,
  ));

/** How upload sent the files: rsync (only the changes) or tar (everything, and why). */
export type Sent = "rsync" | "tar" | "tar:no-local-rsync" | "tar:no-server-rsync";

/** NUL-separated, for tar --null -T - and rsync --from0 --files-from=-. */
const fileList = (list: Entry[]) => list.map((e) => `${e.path}\0`).join("");

/**
 * Uploads the `list` of localDir (see uploadList) to remoteDir. With a seed (the live release's copy on the
 * server), rsync sends only what changed.
 */
export async function upload(s: Server, localDir: string, remoteDir: string, list: Entry[], seed?: string): Promise<Sent> {
  if (!fs.existsSync(localDir)) fail(`directory not found: ${localDir}`);
  const tar = async (sent: Sent) => (await tarUpload(s, localDir, remoteDir, list), sent);
  if (!seed) return tar("tar");
  if (!(await hasRsync())) return tar("tar:no-local-rsync");
  const { stdout } = await runScript(
    s,
    `if ! command -v rsync >/dev/null; then echo no-rsync; elif [ -d ${shq(seed)} ]; then mkdir -p ${shq(remoteDir)} && echo ok; fi`,
    { capture: true },
  );
  const answer = stdout.trim();
  if (answer === "no-rsync") return tar("tar:no-server-rsync");
  if (answer !== "ok") return tar("tar");
  // --copy-dest copies unchanged files from the seed: real copies, since landfall rewrites some release files in place.
  const shell = ["ssh", ...sshOptions(s)].map(shq).join(" ");
  // No -r: the list names every folder and file, and -r would send what it leaves out of a folder.
  const args = ["-lptz", "--from0", "--files-from=-", `--copy-dest=${seed}`, "-e", shell, `${localDir.replace(/\/*$/, "")}/`, `${dest(s)}:${remoteDir}/`];
  if (rsync3 && process.stdout.isTTY) args.unshift("--info=progress2");
  const rsync = spawn("rsync", args, { stdio: ["pipe", "inherit", "inherit"] });
  rsync.stdin.on("error", () => {});
  rsync.stdin.end(fileList(list));
  const code = await new Promise<number>((done, reject) => (rsync.on("error", reject), rsync.on("close", (c) => done(c ?? 1))));
  if (code !== 0) fail(`rsync failed (exit ${code})`);
  return "rsync";
}

async function tarUpload(s: Server, localDir: string, remoteDir: string, list: Entry[]) {
  // "." first: an empty list still makes a valid archive. --no-recursion before -T (GNU tar reads it in order).
  const tar = ["tar", ...(await bsdtarFlags()), "-czf", "-", "-C", localDir, "--no-recursion", "--null", "-T", "-"];
  await sshPipe(s, `mkdir -p ${shq(remoteDir)} && tar -xzof - -C ${shq(remoteDir)}`, tar, "up", `.\0${fileList(list)}`);
}

/**
 * Streams between this machine and a remote command: "up" pipes the local side into it, "down" pipes
 * its output into the local side. The local side is a command (argv) or a file.
 */
export async function sshPipe(s: Server, remote: string, local: string[] | { file: string }, dir: "up" | "down", input?: string) {
  // COPYFILE_DISABLE stops macOS bsdtar from adding ._ AppleDouble files.
  const env = { ...process.env, COPYFILE_DISABLE: "1" };
  const exit = (p: ChildProcess) => new Promise<number>((done) => p.on("close", (c) => done(c ?? 1)));
  const ssh = spawn("ssh", [...sshArgs(s), `${REMOTE_PATH}; ${remote}`], {
    stdio: dir === "up" ? ["pipe", "inherit", "inherit"] : ["ignore", "pipe", "inherit"],
  });
  const done: Promise<number>[] = [exit(ssh)];
  await new Promise<void>((resolve, reject) => {
    ssh.on("error", reject);
    if ("file" in local) {
      const f = dir === "up" ? fs.createReadStream(local.file) : fs.createWriteStream(local.file);
      f.on("error", reject);
      if (dir === "up") {
        ssh.stdin!.on("error", () => (f as fs.ReadStream).destroy());
        (f as fs.ReadStream).pipe(meter("sent")).pipe(ssh.stdin!);
        // A read error rejects above: ssh's exit is the whole result.
        done.push(Promise.resolve(0));
      } else {
        ssh.stdout!.pipe(meter("received")).pipe(f as fs.WriteStream);
        done.push(new Promise((ok) => f.on("close", () => ok(0))));
      }
    } else {
      const p = spawn(local[0], local.slice(1), {
        stdio: dir === "up" ? [input === undefined ? "ignore" : "pipe", "pipe", "inherit"] : ["pipe", "inherit", "inherit"],
        env,
      });
      p.on("error", reject);
      if (dir === "up" && input !== undefined) p.stdin!.end(input);
      // One end gone: stop the other, or it blocks on its full pipe and never exits.
      if (dir === "up") {
        ssh.stdin!.on("error", () => p.kill());
        p.stdout!.pipe(meter("sent")).pipe(ssh.stdin!);
      } else {
        p.stdin!.on("error", () => ssh.kill());
        ssh.stdout!.pipe(p.stdin!);
      }
      done.push(exit(p));
    }
    // Wait for both ends: one may exit 0 before the other reports that it failed halfway.
    Promise.all(done).then(([code, other]) => {
      if (code !== 0) reject(new CliError(`${dir === "up" ? "upload" : "download"} failed (exit ${code})`));
      else if (other !== 0) reject(new CliError(`${local instanceof Array ? local[0] : local.file} failed (exit ${other})`));
      else resolve();
    });
  });
}

/** Shell snippet that writes `content` to `path` byte-exact (base64 avoids any quoting issues). */
export const writeFileCmd = (path: string, content: string, mode = "644") =>
  `printf %s ${shq(Buffer.from(content).toString("base64"))} | base64 -d > ${shq(path)} && chmod ${mode} ${shq(path)}`;
