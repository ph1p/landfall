import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { checkAlias, envVar, expandHome, tildify, type Server } from "./config";
import { canLogin, dest, targetArgs } from "./ssh";
import { effectiveKey, effectiveSsh, setIdentityFile, SSH_CONFIG, upsertHostBlock } from "./sshconfig";
import { c, fail, info, ok, readStdin, report, step, warn } from "./ui";


let askpass: string | undefined;

/**
 * An SSH_ASKPASS helper that answers with $LANDFALL_PASSWORD, so ssh/ssh-copy-id can
 * log in with a password typed into the dashboard or piped in. The password itself
 * only lives in the child's environment, never on disk.
 */
function askpassScript(): string {
  if (askpass) return askpass;
  const dir = fs.mkdtempSync(join(tmpdir(), "landfall-"));
  askpass = join(dir, "askpass");
  fs.writeFileSync(askpass, `#!/bin/sh\nprintf '%s\\n' "$LANDFALL_PASSWORD"\n`, { mode: 0o700 });
  process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
  return askpass;
}

export const askpassEnv = (password: string) => ({ SSH_ASKPASS: askpassScript(), SSH_ASKPASS_REQUIRE: "force", LANDFALL_PASSWORD: password });

/** The login password from --password-stdin or $LANDFALL_PASSWORD; undefined means ssh asks itself. */
export async function loginPassword(fromStdin?: boolean): Promise<string | undefined> {
  if (fromStdin) {
    const pw = (await readStdin()).replace(/\r?\n$/, "");
    if (!pw) fail("--password-stdin: nothing on stdin");
    return pw;
  }
  return envVar("PASSWORD") || undefined;
}

export const keyFile = (name: string) => join(homedir(), ".ssh", `landfall_${checkAlias(name)}`);

export function ensureKey(name: string): { path: string; created: boolean } {
  const path = keyFile(name);
  if (fs.existsSync(path)) return { path, created: false };
  fs.mkdirSync(join(homedir(), ".ssh"), { recursive: true, mode: 0o700 });
  const r = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-f", path, "-N", "", "-C", `landfall-${name}`], { stdio: "inherit" });
  if (r.status !== 0) fail("ssh-keygen failed");
  return { path, created: true };
}

/**
 * Key login for <login>, mutating login.key to the key that works:
 * a given --key, the server's ssh config key, or ~/.ssh/landfall_<name> (generated and
 * installed with the password once). Returns undefined when check-only and no key works yet.
 */
export async function ensureKeyLogin(name: string, login: Server, o: { check?: boolean; password?: string }): Promise<string | undefined> {
  const eff = effectiveSsh(login);
  let keyPath = login.key ? expandHome(login.key) : undefined;
  if (keyPath && !fs.existsSync(keyPath)) fail(`key not found: ${keyPath}`);
  if (keyPath && !fs.existsSync(`${keyPath}.pub`)) {
    // ssh-copy-id and setup's deploy user both need the public half.
    const pub = spawnSync("ssh-keygen", ["-y", "-f", keyPath], { encoding: "utf8" });
    if (pub.status !== 0) fail(`cannot read ${keyPath} (passphrase-protected keys need ssh-agent and a .pub next to it)`);
    fs.writeFileSync(`${keyPath}.pub`, pub.stdout, { mode: 0o644 });
  }
  let works = await canLogin(login);
  // A fresh --host whose key an earlier `setup --key-only` already installed.
  if (!works && !login.key && fs.existsSync(keyFile(name)) && (await canLogin({ ...login, key: keyFile(name) }))) {
    login.key = keyPath = keyFile(name);
    works = true;
  }
  if (works) {
    ok("key login works");
    keyPath ??= effectiveKey(login);
  } else if (o.check) {
    warn("no key login yet — `lf setup` would install a key first");
    report({ needsKey: true });
    return undefined;
  }
  let fresh = false;
  if (!keyPath && !o.check) {
    const key = ensureKey(name);
    keyPath = key.path;
    fresh = key.created;
    if (fresh) ok(`generated key ${tildify(keyPath)}`);
  }
  // Every failed key login counts toward sshd's PerSourcePenalties (OpenSSH 9.8+),
  // which then drops the password connection: only re-test a key that could work.
  const tested = login.key && expandHome(login.key);
  login.key = keyPath;
  if (!o.check && !(works && tested === keyPath) && (fresh || !(await canLogin(login)))) {
    step(`installing key on ${eff.hostname} (${o.password ? "with the given password" : `enter the ${eff.user} password once`})`);
    // ssh-copy-id takes the same -F/-p/-i flags; -i <key> installs <key>.pub.
    // -f: we know the key is not installed, skip its own test login.
    const env = o.password ? { ...process.env, ...askpassEnv(o.password) } : process.env;
    const r = spawnSync("ssh-copy-id", ["-f", ...targetArgs(login), dest(login)], { stdio: o.password ? ["ignore", "inherit", "inherit"] : "inherit", env });
    if (r.status !== 0 || !(await canLogin(login))) fail("could not log in with the key — check host, user and password");
    ok("key installed");
  }
  return keyPath;
}

/**
 * The landfall config entry for <name> after a key login works, writing `Host <name>`
 * to the ssh config (created if missing) unless the user owns that alias.
 */
const showLines = (lines: string[]) => {
  for (const l of lines) console.log(c.dim("    ") + l);
};

export function serverEntry(
  name: string,
  login: Server,
  keyPath: string,
  o: { existing?: Server; sshConfig: boolean; ownAlias: boolean; port?: string; keyGiven?: boolean },
): Server {
  const eff = effectiveSsh(login);
  const entry: Server = { ...o.existing, host: login.host };
  if (o.sshConfig && !o.ownAlias) {
    const w = upsertHostBlock({ alias: name, hostname: eff.hostname, user: login.user ?? eff.user, port: eff.port, key: keyPath });
    ok(`${w.created ? "created" : "updated"} ${tildify(SSH_CONFIG)} with ${c.bold(`Host ${name}`)} — try \`ssh ${name}\``);
    showLines(w.block.split("\n"));
    entry.host = name;
    delete entry.user;
    delete entry.port;
    delete entry.key;
  } else {
    if (login.user) entry.user = login.user;
    if (o.port) entry.port = Number(o.port);
    // The user's own Host block does not offer the key that works: add it there, so plain `ssh <name>` works too.
    const missing = o.keyGiven || keyPath !== effectiveKey({ host: login.host });
    const edit = missing && o.ownAlias && o.sshConfig ? setIdentityFile(name, keyPath) : undefined;
    if (edit) {
      ok(`added the key to your ${c.bold(`Host ${name}`)} in ${tildify(edit.file)} ${c.dim(`(backup: ${tildify(edit.backup)})`)}`);
      showLines([...edit.removed.map((l) => c.red(`- ${l}`)), c.green(`+ ${edit.added}`)]);
      delete entry.key;
    } else if (missing) entry.key = tildify(keyPath);
    if (o.ownAlias) info(c.dim(`kept your own ~/.ssh/config entry for ${name}; lf logs in as ${entry.user ?? eff.user}`));
  }
  return entry;
}
