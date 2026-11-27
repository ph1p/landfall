// What `lf harden` can do, part by part. No node: imports: the web page's Harden dialog reads it too.

/** Each part with what it does; `default`: run by `lf harden` without arguments (and by setup's hardening). */
export const HARDEN_INFO = {
  ssh: { what: "keys only: no passwords, root by key only", default: true },
  fail2ban: { what: "install and start it: bans addresses that keep failing to log in", default: true },
  updates: { what: "install security updates automatically (apt, apk, dnf)", default: true },
  "ssh-options": { what: "sshd: no empty passwords, no X11 forwarding" },
  kernel: { what: "safe network and kernel settings (sysctl, /etc/sysctl.d/90-landfall.conf)" },
  time: { what: "turn on time sync (timedatectl)" },
  accounts: { what: "lock empty passwords (ssh keys keep working)" },
  secrets: { what: "make site .env files readable by their owner only" },
} as const satisfies Record<string, { what: string; default?: true }>;

export type HardenPart = keyof typeof HARDEN_INFO;
export const HARDEN_PARTS = Object.keys(HARDEN_INFO) as HardenPart[];
export const DEFAULT_HARDEN_PARTS = HARDEN_PARTS.filter((p) => "default" in HARDEN_INFO[p]);

/** The environment flag the harden script reads for a part: ssh-options becomes H_SSH_OPTIONS. */
export const hardenFlag = (p: HardenPart) => `H_${p.toUpperCase().replace(/-/g, "_")}`;
