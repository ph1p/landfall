import type { Server } from "./config";
import { canLogin, runScript } from "./ssh";
import { effectiveSsh, sameMachineLogins } from "./sshconfig";
import { fail } from "./term";

/**
 * The first key login that works for root work and is not the login s already is: the alias s.rootAlias names,
 * root, the sudo admin, then other ~/.ssh/config aliases for the same machine (root first).
 */
export function rootLogin(s: Server, o: { fresh?: boolean } = {}): Promise<Server | undefined> {
  const key = JSON.stringify([s.host, s.port, s.user, s.admin, s.key, s.rootAlias]);
  const hit = tried.get(key);
  if (hit && !o.fresh && Date.now() - hit.at < TRIED_TTL) return hit.login;
  const login = tryRoot(s).catch((e) => (tried.delete(key), Promise.reject(e)));
  tried.set(key, { at: Date.now(), login });
  return login;
}

// Each try is an unmultiplexed ssh handshake, and the web UI asks on every facts and system load: remembered a while.
const TRIED_TTL = 10 * 60_000;
const tried = new Map<string, { at: number; login: Promise<Server | undefined> }>();

async function tryRoot(s: Server): Promise<Server | undefined> {
  // Another alias brings its own user, port and key from ~/.ssh/config.
  const via = (alias: string): Server => ({ ...s, host: alias, user: undefined, port: undefined, key: undefined });
  if (s.rootAlias && (await canLogin(via(s.rootAlias)))) return via(s.rootAlias);
  const me = effectiveSsh(s).user;
  for (const user of ["root", s.admin]) {
    if (user && user !== me && (await canLogin({ ...s, user }))) return { ...s, user };
  }
  for (const { alias } of sameMachineLogins(s)) {
    if (alias !== s.rootAlias && (await canLogin(via(alias)))) return via(alias);
  }
}

/** Where to point landfall at a login that has root, for error messages. */
export const ROOT_HINT = "add a Host for root (or a sudo user) in ~/.ssh/config, or name one with lf server config --root-login <ssh-alias>";

/** The login that may run root commands: the server's own if it is root or has sudo, else root's key login. */
export async function adminLogin(s: Server, what: string): Promise<Server> {
  const { stdout } = await runScript(s, `{ [ "$(id -u)" = 0 ] || sudo -n true 2>/dev/null; } && echo yes || true`, { capture: true });
  if (stdout.trim() === "yes") return s;
  return (await rootLogin(s)) ?? fail(`${what} needs root or passwordless sudo; ${effectiveSsh(s).user} has neither and no root key login works; ${ROOT_HINT}`);
}
