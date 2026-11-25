// The infrastructure map: every registered server with its Traefik, sites, containers, volumes and domains as
// connected nodes. Ghost nodes add what is missing; every write is the same lf command the other pages run.
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from "react";
import {
  ArrowRightLeft,
  Box,
  ChevronsDownUp,
  ChevronsUpDown,
  CircleCheck,
  Container,
  ExternalLink,
  FolderGit2,
  Globe,
  HardDrive,
  Laptop,
  Maximize2,
  Package,
  Plus,
  RotateCw,
  Server,
  TriangleExclamationPoint,
  Waypoints,
  X,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from "lucide-react";
import {
  infraGraph,
  GRAPH_COLUMNS,
  NODE_H,
  NODE_W,
  columnX,
  type Graph,
  type GraphEdge,
  type GraphNode,
  type GraphOptions,
  type Health,
  type NodeKind,
  type ServerInput,
} from "../../../core/infra-graph";
import { S, sv } from "../lib/store";
import type { Overview, SiteStatus } from "../lib/types";
import { fetchInto, go } from "../lib/api";
import { run } from "../lib/jobs";
import { Btn, Dot, cx, MONO } from "../ui/kit";
import { addServer, deployFrom, folderDialog, redeploy, setupFlow } from "./flows";
import { ensureDns, runCommand, siteSettings } from "./domains";

const PAD = 48;
const HEAD = 40;
const MIN_K = 0.25;
const MAX_K = 1.6;
/** Fitting never shrinks the map below this; the rest is a scroll away. */
const FIT_K = 0.6;
/** Room for the search and zoom bar above the map. */
const TOOLBAR = 44;

const ICON: Record<NodeKind, LucideIcon> = {
  machine: Laptop,
  project: FolderGit2,
  server: Server,
  proxy: Waypoints,
  site: Package,
  external: Box,
  container: Container,
  service: Container,
  volume: HardDrive,
  domain: Globe,
  redirect: ArrowRightLeft,
  add: Plus,
};
const TINT: Partial<Record<NodeKind, string>> = {
  machine: "text-dim",
  project: "text-dim",
  server: "text-accent",
  proxy: "text-accent",
  site: "text-accent",
  domain: "text-ok",
};
const STROKE: Record<Health, string> = { up: "var(--ok)", warn: "var(--warn)", down: "var(--bad)", "": "var(--line-strong)" };
const DASHED = new Set(["tunnel", "deploys", "redirect"]);
const LAYERS: [Exclude<keyof GraphOptions, "folded">, string][] = [
  ["containers", "Containers"],
  ["volumes", "Volumes"],
  ["domains", "Domains"],
  ["others", "Not landfall's"],
  ["add", "Add buttons"],
];

const registered = () => S.state.servers.filter((s) => s.registered);
const projects = () => S.state.projects ?? [];
const siteOf = (n?: string, name?: string): SiteStatus | undefined => (n ? S.overview[n]?.data?.sites.find((x) => x.meta.name === name) : undefined);
const projectOf = (n?: string, name?: string) => projects().find((p) => p.server === n && p.name === name);

/** What the map draws for each registered server: its overview once read, else why not. */
function inputs(): ServerInput[] {
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
function domainHealth(g: Graph) {
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
function useMapData() {
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
const reloadAll = () => {
  for (const s of registered())
    if (S.reach[s.name]?.state !== "down") fetchInto("overview", s.name, "").then(() => ensureDns(s.name, S.overview[s.name]?.data, true));
};

/** Layer toggles and folded servers, remembered in this browser. */
type Prefs = { layers: Required<Omit<GraphOptions, "folded">>; folded: string[] };
const PREFS = "landfall.map";
function loadPrefs(): Prefs {
  const all = { containers: true, volumes: true, domains: true, others: true, add: true };
  try {
    const p = JSON.parse(localStorage.getItem(PREFS) ?? "{}") as Partial<Prefs>;
    return { layers: { ...all, ...p.layers }, folded: Array.isArray(p.folded) ? p.folded : [] };
  } catch {
    return { layers: all, folded: [] };
  }
}
function savePrefs(p: Prefs) {
  try {
    localStorage.setItem(PREFS, JSON.stringify(p));
  } catch {
    // Private window or blocked storage: the map still works, it just forgets.
  }
}

/** A node and everything upstream and downstream of it: the path traffic and deploys take through it. */
function chain(g: Graph, id: string): Set<string> {
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

const isProblem = (x: GraphNode) => x.kind !== "add" && (x.health === "down" || x.health === "warn");

export function MapView() {
  useMapData();
  const [prefs, setPrefs] = useState(loadPrefs);
  const { layers, folded } = prefs;
  const setLayers = (f: (l: Prefs["layers"]) => Prefs["layers"]) => setPrefs((p) => ((p = { ...p, layers: f(p.layers) }), savePrefs(p), p));
  const fold = (server: string) =>
    setPrefs((p) => ((p = { ...p, folded: p.folded.includes(server) ? p.folded.filter((x) => x !== server) : [...p.folded, server] }), savePrefs(p), p));
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [view, setView] = useState({ x: PAD, y: PAD, k: 1 });
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [glide, setGlide] = useState(false);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const touched = useRef(false);
  const pan = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const cursor = useRef({ problem: -1, match: -1 });

  const g = domainHealth(infraGraph(inputs(), projects(), { ...layers, folded }));
  const byId = new Map(g.nodes.map((x) => [x.id, x]));
  const W = g.width + PAD * 2;
  const H = g.height + HEAD + PAD * 2;
  const picked = sel ? byId.get(sel) : undefined;
  // The inspector covers the right of the map: centre in what is left.
  const side = picked && size.w > 900 ? 340 : 0;

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  /** Moves the view with a short glide instead of a jump. */
  const glideTo = (v: typeof view) => {
    // A hidden tab holds CSS transitions: jump there instead. So does a wish for less motion.
    const still = document.hidden || matchMedia("(prefers-reduced-motion: reduce)").matches;
    setGlide(!still);
    setView(v);
    setTimeout(() => setGlide(false), 320);
  };

  const fit = () => {
    const el = box.current;
    if (!el) return;
    // The whole map when it fits; else its width, at a size still readable, from the top.
    const cw = el.clientWidth;
    const ch = el.clientHeight - TOOLBAR;
    const k = Math.min(1, cw / W, Math.max(ch / H, FIT_K));
    setView({ k, x: Math.max(0, (cw - W * k) / 2), y: TOOLBAR + Math.max(0, (ch - H * k) / 2) });
  };
  // Fit while servers are still being read, until the first pan or zoom.
  const fitNow = useRef(fit);
  fitNow.current = fit;
  useLayoutEffect(() => void (touched.current || fitNow.current()), [W, H]);

  /** Selects a node and brings it to the middle of the free part of the map. */
  const focusNode = (id: string) => {
    const x = byId.get(id);
    const el = box.current;
    if (!x || !el) return;
    touched.current = true;
    setSel(id);
    const k = Math.max(view.k, FIT_K);
    const free = el.clientWidth - (el.clientWidth > 900 ? 340 : 0);
    glideTo({ k, x: free / 2 - (PAD + x.x + NODE_W / 2) * k, y: (el.clientHeight + TOOLBAR) / 2 - (PAD + HEAD + x.y + NODE_H / 2) * k });
  };

  const zoomAt = (k: number, cx: number, cy: number) =>
    setView((v) => {
      const nk = Math.min(MAX_K, Math.max(MIN_K, k));
      return { k: nk, x: cx - ((cx - v.x) * nk) / v.k, y: cy - ((cy - v.y) * nk) / v.k };
    });
  const zoomBy = (f: number) => {
    const el = box.current!;
    touched.current = true;
    zoomAt(view.k * f, el.clientWidth / 2, el.clientHeight / 2);
  };
  // Wheel pans, pinch (or ctrl+wheel) zooms; React's wheel listener is passive, so it is added here.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest("aside")) return;
      e.preventDefault();
      touched.current = true;
      if (e.ctrlKey || e.metaKey) {
        const r = el.getBoundingClientRect();
        setView((v) => {
          const nk = Math.min(MAX_K, Math.max(MIN_K, v.k * Math.exp(-e.deltaY * 0.01)));
          const cx = e.clientX - r.left;
          const cy = e.clientY - r.top;
          return { k: nk, x: cx - ((cx - v.x) * nk) / v.k, y: cy - ((cy - v.y) * nk) / v.k };
        });
      } else setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, []);

  const down = (e: RPointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("[data-node],[data-ui]")) return;
    pan.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const move = (e: RPointerEvent) => {
    const p = pan.current;
    if (!p) return;
    touched.current = true;
    setView((v) => ({ ...v, x: p.vx + e.clientX - p.x, y: p.vy + e.clientY - p.y }));
  };
  const up = (e: RPointerEvent) => {
    const p = pan.current;
    pan.current = null;
    // A click on the background, not a drag: clear the selection.
    if (p && Math.abs(e.clientX - p.x) + Math.abs(e.clientY - p.y) < 4) setSel(null);
  };

  // The pointer lights a node's neighbours; a selection lights its whole path. A search dims what does not match.
  const near = hover ? new Set([hover, ...g.edges.flatMap((e) => (e.from === hover || e.to === hover ? [e.from, e.to] : []))]) : sel ? chain(g, sel) : null;
  const needle = q.trim().toLowerCase();
  const match = (x: GraphNode) => !needle || `${x.label} ${x.sub ?? ""} ${x.server ?? ""}`.toLowerCase().includes(needle);
  const dim = (x: GraphNode) => (near ? !near.has(x.id) : !match(x));
  const matches = needle ? g.nodes.filter((x) => x.kind !== "add" && match(x)) : [];
  const problems = g.nodes.filter(isProblem).sort((a, b) => a.y - b.y || a.x - b.x);
  const nDown = problems.filter((x) => x.health === "down").length;
  const step = (list: GraphNode[], k: "problem" | "match", by = 1) => {
    if (!list.length) return;
    cursor.current[k] = (cursor.current[k] + by + list.length) % list.length;
    focusNode(list[cursor.current[k]].id);
  };

  // Keys: / finds, Esc clears, + and - zoom, 0 fits, n jumps to the next problem.
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e) => {
    const t = e.target as HTMLElement;
    if (e.metaKey || e.ctrlKey || e.altKey || t.closest("input,textarea,select,[contenteditable]") || document.querySelector("dialog[open]")) return;
    const act: Record<string, () => void> = {
      "/": () => search.current?.focus(),
      Escape: () => setSel(null),
      "+": () => zoomBy(1.2),
      "=": () => zoomBy(1.2),
      "-": () => zoomBy(1 / 1.2),
      "0": () => ((touched.current = false), fit()),
      n: () => step(problems, "problem"),
      N: () => step(problems, "problem", -1),
    };
    const f = act[e.key];
    if (!f) return;
    e.preventDefault();
    f();
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  const loading = registered().some((s) => S.overview[s.name]?.loading);

  return (
    <div
      ref={box}
      className="relative h-full overflow-hidden select-none touch-none cursor-grab active:cursor-grabbing bg-[radial-gradient(var(--line-strong)_1px,transparent_1px)] bg-size-[22px_22px]"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={() => (pan.current = null)}
    >
      <div
        className={cx("absolute left-0 top-0 origin-top-left", glide && "transition-transform duration-300 ease-out")}
        style={{ transform: `translate(${view.x}px,${view.y}px) scale(${view.k})`, width: W, height: H }}
      >
        {GRAPH_COLUMNS.map(([c, label]) => (
          <div
            key={c}
            className="absolute text-xs font-semibold uppercase tracking-[.06em] text-faint"
            style={{ left: PAD + columnX(c), top: PAD - 4, width: NODE_W }}
          >
            {label}
          </div>
        ))}
        {g.bands.map((b) => (
          <div
            key={b.server}
            className={cx("absolute rounded-xl border transition-colors", dropOn === b.server ? "border-accent bg-accent-bg" : "border-line bg-panel/40")}
            style={{ left: PAD + columnX("server") - 14, top: PAD + HEAD + b.y - 12, width: g.width - columnX("server") + 28, height: b.h + 24 }}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes(PROJECT)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
              setDropOn(b.server);
            }}
            onDragLeave={() => setDropOn((x) => (x === b.server ? null : x))}
            onDrop={(e) => {
              const path = e.dataTransfer.getData(PROJECT);
              setDropOn(null);
              if (!path) return;
              e.preventDefault();
              deployFrom(path, b.server);
            }}
          >
            {dropOn === b.server && <span className="absolute right-3 top-2 text-xs font-semibold text-accent">Drop to deploy on {b.server}</span>}
          </div>
        ))}
        <svg className="absolute left-0 top-0 overflow-visible pointer-events-none" width={W} height={H}>
          <style>{"@keyframes lf-flow{to{stroke-dashoffset:-18}}@media (prefers-reduced-motion:reduce){.lf-flow{animation:none!important}}"}</style>
          {g.edges.map((e) => {
            const lit = !!near && near.has(e.from) && near.has(e.to);
            return <Edge key={e.id} e={e} g={byId} on={lit} off={!!near && !lit} />;
          })}
        </svg>
        {g.nodes.map((x) => (
          <Node
            key={x.id}
            x={x}
            on={x.id === sel}
            dim={dim(x)}
            hit={!!needle && match(x)}
            folded={x.kind === "server" && folded.includes(x.server!)}
            enter={() => setHover(x.id)}
            leave={() => setHover((h) => (h === x.id ? null : h))}
            click={() => (x.kind === "add" ? addAction(x) : setSel(x.id === sel ? null : x.id))}
            open={() => openNode(x)}
          />
        ))}
      </div>

      <div data-ui className="absolute left-3 top-3 right-3 flex flex-wrap items-center gap-2 pointer-events-none [&>*]:pointer-events-auto">
        <div className="relative">
          <input
            ref={search}
            type="search"
            value={q}
            onChange={(e) => ((cursor.current.match = -1), setQ(e.target.value))}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.preventDefault(), step(matches, "match", e.shiftKey ? -1 : 1));
              if (e.key === "Escape") (setQ(""), e.currentTarget.blur());
            }}
            placeholder="Find a site, domain, container…  /"
            aria-label="Find on the map"
            className="w-[260px] max-w-full px-2.5 py-1.5 pr-16 text-md rounded-md border border-line bg-panel shadow-xs"
          />
          {needle && (
            <span className={cx(MONO, "absolute right-7 top-1/2 -translate-y-1/2 text-xs pointer-events-none", matches.length ? "text-faint" : "text-bad")}>
              {matches.length ? `${cursor.current.match >= 0 ? cursor.current.match + 1 : "–"}/${matches.length}` : "0"}
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-1 p-1 rounded-md border border-line bg-panel shadow-xs">
          {LAYERS.map(([k, label]) => (
            <button
              key={k}
              type="button"
              aria-pressed={layers[k]}
              className={cx(
                "px-2 py-0.5 text-sm rounded-sm border-0 shadow-none",
                layers[k] ? "bg-accent-bg text-accent" : "bg-transparent text-faint hover:bg-hover",
              )}
              onClick={() => setLayers((l) => ({ ...l, [k]: !l[k] }))}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          type="button"
          title={problems.length ? "Jump to the next problem (n)" : "Nothing on the map is down or warning"}
          onClick={() => step(problems, "problem")}
          disabled={!problems.length}
          className={cx(
            "flex items-center gap-1.5 px-2.5 py-1.5 text-sm rounded-md border border-line bg-panel shadow-xs disabled:opacity-100 disabled:cursor-default",
            nDown ? "text-bad" : problems.length ? "text-warn" : "text-ok",
          )}
        >
          {problems.length ? <TriangleExclamationPoint className="size-3.5" aria-hidden="true" /> : <CircleCheck className="size-3.5" aria-hidden="true" />}
          {problems.length
            ? [nDown ? `${nDown} down` : "", problems.length - nDown ? `${problems.length - nDown} warning${problems.length - nDown === 1 ? "" : "s"}` : ""]
                .filter(Boolean)
                .join(" · ")
            : loading
              ? "Reading…"
              : "All up"}
        </button>
      </div>

      <Legend />
      {/* Zoom controls and the overview sit bottom right, left of the inspector when it is open. */}
      <div data-ui className="absolute bottom-3 flex items-end gap-2" style={{ right: side + 12 }}>
        <div className="flex flex-col items-center gap-1 p-1 rounded-md border border-line bg-panel shadow-xs">
          {g.bands.length > 1 && (
            <IconBtn
              icon={folded.length ? ChevronsUpDown : ChevronsDownUp}
              label={folded.length ? "Unfold every server" : "Fold every server"}
              on={() => setPrefs((p) => ((p = { ...p, folded: p.folded.length ? [] : g.bands.map((b) => b.server) }), savePrefs(p), p))}
            />
          )}
          <IconBtn icon={ZoomOut} label="Zoom out (-)" on={() => zoomBy(1 / 1.2)} />
          <span className={cx(MONO, "py-0.5 text-xs text-dim")}>{Math.round(view.k * 100)}%</span>
          <IconBtn icon={ZoomIn} label="Zoom in (+)" on={() => zoomBy(1.2)} />
          <IconBtn icon={Maximize2} label="Fit to the window (0)" on={() => ((touched.current = false), fit())} />
          <IconBtn icon={RotateCw} label="Read every server again" on={reloadAll} spin={loading} />
        </div>
        <Minimap
          g={g}
          W={W}
          H={H}
          view={view}
          size={size}
          jump={(x, y) => ((touched.current = true), setView((v) => ({ ...v, x: (size.w - side) / 2 - x * v.k, y: size.h / 2 - y * v.k })))}
        />
      </div>
      {picked && <Inspector x={picked} g={g} close={() => setSel(null)} folded={folded.includes(picked.server ?? "")} fold={fold} />}
    </div>
  );
}

/** The whole map in small, with the visible part framed; a click or drag moves the view there. */
function Minimap({
  g,
  W,
  H,
  view,
  size,
  jump,
}: {
  g: Graph;
  W: number;
  H: number;
  view: { x: number; y: number; k: number };
  size: { w: number; h: number };
  jump: (x: number, y: number) => void;
}) {
  // Only worth it when the map does not fit the window.
  if (!size.w || (W * view.k <= size.w && H * view.k <= size.h)) return null;
  const s = Math.min(180 / W, 150 / H);
  const at = (e: RPointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    jump((e.clientX - r.left) / s, (e.clientY - r.top) / s);
  };
  return (
    <svg
      data-ui
      width={W * s}
      height={H * s}
      className="rounded-md border border-line bg-panel shadow-xs cursor-pointer max-[760px]:hidden"
      onPointerDown={(e) => (e.currentTarget.setPointerCapture(e.pointerId), at(e))}
      onPointerMove={(e) => e.buttons === 1 && at(e)}
      aria-label="Overview of the map"
      role="img"
    >
      {g.bands.map((b) => (
        <rect
          key={b.server}
          x={(PAD + columnX("server") - 14) * s}
          y={(PAD + HEAD + b.y - 12) * s}
          width={(g.width - columnX("server") + 28) * s}
          height={(b.h + 24) * s}
          rx={2}
          fill="none"
          stroke="var(--line-strong)"
          strokeWidth={0.75}
        />
      ))}
      {g.nodes.map((x) => (
        <rect
          key={x.id}
          x={(PAD + x.x) * s}
          y={(PAD + HEAD + x.y) * s}
          width={NODE_W * s}
          height={Math.max(2, NODE_H * s)}
          rx={1}
          fill={x.health === "down" ? "var(--bad)" : x.health === "warn" ? "var(--warn)" : "var(--line-strong)"}
          opacity={x.kind === "add" ? 0.4 : 1}
        />
      ))}
      <rect
        x={(-view.x / view.k) * s}
        y={(-view.y / view.k) * s}
        width={(size.w / view.k) * s}
        height={(size.h / view.k) * s}
        fill="var(--accent-bg)"
        fillOpacity={0.35}
        stroke="var(--accent)"
        strokeWidth={1.25}
        rx={2}
      />
    </svg>
  );
}

const PROJECT = "application/x-landfall-project";

function IconBtn({ icon: I, label, on, spin }: { icon: LucideIcon; label: string; on: () => void; spin?: boolean }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={on}
      className="grid place-items-center size-7 rounded-sm border-0 bg-transparent shadow-none text-dim hover:bg-hover hover:text-fg"
    >
      <I className={cx("size-3.5", spin && "animate-spin")} aria-hidden="true" />
    </button>
  );
}

function Edge({ e, g, on, off }: { e: GraphEdge; g: Map<string, GraphNode>; on: boolean; off: boolean }) {
  const a = g.get(e.from);
  const b = g.get(e.to);
  if (!a || !b) return null;
  // Left to right from a's right side to b's left side; a redirect host points back at its site.
  const back = b.x < a.x;
  const x1 = PAD + a.x + (back ? 0 : NODE_W);
  const x2 = PAD + b.x + (back ? NODE_W : 0);
  const y1 = PAD + HEAD + a.y + NODE_H / 2;
  const y2 = PAD + HEAD + b.y + NODE_H / 2;
  const dx = Math.max(40, Math.abs(x2 - x1) / 2) * (back ? -1 : 1);
  const ghost = b.kind === "add";
  return (
    <path
      d={`M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`}
      fill="none"
      stroke={on ? "var(--accent)" : STROKE[e.health]}
      strokeWidth={on ? 2 : 1.5}
      // A lit path flows from its source to its end.
      strokeDasharray={on ? "6 3" : ghost || DASHED.has(e.kind) ? "5 4" : undefined}
      opacity={off ? 0.18 : ghost ? 0.55 : 1}
      className={cx("transition-[opacity,stroke] duration-150", on && "lf-flow")}
      style={on ? { animation: "lf-flow .8s linear infinite" } : undefined}
    >
      <title>{`${a.label} → ${b.label} (${e.kind})`}</title>
    </path>
  );
}

function Node(p: {
  x: GraphNode;
  on: boolean;
  dim: boolean;
  hit: boolean;
  folded: boolean;
  enter: () => void;
  leave: () => void;
  click: () => void;
  open: () => void;
}) {
  const { x } = p;
  const I = ICON[x.kind];
  const ghost = x.kind === "add";
  return (
    <button
      type="button"
      data-node
      draggable={x.kind === "project"}
      onDragStart={(e) => {
        e.dataTransfer.setData(PROJECT, x.ref!);
        e.dataTransfer.effectAllowed = "copy";
      }}
      onPointerEnter={p.enter}
      onPointerLeave={p.leave}
      onClick={p.click}
      onDoubleClick={p.open}
      title={x.kind === "project" ? `${x.sub}\nDrag onto a server to deploy it there` : [x.label, x.sub].filter(Boolean).join("\n")}
      className={cx(
        "absolute flex items-center gap-2.5 px-2.5 text-left rounded-lg transition-[opacity,box-shadow,border-color] duration-150",
        ghost
          ? "border-[1.5px] border-dashed border-line-strong bg-transparent text-dim shadow-none hover:border-accent hover:text-accent hover:bg-accent-bg"
          : "border border-line bg-panel shadow-xs hover:border-line-strong hover:shadow-lg",
        x.kind === "project" && "cursor-grab",
        p.on && "border-accent! shadow-[0_0_0_3px_var(--accent-bg)]!",
        p.hit && "border-accent!",
        p.dim && "opacity-35",
      )}
      style={{ left: PAD + x.x, top: PAD + HEAD + x.y, width: NODE_W, height: NODE_H }}
    >
      <span className={cx("grid place-items-center size-7 flex-none rounded-md", ghost ? "" : "bg-hover", TINT[x.kind] ?? "text-dim")}>
        <I className="size-3.5" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-[550] text-md leading-tight">{x.label}</span>
        {x.sub && <span className="block truncate text-xs text-faint leading-tight mt-0.5">{x.sub}</span>}
      </span>
      {p.folded && <ChevronsUpDown className="size-3.5 flex-none text-faint" aria-label="folded" />}
      {!ghost && x.kind !== "machine" && x.kind !== "project" && <Dot kind={x.health} className="m-0" />}
    </button>
  );
}

function Legend() {
  const row = (label: string, stroke: string, dash?: boolean) => (
    <div className="flex items-center gap-2">
      <svg width="26" height="8" aria-hidden="true">
        <path d="M1,4 H25" stroke={stroke} strokeWidth="1.5" strokeDasharray={dash ? "5 4" : undefined} />
      </svg>
      {label}
    </div>
  );
  return (
    <div
      data-ui
      className="absolute left-3 bottom-3 px-3 py-2 rounded-md border border-line bg-panel/90 shadow-xs text-xs text-dim grid gap-1 max-[760px]:hidden"
    >
      {row("routed, up", "var(--ok)")}
      {row("failing or refused", "var(--bad)")}
      {row("warning", "var(--warn)")}
      {row("tunnel only, deploy, redirect", "var(--line-strong)", true)}
      <div className="faint mt-0.5">Drag a project onto a server to deploy it there.</div>
      <div className="faint">
        <kbd>/</kbd> find · <kbd>n</kbd> next problem · <kbd>0</kbd> fit · <kbd>Esc</kbd> clear
      </div>
    </div>
  );
}

/** A ghost node: the lf command that adds it. */
function addAction(x: GraphNode) {
  const n = x.server!;
  if (x.add === "server") return addServer();
  if (x.add === "setup") return setupFlow([n]);
  if (x.add === "site") return void folderDialog(S.state.cwd, undefined, n);
  const site = siteOf(n, x.site);
  if (x.add === "domain" && site) siteSettings(n, site);
}

/** Double click: the page that shows it. */
function openNode(x: GraphNode) {
  if (x.kind === "add") return addAction(x);
  if (!x.server) return;
  if (x.kind === "proxy" || x.kind === "redirect") return go(x.server, "traefik");
  if (x.site) S.open.add(`${x.server}/${x.site}`);
  go(x.server, "sites");
}

function Inspector({ x, g, close, folded, fold }: { x: GraphNode; g: Graph; close: () => void; folded: boolean; fold: (server: string) => void }) {
  const n = x.server;
  const ov: Overview | undefined = n ? S.overview[n]?.data : undefined;
  const site = siteOf(n, x.site);
  const proj = x.kind === "project" ? projects().find((p) => p.path === x.ref) : projectOf(n, x.site);
  const links = g.edges.filter((e) => e.from === x.id || e.to === x.id).length;
  const rows: [string, ReactNode][] = [];
  const acts: [string, () => void, string?][] = [];
  const open =
    (tab = "sites") =>
    () => (x.site && S.open.add(`${n}/${x.site}`), go(n!, tab));

  switch (x.kind) {
    case "machine":
      rows.push(["Servers", registered().length], ["Projects", projects().length], ["Folder", S.state.cwd]);
      acts.push(["Add a server", addServer, "lf server add"], ["Deploy a folder", () => void folderDialog(S.state.cwd)]);
      break;
    case "server": {
      const s = registered().find((y) => y.name === n);
      rows.push(["Address", s?.target], ["ssh login", S.reach[n!]?.state ?? "not checked"], ["Sites", ov?.sites.length ?? "…"]);
      if (ov) rows.push(["Traefik", ov.traefik || "not installed"]);
      if (S.overview[n!]?.error) rows.push(["Error", <span className="text-bad">{S.overview[n!]!.error}</span>]);
      acts.push(["Open", open()]);
      if (ov?.ready) acts.push(["Deploy here…", () => void folderDialog(S.state.cwd, undefined, n), "lf deploy -s " + n]);
      acts.push(["Set up / check", () => setupFlow([n!]), "lf setup --check"], ["Run a command…", () => runCommand(n!)]);
      if (ov) acts.push([folded ? "Unfold on the map" : "Fold on the map", () => fold(n!), "show only the server and its proxy"]);
      break;
    }
    case "proxy":
      rows.push(["Status", ov?.traefik], ["Container", ov?.proxy], ["Owner", ov?.adopted ? "yours (adopted)" : "landfall"]);
      if (ov?.dashboard.hosts.length) rows.push(["Dashboard", ov.dashboard.hosts.join(", ")]);
      acts.push(["Open Traefik", open("traefik")], ["Status", () => run(["traefik", "status", ...sv(n!)]), "lf traefik status"]);
      break;
    case "site":
      if (site) {
        rows.push(
          ["Kind", site.kind],
          ["Status", site.status || "not running"],
          ["Services", site.services.length],
          ["Domains", site.domains.join(", ") || "none: tunnel only"],
        );
        if (site.redirects.length) rows.push(["Redirects", site.redirects.join(", ")]);
        if (site.meta.adopted) rows.push(["Adopted from", <span className={MONO}>{site.meta.adopted}</span>]);
        if (proj) rows.push(["Project", <span className={MONO}>{proj.path}</span>]);
        acts.push(["Open", open()]);
        if (proj) acts.push(["Redeploy", () => redeploy(proj.path, n!, site.meta.name, site.kind, proj.environment), "lf deploy"]);
        acts.push(
          ["Domains and settings…", () => siteSettings(n!, site)],
          ["Logs", () => run(["logs", site.meta.name, ...sv(n!), "-f"]), "lf logs -f"],
          ["Restart", () => run(["restart", site.meta.name, ...sv(n!)]), "lf restart"],
        );
        if (site.domains[0]) acts.push([`Visit ${site.domains[0]}`, () => void window.open(`https://${site.domains[0]}`, "_blank", "noopener")]);
      }
      break;
    case "service":
      rows.push(["Site", x.site], ["Status", x.sub], ["Container", <span className={MONO}>{site?.services.find((s) => s.service === x.ref)?.container}</span>]);
      acts.push(
        ["Logs", () => run(["logs", x.site!, x.ref!, ...sv(n!), "-f"]), "lf logs -f"],
        ["Restart", () => run(["restart", x.site!, x.ref!, ...sv(n!)]), "lf restart"],
        ["Open site", open()],
      );
      break;
    case "volume":
      rows.push(["Site", x.site], ["Volume", <span className={MONO}>{x.ref}</span>]);
      acts.push(["Open site", open()], ["List volumes", () => run(["volume", "ls", x.site!, ...sv(n!)]), "lf volume ls"]);
      break;
    case "domain": {
      const d = S.dns[n!]?.data?.domains.find((y) => y.domain === x.ref);
      rows.push(
        ["Server", n],
        ["DNS", d ? (d.ok ? `points here (${d.ips.join(", ")})` : d.ips.length ? `points at ${d.ips.join(", ")}` : "no record") : "checking…"],
      );
      if (d) rows.push(["HTTPS", d.https.ok ? `${d.https.status} in ${d.https.ms} ms` : (d.https.error ?? `status ${d.https.status}`)]);
      if (d?.https.tls) rows.push(["Certificate", `${d.https.tls.valid ? "valid" : "not trusted"}, ${d.https.tls.days} days left`]);
      acts.push([`Visit ${x.ref}`, () => void window.open(`https://${x.ref}`, "_blank", "noopener")]);
      if (site) acts.push(["Domains and settings…", () => siteSettings(n!, site)]);
      break;
    }
    case "external": {
      const e = ov?.others.find((y) => y.name === x.ref);
      rows.push(["Status", e?.status], ["Containers", e?.containers.join(", ")], ["Domains", e?.domains.join(", ") || "none"]);
      acts.push(["Open", open()]);
      break;
    }
    case "container": {
      // One container, or every container of a Compose project.
      const list = ov?.unrouted.filter((y) => y.container === x.ref || y.project === x.ref) ?? [];
      const c = list.length === 1 ? list[0] : undefined;
      if (c) {
        rows.push(["Image", <span className={MONO}>{c.image}</span>], ["Status", c.status], ["Ports", c.ports.join(", ") || "none"]);
        if (c.project) rows.push(["Compose project", c.project]);
      } else
        for (const y of list)
          rows.push([
            y.container,
            <span>
              <span className={MONO}>{y.image}</span> · {y.status}
              {y.ports.length ? ` · :${y.ports.join(", :")}` : ""}
            </span>,
          ]);
      acts.push(["Open tunnels", open("tunnels")]);
      break;
    }
    case "redirect": {
      const r = ov?.redirects.list.find((y) => y.host === x.ref);
      rows.push(["From", r?.host], ["To", r?.to], ["Kind", r?.permanent ? "permanent (308)" : "temporary (307)"]);
      acts.push(["Open Traefik", open("traefik")]);
      break;
    }
    case "project":
      rows.push(["Folder", <span className={MONO}>{x.ref}</span>], ["Server", x.server], ["Site", x.site]);
      if (proj?.environment) rows.push(["Environment", proj.environment]);
      if (proj && site) acts.push(["Redeploy", () => redeploy(proj.path, proj.server, proj.name, proj.kind, proj.environment), "lf deploy"]);
      acts.push(["Deploy…", () => deployFrom(x.ref!), "review, then lf deploy"]);
      for (const s of registered())
        if (s.name !== x.server && S.overview[s.name]?.data?.ready) acts.push([`Deploy to ${s.name}…`, () => deployFrom(x.ref!, s.name)]);
      break;
  }
  const I = ICON[x.kind];
  return (
    <aside
      data-ui
      className="absolute right-3 top-14 bottom-3 w-[320px] max-w-[calc(100%-24px)] overflow-auto rounded-lg border border-line bg-panel shadow-lg"
    >
      <div className="flex items-start gap-2.5 px-4 pt-3.5 pb-3 border-b border-line">
        <span className={cx("grid place-items-center size-8 flex-none rounded-md bg-hover", TINT[x.kind] ?? "text-dim")}>
          <I className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-[15px] truncate flex items-center gap-1.5">
            {x.label}
            {x.kind !== "machine" && x.kind !== "project" && <Dot kind={x.health} className="m-0" />}
          </div>
          <div className="text-xs text-faint">
            {x.kind}
            {n && x.kind !== "server" ? ` on ${n}` : ""} · {links} {links === 1 ? "link" : "links"}
          </div>
        </div>
        <IconBtn icon={X} label="Close" on={close} />
      </div>
      <dl className="m-0 px-4 py-3 grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
        {rows
          .filter(([, v]) => v !== undefined && v !== "")
          .map(([k, v]) => [
            <dt key={`k${k}`} className="text-faint">
              {k}
            </dt>,
            <dd key={`v${k}`} className="m-0 wrap-anywhere">
              {v}
            </dd>,
          ])}
      </dl>
      {acts.length > 0 && (
        <div className="px-4 pb-4 grid gap-1.5">
          {acts.map(([label, on, hint], i) => (
            <Btn key={label} cls={cx(i === 0 ? "primary" : "", "justify-between w-full")} on={on} title={hint}>
              <span>{label}</span>
              {label.startsWith("Visit") && <ExternalLink className="inline-block size-3 ml-1 -mt-px align-middle" aria-hidden="true" />}
            </Btn>
          ))}
        </div>
      )}
      {x.kind === "project" && <div className="px-4 pb-4 text-xs text-faint">Or drag it onto a server's band to deploy it there.</div>}
    </aside>
  );
}
