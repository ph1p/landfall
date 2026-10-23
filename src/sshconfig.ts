import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { expandHome, type Server } from "./config";
import { dest, targetArgs } from "./ssh";
import { fail } from "./ui";

export const SSH_CONFIG = process.env.SRV_SSH_CONFIG ?? join(homedir(), ".ssh", "config");

export interface EffectiveSsh {
  hostname: string;
  user: string;
  port: number;
  identityFiles: string[];
}

const resolved = new Map<string, EffectiveSsh>();

/** Effective ssh settings for a server, as `ssh -G` resolves them (aliases, Include, Match...). */
export function effectiveSsh(s: Server): EffectiveSsh {
  const args = [...targetArgs(s), "-G", dest(s)];
  const cached = resolved.get(args.join("\0"));
  if (cached) return cached;
  let out: string;
  try {
    out = execFileSync("ssh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e: any) {
    return fail(`ssh cannot resolve ${dest(s)}: ${String(e.stderr ?? e.message).trim()}`);
  }
  const get = (k: string) => out.match(new RegExp(`^${k} (.+)$`, "m"))?.[1] ?? "";
  const identityFiles = [...out.matchAll(/^identityfile (.+)$/gm)].map((m) => expandHome(m[1]));
  const r = { hostname: get("hostname"), user: get("user"), port: Number(get("port") || 22), identityFiles };
  resolved.set(args.join("\0"), r);
  return r;
}

/** First private key ssh would offer that also has a .pub next to it. */
export function effectiveKey(s: Server): string | undefined {
  const files = s.key ? [expandHome(s.key)] : effectiveSsh(s).identityFiles;
  return files.find((f) => fs.existsSync(f) && fs.existsSync(`${f}.pub`));
}

/** Concrete (non-wildcard) Host aliases from ~/.ssh/config, following Include. */
export function sshAliases(file = SSH_CONFIG, seen = new Set<string>()): string[] {
  if (seen.has(file) || !fs.existsSync(file)) return [];
  seen.add(file);
  const out: string[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.trim().match(/^(\w+)\s*=?\s*(.+)$/);
    if (!m) continue;
    const [, key, value] = m;
    if (key.toLowerCase() === "host") {
      out.push(...value.split(/\s+/).filter((h) => !/[*?!]/.test(h)));
    } else if (key.toLowerCase() === "include") {
      for (const pattern of value.split(/\s+/)) {
        const p = expandHome(pattern);
        const abs = p.startsWith("/") ? p : join(homedir(), ".ssh", p);
        for (const f of glob(abs)) out.push(...sshAliases(f, seen));
      }
    }
  }
  return [...new Set(out)];
}

function glob(pattern: string): string[] {
  if (!/[*?[]/.test(pattern)) return [pattern];
  const dir = dirname(pattern);
  if (!fs.existsSync(dir)) return [];
  return fs.globSync(basename(pattern), { cwd: dir }).map((f) => join(dir, f));
}

const markers = (alias: string) => [`# >>> srv:${alias}`, `# <<< srv:${alias}`] as const;

export interface HostBlock {
  alias: string;
  hostname: string;
  user: string;
  port: number;
  key: string;
}

export function renderHostBlock(b: HostBlock): string {
  const [start, end] = markers(b.alias);
  return [
    start,
    `Host ${b.alias}`,
    `  HostName ${b.hostname}`,
    `  User ${b.user}`,
    ...(b.port !== 22 ? [`  Port ${b.port}`] : []),
    // Absolute: ssh expands ~ from the passwd home, which need not be $HOME.
    `  IdentityFile ${b.key}`,
    `  IdentitiesOnly yes`,
    end,
  ].join("\n");
}

/**
 * Insert or replace a srv-managed Host block. Blocks go at the top so they take
 * precedence over any `Host *` defaults further down (ssh uses first match).
 */
export function upsertHostBlock(b: HostBlock, file = SSH_CONFIG): { created: boolean; block: string } {
  const [start, end] = markers(b.alias);
  const created = !fs.existsSync(file);
  const current = created ? "" : fs.readFileSync(file, "utf8");
  const block = renderHostBlock(b);
  const re = new RegExp(`${escapeRe(start)}[\\s\\S]*?${escapeRe(end)}\\n?`);
  const next = re.test(current) ? current.replace(re, block + "\n") : `${block}\n\n${current}`;
  fs.mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, next, { mode: 0o600 });
  resolved.clear();
  return { created, block };
}

export interface FoundBlock {
  file: string;
  /** Line index of the `Host` line, and one past the block's last line. */
  start: number;
  end: number;
  lines: string[];
  managed: boolean;
}

/** The first `Host` block naming this alias exactly, following Include like ssh does. */
export function findHostBlock(alias: string, file = SSH_CONFIG, seen = new Set<string>()): FoundBlock | undefined {
  if (seen.has(file) || !fs.existsSync(file)) return undefined;
  seen.add(file);
  const lines = fs.readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].trim().match(/^(\w+)\s*=?\s*(.+)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key === "host" && m[2].split(/\s+/).includes(alias)) {
      let end = i + 1;
      while (end < lines.length && !/^\s*(host|match)\b/i.test(lines[end]) && !lines[end].startsWith("# <<< srv:")) end++;
      // Trailing blank lines and comments belong to whatever follows.
      while (end > i + 1 && /^\s*(#.*)?$/.test(lines[end - 1])) end--;
      return { file, start: i, end, lines: lines.slice(i, end), managed: lines[i - 1] === markers(alias)[0] };
    }
    if (key === "include") {
      for (const pattern of m[2].split(/\s+/)) {
        const p = expandHome(pattern);
        for (const f of glob(p.startsWith("/") ? p : join(homedir(), ".ssh", p))) {
          const found = findHostBlock(alias, f, seen);
          if (found) return found;
        }
      }
    }
  }
  return undefined;
}

export interface KeyEdit {
  file: string;
  removed: string[];
  added: string;
  backup: string;
}

/**
 * Point the user's own `Host <alias>` block at a key: IdentityFile lines whose
 * file is gone are dropped, the key goes first (ssh tries them in order).
 * The file is backed up to <file>.srv-bak before the first edit.
 */
export function setIdentityFile(alias: string, key: string): KeyEdit | undefined {
  const b = findHostBlock(alias);
  if (!b) return undefined;
  const lines = fs.readFileSync(b.file, "utf8").split("\n");
  const block = lines.slice(b.start + 1, b.end);
  const ident = (l: string) => l.trim().match(/^identityfile\s*=?\s*(.+)$/i)?.[1].replace(/^"(.*)"$/, "$1");
  const removed = block.filter((l) => {
    const f = ident(l);
    return f !== undefined && (!fs.existsSync(expandHome(f)) || expandHome(f) === key);
  });
  const indent = block.find((l) => l.trim())?.match(/^\s*/)?.[0] || "  ";
  const added = `${indent}IdentityFile ${key}`;
  const kept = block.filter((l) => !removed.includes(l));
  lines.splice(b.start + 1, block.length, added, ...kept);
  const backup = `${b.file}.srv-bak`;
  if (!fs.existsSync(backup)) fs.copyFileSync(b.file, backup);
  fs.writeFileSync(b.file, lines.join("\n"));
  resolved.clear();
  return { file: b.file, removed: removed.map((l) => l.trim()), added: added.trim(), backup };
}

export function removeHostBlock(alias: string, file = SSH_CONFIG): boolean {
  if (!fs.existsSync(file)) return false;
  const [start, end] = markers(alias);
  const current = fs.readFileSync(file, "utf8");
  const re = new RegExp(`${escapeRe(start)}[\\s\\S]*?${escapeRe(end)}\\n*`);
  if (!re.test(current)) return false;
  fs.writeFileSync(file, current.replace(re, ""));
  return true;
}

export const hasManagedBlock = (alias: string, file = SSH_CONFIG) =>
  fs.existsSync(file) && fs.readFileSync(file, "utf8").includes(markers(alias)[0]);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
