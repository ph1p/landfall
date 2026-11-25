import { createHash } from "node:crypto";
import { isScalar, isSeq, parseDocument, Scalar } from "yaml";
import type { Server } from "./config";
import { shq } from "./quote";
import { runScript, writeFileCmd } from "./ssh";
import { SUDO_PROBE } from "./stats";
import { PRELUDE, PROXY_FILE, PROXY_PRELUDE } from "./templates";
import { ACCESS_LOG_FLAGS, type AccessLog, type ProxyLog } from "./traffic-merge";

/**
 * Shell, after `P=<proxy container>`: the container's access log flags (`AL`) and how many flags it has (`AF`),
 * its TRAEFIK_ACCESSLOG* and TRAEFIK_CONFIGFILE variables (`AE`) and how many TRAEFIK_ ones it has (`AN`),
 * a mounted traefik.yml/.toml (`AM`), and Docker's log for it: driver (`LD`), size cap (`LO`) and file (`LP`).
 * Only these leave the server: other flags and variables can hold secrets.
 */
export const ACCESS_LOG_SH = String.raw`docker inspect -f '{{range .Args}}A {{println .}}{{end}}{{range .Config.Env}}E {{println .}}{{end}}{{range .Mounts}}M {{println .Destination}}{{end}}{{with .HostConfig.LogConfig}}D {{println .Type}}{{range $k, $v := .Config}}O {{$k}}={{println $v}}{{end}}{{end}}P {{println .LogPath}}' "$P" 2>/dev/null | awk '
{ k = substr($0, 1, 2); v = substr($0, 3) }
k == "D " { print "LD\t" v }
k == "O " && v ~ /^max-(size|file)=/ { print "LO\t" v }
k == "P " && v != "" { print "LP\t" v }
k == "A " && v ~ /^-/ { nf++ }
k == "A " && tolower(v) ~ /^--?(accesslog|configfile)([.=]|$)/ { print "AL\t" v }
k == "E " && v ~ /^TRAEFIK_/ { ne++ }
k == "E " && v ~ /^TRAEFIK_(ACCESSLOG|CONFIGFILE)/ { print "AE\t" v }
k == "M " && tolower(v) ~ /(^|\/)traefik\.(ya?ml|toml)$/ { print "AM\t" v }
END { print "AF\t" nf + 0; print "AN\t" ne + 0 }'`;

/** ACCESS_LOG_SH's lines, then the size in KiB of the log file (`LS`), rotated files included, when `$S` can read it. */
export const ACCESS_LOG_READ = String.raw`al=$(${ACCESS_LOG_SH}); printf '%s
' "$al"
lp=$(printf '%s
' "$al" | awk -F'	' '$1 == "LP" { print $2 }')
[ -z "$lp" ] || printf 'LS	%s
' "$($S sh -c '[ -r "$1" ] && du -kc "$1" "$1".* 2>/dev/null | tail -n 1 | cut -f1' sh "$lp")"`;

/** `--accesslog.format=json` → ["accesslog.format", "json"]; `TRAEFIK_ACCESSLOG_FORMAT=json` the same. */
export function setting(s: string, env: boolean): [string, string] {
  const i = s.indexOf("=");
  const k = (i < 0 ? s : s.slice(0, i)).toLowerCase();
  return [env ? k.replace(/^traefik_/, "").replace(/_/g, ".") : k.replace(/^-+/, ""), i < 0 ? "" : s.slice(i + 1)];
}

/**
 * The access log from ACCESS_LOG_SH's lines. Traefik takes its static config from one source: a config file
 * when there is one, else its flags, else its TRAEFIK_ variables. A file landfall cannot read is "unknown".
 */
export function parseAccessLog(out: string): AccessLog {
  const flags = new Map<string, string>();
  const env = new Map<string, string>();
  let flagCount = 0;
  let envCount = 0;
  let mounted = false;
  for (const line of out.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const kind = line.slice(0, tab);
    const rest = line.slice(tab + 1);
    if (kind === "AL") flags.set(...setting(rest, false));
    else if (kind === "AE") env.set(...setting(rest, true));
    else if (kind === "AF") flagCount = Number(rest) || 0;
    else if (kind === "AN") envCount = Number(rest) || 0;
    else if (kind === "AM") mounted = true;
  }
  const src = flagCount ? flags : envCount ? env : undefined;
  if (mounted || !src || src.has("configfile")) return "unknown";
  if (src.get("accesslog")?.toLowerCase() === "false") return "off";
  if (![...src.keys()].some((k) => k === "accesslog" || k.startsWith("accesslog."))) return "off";
  const path = src.get("accesslog.filepath");
  if (path && !/^\/(dev\/stdout|proc\/self\/fd\/1)$/.test(path)) return "file";
  return src.get("accesslog.format")?.toLowerCase() === "json" ? "json" : "common";
}

