import { S, http, render, server, errorMessage, type Slot, type StoreName } from "./store";
import type { Reach, State } from "./types";
import { pluginTab, type PluginTab, type UiBlock } from "../../../core/plugin-api";
import { toast } from "../ui/toast";
import { closeDialog, dialogOpen } from "../ui/dialog";

// ---- routing: #/<server>/<tab> ---------------------------------------------

/** Set while the hash changes through go(): any other change is the browser's back or forward. */
let ours = false;
export function go(sel: string | null, tab = S.tab) {
  const hash = sel ? `#/${encodeURIComponent(sel)}/${tab}` : "#/";
  if (location.hash !== hash) ((ours = true), (location.hash = hash));
  else route();
}
/** The infrastructure map; its hash has no slash, so no server name can take it. */
export function goMap() {
  if (location.hash !== "#map") ((ours = true), (location.hash = "#map"));
}
export function route() {
  // Back or forward leaves the page a dialog was opened on: a dialog left open would act on what is no longer shown.
  if (!ours && dialogOpen()) closeDialog();
  ours = false;
  const [, name, tab] = location.hash.split("/");
  S.map = location.hash === "#map";
  S.sel = name ? decodeURIComponent(name) : null;
  S.tab = tab && (tab in STORE || pluginNameOf(tab)) ? tab : "sites";
  if (S.sel && server()) load(S.sel, S.tab);
  render();
}

// ---- loading -------------------------------------------------------------

export type CoreTab = "sites" | "tunnels" | "stats" | "traffic" | "traefik" | "facts" | "updates" | "firewall" | "users" | "system" | "history" | "settings";
/** A core section, or a plugin's: plugin-<name>. */
export type Tab = CoreTab | PluginTab;
export const STORE: Record<CoreTab, StoreName> = {
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
};
const URLS: Record<CoreTab, string> = {
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
  ["system", "System", "Machine"],
  ["settings", "Settings", "Machine"],
];

/** The plugin a plugin-<name> tab shows, if one with a panel is loaded. */
export const pluginNameOf = (tab: string) => S.state?.plugins.find((p) => p.panel && !p.error && pluginTab(p.name) === tab)?.name;

// The overview and facts drive the header, so every tab needs them.
export const needs = (tab: string): CoreTab[] =>
  !(tab in STORE) || STORE[tab as CoreTab] === "overview" ? ["sites", "facts"] : ["sites", "facts", tab as CoreTab];
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
  for (const t of todo) fetchTab(name, t);
  const plugin = pluginNameOf(tab);
  if (plugin && (force || !S.plugin[pluginKey(name, plugin)])) loadPlugin(name, plugin);
  if (todo.length || plugin) render();
}
/** Only the tab itself again, not the sites and facts it needs: for polling. */
export function reload(name: string, tab: Tab) {
  const plugin = pluginNameOf(tab);
  if (plugin) loadPlugin(name, plugin);
  else fetchTab(name, tab as CoreTab);
  render();
}

// ---- plugin panels: GET /api/servers/<n>/plugins/<plugin> -------------------

export const pluginKey = (n: string, plugin: string) => `${n}\0${plugin}`;
/** A plugin panel's blocks for server n, into S.plugin; what is shown stays while it reloads. */
export function loadPlugin(n: string, plugin: string) {
  const key = pluginKey(n, plugin);
  S.plugin[key] = { ...S.plugin[key], loading: true, error: undefined };
  const me = {};
  latest.set(`plugin\0${key}`, me);
  const mine = () => latest.get(`plugin\0${key}`) === me;
  return http<UiBlock[]>(`/api/servers/${encodeURIComponent(n)}/plugins/${encodeURIComponent(plugin)}`).then(
    (data) => void (mine() && ((S.plugin[key] = { data }), render())),
    (e) => void (mine() && ((S.plugin[key] = { error: errorMessage(e) }), render())),
  );
}
const fetchTab = (name: string, t: CoreTab) =>
  fetchInto(STORE[t], name, `${URLS[t]}${t === "traffic" ? `?since=${S.since}` : ""}`, t === "stats" ? (data) => logStats(name, data as never) : undefined);
export function invalidate(name: string) {
  delete S.dns[name];
  delete S.errs[name];
  delete S.certs[name];
  delete S.proxy[name];
  // What is on screen reloads in place; other tabs reload when opened.
  const shown = new Set(S.sel === name ? needs(S.tab).map((t) => STORE[t]) : []);
  for (const k of Object.values(STORE)) if (!shown.has(k)) delete S[k][name];
  const open = S.sel === name ? pluginNameOf(S.tab) : undefined;
  for (const k of Object.keys(S.plugin)) if (k.startsWith(`${name}\0`) && k !== pluginKey(name, open ?? "")) delete S.plugin[k];
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
    // One line per server as its answer comes: quick servers show before a dead one times out.
    const r = await fetch(`/api/reach?stream=1${fresh ? "&fresh=1" : ""}`);
    if (r.status === 401) throw new Error("This browser is not logged in. Open the link `lf ui` printed.");
    if (!r.ok || !r.body) throw new Error(`${r.status} ${r.statusText}`);
    const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    let finished = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      const lines = buf.split("\n");
      buf = lines.pop()!;
      for (const line of lines) {
        if (!line) continue;
        const m = JSON.parse(line) as { name?: string; reach?: Reach; done?: boolean; error?: string };
        if (m.error) throw new Error(m.error);
        if (m.name && m.reach) S.reach = { ...S.reach, [m.name]: m.reach };
        if (m.done) ((finished = true), (S.reachedAt = new Date()));
      }
      render();
    }
    if (!finished) throw new Error("the check stopped before every server answered");
  } catch (e) {
    toast(`Checking servers failed: ${errorMessage(e)}`);
  } finally {
    S.reaching = false;
    S.reachSettled = true;
    render();
  }
}
