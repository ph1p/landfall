import { defineCommand, serverOpt } from "../cmd";
import { tildify } from "../../core/config";
import { generateKey } from "../../core/security";
import { addKey, parseKeyLine, readKey } from "../../core/system";
import { askSecret, c, confirmRemoval, confirmRisky, fail, info, ok, passwordOption, report, table, warn, printJson } from "../../core/term";
import {
  account,
  addUser,
  checkPassword,
  checkTakeable,
  checkUserName,
  listUsers,
  newPassword,
  removePassword,
  removeUser,
  setPassword,
  setSudo,
  usersLogin,
  type Account,
} from "../../core/users";
import { loginHint, target } from "./system";

const json = { type: "boolean", desc: "machine-readable output" } as const;
const password = { type: "string", short: "p", desc: "the password (asked in a terminal; visible in ps, prefer --password-stdin)" } as const;
const passwordStdin = { type: "boolean", desc: "read the password from stdin" } as const;

/** --password, --password-stdin, or asked twice in a terminal; undefined when none of them is there to ask. */
async function passwordFrom(o: Record<string, any>, ask: boolean): Promise<string | undefined> {
  const pw = await passwordOption(o);
  if (pw !== undefined || !ask) return pw;
  const a = await askSecret("new password:");
  if ((await askSecret("again:")) !== a) fail("the passwords differ");
  return a;
}

/** The server, the login that manages its users, and user's account there. */
async function load(o: Record<string, any>, user: string) {
  const { name, server } = target(o);
  const admin = await usersLogin(server);
  const u = await listUsers(server, admin);
  return { name, admin, u, a: account(u, user) };
}

function pwLabel(a: Account) {
  return a.password === "set" ? c.green("set") : a.password === "locked" ? c.yellow("locked") : c.dim("none");
}

export const usersList = defineCommand({
  name: "users",
  summary: "List the server's user accounts (root and uid 1000+): sudo, password, SSH keys.",
  options: { server: serverOpt, json },
  async run(_, o) {
    const { server } = target(o);
    const u = await listUsers(server);
    if (o.json) return void printJson(u);
    table([
      ["", "user", "uid", "sudo", "password", "keys", "shell"].map(c.dim),
      ...u.accounts.map((a) => [
        a.me ? c.green("★") : "",
        a.name,
        String(a.uid),
        a.sudo ? (a.nopasswd ? c.yellow("yes, no password") : "yes") : c.dim("no"),
        pwLabel(a),
        a.keys ? String(a.keys) : c.dim("0"),
        a.login ? a.shell : c.dim(a.shell),
      ]),
    ]);
    if (!u.sudo) info(c.dim("sudo is not installed: nobody but root can administer this server"));
    if (u.passwordLogin === false && u.accounts.some((a) => a.password === "set" && !a.keys && a.login))
      info(c.dim("sshd takes keys only: users with just a password cannot log in over ssh"));
  },
});

export const usersAdd = defineCommand({
  name: "users add",
  args: "<name>",
  summary: `Add a user account that logs in with an SSH key (and/or a password).

  lf users add anna --key ~/anna.pub          anna's key may log in
  lf users add anna --generate-key --sudo     make a key pair here (~/.ssh/<server>_anna)
  lf users add ci --key "ssh-ed25519 AAAA…"   a key-only user without sudo

--sudo lets the user administer the server: with their password, or without one
(--nopasswd; key-only users need that, they have no password to give sudo).`,
  options: {
    server: serverOpt,
    key: { type: "string", short: "k", desc: "a public key line or .pub file that may log in" },
    "generate-key": { type: "boolean", desc: "make a new key pair here and add its public key" },
    password,
    "password-stdin": passwordStdin,
    sudo: { type: "boolean", desc: "may run sudo" },
    nopasswd: { type: "boolean", desc: "with --sudo: without being asked for a password" },
    shell: { type: "string", desc: "login shell (default: /bin/bash, else /bin/sh)" },
  },
  async run([user], o) {
    if (!user) fail("usage: lf users add <name> [--key <key|file.pub> | --generate-key] [--password] [--sudo]");
    checkUserName(user);
    if (o.nopasswd && !o.sudo) fail("--nopasswd goes with --sudo");
    const { name, server } = target(o);
    const pw = await passwordFrom(o, false);
    if (pw !== undefined) checkPassword(pw);
    // Check everything here before the account exists: a half-made user is worse than none.
    const line = o.key ? readKey(o.key) : undefined;
    if (!line && !o["generate-key"] && pw === undefined) fail("give the user a way in: --key, --generate-key or --password");
    if (o.sudo && !o.nopasswd && pw === undefined) warn(`${user} has no password to give sudo; consider --nopasswd or --password`);
    const admin = await usersLogin(server);
    const u = await listUsers(server, admin);
    if (u.accounts.some((a) => a.name === user)) fail(`${user} already exists on ${name}`);
    if (o.sudo && !u.sudo) fail(`sudo is not installed on ${name}`);
    const made = o["generate-key"] ? generateKey(name, user) : undefined;
    await addUser(admin, user, { shell: o.shell });
    const key = made?.pub ?? line;
    if (key) await addKey(admin, user, key);
    if (pw !== undefined) await setPassword(admin, user, pw);
    if (o.sudo) await setSudo(admin, user, true, o.nopasswd);
    ok(`added ${user} to ${name}${o.sudo ? (o.nopasswd ? " (sudo, no password)" : " (sudo)") : ""}`);
    if (made) {
      info(`${made.created ? "private key" : "used the existing key"}: ${tildify(made.path)}`);
      info(`log in: ${loginHint(server, user, made.path)}`);
      report({ keyFile: made.path });
    } else if (key) info(`log in: ${loginHint(server, user)} (with ${parseKeyLine(key)!.comment || "that key"})`);
    if (pw !== undefined && u.passwordLogin === false && !key) warn("sshd takes keys only: the password works for sudo and the console, not ssh");
  },
});

