import { useEffect } from "react";
import type { Graph, GraphNode, GraphOptions, ServerInput } from "../../../../core/views/infra-graph";
import { S } from "../../lib/store";
import type { SiteStatus } from "../../lib/types";
import { fetchInto } from "../../lib/api";
import { ensureDns } from "../domains";

export const registered = () => S.state.servers.filter((s) => s.registered);

export const projects = () => S.state.projects ?? [];

export const siteOf = (n?: string, name?: string): SiteStatus | undefined => (n ? S.overview[n]?.data?.sites.find((x) => x.meta.name === name) : undefined);

export const projectOf = (n?: string, name?: string) => projects().find((p) => p.server === n && p.name === name);

/** What the map draws for each registered server: its overview once read, else why not. */
export function inputs(): ServerInput[] {
  return registered().map((s) => {
    const slot = S.overview[s.name];
    const reach = S.reach[s.name]?.state as ServerInput["reach"];
    const note =
      slot?.loading && !slot.data
        ? "reading…"
        : !reach
          ? "checking ssh…"
          : reach !== "ok" && !slot?.data
            ? reach === "login"
              ? "login refused"
              : "unreachable"
            : undefined;
    return { name: s.name, target: s.target, isDefault: s.isDefault, reach, overview: slot?.data, error: slot?.error, note };
  });
}

/** A domain's dot: green when it points here and answers on https, amber when DNS points elsewhere, red when https fails. */
export function domainHealth(g: Graph) {
  for (const x of g.nodes) {
    if (x.kind !== "domain" || !x.server) continue;
    const d = S.dns[x.server]?.data?.domains.find((y) => y.domain === x.ref);
    if (!d) continue;
    x.health = !d.ok ? "warn" : d.https.ok ? "up" : "down";
    x.sub = [x.sub, !d.ok ? (d.ips.length ? `points at ${d.ips[0]}` : "no DNS record") : d.https.status ? `https ${d.https.status}` : (d.https.error ?? "")]
      .filter(Boolean)
      .join(" · ");
  }
  return g;
}

/** Reads what the map needs: the overview of every reachable server, then where its domains point. */
export function useMapData() {
  const ready = registered()
    .map((s) => `${s.name}:${S.reach[s.name]?.state ?? ""}:${S.overview[s.name]?.data ? 1 : 0}`)
    .join(",");
  useEffect(() => {
    for (const s of registered()) {
      const n = s.name;
      if (S.reach[n]?.state === "ok" && !S.overview[n]) fetchInto("overview", n, "");
      ensureDns(n, S.overview[n]?.data);
    }
  }, [ready]);
}

export const reloadAll = () => {
  for (const s of registered())
    if (S.reach[s.name]?.state !== "down") fetchInto("overview", s.name, "").then(() => ensureDns(s.name, S.overview[s.name]?.data, true));
};

/** Layer toggles and folded servers, remembered in this browser. */
export type Prefs = { layers: Required<Omit<GraphOptions, "folded">>; folded: string[] };

const PREFS = "landfall.map";

export function loadPrefs(): Prefs {
  const all = { containers: true, volumes: true, domains: true, others: true, add: true };
  try {
    const p = JSON.parse(localStorage.getItem(PREFS) ?? "{}") as Partial<Prefs>;
    return { layers: { ...all, ...p.layers }, folded: Array.isArray(p.folded) ? p.folded : [] };
  } catch {
    return { layers: all, folded: [] };
  }
}

export function savePrefs(p: Prefs) {
  try {
    localStorage.setItem(PREFS, JSON.stringify(p));
  } catch {
    // Private window or blocked storage: the map still works, it just forgets.
  }
}

/** A node and everything upstream and downstream of it: the path traffic and deploys take through it. */
export function chain(g: Graph, id: string): Set<string> {
  const out = new Set([id]);
  for (const down of [true, false]) {
    const seen = new Set([id]);
    const todo = [id];
    while (todo.length) {
      const c = todo.pop()!;
      for (const e of g.edges) {
        const [a, b] = down ? [e.from, e.to] : [e.to, e.from];
        if (a === c && !seen.has(b)) (seen.add(b), out.add(b), todo.push(b));
      }
    }
  }
  return out;
}

export const isProblem = (x: GraphNode) => x.kind !== "add" && (x.health === "down" || x.health === "warn");
