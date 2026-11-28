// No imports with side effects: the web page reads this list too.
import type { Server } from "../lib/config";

/** What `lf tenant add|limits` and the web page accept per limit; `none` lifts it. */
export const LIMIT_RULES = {
  memory: { re: /^(none|\d+(\.\d+)?[KMGT]?)$/i, hint: "a size like 512M or 2G" },
  cpu: { re: /^(none|\d+%)$/, hint: "a percentage like 150%" },
  tasks: { re: /^(none|\d+)$/, hint: "a number" },
} as const;

/** The local ports of the tenants' own Traefik: never a public port. */
export const PORTS = { min: 20000, max: 20999 } as const;

/** What the admin allows a tenant beyond its domains and limits; tenants/<user>.json, unset is the default. */
export interface Rights {
  /** false: the tenant may not have a crontab (/etc/cron.deny). */
  cron?: boolean;
  /** Ports the firewall opens for the tenant's own containers, like 25565/tcp. */
  ports?: string[];
}

/** Why `p` cannot be a tenant's public port; undefined when it can. */
export function publicPortError(p: string): string | undefined {
  const m = /^(\d+)\/(tcp|udp)$/.exec(p);
  if (!m) return `${p} is not a port like 25565/tcp`;
  const n = Number(m[1]);
  if (n < 1024 || n > 65535) return `${p}: a tenant can only listen on ports 1024 to 65535`;
  if (n >= PORTS.min && n <= PORTS.max) return `${p}: ${PORTS.min}-${PORTS.max} are the local ports of the tenants' Traefik`;
}

/** Rights as tenants/<user>.json keeps them: only what differs from the default. */
export function cleanRights(r: Rights): Rights | undefined {
  const out: Rights = { ...(r.cron === false && { cron: false }), ...(r.ports?.length && { ports: [...new Set(r.ports)].sort() }) };
  return Object.keys(out).length ? out : undefined;
}

export const rightsText = (r?: Rights) => [r?.cron === false && "no cron", ...(r?.ports ?? [])].filter(Boolean).join(", ") || "default";

export interface Invite {
  user: string;
  /** The address the tenant reaches the server at. */
  host: string;
  port?: number;
  domains: string[];
  rights?: Rights;
}

const IP = /^[\d.]+$|:/;

/** What the admin sends a new tenant: install, login, Traefik, DNS, first deploy. Text only: the web page shows it too. */
export function tenantInvite({ user, host, port, domains, rights }: Invite): string {
  const p = port && port !== 22 ? port : undefined;
  const key = "~/.ssh/id_ed25519";
  const w = Math.max(...domains.map((d) => d.length));
  const record = IP.test(host) ? `${host.includes(":") ? "AAAA" : "A"}  ${host}` : `the same address as ${host}`;
  const site = domains.find((d) => d.startsWith("*."))?.replace("*", "www") ?? domains[0];
  const notes = [
    rights?.ports?.length &&
      `Open ports: ${rights.ports.join(", ")}. Your Docker publishes on 127.0.0.1 unless a port says otherwise: write 0.0.0.0:PORT:PORT in compose.`,
    rights?.cron === false && "Cron is off for you: lf autodeploy and scheduled volume backups do not work.",
  ].filter(Boolean);
  return [
    `Your login on ${host} as ${user}. You get your own Docker, sites and Traefik for ${domains.join(", ")}.`,
    "",
    "1. Install lf (Node 22.4 or newer)",
    "",
    "   npm i -g landfall",
    "",
    `2. Add the server, with the key whose public half you sent (${key}.pub)`,
    "",
    `   lf server add ${user} --host ${host}${p ? ` --port ${p}` : ""} --user ${user} -i ${key}`,
    "",
    "   Or put it into ~/.ssh/config first, then lf server add takes it from there:",
    "",
    `   Host ${user}`,
    `     HostName ${host}`,
    ...(p ? [`     Port ${p}`] : []),
    `     User ${user}`,
    `     IdentityFile ${key}`,
    "",
    `   lf server add ${user}`,
    "",
    "3. Start your Traefik: it gets the certificates for your domains",
    "",
    `   lf traefik setup -s ${user} --email you@example.com`,
    "",
    "4. Point your domains at the server",
    "",
    ...domains.map((d) => `   ${d.padEnd(w)}  ${record}`),
    "",
    "5. Deploy, from a project folder",
    "",
    `   lf deploy -s ${user} -d ${site}`,
    "",
    ...(notes.length ? [...notes, ""] : []),
    `lf ls -s ${user} lists your sites, lf ui opens the web UI. Docs: https://ph1p.github.io/landfall/tenants`,
  ].join("\n");
}

/** What a tenant login may run. A command missing here is refused on a tenant server. */
export const TENANT_COMMANDS: ReadonlySet<string> = new Set([
  "deploy",
  "refs",
  "promote",
  "git track",
  "git key",
  "autodeploy",
  "adopt",
  "sites list",
  "sites info",
  "sites rm",
  "logs",
  "env",
  "secret",
  "restart",
  "stop",
  "start",
  "rollback",
  "release rm",
  "tunnel",
  "tunnels",
  "scale",
  "weight",
  "redirects",
  "redirect add",
  "redirect rm",
  "registries",
  "registry login",
  "registry logout",
  "volumes",
  "volume add",
  "volume rm",
  "volume backup",
  "volume backup rm",
  "volume pull",
  "volume push",
  "volume restore",
  "domains",
  "auth",
  "open",
  "check",
  "stats",
  "disk",
  "traffic",
  "certs",
  "prune",
  "traefik status",
  "traefik logs",
  "traefik dashboard",
  "traefik setup",
  "traefik restart",
  "traefik access-log",
  "traefik strict-tls",
  "history",
  "undo",
  "server add",
  "server list",
  "server info",
  "server config",
  "server domain",
  "server use",
  "server rm",
  "ssh",
  "init",
  "eject",
  "keygen",
  "config",
  "ui",
  "plugins",
  "plugin add",
  "plugin rm",
  "plugin new",
]);

/** Plugin commands that say a tenant may run them (PluginCommand.tenant). */
export const tenantPluginCommands = new Set<string>();

/** The lf command this process runs; unset in the web UI's server, which only reads. */
export const running: { cmd?: string } = {};

/** Why `cmd` may not run on s, a tenant login; undefined when it may. */
export function tenantRefusal(name: string, s: Server, cmd = running.cmd): string | undefined {
  if (!s.tenant || !cmd || TENANT_COMMANDS.has(cmd) || tenantPluginCommands.has(cmd)) return;
  return `lf ${cmd} is for the admin of ${name}; ${s.user ?? "this login"} is a tenant there`;
}
