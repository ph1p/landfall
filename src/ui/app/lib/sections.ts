// The server's sections, their stores and routes, and which a tenant login sees. No page code: the unit tests read it.
import { aliases } from "../../../core/lib/aliases";
import { TENANT_COMMANDS } from "../../../core/server/tenant-policy";
import type { PluginTab } from "../../../core/plugins/plugin-api";
import type { Cap } from "../../../core/server/facts";

export type CoreTab =
  | "sites"
  | "tunnels"
  | "stats"
  | "traffic"
  | "traefik"
  | "facts"
  | "updates"
  | "firewall"
  | "users"
  | "system"
  | "history"
  | "settings"
  | "tenants";
/** A core section, or a plugin's: plugin-<name>. */
export type Tab = CoreTab | PluginTab;
export const STORE = {
  sites: "overview",
  tunnels: "overview",
  stats: "stats",
  traffic: "traffic",
  traefik: "settings",
  facts: "facts",
  updates: "updates",
  firewall: "firewall",
  users: "users",
  system: "system",
  history: "history",
  settings: "settings",
  tenants: "tenants",
} as const satisfies Record<CoreTab, string>;
export const URLS: Record<CoreTab, string> = {
  sites: "",
  tunnels: "",
  stats: "/stats",
  traffic: "/traffic",
  traefik: "/config",
  facts: "/facts",
  updates: "/updates",
  firewall: "/firewall",
  users: "/users",
  system: "/system",
  history: "/history",
  settings: "/config",
  tenants: "/tenants",
};
// A server's sections and the group each sits in, in the list and as tabs on phones; keys 1-9 switch between them.
export const SECTIONS: [Tab, string, string][] = [
  ["sites", "Sites", "Apps"],
  ["tunnels", "Tunnels", "Apps"],
  ["stats", "Stats", "Monitoring"],
  ["traffic", "Traffic", "Monitoring"],
  ["history", "History", "Monitoring"],
  ["traefik", "Traefik", "Network"],
  ["firewall", "Firewall", "Network"],
  ["updates", "Updates", "Machine"],
  ["users", "Users", "Machine"],
  ["tenants", "Tenants", "Machine"],
  ["system", "System", "Machine"],
  ["settings", "Settings", "Machine"],
];

type Caps = Record<Cap, boolean>;
/** When each section is worth a tab: the same conditions the CLI checks before doing it. */
export const SECTION_IF: Partial<Record<CoreTab, (k: Caps, tenant: boolean) => unknown>> = {
  sites: (k) => k.docker || k.setup,
  tunnels: (k) => k.docker,
  traffic: (k) => k.docker,
  traefik: (k) => k.docker,
  updates: (k, tenant) => !tenant && (k.packages || k.docker),
  firewall: (k) => k.firewall,
  users: (k) => k.users,
  system: (_, tenant) => !tenant,
  tenants: (k) => k.tenants,
};
/** Sections a tenant login sees as the admin does: they read only its own sites, Docker and journal. */
export const SAME_FOR_TENANTS: CoreTab[] = ["stats", "history", "settings"];

export const showSection = (t: string, k: Caps, tenant: boolean) => SECTION_IF[t as CoreTab]?.(k, tenant) ?? true;

/** Whether a tenant login may run argv: the CLI's own allowlist, and plugin commands that say so. The CLI checks again: this only spares a job that would fail. */
export function tenantMay(argv: string[], plugin: readonly string[] = []): boolean {
  const end = argv.findIndex((a) => a.startsWith("-"));
  const words = argv.slice(0, Math.min(end < 0 ? argv.length : end, 3));
  for (let i = words.length; i > 0; i--) {
    const said = words.slice(0, i).join(" ");
    const cmd = aliases[said] ?? said;
    if (TENANT_COMMANDS.has(cmd) || plugin.includes(cmd)) return true;
  }
  return false;
}
