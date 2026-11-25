import fs from "node:fs";
import { ENV_NAME } from "./env-vars";
import { fail, readStdin } from "../lib/term";

/** Merge KEY=VALUE pairs into dotenv text, preserving order and comments. */
export function mergeEnv(existing: string, set: Record<string, string>, unset: string[] = []): string {
  const out: string[] = [];
  const done = new Set<string>();
  for (const line of existing.split("\n")) {
    const key = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=/)?.[1];
    if (key && unset.includes(key)) continue;
    if (key && Object.hasOwn(set, key)) {
      // Compose takes the last of duplicate keys: keep one, set.
      if (!done.has(key)) out.push(`${key}=${set[key]}`);
      done.add(key);
    } else if (line.trim() || out.length) out.push(line);
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  for (const [k, v] of Object.entries(set)) if (!done.has(k)) out.push(`${k}=${v}`);
  return out.length ? out.join("\n") + "\n" : "";
}

/** KEY=VALUE lines of a dotenv file; `export` prefixes and comments are skipped. */
export const dotenvLines = (text: string): string[] =>
  text
    .split("\n")
    // `KEY = v` is fine for Compose too.
    .map((l) =>
      l
        .trim()
        .replace(/^export\s+/, "")
        .replace(/^([^=\s]+)\s*=\s*/, "$1="),
    )
    .filter((l) => l && !l.startsWith("#") && l.includes("="));

/** The variables of a .env in order, each value as written after `=` (quotes included). */
export const envEntries = (text: string): { key: string; value: string }[] =>
  dotenvLines(text).map((l) => ({ key: l.slice(0, l.indexOf("=")).trim(), value: l.slice(l.indexOf("=") + 1) }));

/** What `lf env --json` prints and the web UI lists: values only when revealed, else just their length. */
export function envView(text: string, reveal = false) {
  return { vars: envEntries(text).map(({ key, value }) => (reveal ? { key, value } : { key, length: value.length })) };
}

/** A .env as `lf env` shows it: comments and blank lines dropped, every value hidden. */
export const maskedEnv = (text: string) =>
  envEntries(text)
    .map(({ key, value }) => `${key}=${"•".repeat(8)} (${value.length})\n`)
    .join("");

/** A local dotenv file as pairs; `-` reads stdin, which keeps the values out of `ps`. */
export const readEnvFile = async (path: string) => parseEnvPairs(dotenvLines(path === "-" ? await readStdin() : fs.readFileSync(path, "utf8")));

/** The .env in a project folder, without its empty values ("" and '' too); none or an unreadable one: {}. */
export function localEnv(dir: string): Record<string, string> {
  try {
    const all = parseEnvPairs(dotenvLines(fs.readFileSync(`${dir}/.env`, "utf8")));
    return Object.fromEntries(Object.entries(all).filter(([, v]) => v.replace(/^(["'])\1$/, "")));
  } catch {
    return {};
  }
}

/** KEY=VALUE pairs; a .env holds one variable per line, so its values (`oneLine`) cannot span lines. */
export function parseEnvPairs(pairs: string[], oneLine = false): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of pairs) {
    const i = p.indexOf("=");
    if (i < 1) fail(`invalid env "${p.split("\n")[0]}", expected KEY=VALUE`);
    const key = p.slice(0, i);
    if (!ENV_NAME.test(key)) fail(`not a variable name: ${JSON.stringify(key)} (letters, digits, _ . -)`);
    if (oneLine && /[\r\n]/.test(p.slice(i + 1))) fail(`${key}: a .env value is one line; put multi-line text (keys, certificates) in a secret: lf secret`);
    out[key] = p.slice(i + 1);
  }
  return out;
}