/** The proxy's Docker log from ACCESS_LOG_SH's lines, and its size in KiB (`LS`) when the script read it. */
export function parseProxyLog(out: string): ProxyLog | undefined {
  const get = (k: string) => [...out.matchAll(new RegExp(`^${k}\\t(.*)$`, "gm"))].map((m) => m[1]);
  const driver = get("LD")[0];
  if (!driver) return undefined;
  const opts = new Map(get("LO").map((o) => [o.slice(0, o.indexOf("=")), o.slice(o.indexOf("=") + 1)]));
  const kib = get("LS")[0];
  const maxFile = Number(opts.get("max-file"));
  return {
    driver,
    ...(opts.get("max-size") && { maxSize: opts.get("max-size") }),
    ...(maxFile > 0 && { maxFile }),
    ...(kib && /^\d+$/.test(kib) && { bytes: Number(kib) * 1024 }),
  };
}

const isAccessLog = (k: string) => k === "accesslog" || k.startsWith("accesslog.");

/**
 * The compose file with `add` appended to the block list at `path` (a service's command or volumes). Only new lines
 * are inserted, after the last item and in its indent and quoting: comments and formatting stay byte for byte.
 * `what` names the list in errors.
 */
export function appendItems(text: string, path: string[], add: string[], what: string): { text: string } | { error: string } {
  if (!add.length) return { text };
  const seq = parseDocument(text).getIn(path, true);
  if (!isSeq(seq) || seq.flow || !seq.items.length || !seq.items.every(isScalar)) return { error: `${what} is not a list, one item per line` };
  const items = seq.items as Scalar[];
  const last = items[items.length - 1];
  const [start, end] = last.range!;
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const prefix = text.slice(lineStart, start);
  if (!/^[ \t]*-[ \t]+$/.test(prefix)) return { error: `${what} is not a list, one item per line` };
  const nl = text.indexOf("\n", end);
  const at = nl < 0 ? text.length : text[nl - 1] === "\r" ? nl - 1 : nl;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const quote = last.type === Scalar.QUOTE_DOUBLE ? '"' : last.type === Scalar.QUOTE_SINGLE ? "'" : "";
  const next = text.slice(0, at) + add.map((f) => `${eol}${prefix}${quote}${f}${quote}`).join("") + text.slice(at);
  // The new file must say what we meant: the old list plus the new items, nothing else.
  const check = parseDocument(next).getIn(path);
  const want = [...items.map((x) => String(x.value)), ...add];
  if (!isSeq(check) || JSON.stringify(check.toJSON()) !== JSON.stringify(want)) return { error: `landfall could not add to ${what} safely` };
  return { text: next };
}

/** The flags of `service`'s command, one scalar per line, or why it has none landfall can edit. */
export function commandOf(text: string, service: string): { items: Scalar[] } | { error: string } {
  const doc = parseDocument(text);
  if (doc.errors.length) return { error: `it is not valid YAML (${doc.errors[0].message.split("\n")[0]})` };
  if (!doc.hasIn(["services", service])) return { error: `it has no service ${service}` };
  const cmd = doc.getIn(["services", service, "command"], true);
  if (cmd === undefined) return { error: `${service} has no command: its traefik is configured by a file` };
  if (!isSeq(cmd) || cmd.flow || !cmd.items.every(isScalar)) return { error: `the command of ${service} is not a list of flags, one per line` };
  return { items: cmd.items as Scalar[] };
}

/**
 * The compose file with ACCESS_LOG_FLAGS added to `service`'s command list. Only new lines are inserted, after the
 * last item and in its indent and quoting: comments and formatting stay byte for byte. An error says why not.
 */
export function withAccessLog(text: string, service: string): { text: string; added: string[] } | { error: string } {
  const cmd = commandOf(text, service);
  if ("error" in cmd) return cmd;
  const set = new Map(cmd.items.map((x) => setting(String(x.value), false)));
  const clash = [...set].find(
    ([k, v]) => (k === "accesslog" && v.toLowerCase() === "false") || k === "accesslog.filepath" || (k === "accesslog.format" && v.toLowerCase() !== "json"),
  );
  if (clash) return { error: `its command already sets --${clash[0]}=${clash[1]}` };
  const added = ACCESS_LOG_FLAGS.filter((f) => !set.has(setting(f, false)[0]));
  const r = appendItems(text, ["services", service, "command"], added, `the command of ${service}`);
  return "error" in r ? r : { text: r.text, added };
}

