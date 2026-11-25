import { BOX, NODE_H, NODE_W, type GraphEdge, type GraphNode } from "../../../../core/views/infra-graph";
import { cx } from "../../ui/kit";
import { PAD, HEAD, STROKE, DASHED } from "./layout";

/** Where an edge leaves or enters a node: a server box is entered at its header. */
const anchor = (x: GraphNode) => PAD + HEAD + x.y + (x.kind === "server" ? BOX.head / 2 : NODE_H / 2);

/** A path with right angles and rounded corners, its vertical run at xm. */
function elbow(x1: number, y1: number, xm: number, x2: number, y2: number) {
  if (Math.abs(y2 - y1) < 1) return `M${x1},${y1} H${x2}`;
  const r = Math.min(10, Math.abs(y2 - y1) / 2, Math.abs(xm - x1), Math.abs(x2 - xm));
  const dy = Math.sign(y2 - y1);
  const dx1 = Math.sign(xm - x1);
  const dx2 = Math.sign(x2 - xm);
  return `M${x1},${y1} H${xm - dx1 * r} Q${xm},${y1} ${xm},${y1 + dy * r} V${y2 - dy * r} Q${xm},${y2} ${xm + dx2 * r},${y2} H${x2}`;
}

export function Edge({ e, g, on, off }: { e: GraphEdge; g: Map<string, GraphNode>; on: boolean; off: boolean }) {
  const a = g.get(e.from);
  const b = g.get(e.to);
  // What a server runs sits inside its box: the box says it, a line would only cross it.
  if (!a || !b || a.kind === "server") return null;
  // Left to right from a's right side to b's left side; a redirect host points back at its site.
  const back = b.x < a.x;
  const x1 = PAD + a.x + (back ? 0 : NODE_W);
  const x2 = PAD + b.x + (back ? NODE_W : 0);
  const y1 = anchor(a);
  const y2 = anchor(b);
  // Neighbouring columns: right angles, so a proxy's routes share one trunk. Longer reaches curve.
  const near = !back && x2 - x1 <= 60;
  const dx = Math.max(40, Math.abs(x2 - x1) / 2) * (back ? -1 : 1);
  const d = near ? elbow(x1, y1, x1 + (x2 - x1) / 2, x2, y2) : `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
  const ghost = b.kind === "add";
  return (
    <path
      d={d}
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
