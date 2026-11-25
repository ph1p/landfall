import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Btn, cx } from "./kit";
import { ChevronDown, Ellipsis } from "lucide-react";

export interface MenuItem {
  label: string;
  run: () => void;
  cls?: string;
  title?: string;
  hint?: string;
}
type Item = MenuItem | "-" | false | null | undefined | "";

// "⋯" menus: one floating list at a time, placed next to the button that opened it.
let open: { anchor: HTMLElement; items: (MenuItem | "-")[] } | null = null;
let redraw: () => void = () => {};
function openMenu(anchor: HTMLElement, items: (MenuItem | "-")[]) {
  closeMenu(false);
  open = { anchor, items };
  anchor.setAttribute("aria-expanded", "true");
  redraw();
}
/** restore: focus goes back to the "⋯" button (Esc, or an item that opens no dialog). */
export function closeMenu(restore = true) {
  if (!open) return;
  const { anchor } = open;
  open = null;
  anchor.setAttribute("aria-expanded", "false");
  if (restore && anchor.isConnected) anchor.focus({ preventScroll: true });
  redraw();
}
export const menuOpen = () => !!open;

/** A "More" button (or `label`) for the less used actions; falsy items are skipped, "-" is a divider. */
export function MenuBtn({
  items,
  title = "More actions",
  cls = "sm",
  dots,
  label = "More",
}: {
  items: Item[];
  title?: string;
  cls?: string;
  dots?: boolean;
  label?: string;
}) {
  // No divider at either end or twice in a row: items that are left out leave none behind.
  const list = (items.filter(Boolean) as (MenuItem | "-")[]).filter((it, i, all) => it !== "-" || (i > 0 && i < all.length - 1 && all[i + 1] !== "-"));
  if (!list.length) return null;
  return (
    <Btn cls={cls} title={title} aria-haspopup="menu" aria-expanded="false" aria-label={title} on={(e) => openMenu(e.currentTarget, list)}>
      {/* Where a row is short of room: only "⋯", the title says what it is. */}
      {dots ? (
        <Ellipsis aria-hidden="true" className="size-4" />
      ) : (
        <>
          {label} <ChevronDown aria-hidden="true" className="inline-block size-3.5 -mt-px ml-0.5 align-middle text-faint" />
        </>
      )}
    </Btn>
  );
}

export function MenuHost() {
  const [, setN] = useState(0);
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    redraw = () => setN((n) => n + 1);
    // A click outside an open menu only closes it.
    const click = (e: MouseEvent) => {
      if (!open || el.current?.contains(e.target as Node)) return;
      closeMenu(false);
      e.preventDefault();
      e.stopPropagation();
    };
    const resize = () => closeMenu(false);
    const scroll = (e: Event) => (e.target as Element).closest?.("#menu") || closeMenu(false);
    document.addEventListener("click", click, true);
    addEventListener("resize", resize);
    document.addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("click", click, true);
      removeEventListener("resize", resize);
      document.removeEventListener("scroll", scroll, true);
    };
  }, []);
  useLayoutEffect(() => {
    const m = el.current;
    if (!m || !open) return;
    const r = open.anchor.getBoundingClientRect();
    m.style.left = `${Math.max(8, Math.min(r.right - m.offsetWidth, innerWidth - m.offsetWidth - 8))}px`;
    m.style.top = `${r.bottom + 4 + m.offsetHeight > innerHeight - 8 ? Math.max(8, r.top - m.offsetHeight - 4) : r.bottom + 4}px`;
    m.querySelector("button")?.focus({ preventScroll: true });
  });
  if (!open) return null;
  const { items } = open;
  return (
    <div
      ref={el}
      id="menu"
      role="menu"
      className="fixed z-30 min-w-[190px] bg-panel border border-line rounded-md shadow-lg p-[5px] grid animate-pop"
      onKeyDown={(e) => {
        const all = [...e.currentTarget.querySelectorAll("button")];
        const i = all.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          all[(i + (e.key === "ArrowDown" ? 1 : all.length - 1)) % all.length].focus();
        } else if (e.key === "Home" || e.key === "End") {
          e.preventDefault();
          all[e.key === "Home" ? 0 : all.length - 1].focus();
        }
      }}
      // Keep focus where it is on mousedown: a browser that does not focus clicked buttons would blur the menu and close it before the click.
      onMouseDown={(e) => e.preventDefault()}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) closeMenu(false);
      }}
    >
      {items.map((it, i) =>
        it === "-" ? (
          <hr key={i} role="separator" className="border-0 border-t border-line mx-0.5 my-1" />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            title={it.title}
            className={cx(
              "border-0 bg-transparent shadow-none font-[450] text-left px-2.5 py-1.5 rounded-sm flex justify-between gap-4 hover:bg-hover focus-visible:bg-accent-bg! focus-visible:shadow-none!",
              it.cls?.includes("danger") && "text-bad hover:bg-bad-bg",
            )}
            onClick={() => (closeMenu(), it.run())}
          >
            <span>{it.label}</span>
            {it.hint && <span className="text-faint font-mono text-xs">{it.hint}</span>}
          </button>
        ),
      )}
    </div>
  );
}
