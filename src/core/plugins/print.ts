// UI blocks as text: what `lf <plugin>` prints for a panel, and what ctx.blocks() prints for a plugin command.
import { actionCommand, type UiAction, type UiBlock, type UiCell, type UiKind, type UiStat } from "./plugin-api";
import { changeText, sparkline, textBar } from "../lib/format";
import { c, table } from "../lib/term";

const tint = (kind: UiKind | undefined, s: string, fallback = (x: string) => x) =>
  kind === "bad" ? c.red(s) : kind === "warn" ? c.yellow(s) : kind === "ok" ? c.green(s) : fallback(s);
const paint = (v: UiCell) => (typeof v === "object" ? tint(v.kind, v.text) : String(v));
const fmtNum = (v: number) => (Number.isInteger(v) ? v.toLocaleString("en") : String(+v.toFixed(2)));

/** A stat's change as text: green when it went the good way. */
export function statChange(s: UiStat): string {
  if (s.change === undefined) return "";
  if (s.change === null) return c.dim("new");
  const text = changeText(s.change);
  if (s.change === 0) return c.dim(text);
  return s.change > 0 !== !!s.lowerIsBetter ? c.green(text) : c.red(text);
}

/** A chart as text: rows with bars, or sparklines for a long line chart. */
function printChart(b: Extract<UiBlock, { type: "chart" }>) {
  if (b.chart === "line") {
    if (!b.labels.length) return console.log(c.dim("no data"));
    if (b.labels.length > 31) {
      const w = Math.max(...b.series.map((x) => x.name.length));
      for (const x of b.series) {
        const total = x.values.reduce((n, v) => n + v, 0);
        console.log(`${c.dim(x.name.padEnd(w))}  ${c.cyan(sparkline(x.values))}  ${c.dim(`max ${fmtNum(Math.max(0, ...x.values))} · total ${fmtNum(total)}`)}`);
      }
      return console.log(c.dim(`${b.labels[0]} … ${b.labels.at(-1)}`));
    }
    const first = b.series[0]?.values ?? [];
    const max = Math.max(0, ...first);
    return table([
      ["", ...b.series.map((x) => c.dim(x.name)), ""],
      ...b.labels.map((l, i) => [l, ...b.series.map((x) => fmtNum(x.values[i] ?? 0)), c.cyan(textBar(first[i] ?? 0, max, 30))]),
    ]);
  }
  if (!b.items.length) return console.log(c.dim((b.chart === "bars" && b.empty) || "none"));
  const max = b.chart === "funnel" ? (b.items[0]?.value ?? 0) : Math.max(0, ...b.items.map((i) => i.value));
  table(
    b.items.map((i, n) => [
      b.chart === "funnel" ? `${n + 1}. ${i.label}` : i.label,
      i.text ?? fmtNum(i.value),
      tint(i.kind, textBar(i.value, max, 24), c.cyan),
    ]),
  );
}

/**
 * Blocks as text on stdout. actions: also list, on stderr, the lf commands behind the blocks' buttons (once each),
 * as `lf <plugin>` does for a panel.
 */
export function printBlocks(blocks: UiBlock[], o: { actions?: boolean } = {}) {
  const actions: UiAction[] = [];
  let printed = false;
  const title = (b: { title?: string; sub?: string }) => b.title && console.log(c.bold(b.title) + (b.sub ? c.dim(` · ${b.sub}`) : ""));
  for (const b of blocks) {
    if (b.type === "actions") {
      actions.push(...b.items);
      continue;
    }
    if (printed) console.log("");
    printed = true;
    if (b.type === "note") console.log(paint({ text: b.text, kind: b.kind }));
    else if (b.type === "facts") {
      title(b);
      table(b.items.map((i) => [c.dim(i.label), paint(i.value)]));
    } else if (b.type === "stats") {
      title(b);
      table(
        b.items.map((s) => [
          c.dim(s.label),
          paint({ text: typeof s.value === "number" ? fmtNum(s.value) : s.value, kind: s.kind }),
          statChange(s),
          c.cyan(sparkline(s.spark ?? [])),
          c.dim(s.note ?? ""),
        ]),
      );
    } else if (b.type === "table") {
      title(b);
      if (!b.rows.length) console.log(c.dim(b.empty ?? "none"));
      else table([b.columns.map(c.dim), ...b.rows.map((r) => r.cells.map(paint))]);
    } else if (b.type === "text") {
      title(b);
      console.log(b.text);
    } else if (b.type === "chart") {
      title(b);
      printChart(b);
    } else if (b.type === "heading") {
      console.log(c.bold(b.text.toUpperCase()) + (b.sub ? c.dim(`  ${b.sub}`) : ""));
    }
    // A table row's actions once, from the first row: an example of what each row offers.
    if (b.type !== "text" && b.type !== "heading")
      actions.push(
        ...(b.actions ?? []),
        ...(b.type === "table" ? (b.rows[0]?.actions ?? []) : []),
        ...(b.type === "chart" && b.chart !== "line" ? (b.items[0]?.actions ?? []) : []),
      );
  }
  if (!o.actions) return;
  const lines = [...new Set(actions.map(actionCommand))];
  if (lines.length) process.stderr.write(`\n${lines.map((l) => c.dim(`  ${l}`)).join("\n")}\n`);
}
