import fs from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

/** A .env variable name. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/**
 * A variable a project wants in its .env. Compose refuses `${NAME:?message}` unset or empty (strict),
 * `${NAME?message}` unset; an example .env's keys are wanted too, but the app may do without them (optional).
 */
export interface RequiredVar {
  name: string;
  /** The file that wants it: a compose file or an example .env. */
  from: string;
  message?: string;
  strict: boolean;
  optional?: boolean;
  /** The value an example .env shows: only suggested, never sent as it is. */
  example?: string;
}

/** Whether a missing var is asked for: an example's key with a value is only suggested. */
export const askable = (v: RequiredVar) => v.example === undefined;

/** The variables a compose file requires, in order, from its text (comment lines left out). */
export function requiredVars(text: string, from: string): RequiredVar[] {
  const out = new Map<string, RequiredVar>();
  const body = text.replace(/^\s*#.*$/gm, "");
  // `$$` first, so an escaped `$${NAME:?}` is not one.
  for (const [, name, op, message] of body.matchAll(/\$(?:\$|\{(\w+)(:?)\?([^}]*)\})/g)) {
    if (!name) continue;
    const had = out.get(name);
    out.set(name, { name, from, message: had?.message ?? (message.trim() || undefined), strict: !!had?.strict || op === ":" });
  }
  return [...out.values()];
}

/** Example .env files, in the order looked for: their keys are what the app reads, in any language. */
export const EXAMPLE_ENV_FILES = [".env.example", ".env.sample", ".env.template", ".env.dist"];

/**
 * The keys of an example .env, all optional: one left empty is asked for, one with a value only
 * suggested. The comment line right above a key is its message.
 */
export function exampleVars(text: string, from: string): RequiredVar[] {
  const out = new Map<string, RequiredVar>();
  let comment: string | undefined;
  for (const raw of text.split("\n")) {
    const l = raw.trim().replace(/^export\s+/, "");
    const m = l.match(/^([^=\s]+)\s*=\s*(.*)$/);
    if (m && ENV_NAME.test(m[1]) && !out.has(m[1])) {
      const quoted = m[2].match(/^(["'])(.*)\1/);
      const value = quoted ? quoted[2] : m[2].replace(/(^|\s)#.*$/, "").trim();
      out.set(m[1], { name: m[1], from, message: comment, strict: false, optional: true, ...(value && { example: value }) });
    }
    // A commented-out KEY=value is no message.
    const text = l.startsWith("#") ? l.replace(/^#+\s*/, "") : undefined;
    comment = text && !ENV_NAME.test(text.split("=")[0].trim()) ? text : undefined;
  }
  return [...out.values()];
}

/**
 * What a deploy of root wants in the site's .env: what its compose files require, and an example
 * .env's keys where the .env reaches the app: always for an app, Dockerfile or image (the compose
 * landfall writes reads it as env_file), for a compose project only if it names an env_file.
 */
/** app: a generated app (with env_file: .env) runs beside the files, so an example .env counts too. */
export function wantedVars(root: string, composeFiles: string[] = [], o: { app?: boolean } = {}): RequiredVar[] {
  const texts = composeFiles.map((f) => [f, fs.readFileSync(join(root, f), "utf8")]);
  const envFile = (text: string) => {
    try {
      return Object.values<any>(parseYaml(text)?.services ?? {}).some((s) => s?.env_file);
    } catch {
      return false;
    }
  };
  const vars = texts.flatMap(([f, text]) => requiredVars(text, f));
  const example = EXAMPLE_ENV_FILES.find((f) => fs.existsSync(join(root, f)));
  if (example && (!texts.length || o.app || texts.some(([, text]) => envFile(text))))
    vars.push(...exampleVars(fs.readFileSync(join(root, example), "utf8"), example));
  // The first file to want a name says it: compose before the example.
  return vars.filter((v, i) => vars.findIndex((u) => u.name === v.name) === i);
}

/** The required variables vars leaves without a value in env (a .env's pairs). */
export const missingVars = (vars: RequiredVar[], env: Record<string, string>) => vars.filter((v) => (v.strict ? !env[v.name] : env[v.name] === undefined));
