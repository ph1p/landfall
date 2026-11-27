import { useSyncExternalStore } from "react";
import type { Job } from "./jobs";
import type * as T from "./types";
import type { UiBlock } from "../../../core/plugins/plugin-api";

/** One server's slot in a store: loading, then { data } or { error }; data stays while it reloads. */
export interface Slot<T = unknown> {
  data?: T;
  error?: string;
  loading?: boolean;
}
type Store<T> = Record<string, Slot<T>>;

export const S = {
  state: null as unknown as T.State, // /api/state, loaded before the first render
  sel: null as string | null, // selected server name
  map: false, // the infrastructure map (#map) is shown
  tab: "sites",
  overview: {} as Store<T.Overview>, // name -> {data} | {error} | {loading}
  firewall: {} as Store<T.Firewall>,
  git: {} as Store<T.GitInfo>, // project folder -> {data: /api/git}: its checkout and git rules
  refs: {} as Store<T.RefsView>, // project folder -> {data: /api/git/envs}: what runs in each environment (lf refs --json)
  pipeline: null as string | null, // the project folder whose pipeline (#git/<folder>) is shown
  det: {} as Record<string, T.Detected | null | false>, // project folder -> what /api/fs detected there (null while reading, false if it failed)
  system: {} as Store<T.SystemInfo>, // name -> {data: lf system --json}
  users: {} as Store<T.Users>, // name -> {data: lf users --json}
  tenants: {} as Store<T.Tenants>, // name -> {data: lf tenant ls --json --sizes}
  history: {} as Store<T.Run[]>,
  updates: {} as Record<string, Slot<T.Updates> & { refreshing?: boolean }>,
  facts: {} as Store<T.Facts>,
  stats: {} as Store<T.Stats>, // name -> {data: lf stats --json}; reloads every few seconds while the tab is open
  statsLog: {} as Record<string, { cpu: number; mem: number }[]>, // the last samples, for the sparklines
  scan: {} as Store<T.ImageScan[]>, // name -> {data: lf scan --json}, only on request: a scan takes a while
  disk: {} as Store<T.DiskUsage>, // name -> {data: lf disk --json}, only on request: du takes a while
  settings: {} as Store<T.Config>, // name -> {data: lf server config --json + dns of the main domain}
  dns: {} as Store<T.Dns>, // name -> {data: {ips, domains: [{domain, ips, ok, https: lf check}]}}; checked again each minute
  traffic: {} as Store<T.Traffic>, // name -> {data: lf traffic --json --since S.since}
  since: "24h", // the Traffic tab's range
  focus: {} as Record<string, string | undefined>, // name -> the site the Traffic tab shows alone (lf traffic <site>)
  errs: {} as Store<T.Traffic>, // name -> {data: lf traffic --json --since 24h}, for the sites' errors card
  certs: {} as Store<T.Certs>, // name -> {data: lf certs --json}
  proxy: {} as Store<T.TraefikStatus>, // name -> {data: lf traefik status --json}, for the Traefik tab
  registries: {} as Store<string[]>, // name -> {data: lf registries --json}, for the Settings tab
  plugin: {} as Store<UiBlock[]>, // "<name>\0<plugin>" -> {data: the plugin panel's blocks}
  pluginView: {} as Record<string, string>, // plugin -> the view its panel shows (one of its views' ids), same on every server
  open: new Set<string>(), // expanded site rows
  allSvcs: {} as Record<string, boolean>, // servers whose System tab lists every service
  filter: "", // server list filter
  reach: {} as Record<string, T.Reach>, // from /api/reach
  reaching: false,
  reachedAt: null as Date | null, // when the last check finished
  reachSettled: false, // the first check ended (answered or failed): until then a server shows once its own answer is in
  jobs: new Map<string, Job>(),
  job: null as string | null, // shown job id
};
export type StoreName = { [K in keyof typeof S]: (typeof S)[K] extends Store<unknown> ? K : never }[keyof typeof S];

// S is plain mutable state: whoever changes it calls render(), and the page redraws from it.
let version = 0;
const subs = new Set<() => void>();
export function render() {
  version++;
  for (const f of subs) f();
}
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));
export const useStore = () => useSyncExternalStore(subscribe, () => version);

export async function http<T = unknown>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (r.status === 401) throw new Error("This browser is not logged in. Open the link `lf ui` printed.");
  const data = await r.json().catch(() => ({ error: `${r.status} ${r.statusText}` }));
  if (!r.ok) throw Object.assign(new Error(data.error || r.statusText), { status: r.status });
  return data;
}

export { plural } from "../../../core/lib/format";
export { ago } from "../../../core/lib/ago";
/** The -s flag for server n. */
export const sv = (n: string) => ["-s", n];
/** " -s n" for a shown command, or "" when n is the default server. */
export const svText = (n: string) => (S.state.defaults.default === n ? "" : ` -s ${n}`);
export const serverNamed = (n: string | null | undefined) => S.state?.servers.find((s) => s.name === n);
/** The login is a tenant's: it sees and runs only what the server's admin left to it. */
export const isTenant = (n: string | null | undefined) => !!serverNamed(n)?.saved?.tenant;
/** The open server. */
export const server = () => serverNamed(S.sel);
export const tilde = (p: string) => p.replace(/^\/(Users|home)\/[^/]+/, "~");
export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
