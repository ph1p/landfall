import { S, http, render, server, errorMessage, type Slot, type StoreName } from "./store";
import type { Reach, State } from "./types";
import { toast } from "../ui/toast";

// ---- routing: #/<server>/<tab> ---------------------------------------------

export function go(sel: string | null, tab = S.tab) {
  const hash = sel ? `#/${encodeURIComponent(sel)}/${tab}` : "#/";
  if (location.hash !== hash) location.hash = hash;
  else route();
}
export function route() {
  const [, name, tab] = location.hash.split("/");
  S.sel = name ? decodeURIComponent(name) : null;
  S.tab = tab && tab in STORE ? tab : "sites";
  if (S.sel && server()) load(S.sel, S.tab);
  render();
}

// ---- loading -------------------------------------------------------------

export type Tab = "sites" | "tunnels" | "stats" | "traffic" | "traefik" | "facts" | "updates" | "firewall" | "users" | "system" | "history" | "settings";
export const STORE: Record<Tab, StoreName> = { sites: "overview", tunnels: "overview", stats: "stats", traffic: "traffic", traefik: "settings", facts: "facts", updates: "updates", firewall: "firewall", users: "users", system: "system", history: "history", settings: "settings" };
const URLS: Record<Tab, string> = { sites: "", tunnels: "", stats: "/stats", traffic: "/traffic", traefik: "/config", facts: "/facts", updates: "/updates", firewall: "/firewall", users: "/users", system: "/system", history: "/history", settings: "/config" };
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
  ["system", "System", "Machine"],
  ["settings", "Settings", "Machine"],
];

// The overview and facts drive the header, so every tab needs them.
export const needs = (tab: string): Tab[] => (STORE[tab as Tab] === "overview" ? ["sites", "facts"] : ["sites", "facts", tab as Tab]);
/** Fetches server n's url into S[store][n]: loading, then { data } or { error }, and renders. */
const latest = new Map<string, object>();
export function fetchInto(store: StoreName, n: string, url: string, then?: (data: unknown) => void) {
  // Keep what is shown while it reloads; views show a spinner only when they have nothing yet.
  S[store][n] = { ...S[store][n], loading: true, error: undefined };
  // Only the last request for a slot fills it: a slow older answer must not overwrite a newer one.
  const key = `${store}\0${n}`;
  const me = {};
  latest.set(key, me);
  const mine = () => latest.get(key) === me;
  return http(`/api/servers/${encodeURIComponent(n)}${url}`).then(
    (data) => void (mine() && (then?.(data), ((S[store] as Record<string, Slot>)[n] = { data }), render())),
    (e) => void (mine() && ((S[store][n] = { error: errorMessage(e) }), render())),
  );
}
/** Fetches store's slot for n once, for views outside the tab stores: the sites' error card and certificates. */
export function ensure(store: StoreName, n: string, url: string) {
  if (!S[store][n]) fetchInto(store, n, url);
}

// The last samples per server, for the sparklines: 5 minutes at one per 5s.
export const STATS_LOG = 60;
function logStats(n: string, s: { cpu: number; mem: { total: number; available: number } }) {
  const log = (S.statsLog[n] ??= []);
  log.push({ cpu: s.cpu, mem: s.mem.total ? ((s.mem.total - s.mem.available) / s.mem.total) * 100 : 0 });
  if (log.length > STATS_LOG) log.shift();
}

/** Fetch what a tab needs (again when forced), showing it as loading right away. */
export function load(name: string, tab: string, force = false) {
  const todo = needs(tab).filter((t) => force || !S[STORE[t]][name]);
  for (const t of todo) fetchInto(STORE[t], name, `${URLS[t]}${t === "traffic" ? `?since=${S.since}` : ""}`, t === "stats" ? (data) => logStats(name, data as never) : undefined);
  if (todo.length) render();
}
export function invalidate(name: string) {
  delete S.dns[name];
  delete S.errs[name];
  delete S.certs[name];
  // What is on screen reloads in place; other tabs reload when opened.
  const shown = new Set(S.sel === name ? needs(S.tab).map((t) => STORE[t]) : []);
  for (const k of Object.values(STORE)) if (!shown.has(k)) delete S[k][name];
  if (S.sel === name) load(name, S.tab, true);
}
export async function refreshState() {
  S.state = await http<State>("/api/state");
  render();
}
/** Which servers take landfall's ssh login; the server caches each answer for 30s unless fresh. */
export async function loadReach(fresh = false) {
  if (S.reaching) return;
  S.reaching = true;
  render();
  try {
    S.reach = await http<Record<string, Reach>>(`/api/reach${fresh ? "?fresh=1" : ""}`);
    S.reachedAt = new Date();
  } catch (e) {
    toast(`Checking servers failed: ${errorMessage(e)}`);
  } finally {
    S.reaching = false;
    render();
  }
}
