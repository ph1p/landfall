import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import { hostname, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { envVar, expandHome, type Server } from "./config";
import { ROOT } from "./templates";
import { fail } from "./ui";

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
export const sshConfigFlag = (f = envVar("SSH_CONFIG")) => (f ? ["-F", fs.existsSync(f) ? f : "/dev/null"] : []);

/** `user@host`, or just the host/alias when ssh config supplies the user. */
export const dest = (s: Server) => (s.user ? `${s.user}@${s.host}` : s.host);

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

export function sshArgs(s: Server, o: SshOpts = {}): string[] {
  const a = [...targetArgs(s), "-o", "ServerAliveInterval=15"];
  if (o.batch || quiet) a.push("-o", "BatchMode=yes", "-o", "ConnectTimeout=10");
  // Reuse one TCP/SSH session across the many calls a deploy makes.
  if (o.noMux) a.push("-o", "ControlPath=none");
  else a.push("-o", "ControlMaster=auto", "-o", `ControlPath=${controlDir()}/%C`, "-o", "ControlPersist=60");
  a.push(o.tty ? "-t" : "-T", dest(s));
  return a;
}

/** Close the multiplexed session to `s`, if one lingers (it keeps a login of that user alive). */
export function closeMux(s: Server): Promise<void> {
  return new Promise((resolve) => {
    const args = [...targetArgs(s), "-o", `ControlPath=${controlDir()}/%C`, "-O", "exit", dest(s)];
    spawn("ssh", args, { stdio: "ignore" }).on("close", () => resolve()).on("error", () => resolve());
  });
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function spawnP(cmd: string, args: string[], opts: SpawnOptions & { input?: string; capture?: boolean }): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      ...opts,
      stdio: [opts.input !== undefined ? "pipe" : "inherit", opts.capture ? "pipe" : "inherit", quiet ? "pipe" : "inherit"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (opts.input !== undefined) child.stdin!.end(opts.input);
  });
}

/** Run an interactive command (or a login shell when cmd is empty). */
export async function sshExec(s: Server, cmd: string[] = []): Promise<number> {
  const { code } = await spawnP("ssh", [...sshArgs(s, { tty: process.stdin.isTTY }), ...cmd], {});
  return code;
}

/**
 * What the server journal credits a change to. One landfall invocation is one run;
 * the dashboard passes LANDFALL_RUN to its jobs so it can offer to undo them.
 */
export const journal = {
  run: process.env.LANDFALL_RUN || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
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
export async function runScript(s: Server, script: string, o: ScriptOpts = {}): Promise<RunResult> {
  const env = { LANDFALL_RUN: journal.run, LANDFALL_ACTOR: journal.actor, LANDFALL_CMD: journal.cmd, ...o.env };
  const header = Object.entries(env)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${shq(typeof v === "boolean" ? (v ? 1 : 0) : v!)}`)
    .join("\n");
  const res = await spawnP("ssh", [...sshArgs(s), o.sudo ? "sudo -n bash -s" : "bash -s"], {
    input: `set -euo pipefail\n${header}\n${script}\n`,
    capture: o.capture,
  });
  if (res.code !== 0) {
    const why = res.stderr.trim().split("\n").at(-1);
    fail(`remote command failed on ${s.host} (exit ${res.code})${why ? `: ${why}` : ""}`);
  }
  return res;
}

/** Can we log in with keys alone? */
export async function canLogin(s: Server): Promise<boolean> {
  const { code } = await spawnP("ssh", [...sshArgs(s, { batch: true, noMux: true }), "true"], { capture: true });
  return code === 0;
}

/** Whether landfall logs in to s and has set it up there; the connection stays open for what follows. */
export async function setUpState(s: Server): Promise<"ready" | "bare" | "no-login"> {
  const { code } = await spawnP("ssh", [...sshArgs(s, { batch: true }), `test -d ${ROOT}`], { capture: true });
  return code === 0 ? "ready" : code === 255 ? "no-login" : "bare";
}

/** Never uploaded: secrets, local state, and compose overrides (local-only by convention; landfall writes the server's). */
const DEFAULT_EXCLUDES = [".git", "node_modules", ".DS_Store", ".landfall.json", ".env", ".env.*", "compose.override.*", "docker-compose.override.*"];

let bsdtar: string[] | undefined;
/** bsdtar (macOS) would otherwise embed xattr headers GNU tar warns about. */
async function bsdtarFlags(): Promise<string[]> {
  if (!bsdtar) {
    const { stdout } = await spawnP("tar", ["--version"], { capture: true });
    bsdtar = stdout.includes("bsdtar") ? ["--no-xattrs", "--no-mac-metadata", "--no-acls"] : [];
  }
  return bsdtar;
}

/** Stream a local directory into a remote directory via tar over ssh. */
export async function upload(s: Server, localDir: string, remoteDir: string, excludes = DEFAULT_EXCLUDES) {
  if (!fs.existsSync(localDir)) fail(`directory not found: ${localDir}`);
  const tarArgs = [...(await bsdtarFlags()), "-czf", "-", ...excludes.flatMap((e) => ["--exclude", e]), "-C", localDir, "."];
  const remote = `mkdir -p ${shq(remoteDir)} && tar -xzof - -C ${shq(remoteDir)}`;
  await new Promise<void>((resolve, reject) => {
    // COPYFILE_DISABLE stops macOS bsdtar from adding ._ AppleDouble files.
    const tar = spawn("tar", tarArgs, {
      stdio: ["ignore", "pipe", "inherit"],
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    const ssh = spawn("ssh", [...sshArgs(s), remote], { stdio: ["pipe", "inherit", "inherit"] });
    tar.stdout.pipe(ssh.stdin);
    tar.on("error", reject);
    ssh.on("error", reject);
    // Wait for both: ssh may exit 0 before tar reports that it failed halfway.
    const exit = (p: ChildProcess) => new Promise<number>((done) => p.on("close", (c) => done(c ?? 1)));
    Promise.all([exit(tar), exit(ssh)]).then(([tarCode, code]) => {
      if (tarCode !== 0) reject(new Error(`tar failed (exit ${tarCode})`));
      else if (code !== 0) reject(new Error(`upload failed (exit ${code})`));
      else resolve();
    });
  });
}

/** Shell snippet that writes `content` to `path` byte-exact (base64 avoids any quoting issues). */
export const writeFileCmd = (path: string, content: string, mode = "644") =>
  `printf %s ${shq(Buffer.from(content).toString("base64"))} | base64 -d > ${shq(path)} && chmod ${mode} ${shq(path)}`;
