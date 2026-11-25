import type { ReactNode } from "react";

export const CHIPS = "flex flex-col gap-[3px] items-start";

export const CHIP = "inline-flex items-center gap-0.5 max-w-full";

/** Rows in an open site's boxes: a line between each, actions on the right. */
export const LIST = "list-none m-0 p-0 [&>li+li]:border-t [&>li+li]:border-line/60";

export const ROW = "flex items-center gap-2.5 px-3 py-2 min-w-0";

export const SIDE = "shrink-0 inline-flex items-center gap-1.5";

export const MORE = "w-full border-0 rounded-none bg-transparent shadow-none px-3 py-1.5 text-left text-sm text-dim hover:text-fg hover:bg-hover";

/** Releases shown before Show older. */
export const RELEASES = 3;

/** On a phone the container buttons show only their icons: the group cannot wrap, and their words widen every row. */
export const TIGHT = "narrow:sr-only";

/** A part of an open site: a titled box, its actions right of the title. */
export function Panel({ title, count, aside, children }: { title: string; count?: number; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="min-w-0 rounded-md border border-line bg-bg/60">
      <h4 className="m-0 flex min-h-10 items-center gap-2 border-b border-line px-3 py-1.5 text-sm font-semibold">
        {title}
        {count !== undefined && <span className="faint font-normal tabular-nums">{count}</span>}
        {aside && <span className="ml-auto inline-flex flex-wrap items-center justify-end gap-1.5 font-normal">{aside}</span>}
      </h4>
      {children}
    </section>
  );
}
