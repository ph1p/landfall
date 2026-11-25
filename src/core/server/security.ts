import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { checkAlias, type Server } from "../lib/config";
import { cloudFirewall, PLATFORM } from "./facts";
import { keygen } from "../ssh/login";
import { runScript } from "../ssh/ssh";
import { effectiveSsh } from "../ssh/sshconfig";
import { fullSystem, system, type SystemInfo } from "./system";
import { HARDEN_SSH, PRELUDE } from "../ssh/templates";
import { c, fail, interactive, report } from "../lib/term";

export type Level = "risk" | "warn" | "info";
/** One thing to look at, with the lf command that fixes it (`confirm`: ask first; `user`: whose key the fix makes). */
export interface Advice {
  id: string;
  level: Level;
  title: string;
  why: string;
  fix?: { label: string; argv: string[]; confirm?: string; user?: string };
}

export const HARDEN_PARTS = ["ssh", "fail2ban", "updates"] as const;
export type HardenPart = (typeof HARDEN_PARTS)[number];

const list = (l: string[]) => (l.length > 1 ? `${l.slice(0, -1).join(", ")} and ${l.at(-1)}` : l[0]);

/** What to do before turning passwords off, for users who log in with a password only. */
export const addKeyFirst = (users: string[]) =>
  `${list(users)} ${users.length === 1 ? "has" : "have"} no key yet and would be locked out: add one first (lf keys add <file.pub> -u ${users[0]}, or --generate to make a pair), then lf harden ssh.`;

/**
 * Users who log in with a password only: turning passwords off locks them out. Root and `exempt`
 * (landfall's own logins, which use keys) do not count. Setup and lf harden both ask this.
 */
export const passwordOnly = (passwordUsers: string[], keyUsers: string[], exempt: string[]) =>
  passwordUsers.filter((u) => u !== "root" && !exempt.includes(u) && !keyUsers.includes(u));

export const lockedOut = (i: SystemInfo, loginUser: string) =>
  passwordOnly(
    i.security.passwordUsers ?? [],
    i.keys.map((k) => k.user),
    [loginUser],
  );

/**
 * What keys-only ssh would break, read with three shell checks instead of the whole system check. `admin`: root or sudo.
 * keysOff: sshd refuses keys (PubkeyAuthentication no, as `sshd -T` resolves it), so keys only would lock everyone out.
 */
export async function lockedOutOn(admin: Server, loginUser: string) {
  const { stdout } = await runScript(admin, `${PRELUDE}\necho "$(password_users)"; echo "$(key_users)"; sshd_opt pubkeyauthentication`, { capture: true });
  const [pw = "", keys = "", pubkey = ""] = stdout.split("\n");
  const words = (l: string) => l.split(/\s+/).filter(Boolean);
  return { keysOff: pubkey.trim() === "no", locked: passwordOnly(words(pw), words(keys), [loginUser]) };
}

