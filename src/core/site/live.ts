import { parse as parseYaml } from "yaml";
import type { Server } from "../lib/config";
import { SECRETS_DIR } from "./meta";
import { noSite, siteDir } from "./site";
import { runScript, shq, sshExec } from "../ssh/ssh";
import { PRELUDE } from "../ssh/templates";

/** Run `dc <args>` in a site's live release, after an optional setup snippet in the site's folder. */
export async function composeCmd(s: Server, name: string, args: string, before = "") {
  await runScript(s, `${PRELUDE}\ncd ${shq(siteDir(name))}\n${before}\ncd -P current && dc ${args}`);
}

/** Logs of a site's services (or one of them), via its compose project. */
/** Exit code of a remote command that found no site folder: the caller reports it with noSite. */
const NO_SITE = 79;

export async function siteLogs(s: Server, name: string, o: { service?: string; tail?: string; follow?: boolean }) {
  const dir = shq(siteDir(name) + "/current");
  const code = await sshExec(s, [
    `{ [ -d ${dir} ] || exit ${NO_SITE}; } && cd -P ${dir} && docker compose logs --tail ${shq(o.tail ?? "100")} ${o.follow ? "-f " : ""}${o.service ? shq(o.service) : ""}`,
  ]);
  if (code === NO_SITE) await noSite(s, name);
  return code;
}

/** The files of a site's .secrets folder with their sizes; never their content. */
export async function readSecrets(s: Server, name: string): Promise<{ key: string; size: number }[]> {
  const { stdout } = await runScript(
    s,
    `cd ${shq(`${siteDir(name)}/${SECRETS_DIR}`)} 2>/dev/null || exit 0; for f in *; do [ -f "$f" ] && printf '%s\t%s\n' "$f" "$(wc -c < "$f")"; done; true`,
    { capture: true },
  );
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => ({ key: l.split("\t")[0], size: Number(l.split("\t")[1]) }));
}

/** `docker compose config` of the site's live release, or undefined when it does not resolve. */
export async function liveConfig(s: Server, name: string): Promise<any> {
  const { stdout } = await runScript(s, `${PRELUDE}\ncd ${shq(siteDir(name))} && cd -P current && dc config 2>/dev/null || true`, { capture: true });
  try {
    return parseYaml(stdout) ?? undefined;
  } catch {
    return undefined;
  }
}
