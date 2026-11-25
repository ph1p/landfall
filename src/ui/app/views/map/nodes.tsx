import type { DragEvent } from "react";
import { ChevronsDownUp, ChevronsUpDown, Server } from "lucide-react";
import { BOX, NODE_H, NODE_W, type GraphNode } from "../../../../core/views/infra-graph";
import { Dot, cx, MONO } from "../../ui/kit";
import { PAD, HEAD, ICON, TINT, PROJECT } from "./layout";

/** A server: a box around what runs on it, its header the node to click. Dropping a project on it deploys there. */
export function ServerBox(p: {
  x: GraphNode;
  h: number;
  on: boolean;
  dim: boolean;
  hit: boolean;
  drop: boolean;
  folded: boolean;
  fold: () => void;
  enter: () => void;
  leave: () => void;
  click: () => void;
  open: () => void;
  dragOver: (e: DragEvent<HTMLDivElement>) => void;
  dragLeave: (e: DragEvent<HTMLDivElement>) => void;
  dropped: (e: DragEvent<HTMLDivElement>) => void;
}) {
  const { x } = p;
  return (
    <div
      className={cx(
        "absolute rounded-xl border transition-[border-color,background-color,box-shadow,opacity] duration-150",
        p.drop ? "border-accent bg-accent-bg" : x.health === "down" ? "border-bad/50 bg-panel/45" : "border-line bg-panel/45",
        (p.on || p.hit) && "border-accent! shadow-[0_0_0_3px_var(--accent-bg)]",
      )}
      style={{ left: PAD + BOX.x, top: PAD + HEAD + x.y, width: BOX.w, height: p.h }}
      onDragOver={p.dragOver}
      onDragLeave={p.dragLeave}
      onDrop={p.dropped}
    >
      <div
        className={cx("flex items-center gap-2 border-b border-line rounded-t-xl bg-panel/80 transition-opacity", p.dim && "opacity-40")}
        style={{ height: BOX.head - 8 }}
      >
        <button
          type="button"
          data-node
          onPointerEnter={p.enter}
          onPointerLeave={p.leave}
          onClick={p.click}
          onDoubleClick={p.open}
          title={`${x.label}\n${x.sub ?? ""}\nClick for details, double-click to open`}
          className="flex min-w-0 flex-1 items-center gap-2.5 h-full pl-3 pr-2 text-left rounded-tl-xl border-0 bg-transparent shadow-none hover:bg-hover"
        >
          <Server className="size-4 flex-none text-accent" aria-hidden="true" />
          <span className="truncate font-semibold text-md">{x.label}</span>
          {x.sub && <span className={cx(MONO, "truncate text-xs text-faint")}>{x.sub}</span>}
          <Dot kind={x.health} className="m-0 ml-1" />
        </button>
        {p.drop ? (
          <span className="pr-3 text-xs font-semibold text-accent">Drop to deploy on {x.label}</span>
        ) : (
          <button
            type="button"
            data-node
            onClick={p.fold}
            title={p.folded ? "Show everything on this server" : "Fold: show only the server and its proxy"}
            className="flex items-center gap-1 mr-1.5 px-2 h-7 text-xs rounded-md border-0 bg-transparent shadow-none text-faint hover:bg-hover hover:text-fg"
          >
            {p.folded ? <ChevronsUpDown className="size-3.5" aria-hidden="true" /> : <ChevronsDownUp className="size-3.5" aria-hidden="true" />}
            {p.folded ? "Unfold" : "Fold"}
          </button>
        )}
      </div>
    </div>
  );
}

export function Node(p: { x: GraphNode; on: boolean; dim: boolean; hit: boolean; enter: () => void; leave: () => void; click: () => void; open: () => void }) {
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
      {!ghost && x.kind !== "machine" && x.kind !== "project" && <Dot kind={x.health} className="m-0" />}
    </button>
  );
}
