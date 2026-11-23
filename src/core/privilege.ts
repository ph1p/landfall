import type { Server } from "./config";
import { canLogin, hasSudoPassword, runScript, setSudoPassword } from "./ssh";
import { effectiveSsh, sameMachineLogins } from "./sshconfig";
import { askSecret, c, fail, info, interactive } from "./term";

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
export const ROOT_HINT =
  "add a Host for root (or a sudo user) in ~/.ssh/config, name one with lf server config --root-login <ssh-alias>, or give the sudo password with -K ($LANDFALL_SUDO_PASSWORD)";

/** How s gets root: it is root, it may sudo (without a password, or with the one given by -K), or not at all. */
export async function rootVia(s: Server): Promise<"root" | "sudo" | ""> {
  const { stdout } = await runScript(s, `if [ "$(id -u)" = 0 ]; then echo root; elif sudo -n true 2>/dev/null; then echo sudo; fi`, { capture: true });
  const v = stdout.trim();
  return v === "root" || v === "sudo" ? v : "";
}

/**
 * The login that may run root commands: the server's own if it is root or has sudo, else root's key login.
 * In a terminal, a login whose sudo wants a password is asked for it once. Says on stderr how root is reached,
 * before anything runs.
 */
export async function adminLogin(s: Server, what: string): Promise<Server> {
  const me = effectiveSsh(s).user;
  const via = await rootVia(s);
  if (via === "root") return s;
  if (via !== "sudo") {
    const other = await rootLogin(s);
    if (other) return (info(c.dim(`${what} runs as root: through the login ${effectiveSsh(other).user}@${other.host}`)), other);
    await askSudo(s, what, `no root key login works either; ${ROOT_HINT}`);
  }
  return (sudoNote(what, me), s);
}

/** Says, before it runs, that `what` gets root through sudo. */
export const sudoNote = (what: string, me: string) => info(c.dim(`${what} runs as root: sudo as ${me}${hasSudoPassword() ? " with the password given" : ""}`));

/**
 * For a login that may not sudo without a password: ask once for its sudo password and check it.
 * Fails, naming `how`, without a terminal, when a password was given already, or when sudo refuses it.
 */
export async function askSudo(s: Server, what: string, how = ROOT_HINT) {
  const me = effectiveSsh(s).user;
  if (hasSudoPassword() || !interactive())
    fail(`${what} needs root: ${me} is not root and may not sudo${hasSudoPassword() ? " with the password given" : " without a password"}; ${how}`);
  setSudoPassword(await askSecret(`${what} needs root. sudo password for ${me}@${s.host} (kept for this run only):`));
  if ((await rootVia(s)) === "sudo") return;
  setSudoPassword(undefined);
  fail(`sudo refused ${me} on ${s.host}: wrong password, or ${me} may not use sudo; ${how}`);
}