export const usersRemove = defineCommand({
  name: "users rm",
  args: "<name>",
  summary: "Remove a user account and its home directory (--keep-home keeps it). Not undoable.",
  options: {
    server: serverOpt,
    "keep-home": { type: "boolean", desc: "keep /home/<name>" },
  },
  async run([user], o) {
    if (!user) fail("usage: lf users rm <name>");
    const { name, admin, a } = await load(o, user);
    checkTakeable(a, `cannot remove ${user}`);
    await confirmRemoval(`Remove ${user} from ${name}${o["keep-home"] ? "" : `, with ${a.home}`}? This cannot be undone.`, user);
    await removeUser(admin, user, o["keep-home"]);
    ok(`removed ${user}${o["keep-home"] ? `; ${a.home} stays` : ""}`);
  },
});

export const usersPasswd = defineCommand({
  name: "users passwd",
  args: "<name>",
  summary: `Set a user's password (asked in a terminal), make one up (--generate), or remove it (--remove).

Without a password the user logs in with an SSH key only, and sudo needs NOPASSWD.`,
  options: {
    server: serverOpt,
    password,
    "password-stdin": passwordStdin,
    generate: { type: "boolean", desc: "make up a password and print it once" },
    remove: { type: "boolean", desc: "remove the password: key login only" },
  },
  async run([user], o) {
    if (!user) fail("usage: lf users passwd <name> [--password … | --generate | --remove]");
    if (o.generate && o.remove) fail("--generate or --remove, not both");
    const pw = o.remove ? undefined : o.generate ? newPassword() : await passwordFrom(o, true);
    if (pw !== undefined) checkPassword(pw);
    const { name, admin, a } = await load(o, user);
    if (o.remove) {
      if (a.sudo && !a.nopasswd && a.uid !== 0 && !(await confirmRisky(`${user} needs the password for sudo; without it they cannot sudo. Remove it anyway?`)))
        fail(`${user} needs the password for sudo (give them sudo --nopasswd first, or pass -y)`);
      if (!a.keys && a.login) warn(`${user} has no SSH key: without a password they cannot log in at all`);
      await removePassword(admin, user);
      return void ok(`${user} on ${name} has no password now`);
    }
    await setPassword(admin, user, pw!);
    ok(`set the password of ${user} on ${name}`);
    if (o.generate) {
      // The dashboard shows it from the report; its job log keeps no copy.
      report({ password: pw });
      if (!process.env.LANDFALL_REPORT) console.log(pw);
      info(c.dim("shown once: landfall keeps no copy"));
    }
  },
});

export const usersSudo = defineCommand({
  name: "users sudo",
  args: "<name>",
  summary: `Let a user run sudo (--nopasswd: without a password), or take it away (--off).

landfall writes /etc/sudoers.d/landfall-<name>, checked with visudo first; --off
removes that and the sudo/wheel group membership.`,
  options: {
    server: serverOpt,
    off: { type: "boolean", desc: "take sudo away" },
    nopasswd: { type: "boolean", desc: "without being asked for a password" },
  },
  async run([user], o) {
    if (!user) fail("usage: lf users sudo <name> [--nopasswd | --off]");
    if (o.off && o.nopasswd) fail("--off or --nopasswd, not both");
    const { name, admin, u, a } = await load(o, user);
    if (!u.sudo) fail(`sudo is not installed on ${name}`);
    if (o.off) {
      checkTakeable(a, `cannot take sudo from ${user}`);
      if (!a.sudo) return void info(`${user} has no sudo`);
      await setSudo(admin, user, false);
      return void ok(`${user} on ${name} has no sudo now`);
    }
    if (a.uid === 0) return void info("root needs no sudo");
    if (!o.nopasswd && a.password !== "set") warn(`${user} has no password to give sudo: set one (lf users passwd ${user}) or use --nopasswd`);
    await setSudo(admin, user, true, o.nopasswd);
    ok(`${user} on ${name} may sudo${o.nopasswd ? " without a password" : ""}`);
  },
});
