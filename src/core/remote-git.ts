// A repository the server fetches itself (deploy --git, lf git key): its URL, deploy key and bare mirror under
// /opt/landfall/repos/<id>. git runs on the server; this machine gets only a copy of the commit it deploys.
import { fail } from "./fail";
import { parseRefLines, REF_FORMAT } from "./git";
import { shq } from "./quote";
import type { Ref } from "./refs";
import { PRELUDE, ROOT } from "./templates";

export interface GitUrl {
  /** What git fetches: gh:/gl: written out, nothing else changed. */
  url: string;
  /** The part after #: a branch, tag or commit. */
  ref?: string;
  /** github.com, gitlab.example.com; undefined for a path on the server. */
  host?: string;
  /** The repository's path at the host, without .git: acme/shop. */
  path: string;
}

/**
 * A git URL as deploy --git and lf git key take it, with an optional #ref: git@host:o/r.git, ssh://, https://,
 * file:// or an absolute path on the server, gh:o/r and gl:g/r. A password or token in it is refused: the server
 * fetches with a deploy key.
 */
export function parseGitUrl(input: string): GitUrl {
  const raw = input.trim();
  const hash = raw.lastIndexOf("#");
  const ref = hash >= 0 ? raw.slice(hash + 1) || undefined : undefined;
  let url = hash >= 0 ? raw.slice(0, hash) : raw;
  // eslint-disable-next-line no-control-regex
  if (!url || url.startsWith("-") || /[\s\x00-\x1f]/.test(url)) fail(`not a git URL: ${input}`);
  if (ref && (ref.startsWith("-") || /[\s\x00-\x1f~^:?*[\\]/.test(ref))) fail(`not a branch, tag or commit: ${ref}`);
  const short = /^(gh|gl):([\w.-]+(?:\/[\w.-]+)+?)(?:\.git)?$/.exec(url);
  if (short) url = `git@${short[1] === "gh" ? "github.com" : "gitlab.com"}:${short[2]}.git`;
  const bare = (p: string) => p.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  if (url.startsWith("/")) return { url, ...(ref && { ref }), path: bare(url) };
  const proto = /^(ssh|git|https?|file):\/\/(?:([^@/]*)@)?([^/:]*)(?::\d+)?(\/.*)?$/.exec(url);
  if (proto) {
    const [, scheme, user, host, path = ""] = proto;
    if (user !== undefined && scheme.startsWith("http"))
      fail(`${safe(url)} holds a login: the server fetches with a deploy key (lf git key), not a password or token`);
    if (scheme === "file") return { url, ...(ref && { ref }), path: bare(path) };
    if (!host || !bare(path)) fail(`not a git URL: ${input}`);
    return { url, ...(ref && { ref }), host: host.toLowerCase(), path: bare(path) };
  }
  const scp = /^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)(.+)$/.exec(url);
  if (scp && bare(scp[2])) return { url, ...(ref && { ref }), host: scp[1].toLowerCase(), path: bare(scp[2]) };
  return fail(`not a git URL: ${input} (git@host:owner/repo.git, https://…, ssh://…, gh:owner/repo or a path on the server)`);
}

const safe = (url: string) => url.replace(/^(https?:\/\/)[^@/]+@/, "$1");

/** The forge whose CLI (gh, glab) can add a deploy key. */
export const forgeOf = (g: GitUrl): "github" | "gitlab" | undefined => (g.host === "github.com" ? "github" : g.host === "gitlab.com" ? "gitlab" : undefined);

/** The repository's folder name on the server: github.com-acme-shop; local-srv-git-shop for a path there. */
export function repoId(g: GitUrl): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9.]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "");
  return g.host ? `${slug(g.host)}-${slug(g.path)}` : `local-${slug(g.path)}`;
}

/** The repository's name, for a site that has none: shop. */
export const repoName = (g: GitUrl) => g.path.split("/").pop()!;

export const repoDir = (g: GitUrl) => `${ROOT}/repos/${repoId(g)}`;
export const mirrorDir = (g: GitUrl) => `${repoDir(g)}/mirror.git`;

/** github.com's and gitlab.com's host keys: their first fetch trusts nothing it is told. Other hosts are trusted on first use. */
const KNOWN_HOSTS = [
  "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
  "gitlab.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAfuCHKVTjquxvt6CM6tdG4SLp1Btn/nOeHHE5UOzRdf",
];

/** The shell every script here starts with: $R the repository's folder, git installed, and ssh told which key and hosts to use. */
function head(g: GitUrl): string {
  return [
    PRELUDE,
    `R=${shq(repoDir(g))}`,
    `M="$R/mirror.git"`,
    `command -v git >/dev/null || { pkg_install git; record "installed git"; }`,
    `mkdir -p "$R"`,
    `[ -f "$R/known_hosts" ] || printf '%s\\n' ${KNOWN_HOSTS.map(shq).join(" ")} >"$R/known_hosts"`,
    `export GIT_TERMINAL_PROMPT=0`,
    `GIT_SSH_COMMAND="ssh -o BatchMode=yes -o UserKnownHostsFile=$R/known_hosts -o StrictHostKeyChecking=accept-new"`,
    `[ ! -f "$R/key" ] || GIT_SSH_COMMAND="$GIT_SSH_COMMAND -i $R/key -o IdentitiesOnly=yes"`,
    `export GIT_SSH_COMMAND`,
  ].join("\n");
}

