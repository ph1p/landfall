import { useState } from "react";
import { ChevronsDownUp, Info, type LucideIcon } from "lucide-react";
import { cx } from "../../ui/kit";

const LEGEND = "landfall.map.legend";

export function IconBtn({ icon: I, label, on, spin }: { icon: LucideIcon; label: string; on: () => void; spin?: boolean }) {
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

export function Legend() {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(LEGEND) === "1";
    } catch {
      return false;
    }
  });
  const toggle = () =>
    setOpen((o) => {
      try {
        localStorage.setItem(LEGEND, o ? "0" : "1");
      } catch {
        // Not remembered; it still toggles.
      }
      return !o;
    });
  const row = (label: string, stroke: string, dash?: boolean) => (
    <div className="flex items-center gap-2">
      <svg width="26" height="8" aria-hidden="true">
        <path d="M1,4 H25" stroke={stroke} strokeWidth="1.5" strokeDasharray={dash ? "5 4" : undefined} />
      </svg>
      {label}
    </div>
  );
  return (
    <div data-ui className="absolute left-3 bottom-3 rounded-md border border-line bg-panel/90 shadow-xs text-xs text-dim max-[760px]:hidden">
      {open && (
        <div className="grid gap-1 px-3 pt-2 pb-1">
          {row("routed, up", "var(--ok)")}
          {row("failing or refused", "var(--bad)")}
          {row("warning", "var(--warn)")}
          {row("tunnel only, deploy, redirect", "var(--line-strong)", true)}
          <div className="faint mt-0.5">Drag a project onto a server to deploy it there.</div>
          <div className="faint">
            <kbd>/</kbd> find · <kbd>n</kbd> next problem · <kbd>0</kbd> fit · <kbd>Esc</kbd> clear
          </div>
        </div>
      )}
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-md border-0 bg-transparent shadow-none text-dim hover:text-fg"
      >
        {open ? <ChevronsDownUp className="size-3.5" aria-hidden="true" /> : <Info className="size-3.5" aria-hidden="true" />}
        {open ? "Hide the legend" : "Legend and keys"}
      </button>
    </div>
  );
}
