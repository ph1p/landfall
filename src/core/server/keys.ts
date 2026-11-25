import { createHash } from "node:crypto";
import fs from "node:fs";
import { expandHome, type Server } from "../lib/config";
import { runScript } from "../ssh/ssh";
import { effectiveSsh } from "../ssh/sshconfig";
import { PRELUDE } from "../ssh/templates";
import { fail } from "../lib/term";

export interface AuthorizedKey {
  user: string;
  type: string;
  /** SHA256:… as ssh-keygen -l prints it. */
  fingerprint: string;
  comment: string;
  /** authorized_keys options before the key (from=, command=…). */
  options: string;
  /** The whole line, as it is in the file. */
  line: string;
  /** One of the keys this machine logs in with. */
  mine?: boolean;
}

const KEY_TYPE = /^(ssh-(rsa|dss|ed25519)|ecdsa-sha2-\S+|sk-\S+@openssh\.com)$/;

/** Splits an authorized_keys line; options may hold quoted spaces (command="a b"). */
export function parseKeyLine(line: string): Omit<AuthorizedKey, "user"> | undefined {
  const toks: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of line.trim()) {
    if (ch === '"') quoted = !quoted;
    if (/\s/.test(ch) && !quoted) {
      if (cur) toks.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) toks.push(cur);
  const i = toks.findIndex((t) => KEY_TYPE.test(t));
  if (i < 0 || !toks[i + 1]) return undefined;
  const blob = Buffer.from(toks[i + 1], "base64");
  if (!blob.length) return undefined;
  return {
    type: toks[i],
    fingerprint: `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`,
    comment: toks.slice(i + 2).join(" "),
    options: toks.slice(0, i).join(" "),
    line: line.trim(),
  };
}

/** A key line as given, or the contents of a .pub file. */
export function readKey(arg: string): string {
  const p = expandHome(arg);
  const line = !/^\S+ AAAA/.test(arg) && fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim().split("\n")[0] : arg.trim();
  if (!parseKeyLine(line)) fail(`not a public key: ${arg} (a line like ssh-ed25519 AAAA… or a .pub file)`);
  return line;
}

/** Fingerprints of the public keys next to the identity files this machine uses for `s`. */
export function localFingerprints(s: Server): Set<string> {
  const out = new Set<string>();
  for (const f of effectiveSsh(s).identityFiles) {
    try {
      const k = parseKeyLine(fs.readFileSync(`${f}.pub`, "utf8"));
      if (k) out.add(k.fingerprint);
    } catch {}
  }
  return out;
}

const HOME = `home=$(home_of "$KEY_USER")
[ -n "$home" ] || { log "no user $KEY_USER"; exit 1; }
f="$home/.ssh/authorized_keys"`;

export async function addKey(s: Server, user: string, line: string) {
  if (!parseKeyLine(line)) fail("not a public key: expected a line like ssh-ed25519 AAAA… comment");
  const script = String.raw`
${HOME}
if $SUDO grep -qxF -- "$KEY" "$f" 2>/dev/null; then log "already there"; exit 0; fi
$SUDO mkdir -p "$home/.ssh"; $SUDO chmod 700 "$home/.ssh"
printf '%s\n' "$KEY" | $SUDO tee -a "$f" >/dev/null
g=$(id -gn "$KEY_USER" 2>/dev/null || echo "$KEY_USER")
$SUDO chown "$KEY_USER:$g" "$home/.ssh" "$f"; $SUDO chmod 600 "$f"
record "authorized key $WHAT for $KEY_USER" "drop_line $(printf %q "$f") $(printf %q "$KEY")"
`;
  const k = parseKeyLine(line)!;
  await runScript(s, PRELUDE + script, { env: { KEY_USER: user, KEY: k.line, WHAT: k.comment || k.fingerprint } });
}

export async function removeKey(s: Server, k: AuthorizedKey) {
  const script = String.raw`
${HOME}
$SUDO grep -qxF -- "$KEY" "$f" || { log "key not found in $f"; exit 1; }
drop_line "$f" "$KEY"
record "removed key $WHAT of $KEY_USER" "printf '%s\n' $(printf %q "$KEY") | \$SUDO tee -a $(printf %q "$f") >/dev/null"
`;
  await runScript(s, PRELUDE + script, { env: { KEY_USER: k.user, KEY: k.line, WHAT: k.comment || k.fingerprint } });
}
