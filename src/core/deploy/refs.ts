// Which git refs may deploy where. Pure: no node: imports, so the web page uses it too.

import type { ReleaseGit } from "../site/compose";

/** What an environment deploys: branches or tags by glob (`*` stays within a /, `**` crosses it). */
export interface RefRule {
  branch?: string | string[];
  tag?: string | string[];
  /** Tags with a semver pre-release suffix (v1.2.0-rc.1) match too. */
  prerelease?: boolean;
  /** Refuse a working tree with uncommitted changes. */
  requireClean?: boolean;
}

/** `git` in .landfall.json: a rule, and the repository's URL (for the forge links and, later, the server fetch). */
export interface GitConfig extends RefRule {
  url?: string;
}

export type RefKind = "branch" | "tag";

export interface Ref {
  name: string;
  kind: RefKind;
  /** The commit it points at (a tag peeled). */
  sha: string;
  /** ISO date of the commit, or of an annotated tag. */
  date?: string;
  subject?: string;
}

export const list = (v: string | string[] | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]).filter(Boolean);

/** A rule names something to check. An environment without one deploys anything. */
export const hasRule = (r: RefRule | undefined): r is RefRule => !!r && (list(r.branch).length > 0 || list(r.tag).length > 0);

/** A glob as a whole-string RegExp: `**` any characters, `*` any but /, `?` one but /. */
export function globRe(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
    } else if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

const globs = new Map<string, RegExp>();
export function globMatch(glob: string, name: string): boolean {
  let re = globs.get(glob);
  if (!re) globs.set(glob, (re = globRe(glob)));
  return re.test(name);
}

interface Semver {
  major: number;
  minor: number;
  patch: number;
  pre: string[];
}

/** v1.2.3, 1.2.3-rc.1, release-1.2.3+build: the version inside a tag name, if it has one. */
export function semver(tag: string): Semver | undefined {
  const m = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(tag);
  if (!m) return undefined;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split(".") : [] };
}

export const isPrerelease = (tag: string) => (semver(tag)?.pre.length ?? 0) > 0;

