// Charts for plugin panels: a line chart over time, horizontal bars and a funnel. Plain SVG and divs, no library.
import { type ReactNode, useState } from "react";
import type { UiBar, UiChart, UiKind, UiStat } from "../../../core/plugins/plugin-api";
import { MONO, cx } from "../ui/kit";

const COLOR: Record<UiKind, string> = { "": "var(--accent)", ok: "var(--ok)", warn: "var(--warn)", bad: "var(--bad)", info: "var(--accent)" };
/** Line colors in series order: the first is the accent, the others stay readable next to it. */
const SERIES = ["var(--accent)", "var(--dim)", "var(--warn)", "var(--ok)"];
const num = (v: number) => (Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 2 }));

function Legend({ items }: { items: [string, string][] }) {
  return (
    <div className="flex flex-wrap gap-3.5 text-xs text-dim mt-2">
      {items.map(([name, col]) => (
        <span key={name}>
          <i className="inline-block w-2.5 h-2.5 rounded-xs mr-1.25 align-[-1px]" style={{ background: col }} />
          {name}
        </span>
      ))}
    </div>
  );
}

function Line({ c }: { c: Extract<UiChart, { chart: "line" }> }) {
  const W = 600,
    H = 120;
  const n = c.labels.length;
  if (!n || !c.series.length) return <div className="text-dim">No data yet.</div>;
  const max = Math.max(1, ...c.series.flatMap((s) => s.values));
  const x = (i: number) => (n === 1 ? W / 2 : (i / (n - 1)) * W);
  const y = (v: number) => H - 2 - (v / max) * (H - 6);
  const unit = c.unit ? ` ${c.unit}` : "";
  const step = n === 1 ? W : W / (n - 1);
  return (
    <div className="relative">
      <div className="absolute -top-0.5 left-0 text-xs faint">
        {num(max)}
        {unit}
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={c.title ?? c.series.map((s) => s.name).join(", ")}
        className="block w-full h-30 border-b border-line"
      >
        {c.series.map((s, k) => {
          const pts = s.values.map((v, i) => `${x(i)},${y(v)}`).join(" ");
          const col = SERIES[k % SERIES.length];
          return (
            <g key={s.name}>
              {k === 0 && <polygon points={`${x(0)},${H} ${pts} ${x(s.values.length - 1)},${H}`} fill={col} opacity={0.12} />}
              <polyline points={pts} fill="none" stroke={col} strokeWidth={k === 0 ? 2 : 1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
            </g>
          );
        })}
        {c.labels.map((l, i) => (
          <rect key={i} x={x(i) - step / 2} y={0} width={step} height={H} fill="transparent">
            <title>{`${l}: ${c.series.map((s) => `${num(s.values[i] ?? 0)}${unit} ${s.name}`).join(", ")}`}</title>
          </rect>
        ))}
      </svg>
      <div className="grid grid-cols-3 text-xs faint mt-1">
        {[0, Math.floor((n - 1) / 2), n - 1].map((i, j) => (
          <span key={j} className={["text-left", "text-center", "text-right"][j]}>
            {n > 2 || j !== 1 ? c.labels[i] : ""}
          </span>
        ))}
      </div>
      {c.series.length > 1 && <Legend items={c.series.map((s, k) => [s.name, SERIES[k % SERIES.length]])} />}
    </div>
  );
}

/** One row: label, a track with the bar, the value. `extra` sits after the value (the funnel's shares). */
function Row({ b, max, lead, extra, tail }: { b: UiBar; max: number; lead?: ReactNode; extra?: ReactNode; tail?: ReactNode }) {
  const pct = max > 0 ? Math.max(b.value > 0 ? 0.5 : 0, (b.value / max) * 100) : 0;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 items-center py-1" title={b.title}>
      <div className="relative min-w-0 h-6 rounded-xs overflow-hidden">
        <div className="absolute inset-y-0 left-0 rounded-xs" style={{ width: `${pct}%`, background: COLOR[b.kind ?? "info"], opacity: 0.18 }} />
        <div className={cx("relative h-full flex items-center gap-1.5 px-2 text-md truncate", b.mono && MONO)}>
          {lead}
          <span className="truncate">{b.label}</span>
        </div>
      </div>
      <div className="flex items-center gap-2 text-md tabular-nums whitespace-nowrap">
        <span>{b.text ?? num(b.value)}</span>
        {extra}
        {tail}
      </div>
    </div>
  );
}

