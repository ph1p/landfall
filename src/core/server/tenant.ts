import { isDeepStrictEqual } from "node:util";
import { loadConfig, patchServer, updateConfig, type Server, type Tenant } from "../lib/config";
import { fail } from "../lib/term";
import { runScript } from "../ssh/ssh";
import { TENANTS } from "../ssh/templates";

/** The tenant file of the login running the script, on one line after MINE; nothing for any other login. */
export const mineLine = (s: Server) => (s.tenant ? `printf 'MINE\\t%s\\n' "$(tr -d '\\n' < ${TENANTS}/"$(id -un)".json 2>/dev/null)"` : "");

/** The domains the admin gave this tenant, from mineLine's output; undefined when the file is gone or unreadable. */
export function mineOf(stdout: string): string[] | undefined {
  const line = stdout.split("\n").find((l) => l.startsWith("MINE\t"));
  try {
    const { domains } = JSON.parse(line!.slice(5)) as { domains?: unknown };
    return Array.isArray(domains) ? domains.filter((d): d is string => typeof d === "string") : [];
  } catch {
    return;
  }
}

/** The tenant the login of s is on its server, read from the one file the admin left for it. */
export async function detectTenant(s: Server): Promise<(Tenant & { domains: string[] }) | undefined> {
  const { tenant: _, ...login } = s;
  const { stdout } = await runScript(
    login,
    `u=$(id -un); f=${TENANTS}/"$u".json
[ "$(id -u)" -ne 0 ] && [ -r "$f" ] && { echo "$u"; cat "$f"; } || true`,
    { capture: true },
  );
  const [user, ...rest] = stdout.trim().split("\n");
  if (!user || !rest.length) return;
  let raw: { uid?: unknown; port?: unknown; domains?: unknown; trustedIP?: unknown };
  try {
    raw = JSON.parse(rest.join("\n"));
  } catch {
    return;
  }
  const { uid, port, domains, trustedIP } = raw;
  if (!Number.isInteger(uid) || !Number.isInteger(port)) return;
  return {
    uid: uid as number,
    root: `${TENANTS}/${user}`,
    port: port as number,
    domains: Array.isArray(domains) ? domains.filter((d): d is string => typeof d === "string") : [],
    ...(typeof trustedIP === "string" && /^[\d.:a-f]+$/i.test(trustedIP) ? { trustedIP } : {}),
  };
}

/** What a connection needs of a tenant; its domains stay on the server, where the admin changes them. */
export const tenantLogin = ({ uid, root, port, trustedIP }: Tenant): Tenant => ({ uid, root, port, ...(trustedIP && { trustedIP }) });

/** s with its tenant as the server has it now; saved when it changed. */
export async function freshTenant(name: string, s: Server): Promise<Server> {
  if (!s.tenant) return s;
  const found = (await detectTenant(s)) ?? fail(`${s.user ?? "this login"} is no longer a tenant on ${name}; ask its admin, or lf server add ${name} again`);
  const tenant = tenantLogin(found);
  if (isDeepStrictEqual(tenant, s.tenant)) return s;
  const before = loadConfig().servers[name];
  if (before) await updateConfig((cfg) => void patchServer(cfg, name, before, { ...before, tenant }));
  return { ...s, tenant };
}