/**
 * The compose file without `service`'s --accesslog flags. Only their lines go: everything else stays byte for byte.
 * An error says why not, for example when the log is set by variables or a config file.
 */
export function withoutAccessLog(text: string, service: string): { text: string; removed: string[] } | { error: string } {
  const cmd = commandOf(text, service);
  if ("error" in cmd) return cmd;
  const items = cmd.items;
  const drop = items.filter((x) => isAccessLog(setting(String(x.value), false)[0]));
  const removed = drop.map((x) => String(x.value));
  if (!drop.length) return { text, removed };
  if (drop.length === items.length) return { error: `the command of ${service} would be empty` };
  let next = text;
  for (const x of [...drop].reverse()) {
    const [start, end] = x.range!;
    const lineStart = next.lastIndexOf("\n", start - 1) + 1;
    if (!/^[ \t]*-[ \t]+$/.test(next.slice(lineStart, start))) return { error: `the command of ${service} is not a list of flags, one per line` };
    const nl = next.indexOf("\n", end);
    next = next.slice(0, lineStart) + (nl < 0 ? "" : next.slice(nl + 1));
  }
  // The new file must say what we meant: the old command without the flags, nothing else.
  const check = parseDocument(next).getIn(["services", service, "command"]);
  const want = items.filter((x) => !drop.includes(x)).map((x) => String(x.value));
  if (!isSeq(check) || JSON.stringify(check.toJSON()) !== JSON.stringify(want)) return { error: `landfall could not remove the flags from ${service} safely` };
  return { text: next, removed };
}

/** The proxy container and, when Docker Compose started it, the compose file it came from. */
export interface ProxyCompose {
  container: string;
  /** Your own Traefik (lf traefik use), not landfall's. */
  own: boolean;
  /** The login is root or may sudo without a password. */
  root: boolean;
  accessLog: AccessLog;
  /** Docker's log of the proxy, with its size when the login can read it. */
  log?: ProxyLog;
  /** From the container's compose labels; missing when it was not started by compose. */
  files: string[];
  dir?: string;
  project?: string;
  service?: string;
  /** The compose file, when there is exactly one. */
  text?: string;
  sha256?: string;
}

const label = (labels: Record<string, string>, k: string) => labels[`com.docker.compose.${k}`] || undefined;

/** Reads the proxy container's compose labels, access log flags and compose file; undefined without a proxy. */
export async function readProxyCompose(server: Server): Promise<ProxyCompose | undefined> {
  const { stdout } = await runScript(
    server,
    `${PRELUDE}
${PROXY_PRELUDE}
[ ! -f ${PROXY_FILE} ] || echo OWN
${SUDO_PROBE}
{ [ -z "$SUDO" ] || [ -n "$S" ]; } && echo ROOT
printf 'CTR\\t%s\\n' "$P"
{ read -r l; read -r f; } < <(docker inspect -f '{{json .Config.Labels}}{{println}}{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$P")
printf 'LABELS\\t%s\\n' "$l"
${ACCESS_LOG_READ}
case "$f" in
  ""|*,*) ;;
  *) d=$(dirname "$f"); if y=$(_as "$d" cat "$f" 2>/dev/null | base64 | tr -d '\\n'); then printf 'YAML\\t%s\\n' "$y"; fi ;;
esac`,
    { capture: true },
  );
  if (/^NOPROXY$/m.test(stdout)) return undefined;
  const get = (k: string) => stdout.match(new RegExp(`^${k}\\t(.*)$`, "m"))?.[1];
  let labels: Record<string, string> = {};
  try {
    labels = JSON.parse(get("LABELS") || "{}") ?? {};
  } catch {}
  const yaml = get("YAML");
  const buf = yaml === undefined ? undefined : Buffer.from(yaml, "base64");
  return {
    container: get("CTR") ?? "traefik",
    own: /^OWN$/m.test(stdout),
    root: /^ROOT$/m.test(stdout),
    accessLog: parseAccessLog(stdout),
    log: parseProxyLog(stdout),
    files: (label(labels, "project.config_files") ?? "").split(",").filter(Boolean),
    dir: label(labels, "project.working_dir"),
    project: label(labels, "project"),
    service: label(labels, "service"),
    ...(buf && { text: buf.toString("utf8"), sha256: createHash("sha256").update(buf).digest("hex") }),
  };
}

/** What `lf traefik access-log --json` prints: the proxy, its access log and Docker's log of it. */
export const accessLogStatus = (p: ProxyCompose) => ({ container: p.container, own: p.own, accessLog: p.accessLog, log: p.log ?? null });