/** Semver order: below 0 when a is older than b. */
export function compareSemver(a: Semver, b: Semver): number {
  for (const k of ["major", "minor", "patch"] as const) if (a[k] !== b[k]) return a[k] - b[k];
  // A release is newer than its pre-releases.
  if (!a.pre.length || !b.pre.length) return (a.pre.length ? 0 : 1) - (b.pre.length ? 0 : 1);
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const [x, y] = [a.pre[i], b.pre[i]];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const [nx, ny] = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (nx && ny && +x !== +y) return +x - +y;
    if (nx !== ny) return nx ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** refs/heads/x is a branch, refs/tags/x a tag; a bare name could be either. */
export function parseRefName(ref: string): { name: string; kind?: RefKind } {
  const r = ref.trim();
  if (r.startsWith("refs/heads/")) return { name: r.slice(11), kind: "branch" };
  if (r.startsWith("refs/tags/")) return { name: r.slice(10), kind: "tag" };
  if (r.startsWith("refs/remotes/origin/")) return { name: r.slice(20), kind: "branch" };
  return { name: r };
}

/** Whether a rule lets this ref deploy. Without a rule, anything may. */
export function refMatches(rule: RefRule | undefined, ref: { name: string; kind: RefKind }): boolean {
  if (!hasRule(rule)) return true;
  if (ref.kind === "branch") return list(rule.branch).some((g) => globMatch(g, ref.name));
  if (!rule.prerelease && isPrerelease(ref.name)) return false;
  return list(rule.tag).some((g) => globMatch(g, ref.name));
}

const newerDate = (a: { date?: string }, b: { date?: string }) => (b.date ?? "").localeCompare(a.date ?? "");

/** Tags newest first: semver ones by version, the rest after them by date. */
export function sortTags<T extends { name: string; date?: string }>(tags: T[]): T[] {
  return tags
    .map((t) => ({ t, v: semver(t.name) }))
    .sort((a, b) => {
      if (a.v && b.v) return compareSemver(b.v, a.v) || newerDate(a.t, b.t);
      if (a.v || b.v) return a.v ? -1 : 1;
      return newerDate(a.t, b.t);
    })
    .map((x) => x.t);
}

/** Branches, most recent commit first. */
export const sortBranches = <T extends { date?: string }>(branches: T[]): T[] => [...branches].sort(newerDate);

/** The newest of these refs' tags. */
export const newestTag = (refs: { name: string; kind?: RefKind; date?: string }[]) => sortTags(refs.filter((r) => r.kind === "tag"))[0]?.name;

/** The newest tag a rule lets deploy; without a tag rule, the newest version of any tag. */
export function latestTag<T extends Ref>(rule: RefRule | undefined, refs: T[]): T | undefined {
  const r = list(rule?.tag).length ? rule : { ...rule, tag: "**" };
  return sortTags(refs.filter((x) => x.kind === "tag" && refMatches(r, x)))[0];
}

/** One glob as a string, several as a list: the shape .landfall.json keeps. */
export const one = (v: string[]): string | string[] => (v.length === 1 ? v[0] : v);

/** The names a commit goes by: the one it was deployed or asked for, then the branches and tags at it. */
export function namesAt(sha: string, refs: Ref[], also: { name?: string; kind?: RefKind }[] = []): { name: string; kind: RefKind }[] {
  return [
    ...also.flatMap((r) => (r.name && r.kind ? [{ name: r.name, kind: r.kind }] : [])),
    ...refs.filter((r) => r.sha === sha).map((r) => ({ name: r.name, kind: r.kind })),
  ];
}

/** Whether a rule lets a commit deploy under one of its names. */
export const allows = (rule: RefRule | undefined, names: { name: string; kind: RefKind }[]) => !hasRule(rule) || names.some((r) => refMatches(rule, r));

/** An environment's name (config.ts ENV_NAME); "" is the project itself. Pure, so the web page checks the same way. */
export const ENVIRONMENT_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** What the rule says, in words: "branch main, release/*" or "tags v* (pre-releases too)". */
export function ruleText(rule: RefRule | undefined): string {
  if (!hasRule(rule)) return "any ref";
  const parts: string[] = [];
  const b = list(rule.branch);
  const t = list(rule.tag);
  if (b.length) parts.push(`${b.length > 1 ? "branches" : "branch"} ${b.join(", ")}`);
  if (t.length) parts.push(`tags ${t.join(", ")}${rule.prerelease ? " (pre-releases too)" : ""}`);
  return parts.join("; ") + (rule.requireClean ? ", clean tree only" : "");
}

/** The environments whose rule lets one of these refs deploy (environments without a rule are left out). */
export function envsForRef(rules: Record<string, RefRule | undefined>, refs: { name: string; kind: RefKind }[]): string[] {
  return Object.entries(rules)
    .filter(([, r]) => hasRule(r) && refs.some((ref) => refMatches(r, ref)))
    .map(([e]) => e);
}

/** Environments whose rules both match one of these refs: --for-ref could not pick. */
export function overlaps(rules: Record<string, RefRule | undefined>, refs: { name: string; kind: RefKind }[]): string[][] {
  return refs.map((r) => envsForRef(rules, [r])).filter((e) => e.length > 1);
}

export type Forge = "github" | "gitlab";

/** The web address of a remote: git@host:o/r.git, ssh://git@host/o/r, https://user@host/o/r.git → https://host/o/r. */
export function webUrl(remote: string | undefined): string | undefined {
  if (!remote) return undefined;
  const r = remote.trim();
  if (/^https?:\/\//.test(r)) {
    try {
      const u = new URL(r);
      return `https://${u.host}${u.pathname.replace(/\.git\/?$/, "").replace(/\/$/, "")}`;
    } catch {
      return undefined;
    }
  }
  if (r.startsWith("gh:")) return `https://github.com/${r.slice(3)}`;
  if (r.startsWith("gl:")) return `https://gitlab.com/${r.slice(3)}`;
  const m = /^(?:ssh:\/\/)?(?:[^@/]+@)?([^:/]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/.exec(r);
  return m ? `https://${m[1]}/${m[2]}` : undefined;
}

export function detectForge(remote: string | undefined): Forge | undefined {
  const web = webUrl(remote);
  const host = web ? new URL(web).host : "";
  if (host.includes("github")) return "github";
  if (host.includes("gitlab")) return "gitlab";
  return undefined;
}

/** A page of the repository on its forge: commit/<sha>, compare/<a>...<b>. */
function forgeLink(remote: string | undefined, path: string): string | undefined {
  const web = webUrl(remote);
  const f = detectForge(remote);
  return web && f ? `${web}${f === "gitlab" ? "/-" : ""}/${path}` : undefined;
}

export const commitUrl = (remote: string | undefined, sha: string) => forgeLink(remote, `commit/${sha}`);
export const compareUrl = (remote: string | undefined, from: string, to: string) => forgeLink(remote, `compare/${from}...${to}`);

/** How a release's source was taken: shown next to its commit. */
export const SOURCE_LABEL: Record<string, string> = { local: "working tree", ref: "clean export", server: "server fetch", ci: "CI", auto: "auto-deploy" };

/**
 * A release's git, in the parts every view shows: its name (the tag, else the commit), what goes beside it
 * (the commit of a tag, else the branch), and how it was taken (no label for the working tree, the default).
 * `len` shortens the commit: the CLI shows 12 characters, the web page 7.
 */
export function gitParts(g: ReleaseGit, len = 12) {
  const commit = g.commit.slice(0, len);
  return {
    name: g.tag ?? commit,
    beside: g.tag ? commit : g.branch,
    dirty: !!g.dirty,
    source: g.source && g.source !== "local" ? (SOURCE_LABEL[g.source] ?? g.source) : undefined,
  };
}

/** Two rules allow the same refs and checks: glob order does not count, a glob alone equals a list of one. */
export function sameRule(a: RefRule | undefined, b: RefRule | undefined): boolean {
  if (!hasRule(a) || !hasRule(b)) return hasRule(a) === hasRule(b);
  const globs = (x: string | string[] | undefined) => [...list(x)].sort().join("\n");
  return globs(a.branch) === globs(b.branch) && globs(a.tag) === globs(b.tag) && !!a.prerelease === !!b.prerelease && !!a.requireClean === !!b.requireClean;
}
