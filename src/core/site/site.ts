import { loadProject, type Server } from "../lib/config";
import { isSiteMeta, type SiteMeta } from "./meta";
import { onStop } from "../lib/job";
import { runScript, shq } from "../ssh/ssh";
import { OWN_PROXY, parseProxy, PROXY_FILE, SITES, TRAEFIK_DIR, type Proxy } from "../ssh/templates";
import { fail } from "../lib/term";

export const siteDir = (name: string) => `${SITES}/${name}`;

export const SITE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** Names of the sites on the server (folders with a site.json). */
export async function siteNames(s: Server): Promise<string[]> {
  const { stdout } = await runScript(s, `for f in ${SITES}/*/site.json; do [ ! -f "$f" ] || basename "$(dirname "$f")"; done`, { capture: true });
  return stdout.split("\n").filter(Boolean).sort();
}

/** Edit distance, for suggesting a site name close to a mistyped one. */
function distance(a: string, b: string) {
  let row = [...Array(b.length + 1).keys()];
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

/**
 * The error for a site name the server does not have: its sites, a close name, and the site ./.landfall.json
 * deploys when that one is there (`here`). argv: the command as typed, to repeat it with the right name.
 */
export function noSiteMessage(name: string, host: string, names: string[], here?: string, argv: string[] = []) {
  const close = names.filter((x) => x !== name && (x.includes(name) || name.includes(x) || distance(x, name) <= (name.length > 3 ? 2 : 1)));
  // ./.landfall.json counts only for a name typed on the command line, not one from lf ui.
  const pick = here && here !== name && names.includes(here) && argv.includes(name) ? here : close.length === 1 ? close[0] : undefined;
  const lines = [`no site ${name} on ${host}. ${names.length ? `Sites: ${names.join(", ")}` : "It has no sites yet (lf deploy)"}`];
  const again = pick && argv.includes(name) ? `lf ${argv.map((a) => (a === name ? pick : a)).join(" ")}` : "";
  if (pick && pick === here) lines.push(`this folder deploys as ${pick}${again && `: ${again}`}`);
  else if (pick) lines.push(`did you mean ${pick}?${again && ` ${again}`}`);
  return lines.join("\n");
}

/** Fails with noSiteMessage for `name` on the server. */
export async function noSite(s: Server, name: string): Promise<never> {
  const names = await siteNames(s).catch(() => []);
  let here: string | undefined;
  try {
    here = loadProject(process.cwd())?.name;
  } catch {}
  return fail(noSiteMessage(name, s.host, names, here, process.argv.slice(2)));
}

export function validName(name: string) {
  if (!SITE_NAME.test(name)) fail(`invalid site name "${name}" (use lowercase letters, digits, dashes)`);
  return name;
}

/** Between the parts of readSite's answer. */
export const SEP = "\n--8<--landfall--8<--\n";

/** Fetch site.json and .env of a site, and the Traefik it goes through, in one round trip. */
/** `routed`: a Traefik serves this server's sites (landfall's own, or one they were pointed at). Without one a domain answers nothing. */
export async function readSite(s: Server, name: string): Promise<{ meta?: SiteMeta; env: string; proxy: Proxy; exists: boolean; routed: boolean }> {
  const dir = siteDir(name);
  const { stdout } = await runScript(
    s,
    [
      ...[`${dir}/site.json`, `${dir}/.env`, PROXY_FILE].map((f) => `cat ${shq(f)} 2>/dev/null || true`),
      `[ ! -d ${shq(dir)} ] || echo 1`,
      `{ [ ! -f ${shq(PROXY_FILE)} ] && [ ! -f ${shq(`${TRAEFIK_DIR}/docker-compose.yml`)} ]; } || echo 1`,
    ].join(`; printf %s ${shq(SEP)}; `),
    { capture: true },
  );
  const [json, env = "", proxy = "", exists = "", routed = ""] = stdout.split(SEP);
  const meta = parseSiteMeta(s, name, json);
  return { meta, env, proxy: parseProxy(proxy) ?? OWN_PROXY, exists: exists.trim() === "1", routed: routed.trim() === "1" };
}

/** A site that exists and is a Compose project; `deployed` also refuses adopted ones (no releases). */
/** site.json's text as read from the server: undefined when empty, refused when corrupt. */
export function parseSiteMeta(s: Server, name: string, json: string): SiteMeta | undefined {
  if (!json.trim()) return undefined;
  let meta: unknown;
  try {
    meta = JSON.parse(json);
  } catch {}
  if (!isSiteMeta(meta)) return fail(`corrupt ${siteDir(name)}/site.json on ${s.host}`);
  return meta;
}

export async function requireSite(s: Server, name: string, o: { deployed?: string } = {}): Promise<{ meta: SiteMeta; env: string; proxy: Proxy }> {
  const site = await readSite(s, name);
  if (!site.meta) await noSite(s, name);
  const meta = site.meta!;
  if (o.deployed && meta.adopted) fail(`${name} is adopted (${meta.adopted}): landfall does not ${o.deployed} it; change its compose files there`);
  return site as { meta: SiteMeta; env: string; proxy: Proxy };
}

/**
 * Hold a site for one deploy: a second one at the same time would build into the same folder and switch
 * `current` under the first. A lock older than an hour is from a deploy that was cut off. Returns the
 * server's clock as a release id, so ids follow each other even when this machine's clock is off.
 */
/** fn on site.json as read under the deploy lock: a deploy or change in between would be lost on write. */
export async function withSite<T>(
  s: Server,
  name: string,
  o: { deployed?: string },
  fn: (site: { meta: SiteMeta; env: string; proxy: Proxy }) => Promise<T>,
): Promise<T> {
  const lock = await lockSite(s, name);
  try {
    return await fn(await requireSite(s, name, o));
  } finally {
    await lock.unlock();
  }
}

export async function lockSite(s: Server, name: string): Promise<{ now: string; unlock: () => Promise<void> }> {
  const lock = `${SITES}/.${validName(name)}.deploying`;
  const { stdout } = await runScript(
    s,
    [
      `mkdir -p ${SITES}`,
      `if ! mkdir ${shq(lock)} 2>/dev/null; then`,
      `  [ -n "$(find ${shq(lock)} -maxdepth 0 -mmin +60 2>/dev/null)" ] && { echo "taking over the lock of a cut-off run ($(cat ${shq(lock + "/by")} 2>/dev/null || echo unknown), over an hour old)" >&2; } && rm -rf ${shq(lock)} && mkdir ${shq(lock)} ||`,
      `  { echo "another deploy or change of "${shq(name)}" is running ($(cat ${shq(lock + "/by")} 2>/dev/null || echo unknown)): wait for it, or remove "${shq(lock)}" if it was cut off" >&2; exit 1; }`,
      `fi`,
      `printf '%s\\n' "$LANDFALL_ACTOR" >${shq(lock + "/by")}`,
      `date -u +%Y%m%d%H%M%S`,
    ].join("\n"),
    { capture: true },
  );
  const unlock = () => runScript(s, `rm -rf ${shq(lock)}`).then(() => {});
  const off = onStop(unlock);
  return { now: stdout.trim(), unlock: () => (off(), unlock()) };
}