/** Where your own Traefik's compose service lives, as read: what landfall needs to rewrite it and recreate the proxy. */
export interface ComposeTarget {
  container: string;
  project: string;
  dir: string;
  service: string;
  file: string;
  /** Of the file as read: writing refuses when it changed since. */
  sha256: string;
  /** The file as read. */
  text: string;
}

/** The proxy's compose file landfall may rewrite, or why it cannot. */
export function composeTarget(p: ProxyCompose): ComposeTarget | { error: string } {
  const { container, project, dir, service, files, text, sha256 } = p;
  if (!files.length || !project || !service || !dir) return { error: `${container} was not started by Docker Compose` };
  if (files.length > 1) return { error: `${container} comes from several compose files (${files.join(", ")})` };
  const file = files[0];
  if (text === undefined || sha256 === undefined)
    return { error: p.root ? `${file} is not on the server (was ${container} started from another machine?)` : `${file} needs root to read` };
  return { container, project, dir, service, file, sha256, text };
}

/** The compose file `lf traefik access-log on|off` writes, and what it needs to recreate the proxy from it. */
export interface AccessLogPlan extends ComposeTarget {
  on: boolean;
  /** The flags added (on) or removed (off); empty when there is nothing to change. */
  changed: string[];
}

/** What `lf traefik access-log on|off` would write to your own Traefik's compose file, or why it cannot. */
export function planAccessLog(p: ProxyCompose, on = true): AccessLogPlan | { error: string } {
  const t = composeTarget(p);
  if ("error" in t) return t;
  const r = on ? withAccessLog(t.text, t.service) : withoutAccessLog(t.text, t.service);
  if ("error" in r) return { error: `${t.file}: ${r.error}` };
  const changed = "added" in r ? r.added : r.removed;
  // Off, but the log comes from variables or a config file: removing no flags would change nothing.
  if (!on && !changed.length && p.accessLog !== "off") return { error: `${t.file}: the access log of ${t.service} is not set by flags in its command` };
  return { ...t, on, text: r.text, changed };
}

/** Shell: recreate the proxy's compose service, with sudo when the compose file is not readable. */
export const composeUp = (p: Omit<ComposeTarget, "sha256" | "text" | "container">) => {
  const args = `-p ${shq(p.project)} --project-directory ${shq(p.dir)} -f ${shq(p.file)} up -d ${shq(p.service)}`;
  return `if [ -r ${shq(p.file)} ]; then dc ${args}; else $SUDO docker compose ${args}; fi`;
};

/** Shell: write `text` over the compose file at `$f` (dir `$d`) only if it did not change since landfall read it; `$u` restores it. */
export const rewriteCompose = (t: { file: string; sha256: string; text: string }) => `f=${shq(t.file)}; d=$(dirname "$f")
[ "$(_as "$d" sha256sum "$f" | cut -d' ' -f1)" = ${shq(t.sha256)} ] || { echo "$f changed since landfall read it; run the command again" >&2; exit 1; }
read -r m o < <(_as "$d" stat -c '%a %u:%g' "$f")
u=$(saved "$f")
${writeFileCmd(t.file, t.text, '"$m"')}
_as "$d" chown "$o" "$f" 2>/dev/null || true`;

/** Writes the planned compose file (only if it did not change since it was read), journals it, recreates the proxy. */
export async function writeAccessLog(server: Server, plan: AccessLogPlan) {
  const up = composeUp(plan);
  await runScript(
    server,
    `${PRELUDE}
${rewriteCompose(plan)}
record ${shq(`turned ${plan.on ? "on the JSON" : "off the"} access log of traefik ${plan.container} (${plan.file})`)} "$u"${shq(` && ${up}`)}
log ${shq(`recreating ${plan.container}`)}
${up}
sleep 2 # traefik exits shortly after start on a bad config
ensure_running ${shq(plan.container)}`,
  );
}

/** Empties the proxy container's log file (json-file driver only): the requests landfall counts start again. */
export async function clearProxyLog(server: Server, container: string) {
  await runScript(
    server,
    `${PRELUDE}
IFS=$'\\t' read -r t p < <(docker inspect -f '{{.HostConfig.LogConfig.Type}}{{"\\t"}}{{.LogPath}}' ${shq(container)})
[ "$t" = json-file ] && [ -n "$p" ] || { echo ${shq(`${container} keeps no log file landfall can empty`)} "(log driver $t)" >&2; exit 1; }
$SUDO sh -c ': > "$1" && rm -f "$1".*' sh "$p"
record ${shq(`emptied the log of traefik ${container}`)}`,
  );
}
