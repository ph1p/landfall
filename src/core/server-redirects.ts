import type { Server } from "./config";
import { parseRedirects, redirectsFile, type ServerRedirect } from "./redirects";
import { runScript, shq, writeFileCmd } from "./ssh";
import { DYNAMIC_DIR, PRELUDE } from "./templates";
import { fail } from "./term";
import { TRAEFIK_STATE, traefikStateOf } from "./traefik";

export const REDIRECTS_FILE = `${DYNAMIC_DIR}/redirects.yml`;

/** Prints `REDIRECTS <sha256> <file without comments, on one line>` if the file exists. */
export const REDIRECTS_LINE = `[ ! -f ${REDIRECTS_FILE} ] || printf 'REDIRECTS\\t%s\\t%s\\n' "$(sha256sum ${REDIRECTS_FILE} | cut -c1-64)" "$(grep -v '^#' ${REDIRECTS_FILE} | tr -d '\\n')" || true`;

export interface RedirectsFile {
  list: ServerRedirect[];
  /** sha256 of the file as read, to notice a change in between; unset when there is none. */
  sha?: string;
  /** The file is there but not landfall's format. */
  error?: string;
}

export function readRedirectsLine(sha: string, json: string): RedirectsFile {
  try {
    return { sha, list: parseRedirects(json) };
  } catch (e) {
    return { sha, list: [], error: `${REDIRECTS_FILE} is not as landfall wrote it (${(e as Error).message})` };
  }
}

/** The server's redirects, and whether landfall's own Traefik runs there (it alone reads the file). */
export async function readRedirects(server: Server): Promise<RedirectsFile & { traefik: "ours" | "foreign" | "none" }> {
  const { stdout } = await runScript(server, `${TRAEFIK_STATE}\n${REDIRECTS_LINE}`, { capture: true });
  const st = traefikStateOf(stdout);
  const line = stdout.split("\n").find((l) => l.startsWith("REDIRECTS\t"));
  const [, sha = "", json = ""] = line?.split("\t") ?? [];
  return { ...(line ? readRedirectsLine(sha, json) : { list: [] }), traefik: st.proxy ? "foreign" : (st.compose ?? "none") };
}

/** Writes the list (none: removes the file), journaled; fails if the file changed since `was` was read. */
export async function writeRedirects(server: Server, was: RedirectsFile, list: ServerRedirect[], what: string) {
  const f = shq(REDIRECTS_FILE);
  await runScript(
    server,
    `${PRELUDE}
# Another change in between would be lost: compare with what was read.
${was.sha ? `printf '%s  %s\\n' ${shq(was.sha)} ${f} | sha256sum -c --status 2>/dev/null` : `[ ! -e ${f} ]`} || { echo "${REDIRECTS_FILE} changed meanwhile: run the command again" >&2; exit 1; }
u=$(saved ${f})
${list.length ? writeFileCmd(REDIRECTS_FILE, redirectsFile(list)) : `rm -f ${f}`}
record ${shq(what)} "$u"`,
  );
}

/** Refuses unless landfall's Traefik runs and the file is landfall's: the redirects live in its file provider. */
export async function editableRedirects(server: Server, name: string): Promise<RedirectsFile> {
  const r = await readRedirects(server);
  if (r.traefik === "none") fail(`${name} has no traefik yet: lf traefik setup -s ${name}`);
  if (r.traefik === "foreign") fail(`${name} runs a Traefik landfall does not manage: add redirects in its own configuration`);
  if (r.error) fail(`${r.error}: change it by hand, or remove it`);
  return r;
}

/** Takes hosts off the server's redirects, journaled; `why`: what serves them now. `was`: the file as last read. */
export async function dropRedirects(server: Server, was: RedirectsFile, hosts: string[], why?: string) {
  const left = was.list.filter((x) => !hosts.includes(x.host));
  await writeRedirects(server, was, left, `removed redirect ${hosts.join(", ")}${why ? `: ${why}` : ""}`);
}
