// The infrastructure map: every registered server with its Traefik, sites, containers, volumes and domains as
// connected nodes. Ghost nodes add what is missing; every write is the same lf command the other pages run.
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { ChevronsDownUp, ChevronsUpDown, CircleCheck, Maximize2, RotateCw, TriangleExclamationPoint, ZoomIn, ZoomOut } from "lucide-react";
import { infraGraph, GRAPH_COLUMNS, NODE_H, NODE_W, columnX, type GraphNode } from "../../../../core/views/infra-graph";
import { S } from "../../lib/store";
import { cx, MONO } from "../../ui/kit";
import { deployFrom } from "../flows/deploy";
import { PAD, HEAD, MIN_K, MAX_K, FIT_K, TOOLBAR, EDGE, LAYERS, PROJECT } from "./layout";
import { registered, projects, inputs, domainHealth, useMapData, reloadAll, type Prefs, loadPrefs, savePrefs, chain, isProblem } from "./data";
import { Minimap } from "./minimap";
import { IconBtn, Legend } from "./controls";
import { Edge } from "./edge";
import { ServerBox, Node } from "./nodes";
import { addAction, openNode, Inspector } from "./inspector";

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
  const [view, setRawView] = useState({ x: PAD, y: PAD, k: 1 });
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

  // Panning stops with some of the map still in sight; a map smaller than the window stays inside it.
  const dims = useRef({ W, H });
  dims.current = { W, H };
  type View = typeof view;
  const setView = (next: View | ((v: View) => View)) =>
    setRawView((v) => {
      const n = typeof next === "function" ? next(v) : next;
      const el = box.current;
      if (!el) return n;
      const keep = (pos: number, len: number, room: number, top: number) => {
        const far = room - len * n.k - EDGE;
        return Math.min(Math.max(top, far), Math.max(pos, Math.min(top, far)));
      };
      return { k: n.k, x: keep(n.x, dims.current.W, el.clientWidth, EDGE), y: keep(n.y, dims.current.H, el.clientHeight, TOOLBAR + EDGE) };
    });
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  /** Moves the view with a short glide instead of a jump. */
  const glideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(glideTimer.current), []);
  const glideTo = (v: typeof view) => {
    // A hidden tab holds CSS transitions: jump there instead. So does a wish for less motion.
    const still = document.hidden || matchMedia("(prefers-reduced-motion: reduce)").matches;
    setGlide(!still);
    setView(v);
    clearTimeout(glideTimer.current);
    glideTimer.current = setTimeout(() => setGlide(false), 320);
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
        {g.bands.map((b) => {
          const x = byId.get(`server:${b.server}`);
          if (!x) return null;
          return (
            <ServerBox
              key={b.server}
              x={x}
              h={b.h}
              on={x.id === sel}
              dim={dim(x)}
              hit={!!needle && match(x)}
              drop={dropOn === b.server}
              folded={folded.includes(b.server)}
              fold={() => fold(b.server)}
              enter={() => setHover(x.id)}
              leave={() => setHover((h) => (h === x.id ? null : h))}
              click={() => setSel(x.id === sel ? null : x.id)}
              open={() => openNode(x)}
              dragOver={(e) => {
                if (!e.dataTransfer.types.includes(PROJECT)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
                setDropOn(b.server);
              }}
              dragLeave={(e) => {
                // Moving onto a node inside the box is not leaving it.
                if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
                setDropOn((v) => (v === b.server ? null : v));
              }}
              dropped={(e) => {
                const path = e.dataTransfer.getData(PROJECT);
                setDropOn(null);
                if (!path) return;
                e.preventDefault();
                deployFrom(path, b.server);
              }}
            />
          );
        })}
        <svg className="absolute left-0 top-0 overflow-visible pointer-events-none" width={W} height={H}>
          <style>{"@keyframes lf-flow{to{stroke-dashoffset:-18}}@media (prefers-reduced-motion:reduce){.lf-flow{animation:none!important}}"}</style>
          {g.edges.map((e) => {
            const lit = !!near && near.has(e.from) && near.has(e.to);
            return <Edge key={e.id} e={e} g={byId} on={lit} off={!!near && !lit} />;
          })}
        </svg>
        {g.nodes.map((x) =>
          x.kind === "server" ? null : (
            <Node
              key={x.id}
              x={x}
              on={x.id === sel}
              dim={dim(x)}
              hit={!!needle && match(x)}
              enter={() => setHover(x.id)}
              leave={() => setHover((h) => (h === x.id ? null : h))}
              click={() => (x.kind === "add" ? addAction(x) : setSel(x.id === sel ? null : x.id))}
              open={() => openNode(x)}
            />
          ),
        )}
      </div>

      <div data-ui className="absolute left-3 top-3 right-3 flex flex-wrap items-center gap-2 pointer-events-none *:pointer-events-auto">
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
            className="w-65 max-w-full px-2.5 py-1.5 pr-16 text-md rounded-md border border-line bg-panel shadow-xs"
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
      {/* The overview and, below it, the view controls in one row; left of the inspector when it is open. */}
      <div data-ui className="absolute bottom-3 flex flex-col items-end gap-2" style={{ right: side + 12 }}>
        <Minimap
          g={g}
          W={W}
          H={H}
          view={view}
          size={{ w: size.w - side, h: size.h }}
          jump={(x, y) => ((touched.current = true), setView((v) => ({ ...v, x: (size.w - side) / 2 - x * v.k, y: size.h / 2 - y * v.k })))}
        />
        <div className="flex items-center gap-0.5 p-1 rounded-md border border-line bg-panel shadow-xs">
          <IconBtn icon={ZoomOut} label="Zoom out (-)" on={() => zoomBy(1 / 1.2)} />
          <button
            type="button"
            title="Back to 100%"
            onClick={() => ((touched.current = true), zoomAt(1, (size.w - side) / 2, size.h / 2))}
            className={cx(MONO, "w-11 h-7 rounded-sm border-0 bg-transparent shadow-none text-xs text-dim hover:bg-hover hover:text-fg")}
          >
            {Math.round(view.k * 100)}%
          </button>
          <IconBtn icon={ZoomIn} label="Zoom in (+)" on={() => zoomBy(1.2)} />
          <span className="w-px h-4 mx-1 bg-line" aria-hidden="true" />
          <IconBtn icon={Maximize2} label="Fit to the window (0)" on={() => ((touched.current = false), fit())} />
          {g.bands.length > 1 && (
            <IconBtn
              icon={folded.length ? ChevronsUpDown : ChevronsDownUp}
              label={folded.length ? "Unfold every server" : "Fold every server"}
              on={() => setPrefs((p) => ((p = { ...p, folded: p.folded.length ? [] : g.bands.map((b) => b.server) }), savePrefs(p), p))}
            />
          )}
          <IconBtn icon={RotateCw} label="Read every server again" on={reloadAll} spin={loading} />
        </div>
      </div>
      {picked && <Inspector x={picked} g={g} close={() => setSel(null)} folded={folded.includes(picked.server ?? "")} fold={fold} />}
    </div>
  );
}
