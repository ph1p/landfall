import type { Server } from "./config";
import { canLogin, runScript } from "./ssh";
import { effectiveSsh } from "./sshconfig";
import { fail } from "./term";

/** s as root, else as its sudo admin, when that key login works and is not the login s already is. */
export async function rootLogin(s: Server): Promise<Server | undefined> {
  const me = effectiveSsh(s).user;
  for (const user of ["root", s.admin]) {
    if (user && user !== me && (await canLogin({ ...s, user }))) return { ...s, user };
  }
}

/** The login that may run root commands: the server's own if it is root or has sudo, else root's key login. */
export async function adminLogin(s: Server, what: string): Promise<Server> {
  const { stdout } = await runScript(s, `{ [ "$(id -u)" = 0 ] || sudo -n true 2>/dev/null; } && echo yes || true`, { capture: true });
  if (stdout.trim() === "yes") return s;
  return (await rootLogin(s)) ?? fail(`${what} needs root or passwordless sudo; ${effectiveSsh(s).user} has neither and root's key login does not work`);
}
