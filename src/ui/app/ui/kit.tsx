import type { ReactNode, ButtonHTMLAttributes, HTMLAttributes } from "react";
import type { Slot } from "../lib/store";
import { Pencil, Play, RotateCw, ScrollText, Square, Upload, type LucideIcon } from "lucide-react";

/** Joins class names, skipping the falsy ones. */
export const cx = (...c: (string | false | null | undefined | 0)[]) => c.filter(Boolean).join(" ");

// Shared class strings for what many views repeat.
export const NUM = "text-right tabular-nums whitespace-nowrap";
/** A table's action cell: buttons in a row on the right, wrapping on phones. */
export const ACTS = "text-right whitespace-nowrap [&_button]:ml-1 max-[760px]:whitespace-normal max-[760px]:[&_button]:my-0.5";
/** Hidden when main is narrow (a phone, or squeezed by the job panel), and the reverse. */
export const HIDE = "narrow:hidden";
export const SHOW = "hidden! narrow:flex!";
export const MONO = "font-mono text-sm";
/** A table's name cell: the name and its small markers on one line. */
export const NAME = "flex items-center gap-0.5 whitespace-nowrap";
export const SR = "sr-only";

/** Text with its `lf …` commands set as code: in the sans font "lf" reads as "If". */
export const cmds = (text: string): ReactNode =>
  text.split(/(\blf(?: (?:[a-z][\w-]*|-[\w-]+))+)/).map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part));

// Button looks, by the words the old markup used: "sm primary", "danger solid", "ghost sm"…
const LOOK: Record<string, string> = {
  sm: "px-[9px] py-0.5 text-sm",
  primary: "bg-accent-solid border-accent-solid text-white hover:brightness-110",
  danger: "text-bad hover:bg-bad-bg",
  ghost: "border-transparent bg-transparent text-dim shadow-none hover:text-fg hover:bg-hover",
};
const SOLID = "bg-bad-solid border-bad-solid text-white hover:brightness-110";
export function btnClass(cls = "") {
  const words = cls.split(/\s+/).filter(Boolean);
  const solid = words.includes("danger") && words.includes("solid");
  return cx(...words.map((w) => (w === "danger" && solid ? SOLID : w === "solid" ? "" : (LOOK[w] ?? w))));
}

type BtnProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "onClick"> & {
  cls?: string;
  on?: (e: React.MouseEvent<HTMLButtonElement>) => void;
};
/** A button that runs on(); cls picks its look (see LOOK) plus any utility classes. */
export function Btn({ cls, on, children, type = "button", ...rest }: BtnProps) {
  return (
    <button type={type} className={btnClass(cls)} onClick={on && ((e) => (e.preventDefault(), e.stopPropagation(), on(e)))} {...rest}>
      {children}
    </button>
  );
}

// The row actions' lucide icons, by what they do.
const ICONS = { deploy: Upload, edit: Pencil, logs: ScrollText, restart: RotateCw, stop: Square, start: Play } satisfies Record<string, LucideIcon>;
/** A small line icon before a button's label. */
export function Icon({ name }: { name: keyof typeof ICONS }) {
  const I = ICONS[name];
  return <I aria-hidden="true" className="inline-block size-3.5 -mt-px mr-1.5 align-middle opacity-80" />;
}
/** Buttons joined into one segmented control: related actions read as one group. */
export function BtnGroup({ children, label }: { children: ReactNode; label: string }) {
  return (
    <span
      role="group"
      aria-label={label}
      className="inline-flex [&>button]:ml-0! [&>button]:rounded-none! [&>button:first-child]:rounded-l-sm! [&>button:last-child]:rounded-r-sm! [&>button+button]:-ml-px! [&>button:hover]:z-1 [&>button:focus-visible]:z-2 [&>button]:relative"
    >
      {children}
    </span>
  );
}

const BADGE: Record<string, string> = {
  "": "bg-hover text-dim border-line",
  ok: "bg-ok-bg text-ok border-transparent",
  warn: "bg-warn-bg text-warn border-transparent",
  bad: "bg-bad-bg text-bad border-transparent",
  accent: "bg-accent-bg text-accent border-transparent",
};
export const badgeClass = (kind = "") =>
  cx("inline-block text-xs font-medium leading-[1.6] px-2 rounded-full border whitespace-nowrap", BADGE[kind] ?? BADGE[""]);
export const Badge = ({ kind = "", children, className, title }: { kind?: string; children: ReactNode; className?: string; title?: string }) => (
  <span className={cx(badgeClass(kind), className)} title={title}>
    {children}
  </span>
);

