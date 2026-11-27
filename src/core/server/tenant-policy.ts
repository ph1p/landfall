// No imports with side effects: the web page reads this list too.
import type { Server } from "../lib/config";

/** What `lf tenant add|limits` and the web page accept per limit; `none` lifts it. */
export const LIMIT_RULES = {
  memory: { re: /^(none|\d+(\.\d+)?[KMGT]?)$/i, hint: "a size like 512M or 2G" },
  cpu: { re: /^(none|\d+%)$/, hint: "a percentage like 150%" },
  tasks: { re: /^(none|\d+)$/, hint: "a number" },
} as const;

/** How a tenant registers its login. Not `user@host` as the name: ssh would read that as user and host, past the alias. */
export const tenantLogin = (user: string, host: string, port?: number) =>
  `lf server add ${user} --host ${host}${port && port !== 22 ? ` --port ${port}` : ""} --user ${user} -i <key>`;

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
