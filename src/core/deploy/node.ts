import type { Files } from "./runtimes";

/** The package manager its lockfile names, and how it runs a package.json script. */
export function packageManager(has: (f: string) => boolean, bun = false, declared?: string) {
  // The lockfile says what installed the project; else package.json's packageManager (`pnpm@10.4.1`).
  const named = declared?.match(/^(pnpm|yarn|npm|bun)@/)?.[1];
  const name =
    bun || has("bun.lock") || has("bun.lockb")
      ? "bun"
      : has("pnpm-lock.yaml")
        ? "pnpm"
        : has("yarn.lock")
          ? "yarn"
          : has("package-lock.json")
            ? "npm"
            : (named ?? "npm");
  const run = (script: string) =>
    name === "bun" ? `bun run ${script}` : name === "npm" ? (script === "start" ? "npm start" : `npm run ${script}`) : `${name} ${script}`;
  /** Adds a dev dependency. */
  const add = (pkg: string) => (name === "npm" ? `npm install -D ${pkg}` : `${name} add -${name === "bun" ? "d" : "D"} ${pkg}`);
  return { name, run, add };
}

/** The Node.js major landfall builds with when the project names none. */
const NODE = "24";
/** Majors still maintained; an engines range without NODE picks the newest of them it allows. */
const NODE_MAJORS = [22, 24, 26];

/**
 * The Node.js major for package.json's engines.node: NODE if the range allows it, else the newest maintained
 * major it does (`>=25` is 26), else the newest it names (`^18`). Undefined without a range or for one it cannot read.
 */
export function nodeMajor(range: unknown): string | undefined {
  if (typeof range !== "string" || !range.trim()) return;
  const v = (s: string) => {
    const [maj, min, pat] = s.replace(/^v/, "").split(".");
    const part = (x?: string) => (x === undefined || /^[x*]$/i.test(x) ? undefined : Number.parseInt(x, 10));
    return [part(maj), part(min), part(pat)] as const;
  };
  const at = (p: readonly (number | undefined)[]) => (p[0] ?? 0) * 1e6 + (p[1] ?? 0) * 1e3 + (p[2] ?? 0);
  // The first version past a partial one: 22 → 23.0.0, 22.4 → 22.5.0.
  const after = (p: readonly (number | undefined)[]) =>
    p[0] === undefined ? Infinity : p[1] === undefined ? (p[0] + 1) * 1e6 : p[2] === undefined ? p[0] * 1e6 + (p[1] + 1) * 1e3 : at(p) + 1;
  const allows = (alt: string, major: number) => {
    let lo = major * 1e6;
    let hi = (major + 1) * 1e6;
    const hyphen = alt.match(/^(\S+)\s+-\s+(\S+)$/);
    const parts = hyphen
      ? [`>=${hyphen[1]}`, `<=${hyphen[2]}`]
      : alt
          .replace(/([<>=^~]+)\s+/g, "$1")
          .split(/\s+/)
          .filter(Boolean);
    for (const c of parts) {
      const [, op = "", ver] = c.match(/^([<>]=?|=|\^|~)?(.+)$/) ?? [];
      const p = v(ver ?? "");
      if (p[0] === undefined && ver !== undefined && !/^[x*]$/i.test(ver)) return false;
      if (op === ">=") lo = Math.max(lo, at(p));
      else if (op === ">") lo = Math.max(lo, after(p));
      else if (op === "<") hi = Math.min(hi, at(p));
      else if (op === "<=") hi = Math.min(hi, after(p));
      else if (op === "^") ((lo = Math.max(lo, at(p))), (hi = Math.min(hi, ((p[0] ?? 0) + 1) * 1e6)));
      else if (op === "~") ((lo = Math.max(lo, at(p))), (hi = Math.min(hi, p[1] === undefined ? after(p) : (p[0] ?? 0) * 1e6 + (p[1] + 1) * 1e3)));
      else ((lo = Math.max(lo, at(p))), (hi = Math.min(hi, after(p))));
    }
    return lo < hi;
  };
  const ok = (m: number) => range.split("||").some((alt) => allows(alt.trim(), m));
  if (ok(Number(NODE))) return NODE;
  const pick = NODE_MAJORS.findLast(ok) ?? Array.from({ length: 21 }, (_, i) => 36 - i).find(ok);
  return pick === undefined ? undefined : String(pick);
}

/** The FROM line of a Node.js (or Bun) image: the version the project names. */
export function nodeFrom(f: Files, bun: boolean, as = "") {
  const major = (f.read(".nvmrc") || f.read(".node-version")).trim().match(/^v?(\d+)/)?.[1] ?? nodeMajor(f.pkg.engines?.node) ?? NODE;
  return (bun ? `FROM oven/bun:${f.pkg.packageManager?.match(/^bun@(\d+(?:\.\d+){0,2})/)?.[1] ?? "1"}-slim` : `FROM node:${major}-slim`) + (as && ` AS ${as}`);
}

/**
 * The stage that installs a package.json's dependencies: Node.js from .nvmrc / .node-version with the lockfile's
 * package manager, or Bun's image (which answers to `node` too). Dependencies install in a layer of their own, so a
 * redeploy that changes none skips it, unless install scripts or workspaces need the whole project.
 */
export function nodeStage(f: Files, bun: boolean, as = ""): string[] {
  const pkg = f.pkg;
  const pm = packageManager(f.has, bun, pkg.packageManager);
  const lock = ["bun.lock", "bun.lockb", "pnpm-lock.yaml", "yarn.lock", "package-lock.json"].find(f.has);
  const whole =
    !!pkg.workspaces ||
    ["pnpm-workspace.yaml", ".yarnrc.yml", "patches"].some(f.has) ||
    ["preinstall", "install", "postinstall", "prepare"].some((s) => s in (pkg.scripts ?? {}));
  const install = !f.has("package.json")
    ? undefined
    : pm.name === "npm"
      ? lock
        ? "npm ci"
        : "npm install"
      : `${pm.name} install${lock ? " --frozen-lockfile" : ""}`;
  const manifests = ["package.json", lock, ...[".npmrc", ".yarnrc", "bunfig.toml"].filter(f.has)].filter(Boolean);
  return [
    nodeFrom(f, bun, as),
    "WORKDIR /app",
    // Corepack runs the version package.json's packageManager pins; Node.js 25 and later ship without it.
    ...(pm.name !== "npm" && !bun ? [`RUN corepack enable || (npm install -g corepack && corepack enable)`] : []),
    ...(install && !whole ? [`COPY ${manifests.join(" ")} ./`, `RUN ${install}`, "COPY . ."] : ["COPY . .", ...(install ? [`RUN ${install}`] : [])]),
  ];
}