function Bars({ c, tail }: { c: Extract<UiChart, { chart: "bars" }>; tail: (b: UiBar) => ReactNode }) {
  const [all, setAll] = useState(false);
  if (!c.items.length) return <div className="text-dim">{c.empty ?? "Nothing here."}</div>;
  const max = Math.max(...c.items.map((b) => b.value));
  const cut = !all && c.show && c.items.length > c.show + 1 ? c.show : c.items.length;
  return (
    <div>
      {c.items.slice(0, cut).map((b, i) => (
        <Row key={i} b={b} max={max} tail={tail(b)} />
      ))}
      {c.items.length > cut || all ? (
        <button type="button" aria-expanded={all} className="mt-1 text-sm text-dim hover:text-fg cursor-pointer" onClick={() => setAll((v) => !v)}>
          {all ? "Show fewer" : `Show all ${c.items.length}`}
        </button>
      ) : null}
    </div>
  );
}

function Funnel({ c, tail }: { c: Extract<UiChart, { chart: "funnel" }>; tail: (b: UiBar) => ReactNode }) {
  if (!c.items.length) return <div className="text-dim">No steps.</div>;
  const first = c.items[0].value;
  return (
    <div>
      {c.items.map((b, i) => {
        const prev = i ? c.items[i - 1].value : 0;
        const share = first > 0 ? Math.round((b.value / first) * 100) : 0;
        const drop = i && prev > 0 ? Math.round(((prev - b.value) / prev) * 100) : 0;
        return (
          <Row
            key={i}
            b={b}
            max={first}
            lead={<span className="text-xs faint w-4 shrink-0">{i + 1}</span>}
            extra={
              <span className="text-xs text-dim w-24 text-right" title={i ? `${drop}% left after the step before` : "everyone starts here"}>
                {share}%{i > 0 && drop > 0 && <span className="faint"> · −{drop}%</span>}
              </span>
            }
            tail={tail(b)}
          />
        );
      })}
    </div>
  );
}

/** Draws a chart block's body. `tail` renders the per-item buttons. */
export function Chart({ c, tail }: { c: UiChart; tail: (b: UiBar) => ReactNode }) {
  switch (c.chart) {
    case "line":
      return <Line c={c} />;
    case "bars":
      return <Bars c={c} tail={tail} />;
    case "funnel":
      return <Funnel c={c} tail={tail} />;
  }
}

/** A small trend line for a stat tile. */
function Spark({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const W = 100,
    H = 24;
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * W},${H - 1 - (v / max) * (H - 3)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden className="block w-full h-6 mt-2.5">
      <polygon points={`0,${H} ${pts} ${W},${H}`} fill="var(--accent)" opacity={0.1} />
      <polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

/** The change against the period before: green when it went the good way, red when not. */
function Change({ s }: { s: UiStat }) {
  if (s.change === undefined) return null;
  if (s.change === null) return <span className="text-xs text-dim">new</span>;
  const good = s.change === 0 ? null : s.change > 0 !== !!s.lowerIsBetter;
  return (
    <span
      className={cx(
        "text-xs font-medium tabular-nums rounded px-1.5 py-0.5 whitespace-nowrap",
        good === null ? "text-dim bg-line/40" : good ? "text-ok bg-ok-bg" : "text-bad bg-bad-bg",
      )}
    >
      {s.change > 0 ? "↑" : s.change < 0 ? "↓" : "±"}
      {Math.abs(s.change)}%
    </span>
  );
}

/** Numbers as tiles: label, big value, change, trend. The grid fills the row; borders sit between tiles. */
export function Stats({ items }: { items: UiStat[] }) {
  return (
    <div className="overflow-hidden">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] -mr-px -mb-px">
        {items.map((s) => (
          <div key={s.label} className="px-4.5 py-3.5 border-r border-b border-line min-w-0" title={s.title}>
            <div className="text-xs text-dim truncate">{s.label}</div>
            <div className="flex items-center flex-wrap gap-x-2 gap-y-1 mt-1.5">
              {s.kind === "ok" && (
                <span className="relative flex w-2 h-2">
                  <span className="absolute inset-0 rounded-full bg-ok opacity-60 animate-ping" />
                  <span className="relative w-2 h-2 rounded-full bg-ok" />
                </span>
              )}
              <span className={cx("text-2xl font-semibold tabular-nums leading-tight", s.kind === "bad" && "text-bad", s.kind === "warn" && "text-warn")}>
                {typeof s.value === "number" ? num(s.value) : s.value}
              </span>
              <Change s={s} />
            </div>
            {s.note && <div className="text-xs faint mt-1 truncate">{s.note}</div>}
            {s.spark && <Spark values={s.spark} />}
          </div>
        ))}
      </div>
    </div>
  );
}
