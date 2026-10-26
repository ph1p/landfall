import { useSyncExternalStore } from "react";
import type { Job } from "./jobs";

// The API's payloads are whatever the CLI's --json prints; the views read the fields they show.
export type Any = any;
/** One server's slot in a store: loading, then { data } or { error }; data stays while it reloads. */
export interface Slot<T = Any> { data?: T; error?: string; loading?: boolean }
type Store = Record<string, Slot>;

export const S = {
  state: null as Any,        // /api/state
  sel: null as string | null, // selected server name
  tab: "sites",
  overview: {} as Store,     // name -> {data} | {error} | {loading}
  firewall: {} as Store,
  det: {} as Record<string, Any>, // project folder -> what /api/fs detected there (null while reading, false if it failed)
  system: {} as Store,       // name -> {data: lf system --json}
  history: {} as Store,
  updates: {} as Store,
  facts: {} as Store,
  stats: {} as Store,        // name -> {data: lf stats --json}; reloads every few seconds while the tab is open
  statsLog: {} as Record<string, { cpu: number; mem: number }[]>, // the last samples, for the sparklines
  disk: {} as Store,         // name -> {data: lf disk --json}, only on request: du takes a while
  settings: {} as Store,     // name -> {data: lf server config --json + dns of the main domain}
  dns: {} as Store,          // name -> {data: {ips, domains: [{domain, ips, ok, https: lf check}]}}; checked again each minute
  traffic: {} as Store,      // name -> {data: lf traffic --json --since S.since}
  since: "24h",              // the Traffic tab's range
  errs: {} as Store,         // name -> {data: lf traffic --json --since 24h}, for the sites' errors card
  certs: {} as Store,        // name -> {data: lf certs --json}
  open: new Set<string>(),   // expanded site rows
  allSvcs: {} as Record<string, boolean>, // servers whose System tab lists every service
  filter: "",                // server list filter
  reach: {} as Record<string, { state: "ok" | "login" | "down"; detail?: string; ms?: number }>, // from /api/reach
  reaching: false,
  reachedAt: null as Date | null, // when the last check finished
  jobs: new Map<string, Job>(),
  job: null as string | null, // shown job id
};
export type StoreName = { [K in keyof typeof S]: (typeof S)[K] extends Store ? K : never }[keyof typeof S];

// S is plain mutable state: whoever changes it calls render(), and the page redraws from it.
let version = 0;
const subs = new Set<() => void>();
export function render() {
  version++;
  for (const f of subs) f();
}
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));
export const useStore = () => useSyncExternalStore(subscribe, () => version);

export async function http<T = Any>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (r.status === 401) throw new Error("This browser is not logged in. Open the link `lf ui` printed.");
  const data = await r.json().catch(() => ({ error: `${r.status} ${r.statusText}` }));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

export const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
export function ago(iso: string | Date) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!isFinite(s)) return "";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}
/** The -s flag for server n. */
export const sv = (n: string) => ["-s", n];
export const serverNamed = (n: string | null | undefined): Any => S.state?.servers.find((s: Any) => s.name === n);
/** The open server. */
export const server = () => serverNamed(S.sel);
export const tilde = (p: string) => p.replace(/^\/(Users|home)\/[^/]+/, "~");
export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
