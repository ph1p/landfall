import { randomBytes } from "node:crypto";
import { MIN_PASSWORD, type Server } from "./config";
import { requireCap } from "./facts";
import { adminLogin } from "./privilege";
import { runScript } from "./ssh";
import { effectiveSsh } from "./sshconfig";
import { KV, kvRecord, PRELUDE } from "./templates";
import { fail } from "./term";

/** Debian's NAME_REGEX: what useradd and busybox's adduser both take, and sudoers.d file names allow (no dots). */
export const USER_NAME = /^[a-z_][a-z0-9_-]{0,31}$/;
export const checkUserName = (name: string) =>
  USER_NAME.test(name) || fail(`not a user name: ${name} (lowercase letters, digits, _ and -, starting with a letter)`);
export function checkPassword(pw: string) {
  if (pw.length < MIN_PASSWORD) fail(`use a password of at least ${MIN_PASSWORD} characters`);
  if (/[\n\r]/.test(pw)) fail("a password cannot have line breaks");
}
export const newPassword = () => randomBytes(15).toString("base64url");

/** landfall's sudo rule for a user: one file each, so taking sudo away removes exactly what it added. */
const SUDOERS = "/etc/sudoers.d/landfall-";

export interface Account {
  name: string;
  uid: number;
  home: string;
  shell: string;
  groups: string[];
  /** Root, in group sudo or wheel, or with landfall's sudo rule. */
  sudo: boolean;
  /** landfall's rule lets them sudo without a password. */
  nopasswd: boolean;
  /** locked: set, but passwd -l locked it. */
  password: "set" | "locked" | "none";
  /** Lines in their authorized_keys. */
  keys: number;
  /** Their shell lets them log in (not nologin or false). */
  login: boolean;
  /** landfall logs in to the server as them. */
  me: boolean;
  /** Why lf will not remove them or take their sudo away (root, landfall's login, the managing login). */
  keep?: string;
}

export interface Users {
  /** Who manages users here: the login, or root's (or the admin user's) key login (adminLogin). */
  admin: string;
  /** sudo is installed: without it nobody can be given sudo. */
  sudo: boolean;
  /** sshd takes passwords; undefined when it could not tell. */
  passwordLogin?: boolean;
  accounts: Account[];
}

/** Root and everyone with a uid from 1000 (people, deploy users), read as admin: /etc/shadow and others' keys need root. */
export const USERS = String.raw`
set +e
${KV}
kv admin "$(id -un)"
kv sudo "$(command -v sudo >/dev/null 2>&1 && echo 1)"
# What sshd really uses (a Match block can override the config file): "no" when it takes keys only.
kv sshd_passwords "$(sshd_passwords)"
# Only whether a password is set: hashes stay on the server.
$SUDO awk -F: '{ s = $2 ~ /^\$/ ? "set" : $2 ~ /^!+\$/ ? "locked" : "none"; print "PW\t" $1 "\t" s }' /etc/shadow
awk -F: '$3 == 0 || ($3 >= 1000 && $3 < 60000) { print $1 ":" $3 ":" $6 ":" $7 }' /etc/passwd | while IFS=: read -r u uid home sh; do
  k=$($SUDO cat "$home/.ssh/authorized_keys" 2>/dev/null | grep -c '^[^#[:space:]]')
  r=$($SUDO cat "${SUDOERS}$u" 2>/dev/null)
  rule=""; [ -z "$r" ] || rule=1
  np=""; case "$r" in *NOPASSWD*) np=1 ;; esac
  printf 'USER\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$u" "$uid" "$home" "$sh" "$(id -nG "$u" 2>/dev/null | tr ' ' ,)" "$k" "$rule" "$np"
done
exit 0
`;

export function parseUsers(out: string, me = ""): Users {
  const v = kvRecord(out);
  const pw = new Map<string, Account["password"]>();
  const rows: string[][] = [];
  for (const line of out.split("\n")) {
    const t = line.split("\t");
    if (t[0] === "PW") pw.set(t[1], t[2] as Account["password"]);
    else if (t[0] === "USER") rows.push(t.slice(1));
  }
  const admin = v.admin ?? "";
  const sudo = v.sudo === "1";
  const accounts = rows.map(([name, uid, home, shell, groups, keys, rule, np]): Account => {
    const g = groups ? groups.split(",").filter(Boolean) : [];
    return {
      name,
      uid: Number(uid),
      home,
      shell,
      groups: g,
      sudo: uid === "0" || (sudo && (rule === "1" || g.includes("sudo") || g.includes("wheel"))),
      nopasswd: sudo && np === "1",
      password: pw.get(name) ?? "none",
      keys: Number(keys) || 0,
      login: !/(nologin|false)$/.test(shell),
      me: name === me,
      keep:
        uid === "0"
          ? "not root"
          : name === me
            ? `landfall logs in as ${name}; that would lock it out`
            : name === admin
              ? `${name} is the login that manages users here`
              : undefined,
    };
  });
  const p = v.sshd_passwords;
  return { admin, sudo, passwordLogin: p ? p !== "no" : undefined, accounts };
}

/** The login that manages users on s: fails, saying why, where landfall may not (the users capability). */
export async function usersLogin(s: Server): Promise<Server> {
  await requireCap(s, "users", "manage users");
  return adminLogin(s, "managing users");
}

