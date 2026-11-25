import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import tls from "node:tls";
import { isSeq, parse, parseDocument } from "yaml";
import { appendItems, commandOf, composeTarget, composeUp, rewriteCompose, setting, type ComposeTarget, type ProxyCompose } from "./accesslog";
import type { Server } from "./config";
import { shq } from "./quote";
import { runScript, writeFileCmd } from "./ssh";
import { effectiveSsh } from "./sshconfig";
import { PRELUDE } from "./templates";

/**
 * How the proxy answers HTTPS for a hostname no site serves: it refuses the handshake (`sniStrict`), sends Traefik's
 * self-signed default certificate (browsers warn), sends another certificate, or could not be reached from here.
 */
export type UnknownHosts = "refused" | "default-cert" | "cert" | "unreachable";
export interface UnknownHostsCheck {
  state: UnknownHosts;
  /** The certificate's CN, when one was sent. */
  subject?: string;
  /** Why the proxy could not be reached. */
  error?: string;
}

/** The CN of the certificate Traefik sends when none matches and sniStrict is off. */
export const DEFAULT_CERT = "TRAEFIK DEFAULT CERT";

/** Connects to `addr`:443 with a made-up hostname and reports what Traefik answers. */
export function checkUnknownHosts(addr: string, o: { port?: number; timeout?: number } = {}): Promise<UnknownHostsCheck> {
  const servername = `landfall-check-${randomBytes(4).toString("hex")}.invalid`;
  return new Promise((done) => {
    const sock = tls.connect({ host: addr, port: o.port ?? 443, servername, rejectUnauthorized: false, timeout: o.timeout ?? 8000 });
    sock.once("secureConnect", () => {
      const cn = sock.getPeerCertificate()?.subject?.CN;
      const subject = Array.isArray(cn) ? cn[0] : cn;
      sock.destroy();
      done({ state: subject === DEFAULT_CERT ? "default-cert" : "cert", ...(subject && { subject }) });
    });
    sock.once("timeout", () => sock.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })));
    // A TLS alert (sniStrict sends "unrecognized name") means Traefik refused; anything else means it was not reached.
    sock.once("error", (e: any) => {
      const code = String(e?.code ?? e?.message ?? e);
      done(code.startsWith("ERR_SSL_") ? { state: "refused" } : { state: "unreachable", error: code });
    });
  });
}

/** Probes the server's address as ssh resolves it. */
export const unknownHostsOf = (server: Server) => checkUnknownHosts(effectiveSsh(server).hostname);

/** What to tell someone whose Traefik sends its default certificate. */
export const DEFAULT_CERT_HINT = `hostnames no site serves get traefik's self-signed default certificate, so browsers show a certificate warning`;

/** Where `lf traefik strict-tls on` mounts a new file provider folder in your own Traefik. */
export const PROVIDER_DIR = "/etc/traefik/dynamic";
/** The file landfall writes into the provider folder; `off` removes only this one. */
export const STRICT_FILE = "landfall-tls.yml";
export const STRICT_TLS_FILE = `# written by landfall (lf traefik strict-tls on); lf traefik strict-tls off removes it
tls:
  options:
    default:
      # Refuse the handshake for a name no certificate covers: no TRAEFIK DEFAULT CERT, no certificate warning.
      sniStrict: true
`;

/** The folder your own Traefik reads dynamic config from (its file provider), or what to add to get one. */
export interface FileProvider {
  /** The folder on the server. */
  hostDir: string;
  /** The same folder in the container. */
  containerDir: string;
  /** Traefik reloads files there by itself; without watch it needs a restart. */
  watch: boolean;
  /** No file provider yet: these flags and, when no volume is there, this volume go into the compose service. */
  add?: { flags: string[]; volume?: string };
}

/** A compose volume as source and target: `./dynamic:/etc/traefik/dynamic:ro`, or the long form. */
function volumeOf(v: unknown): { src: string; dst: string } | undefined {
  if (typeof v === "string") {
    const [src, dst] = v.split(":");
    return dst ? { src, dst } : undefined;
  }
  if (v && typeof v === "object" && "source" in v && "target" in v) return { src: String(v.source), dst: String(v.target) };
  return undefined;
}

