import { useEffect, useRef, useState } from "react";
import { Btn } from "./kit";

// One live region in the top layer, so it shows (and is announced) above an open dialog too.
// action: {label, run} adds a button, e.g. to open the job a toast is about.
interface Toast {
  msg: string;
  action?: { label: string; run: () => void };
  n: number;
}
let show: (t: Toast) => void = () => {};
let n = 0;
export function toast(msg: string, action?: Toast["action"]) {
  show({ msg, action, n: ++n });
}

/** Copy text to the clipboard; what names it in the toast. Without a clipboard the toast shows the text. */
export function copy(text: string, what = text) {
  navigator.clipboard?.writeText(text).then(
    () => toast(`Copied ${what}`),
    () => toast(text),
  ) ?? toast(text);
}

let speak: (text: string) => void = () => {};
/** Tell screen readers about a change that has no visible text of its own. */
export const say = (text: string) => speak(text);

export function ToastHost() {
  const el = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [t, setT] = useState<Toast | null>(null);
  const [live, setLive] = useState("");
  const hide = () => el.current?.hidePopover?.();
  useEffect(() => {
    show = setT;
    speak = (text) => {
      setLive("");
      setTimeout(() => setLive(text), 50);
    };
  }, []);
  useEffect(() => {
    if (!t) return;
    el.current?.hidePopover?.();
    el.current?.showPopover?.();
    clearTimeout(timer.current);
    timer.current = setTimeout(hide, Math.max(4000, t.msg.length * 70) + (t.action ? 4000 : 0));
  }, [t]);
  return (
    <>
      <div
        ref={el}
        role="status"
        popover="manual"
        className="fixed inset-[auto_auto_20px_50%] -translate-x-1/2 m-0 border-0 bg-fg text-bg px-4 py-2.5 rounded-md shadow-lg text-md font-medium max-w-[min(560px,calc(100vw-32px))]"
        onMouseEnter={() => clearTimeout(timer.current)}
        onMouseLeave={() => (timer.current = setTimeout(hide, 2000))}
      >
        {t?.msg}
        {t?.action && (
          <Btn
            cls="sm ml-2.5 bg-transparent shadow-none border-[color-mix(in_srgb,var(--bg)_40%,transparent)] text-inherit"
            on={() => (hide(), t.action!.run())}
          >
            {t.action.label}
          </Btn>
        )}
      </div>
      <div className="sr-only" role="status">
        {live}
      </div>
    </>
  );
}