/** A status dot: grey unless up, warn or down. */
export const Dot = ({ kind = "", className, ...rest }: { kind?: string } & HTMLAttributes<HTMLSpanElement>) => (
  <span className={cx("dot", kind, className)} {...rest} />
);
export const Spin = ({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) => <span className={cx("spin", className)} {...rest} />;

const NOTE: Record<string, string> = { "": "bg-warn-bg text-warn", warn: "bg-warn-bg text-warn", bad: "bg-bad-bg text-bad", info: "bg-accent-bg text-accent" };
export const noteClass = (kind = "") =>
  cx("px-3.5 py-[11px] rounded-md mb-4 [.card+&]:mt-5 border border-[color-mix(in_srgb,currentColor_18%,transparent)]", NOTE[kind]);
export const Note = ({ kind = "", className, children, ...rest }: { kind?: string } & HTMLAttributes<HTMLDivElement>) => (
  <div className={cx(noteClass(kind), className)} {...rest}>
    {children}
  </div>
);

export const Card = ({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cx("card bg-panel border border-line rounded-lg shadow-xs overflow-clip [.card+&]:mt-5", className)} {...rest}>
    {children}
  </div>
);
export const CardHead = ({ className, children }: { className?: string; children: ReactNode }) => (
  <h2 className={cx("m-0 px-[18px] py-3.5 text-[14px] font-semibold border-b border-line flex flex-wrap items-center gap-x-2.5 gap-y-1.5", className)}>
    {children}
  </h2>
);
/** The quiet part of a card's heading. */
export const Sub = ({ children, className }: { children: ReactNode; className?: string }) => (
  <span className={cx("font-normal text-dim", className)}>{children}</span>
);
export const Actions = ({ children, className }: { children: ReactNode; className?: string }) => (
  <span className={cx("flex flex-wrap gap-1.5 ml-auto font-normal", className)}>{children}</span>
);
export const Body = ({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cx("px-[18px] py-4", className)} {...rest}>
    {children}
  </div>
);
export const Lede = ({ children }: { children: ReactNode }) => <div className="px-[18px] py-2.5 text-dim text-md border-b border-line">{children}</div>;
export const Scroll = ({ className, children }: { className?: string; children: ReactNode }) => (
  <div className={cx("overflow-x-auto", className)}>{children}</div>
);
/** A scrolling table: head is its <th>s, or cols gives them as [heading, class]. */
export const Table = ({ head, cols, children }: { head?: ReactNode; cols?: [string, string?][]; children: ReactNode }) => (
  <Scroll>
    <table>
      <thead>
        <tr>
          {head ??
            cols?.map(([c, cls]) => (
              <th key={c} className={cls}>
                {c}
              </th>
            ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  </Scroll>
);
export const Empty = ({ title, children, className }: { title: ReactNode; children?: ReactNode; className?: string }) => (
  <div className={cx("text-dim text-center px-5 py-16 flex flex-col items-center gap-4 [&>p]:m-0 [&>p]:max-w-[58ch] [&>p]:text-pretty", className)}>
    <h2 className="text-fg text-[18px] font-semibold tracking-[-.01em] m-0 -mb-2">{title}</h2>
    {children}
  </div>
);
export const Loading = ({ children }: { children: ReactNode }) => (
  <div className="text-dim py-10 text-center">
    <Spin /> {children}
  </div>
);

/** A grey stand-in for a word or a control that is still loading. */
export const Bone = ({ className }: { className?: string }) => (
  <span aria-hidden="true" className={cx("inline-block h-3 rounded-sm bg-line motion-safe:animate-pulse align-middle", className)} />
);
const WIDTHS = ["w-[38%]", "w-[52%]", "w-[30%]", "w-[46%]", "w-[24%]"];
/** A card's rows while they load: a name, some text, a short value on the right. */
export const BoneRows = ({ rows = 3 }: { rows?: number }) => (
  <div aria-hidden="true">
    {Array.from({ length: rows }, (_, i) => (
      <div key={i} className="flex items-center gap-4 px-[18px] py-3.5 border-b border-line last:border-0">
        <Bone className="w-24 flex-none" />
        <Bone className={WIDTHS[i % WIDTHS.length]} />
        <Bone className="w-14 ml-auto flex-none" />
      </div>
    ))}
  </div>
);
/** A page while it loads: what it waits for, then cards shaped like most pages' cards, so nothing jumps around. */
export const Placeholder = ({ children, cards = 2 }: { children: ReactNode; cards?: number }) => (
  <div role="status">
    <div className="text-dim text-sm mb-3 flex items-center gap-2">
      <Spin /> {children}
    </div>
    {Array.from({ length: cards }, (_, i) => (
      <Card key={i}>
        <div className="px-[18px] py-[17px] border-b border-line">
          <Bone className="w-36 h-3.5" />
        </div>
        <BoneRows rows={i ? 2 : 4} />
      </Card>
    ))}
  </div>
);

/** st has nothing to show yet. */
export const waiting = (st: Slot | undefined) => !st || (st.loading && !st.data);

/** A placeholder page while st has nothing to show yet, or its error; null once there is data. */
export function pending(st: Slot | undefined, what: ReactNode, retry?: () => void): ReactNode {
  if (!st || waiting(st)) return <Placeholder>{what}</Placeholder>;
  if (st.error)
    return (
      <>
        <Note kind="bad">{st.error}</Note>
        {retry && (
          <Actions className="m-0">
            <Btn on={retry}>Retry</Btn>
          </Actions>
        )}
      </>
    );
  return null;
}

/** Label/value rows. */
export const Kv = ({ pairs, className }: { pairs: [string, ReactNode][]; className?: string }) => (
  <dl className={cx("grid grid-cols-[max-content_minmax(0,1fr)] gap-x-[18px] gap-y-1.5 text-md m-0", className)}>
    {pairs.map(([k, v]) => [
      <dt key={`k${k}`} className="text-faint">
        {k}
      </dt>,
      <dd key={`v${k}`} className="m-0 wrap-anywhere">
        {v}
      </dd>,
    ])}
  </dl>
);