/** What to fix on a server, worst first. Pure: `lf security`, setup and the web UI share it. */
export function advise(i: SystemInfo, ctx: { name: string; loginUser: string }): Advice[] {
  const s = i.security;
  const srv = ["-s", ctx.name];
  const out: Advice[] = [];
  // Where landfall installs ufw and fail2ban itself.
  const installs = s.pkg === "apt-get" || s.pkg === "apk";
  // Systems like DSM that have their own firewall and bans: point there instead.
  const own = s.platform ? PLATFORM[s.platform] : undefined;
  if (s.passwordLogin) {
    const locked = lockedOut(i, ctx.loginUser);
    out.push({
      id: "password-login",
      level: "risk",
      title: s.rootLogin === "yes" ? "SSH accepts passwords, root's too" : "SSH accepts passwords",
      why: `Bots try passwords on every public server all day: one weak or reused password lets them in. A key cannot be guessed.${
        s.keyLogin === false
          ? " sshd refuses keys as well (PubkeyAuthentication no): set PubkeyAuthentication yes in /etc/ssh/sshd_config.d/ and reload ssh first."
          : locked.length
            ? ` ${addKeyFirst(locked)}`
            : ""
      }`,
      fix:
        s.keyLogin === false
          ? undefined
          : locked.length
            ? { label: `Make a key for ${locked[0]}`, argv: ["keys", "add", "--generate", "-u", locked[0], ...srv], user: locked[0] }
            : { label: "Keys only", argv: ["harden", "ssh", ...srv], confirm: "Only keys log in afterwards; lf undo turns passwords back on." },
    });
  }
  // Without root ufw and fail2ban cannot be asked: say nothing rather than guess.
  // A provider firewall that is always in front does ufw's job: no warning for leaving ufw off.
  const front = cloudFirewall(s.cloud);
  if (front && (s.firewall === "inactive" || s.firewall === "missing")) {
    out.push({
      id: "firewall",
      level: "info",
      title: `Firewall: the ${front}`,
      why: `It is in front of this server and closed until you open a port there. Let in only ssh, 80 and 443. ufw is not needed on top.`,
    });
  } else if (s.firewall === "inactive" || (s.firewall === "missing" && installs)) {
    out.push({
      id: "firewall",
      level: "warn",
      title: s.firewall === "missing" ? "No firewall" : "Firewall is off",
      why: "Every port a program opens is reachable from the internet. ufw lets in ssh, 80 and 443, and what you allow.",
      fix: { label: "Turn it on", argv: ["firewall", "enable", ...srv] },
    });
  } else if (s.firewall === "missing") {
    out.push({
      id: "firewall",
      level: "info",
      title: own?.firewall ? "Firewall: the system's own" : "No ufw",
      why: own?.firewall ? `${own.firewall}. Let in only ssh, 80 and 443.` : "Use firewalld or your provider's firewall to let in only ssh, 80 and 443.",
    });
  }
  // Keys only and no fail2ban: nothing to guess, nothing to ban. lf harden fail2ban still installs it.
  const wanted = i.fail2ban === "stopped" || (installs && s.passwordLogin);
  if (i.root && i.fail2ban !== "running" && wanted) {
    out.push({
      id: "fail2ban",
      level: s.passwordLogin ? "warn" : "info",
      title: i.fail2ban === "missing" ? "No fail2ban" : "fail2ban is not running",
      why: "It bans addresses that keep failing to log in: it slows password guessing and keeps the logs readable.",
      fix: { label: i.fail2ban === "missing" ? "Install it" : "Start it", argv: ["harden", "fail2ban", ...srv] },
    });
  } else if (i.fail2ban === "missing" && own?.bans) {
    out.push({ id: "fail2ban", level: "info", title: "Login bans: the system's own", why: own.bans });
  }
  if (s.autoUpdates === false) {
    out.push({
      id: "auto-updates",
      level: "warn",
      title: "No automatic security updates",
      why: "Holes in OpenSSH, the kernel or libraries get fixed within days; without automatic updates they stay open until someone runs lf update.",
      fix: { label: "Turn them on", argv: ["harden", "updates", ...srv] },
    });
  }
  if (s.reboot) {
    out.push({
      id: "reboot",
      level: "info",
      title: "Reboot pending",
      why: "Installed updates (a new kernel or libc) only take effect after a reboot.",
      fix: { label: "Reboot", argv: ["reboot", ...srv] },
    });
  }
  const rank: Record<Level, number> = { risk: 0, warn: 1, info: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

export function printAdvice(list: Advice[]) {
  for (const a of list) {
    const mark = a.level === "risk" ? c.red("!") : a.level === "warn" ? c.yellow("!") : c.dim("·");
    console.log(`${mark} ${c.bold(a.title)}\n  ${c.dim(a.why)}${a.fix ? `\n  ${c.cyan(`lf ${a.fix.argv.join(" ")}`)}` : ""}`);
  }
}

/** The server's system info and what to fix on it. `admin`: a root or sudo login already at hand. */
export async function securityOf(name: string, s: Server, admin?: Server) {
  const i = admin ? await system(admin) : await fullSystem(s);
  return { ...i, advice: advise(i, { name, loginUser: effectiveSsh(s).user }) };
}

/** After setup or server add: what is still open. Never fails the command it follows. */
export async function securityNotes(name: string, s: Server, admin?: Server) {
  try {
    const l = (await securityOf(name, s, admin)).advice;
    report({ advice: l });
    if (!l.length) return;
    console.log(`\n${c.bold("Security")}`);
    printAdvice(l);
  } catch {
    // The server answered a moment ago; a hiccup here only costs the advice.
  }
}

const HARDEN = String.raw`
if [ "$H_SSH" = 1 ]; then
  if [ -d /etc/ssh ]; then
${HARDEN_SSH}
  else log "no /etc/ssh, ssh skipped"; fi
fi
if [ "$H_F2B" = 1 ]; then
  if ! command -v fail2ban-client >/dev/null 2>&1; then
    log "installing fail2ban"
    pkg_install fail2ban || { echo "could not install fail2ban (RHEL-likes have it in EPEL)" >&2; exit 1; }
    record "installed fail2ban"
  fi
  # Debian 12 logs to the journal only: the sshd jail's /var/log/auth.log never appears and fail2ban will not start.
  jail=/etc/fail2ban/jail.d/00-landfall.local
  if [ ! -e /var/log/auth.log ] && [ ! -e /var/log/secure ] && [ -d /run/systemd/system ] && [ ! -e $jail ]; then
    printf '[sshd]\nbackend = systemd\n' | $SUDO tee $jail >/dev/null
    record "fail2ban reads sshd's log from the journal" "\$SUDO rm -f $jail"
  fi
  if ! $SUDO fail2ban-client ping >/dev/null 2>&1; then
    log "starting fail2ban"
    # restart: a running fail2ban that does not answer gets the jail written above.
    { svc enable fail2ban; svc restart fail2ban; } >/dev/null 2>&1 || true
    up=0; for _ in 1 2 3 4 5 6; do $SUDO fail2ban-client ping >/dev/null 2>&1 && { up=1; break; }; sleep 1; done
    if [ $up = 1 ]; then record "started fail2ban" 'svc stop fail2ban; svc disable fail2ban'
    else echo "fail2ban did not start; see: lf services logs fail2ban" >&2; exit 1; fi
  fi
fi
if [ "$H_UPDATES" = 1 ]; then
  case "$(pkg_mgr)" in
    apt-get)
      pkg_has unattended-upgrades || { log "installing unattended-upgrades"; pkg_install unattended-upgrades; record "installed unattended-upgrades"; }
      if ! apt_auto_updates; then
        log "turning on automatic security updates"
        f=/etc/apt/apt.conf.d/20auto-upgrades
        undo=$(saved $f)
        printf '%s\n' 'APT::Periodic::Update-Package-Lists "1";' 'APT::Periodic::Unattended-Upgrade "1";' | $SUDO tee $f >/dev/null
        record "turned on automatic security updates" "$undo"
      fi ;;
    apk)
      if ! apk_auto_updates; then
        log "turning on automatic updates"
        # A stable Alpine branch only gets fixes, so upgrading all of it is what apt's security updates do.
        f=/etc/periodic/daily/landfall-upgrade
        if [ ! -e $f ]; then
          printf '#!/bin/sh\napk upgrade --no-cache --quiet\n' | $SUDO tee $f >/dev/null && $SUDO chmod 755 $f
          record "turned on automatic updates" "\$SUDO rm -f $f"
        fi
        if ! pidof crond >/dev/null; then
          { svc enable crond; svc start crond; } >/dev/null 2>&1 || { echo "could not start crond, which runs $f" >&2; exit 1; }
          record "started crond" 'svc stop crond; svc disable crond'
        fi
      fi ;;
    dnf)
      pkg_has dnf-automatic || { log "installing dnf-automatic"; pkg_install dnf-automatic && record "installed dnf-automatic"; }
      if dnf_auto_updates; then :
      elif systemctl cat dnf-automatic-install.timer >/dev/null 2>&1; then
        $SUDO systemctl enable --now dnf-automatic-install.timer >/dev/null
        record "turned on automatic updates" '$SUDO systemctl disable --now dnf-automatic-install.timer'
      else
        # dnf5 (Fedora 41+): one timer, and automatic.conf says whether it installs.
        log "turning on automatic updates"
        f=/etc/dnf/automatic.conf
        if ! dnf_applies; then
          undo=$(saved $f)
          if grep -q '^[[:space:]]*apply_updates' $f 2>/dev/null; then $SUDO sed -i 's/^[[:space:]]*apply_updates.*/apply_updates = yes/' $f
          elif grep -q '^\[commands\]' $f 2>/dev/null; then $SUDO sed -i '/^\[commands\]/a apply_updates = yes' $f
          else printf '[commands]\napply_updates = yes\n' | $SUDO tee -a $f >/dev/null; fi
          record "automatic updates install, not only download" "$undo"
        fi
        t=dnf5-automatic.timer; systemctl cat $t >/dev/null 2>&1 || t=dnf-automatic.timer
        if ! systemctl is-enabled -q $t 2>/dev/null; then
          $SUDO systemctl enable --now $t >/dev/null
          record "turned on automatic updates" "\$SUDO systemctl disable --now $t"
        fi
      fi ;;
    *) echo "automatic updates: landfall knows apt, apk and dnf; on $(pkg_mgr) set them up by hand" >&2; exit 1 ;;
  esac
fi
`;

/** Runs as an admin login (root or passwordless sudo); every change is journaled for lf undo. */
export async function harden(admin: Server, parts: HardenPart[]) {
  await runScript(admin, PRELUDE + HARDEN, {
    env: { H_SSH: parts.includes("ssh"), H_F2B: parts.includes("fail2ban"), H_UPDATES: parts.includes("updates") },
  });
}

/**
 * A key pair for <user> on server <name>, at ~/.ssh/<name>_<user> (kept if it exists). In a terminal
 * ssh-keygen asks for a passphrase; elsewhere (the web UI) the key gets none.
 */
export function generateKey(name: string, user: string): { path: string; created: boolean; passphrase: boolean; pub: string } {
  if (!/^[a-z_][a-z0-9_.-]*$/i.test(user)) fail(`not a user name: ${user}`);
  const path = join(homedir(), ".ssh", `${checkAlias(name)}_${user}`);
  const passphrase = interactive();
  const created = keygen(path, `${user}@${name}`, passphrase);
  if (!fs.existsSync(`${path}.pub`)) fail(`${path} exists without ${path}.pub; move it away or pass the public key`);
  return { path, created, passphrase: created && passphrase, pub: fs.readFileSync(`${path}.pub`, "utf8").trim() };
}