/** Where `service`'s file provider reads from, from its compose file in `dir`, or why landfall cannot add one. */
export function fileProvider(text: string, service: string, dir: string): FileProvider | { error: string } {
  const cmd = commandOf(text, service);
  if ("error" in cmd) return cmd;
  const flags = new Map(cmd.items.map((x) => setting(String(x.value), false)));
  if (flags.has("configfile")) return { error: `its command sets --configfile=${flags.get("configfile")}: traefik reads that file, not its flags` };
  if (flags.has("providers.file.filename"))
    return { error: `it reads its dynamic config from one file (${flags.get("providers.file.filename")}): set tls.options.default.sniStrict there` };
  const doc = parseDocument(text);
  const raw = doc.getIn(["services", service, "volumes"], true);
  const vols = isSeq(raw) ? (raw.toJSON() as unknown[]).map(volumeOf).filter((v) => !!v) : [];
  const file = vols.find((v) => /(^|\/)traefik\.(ya?ml|toml)$/.test(v.dst));
  if (file) return { error: `it mounts ${file.dst}: traefik reads that file, not its flags` };
  const at = (d: string) => vols.filter((v) => d === v.dst || d.startsWith(`${v.dst.replace(/\/$/, "")}/`)).sort((a, b) => b.dst.length - a.dst.length)[0];
  const host = (v: { src: string; dst: string }, d: string) => posix.join(posix.resolve(dir, v.src), posix.relative(v.dst, d));
  const named = (v: { src: string }) => !/^[./~]/.test(v.src);
  const directory = flags.get("providers.file.directory");
  if (directory !== undefined) {
    const v = at(directory);
    if (!v) return { error: `--providers.file.directory=${directory} is not a folder mounted from the server` };
    if (named(v)) return { error: `--providers.file.directory=${directory} is in the docker volume ${v.src}, not a folder on the server` };
    const w = flags.get("providers.file.watch");
    return { hostDir: host(v, directory), containerDir: directory, watch: w !== undefined && w.toLowerCase() !== "false" };
  }
  const flagsToAdd = [`--providers.file.directory=${PROVIDER_DIR}`, "--providers.file.watch=true"];
  const v = vols.find((x) => x.dst.replace(/\/$/, "") === PROVIDER_DIR);
  if (v) {
    if (named(v)) return { error: `${PROVIDER_DIR} is the docker volume ${v.src}, not a folder on the server` };
    return { hostDir: host(v, PROVIDER_DIR), containerDir: PROVIDER_DIR, watch: true, add: { flags: flagsToAdd } };
  }
  if (!isSeq(raw)) return { error: `${service} has no volumes list to mount ${PROVIDER_DIR} with` };
  return { hostDir: posix.join(dir, "dynamic"), containerDir: PROVIDER_DIR, watch: true, add: { flags: flagsToAdd, volume: `./dynamic:${PROVIDER_DIR}:ro` } };
}

/** The provider folder on the server: whether it exists, how many entries it has, its YAML and TOML files. */
export interface DynamicDir {
  exists: boolean;
  entries: number;
  files: { name: string; text: string }[];
}

/** Reads the provider folder (as root when needed): its config files, 64 KiB of each at most. */
export async function readDynamicDir(server: Server, hostDir: string): Promise<DynamicDir> {
  const { stdout } = await runScript(
    server,
    `${PRELUDE}
h=${shq(hostDir)}
_as "$(dirname "$h")" test -d "$h" || { echo NODIR; exit 0; }
printf 'N\\t%s\\n' "$(_as "$h" ls -A "$h" | wc -l)"
_as "$h" find "$h" -maxdepth 1 -type f \\( -name '*.yml' -o -name '*.yaml' -o -name '*.toml' \\) | while IFS= read -r f; do
  printf 'F\\t%s\\t%s\\n' "$(basename "$f")" "$(_as "$h" head -c 65536 "$f" | base64 | tr -d '\\n')"
done`,
    { capture: true },
  );
  if (/^NODIR$/m.test(stdout)) return { exists: false, entries: 0, files: [] };
  const entries = Number(stdout.match(/^N\t\s*(\d+)/m)?.[1] ?? 0);
  const files = [...stdout.matchAll(/^F\t([^\t]+)\t(.*)$/gm)].map((m) => ({ name: m[1], text: Buffer.from(m[2], "base64").toString("utf8") }));
  return { exists: true, entries, files };
}