/**
 * Fetches the repository into the server's bare mirror (made on first use, journaled) and prints its branches and
 * tags; with head, the remote's default branch; with sha, the commit an abbreviated hash names.
 */
export function fetchScript(g: GitUrl, o: { head?: boolean; sha?: string } = {}): string {
  const hint = g.host ? `: lf git key ${g.url} gives the server a deploy key` : "";
  return [
    head(g),
    `if [ ! -d "$M" ]; then`,
    `  git init -q --bare "$M"`,
    `  git --git-dir="$M" config remote.origin.url ${shq(g.url)}`,
    `  git --git-dir="$M" config --add remote.origin.fetch '+refs/heads/*:refs/heads/*'`,
    `  git --git-dir="$M" config --add remote.origin.fetch '+refs/tags/*:refs/tags/*'`,
    `  record ${shq(`git mirror of ${safe(g.url)}`)} ${shq(`rm -rf ${shq(mirrorDir(g))}`)}`,
    `else`,
    `  git --git-dir="$M" config remote.origin.url ${shq(g.url)}`,
    `fi`,
    // One fetch into the mirror at a time; the lock goes with the script.
    `exec 9>"$R/.lock"`,
    // BusyBox flock has no -w: timeout bounds the wait where it exists; the lock stays on fd 9 either way.
    `if command -v flock >/dev/null; then { if command -v timeout >/dev/null; then timeout 300 flock 9; else flock 9; fi; } || { echo ${shq(`another fetch of ${safe(g.url)} still runs`)} >&2; exit 1; }; fi`,
    `git --git-dir="$M" fetch -q --prune origin >&2 || { echo ${shq(`could not fetch ${safe(g.url)}${hint}`)} >&2; exit 1; }`,
    ...(o.head
      ? [`echo @@head`, `git --git-dir="$M" ls-remote --symref origin HEAD 2>/dev/null | sed -n 's|^ref: refs/heads/\\(.*\\)\tHEAD$|\\1|p' || true`]
      : []),
    ...(o.sha ? [`echo @@sha`, `git --git-dir="$M" rev-parse --verify -q ${shq(`${o.sha}^{commit}`)} || true`] : []),
    `echo @@refs`,
    `git --git-dir="$M" for-each-ref --format=${shq(REF_FORMAT)} refs/heads refs/tags`,
  ].join("\n");
}

export interface Fetched {
  refs: Ref[];
  /** The remote's default branch. */
  head?: string;
  /** The full hash of an abbreviated one. */
  sha?: string;
}

/** fetchScript's output. */
export function parseFetched(out: string): Fetched {
  const parts: Record<string, string> = {};
  let at = "";
  for (const line of out.split("\n")) {
    if (/^@@\w+$/.test(line)) at = line.slice(2);
    else if (at) parts[at] = (parts[at] ? parts[at] + "\n" : "") + line;
  }
  return {
    refs: parseRefLines(parts.refs),
    ...(parts.head?.trim() && { head: parts.head.trim() }),
    ...(parts.sha?.trim() && { sha: parts.sha.trim() }),
  };
}

/** The shell that streams a commit (or a folder of it) as tar on stdout. */
export const archiveCmd = (g: GitUrl, sha: string, sub = "") => `git --git-dir=${shq(mirrorDir(g))} archive --format=tar ${shq(sub ? `${sha}:${sub}` : sha)}`;

/**
 * A release's files from the mirror: the commit's folder unpacked into dir, then what the upload rules leave
 * out (exclude, .gitignore, …) removed, as an upload would not have sent it.
 */
export function unpackScript(g: GitUrl, sha: string, sub: string, dir: string, drop: string[]): string {
  return [
    `mkdir -p ${shq(dir)}`,
    `${archiveCmd(g, sha, sub)} | tar -xof - -C ${shq(dir)}`,
    ...(drop.length ? [`cd ${shq(dir)} && rm -rf -- ${drop.map((p) => shq(`./${p}`)).join(" ")}`] : []),
  ].join("\n");
}

/**
 * The server's deploy key for the repository: made once (ed25519, journaled), else left as it is. Prints
 * @@created when it made one, then the public key; never the private one.
 */
export function keyScript(g: GitUrl, comment: string): string {
  return [
    head(g),
    `if [ ! -f "$R/key" ]; then`,
    `  ssh-keygen -q -t ed25519 -N '' -C ${shq(comment)} -f "$R/key" >/dev/null`,
    `  chmod 600 "$R/key"`,
    `  record ${shq(`deploy key for ${safe(g.url)}`)} ${shq(`rm -f ${shq(`${repoDir(g)}/key`)} ${shq(`${repoDir(g)}/key.pub`)}`)}`,
    `  echo @@created`,
    `fi`,
    `cat "$R/key.pub"`,
  ].join("\n");
}

/** Removes the deploy key (and with it, the mirror's access). Cannot be undone: the private key is gone. */
export function keyRemoveScript(g: GitUrl): string {
  return [
    PRELUDE,
    `R=${shq(repoDir(g))}`,
    `[ -f "$R/key" ] || { echo ${shq(`no deploy key for ${safe(g.url)}`)} >&2; exit 0; }`,
    `rm -f "$R/key" "$R/key.pub"`,
    `record ${shq(`removed the deploy key for ${safe(g.url)}`)}`,
  ].join("\n");
}

/** Reads the public key, if the server has one: no change. */
export const keyReadScript = (g: GitUrl) => `cat ${shq(`${repoDir(g)}/key.pub`)} 2>/dev/null || true`;
