import type { PointerEvent as RPointerEvent } from "react";
import { BOX, NODE_H, NODE_W, type Graph } from "../../../../core/views/infra-graph";
import { PAD, HEAD } from "./layout";

/** The whole map in small, with the visible part framed; a click or drag moves the view there. */
export function Minimap({
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
  const w = W * s;
  const h = H * s;
  const inset = 1;
  const x0 = Math.min(w - inset, Math.max(inset, (-view.x / view.k) * s));
  const y0 = Math.min(h - inset, Math.max(inset, (-view.y / view.k) * s));
  const x1 = Math.max(x0, Math.min(w - inset, ((size.w - view.x) / view.k) * s));
  const y1 = Math.max(y0, Math.min(h - inset, ((size.h - view.y) / view.k) * s));
  const frame = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
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
          x={(PAD + BOX.x) * s}
          y={(PAD + HEAD + b.y) * s}
          width={BOX.w * s}
          height={b.h * s}
          rx={2}
          fill="none"
          stroke="var(--line-strong)"
          strokeWidth={0.75}
        />
      ))}
      {g.nodes
        .filter((x) => x.kind !== "server")
        .map((x) => (
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
      {/* The visible part, cut to the overview's edges so its frame stays whole. */}
      <rect {...frame} fill="var(--accent-bg)" fillOpacity={0.35} stroke="var(--accent)" strokeWidth={1.25} rx={2} />
    </svg>
  );
}