/** The file in the folder that sets tls.options.default, and whether it turns sniStrict on. */
export function tlsDefaultIn(files: DynamicDir["files"]): { name: string; strict: boolean } | undefined {
  for (const f of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    if (f.name.endsWith(".toml")) {
      if (/^\s*\[\s*tls\.options\.default\s*\]/m.test(f.text)) return { name: f.name, strict: /^\s*sniStrict\s*=\s*true\b/im.test(f.text) };
      continue;
    }
    let y: any;
    try {
      y = parse(f.text);
    } catch {
      continue;
    }
    const d = y?.tls?.options?.default;
    if (d !== undefined) return { name: f.name, strict: d?.sniStrict === true };
  }
  return undefined;
}

/** What `lf traefik strict-tls on|off` changes on your own Traefik. */
export interface StrictTlsPlan extends ComposeTarget {
  on: boolean;
  provider: FileProvider;
  /** The file landfall writes (on) or removes (off). */
  path: string;
  /** The new compose file, when the file provider is added to it. */
  compose?: string;
  /** recreate: the compose file changed; restart: the folder is not watched. */
  reload: "recreate" | "restart" | "none";
}

/** What `lf traefik strict-tls on|off` would change, `{ already }` when nothing, or why it cannot. */
export function planStrictTls(p: ProxyCompose, prov: FileProvider, dir: DynamicDir, on: boolean): StrictTlsPlan | { already: string } | { error: string } {
  const t = composeTarget(p);
  if ("error" in t) return t;
  const path = posix.join(prov.hostDir, STRICT_FILE);
  const def = tlsDefaultIn(dir.files);
  const ours = dir.files.some((f) => f.name === STRICT_FILE);
  const reloadFile = prov.watch ? "none" : "restart";
  if (!on) {
    if (ours && !prov.add) return { ...t, on, provider: prov, path, reload: reloadFile };
    if (def?.strict) return { error: `sniStrict is set in ${posix.join(prov.hostDir, def.name)}, not by landfall: remove it there` };
    return { already: `${p.container} has no sniStrict from landfall` };
  }
  if (def?.strict) return { already: `${posix.join(prov.hostDir, def.name)} already sets sniStrict` };
  if (def) return { error: `${posix.join(prov.hostDir, def.name)} sets tls.options.default without sniStrict: add sniStrict: true there` };
  if (prov.add?.volume && dir.entries > 0)
    return { error: `${prov.hostDir} exists and is not mounted into ${p.container}: mount it and point --providers.file.directory at it, or move it away` };
  if (!prov.add) return { ...t, on, provider: prov, path, reload: reloadFile };
  const svc = ["services", t.service];
  let r = appendItems(t.text, [...svc, "command"], prov.add.flags, `the command of ${t.service}`);
  if (!("error" in r) && prov.add.volume) r = appendItems(r.text, [...svc, "volumes"], [prov.add.volume], `the volumes of ${t.service}`);
  if ("error" in r) return { error: `${t.file}: ${r.error}` };
  return { ...t, on, provider: prov, path, compose: r.text, reload: "recreate" };
}

/** Writes or removes landfall's sniStrict file, adds the file provider to the compose file if planned, reloads Traefik. */
export async function writeStrictTls(server: Server, plan: StrictTlsPlan) {
  const up = plan.reload === "recreate" ? composeUp(plan) : plan.reload === "restart" ? `docker restart ${shq(plan.container)} >/dev/null` : "";
  const what = plan.on
    ? `traefik ${plan.container} refuses unknown hosts (${plan.path})`
    : `traefik ${plan.container} answers unknown hosts again (${plan.path})`;
  await runScript(
    server,
    `${PRELUDE}
h=${shq(plan.provider.hostDir)}; t=${shq(plan.path)}
${plan.on ? `_as "$(dirname "$h")" mkdir -p "$h"` : ""}
v=$(saved "$t")
${plan.on ? writeFileCmd(plan.path, STRICT_TLS_FILE) : `_as "$h" rm -f "$t"`}
${plan.compose === undefined ? "undo=$v" : `${rewriteCompose({ ...plan, text: plan.compose })}\nundo="$u && $v"`}
record ${shq(what)} "$undo"${up ? shq(` && ${up}`) : ""}
${
  up
    ? `log ${shq(`${plan.reload === "recreate" ? "recreating" : "restarting"} ${plan.container}`)}
${up}
sleep 2 # traefik exits shortly after start on a bad config
ensure_running ${shq(plan.container)}`
    : ""
}`,
  );
}