/** `lf users --json`. */
export async function listUsers(s: Server, admin?: Server): Promise<Users> {
  const login = admin ?? (await usersLogin(s));
  const { stdout } = await runScript(login, PRELUDE + USERS, { capture: true });
  return parseUsers(stdout, effectiveSsh(s).user);
}

export function account(u: Users, name: string): Account {
  return u.accounts.find((a) => a.name === name) ?? fail(`no user ${name} (root or uid 1000+): see lf users`);
}

/** Taking an account (or its sudo) away: never one parseUsers marked to keep. */
export function checkTakeable(a: Account, what: string) {
  if (a.keep) fail(`${what}: ${a.keep}`);
}

// Changes: each runs as usersLogin's login and journals what it did (with its undo where there is one).

const EXISTS = `id "$U" >/dev/null 2>&1 || { log "no user $U"; exit 1; }`;

export async function addUser(admin: Server, name: string, o: { shell?: string } = {}) {
  checkUserName(name);
  if (o.shell && !/^\/[\w/.+-]+$/.test(o.shell)) fail(`not a shell: ${o.shell} (a path like /bin/bash)`);
  const script = String.raw`
if id "$U" >/dev/null 2>&1; then log "$U already exists"; exit 1; fi
if [ -z "$NEW_SHELL" ]; then NEW_SHELL=/bin/sh; [ -x /bin/bash ] && NEW_SHELL=/bin/bash; fi
[ -x "$NEW_SHELL" ] || { log "no shell $NEW_SHELL"; exit 1; }
if command -v useradd >/dev/null 2>&1; then $SUDO useradd -m -s "$NEW_SHELL" "$U"; else $SUDO adduser -D -s "$NEW_SHELL" "$U"; fi
record "created user $U" "user_del $U"
user_nopw "$U"
`;
  await runScript(admin, PRELUDE + script, { env: { U: name, NEW_SHELL: o.shell ?? "" } });
}

export async function removeUser(admin: Server, name: string, keepHome = false) {
  const script = String.raw`
${EXISTS}
$SUDO rm -f "${SUDOERS}$U"
user_del "$U"${keepHome ? " keep-home" : ""}
record "removed user $U${keepHome ? ", kept its home" : ""}"
`;
  await runScript(admin, PRELUDE + script, { env: { U: name } });
}

/** The password travels in the script on stdin, never on a command line. Not undoable: the journal keeps no hashes. */
export async function setPassword(admin: Server, name: string, pw: string) {
  checkPassword(pw);
  const script = String.raw`
${EXISTS}
e=$(printf '%s:%s\n' "$U" "$PW" | $SUDO chpasswd 2>&1) || { log "$e"; exit 1; }
record "set a password for $U"
`;
  await runScript(admin, PRELUDE + script, { env: { U: name, PW: pw } });
}

/** Key login only: '*' like a new user's, not a lock (sshd refuses locked accounts even with a key). */
export async function removePassword(admin: Server, name: string) {
  const script = String.raw`
${EXISTS}
user_nopw "$U"
record "removed the password of $U"
`;
  await runScript(admin, PRELUDE + script, { env: { U: name } });
}

/** On: landfall's own rule in /etc/sudoers.d (checked with visudo first). Off: that rule, and group sudo/wheel. */
export async function setSudo(admin: Server, name: string, on: boolean, nopasswd = false) {
  const script = String.raw`
${EXISTS}
command -v sudo >/dev/null 2>&1 || { log "sudo is not installed"; exit 1; }
f="${SUDOERS}$U"
if [ "$ON" = 1 ]; then
  $SUDO grep -qE '^[@#]includedir[[:space:]]+/etc/sudoers.d' /etc/sudoers || { log "/etc/sudoers does not read /etc/sudoers.d"; exit 1; }
  rule="$U ALL=(ALL) ALL"; how=""
  if [ "$NOPW" = 1 ]; then rule="$U ALL=(ALL) NOPASSWD: ALL"; how=" without a password"; fi
  if [ "$($SUDO cat "$f" 2>/dev/null)" = "$rule" ]; then log "$U already has that"; exit 0; fi
  t=$(mktemp); trap 'rm -f "$t"' EXIT; printf '%s\n' "$rule" > "$t"
  if ! $SUDO visudo -cf "$t" >/dev/null; then rm -f "$t"; log "visudo refused: $rule"; exit 1; fi
  undo=$(saved "$f")
  $SUDO install -m 0440 -o root -g root "$t" "$f"; rm -f "$t"
  record "gave $U sudo$how" "$undo"
else
  if $SUDO test -e "$f"; then undo=$(saved "$f"); $SUDO rm -f "$f"; record "took sudo from $U" "$undo"; fi
  for g in sudo wheel; do
    case " $(id -nG "$U") " in
      *" $g "*) $SUDO gpasswd -d "$U" "$g" >/dev/null 2>&1 || $SUDO delgroup "$U" "$g"
         record "removed $U from group $g" "\$SUDO usermod -aG $g $U 2>/dev/null || \$SUDO addgroup $U $g" ;;
    esac
  done
fi
`;
  await runScript(admin, PRELUDE + script, { env: { U: name, ON: on, NOPW: nopasswd } });
}
