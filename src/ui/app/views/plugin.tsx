// A plugin's section: the blocks its panel returns, drawn with the page's own parts. Every button runs an lf job.
import { S, render, sv } from "../lib/store";
import { loadPlugin, pluginKey } from "../lib/api";
import { ifOk, run } from "../lib/jobs";
import { dialog, confirmDlg, type Field } from "../ui/dialog";
import { ACTS, Actions, Badge, Body, Btn, BtnGroup, Card, CardHead, Kv, MONO, Note, Sub, Table, cx, pending } from "../ui/kit";
import { actionArgv, actionCommand, panelView, type UiAction, type UiBlock, type UiCell } from "../../../core/plugins/plugin-api";
import { Chart, Stats } from "./plugin-chart";

const after = (n: string, plugin: string) => ({ after: ifOk(() => loadPlugin(n, plugin)) });

const optionValue = (o: string | { value: string } | undefined) => (typeof o === "object" ? o.value : o);

/** Asks for the action's fields (or a yes) when it has any, then runs it. */
function act(n: string, plugin: string, a: UiAction) {
  const go = (values: Record<string, string | boolean> = {}) => void run([...actionArgv(a, values), ...sv(n)], after(n, plugin));
  if (a.fields?.length) {
    const fields: Field[] = a.fields.map((f) => ({
      name: f.name,
      label: f.label,
      type: f.type ?? "text",
      options: f.options?.map((o) => (typeof o === "string" ? { value: o, label: o } : o)),
      value: f.value ?? (f.type === "check" ? false : f.type === "select" ? optionValue(f.options?.[0]) : ""),
      suggest: f.suggest,
      placeholder: f.placeholder,
      hint: f.hint,
      required: f.required,
      min: f.min,
      max: f.max,
    }));
    return dialog({ title: a.title ?? a.label, text: a.confirm, fields, ok: a.label, danger: a.danger, onOk: (v) => go(v) });
  }
  if (a.confirm) return confirmDlg({ title: a.title ?? a.label, text: a.confirm, ok: a.label, danger: a.danger, onOk: () => go() });
  go();
}

function Buttons({ n, plugin, items, small }: { n: string; plugin: string; items?: UiAction[]; small?: boolean }) {
  if (!items?.length) return null;
  return items.map((a) => (
    <Btn key={a.label} cls={cx(a.primary && "primary", a.danger && "danger", small && "sm")} title={a.title ?? actionCommand(a)} on={() => act(n, plugin, a)}>
      {a.label}
    </Btn>
  ));
}

function Cell({ v }: { v: UiCell }) {
  if (typeof v !== "object") return <>{v}</>;
  if (v.kind)
    return (
      <Badge kind={v.kind === "info" ? "accent" : v.kind} title={v.title}>
        {v.text}
      </Badge>
    );
  return (
    <span className={cx(v.mono && MONO)} title={v.title}>
      {v.text}
    </span>
  );
}

function Block({ n, plugin, b }: { n: string; plugin: string; b: UiBlock }) {
  const btns = (items?: UiAction[], small?: boolean) => <Buttons n={n} plugin={plugin} items={items} small={small} />;
  const head = (h: { title?: string; sub?: string; actions?: UiAction[] }, always = false) =>
    (always || h.title || h.sub || h.actions?.length) && (
      <CardHead>
        {h.title}
        {h.sub && <Sub>{h.sub}</Sub>}
        <Actions>{btns(h.actions)}</Actions>
      </CardHead>
    );
  switch (b.type) {
    case "note":
      return (
        <Note kind={b.kind === "ok" ? "info" : (b.kind ?? "")}>
          {b.text}
          {b.actions?.length ? <div className="flex flex-wrap gap-1.5 mt-2">{btns(b.actions)}</div> : null}
        </Note>
      );
    case "facts":
      return (
        <Card>
          {head(b)}
          <Body>
            <Kv pairs={b.items.map((i) => [i.label, <Cell key={i.label} v={i.value} />])} />
          </Body>
        </Card>
      );
    case "stats":
      return (
        <Card>
          {head(b)}
          <Stats items={b.items} />
        </Card>
      );
    case "table": {
      const acts = b.rows.some((r) => r.actions?.length);
      return (
        <Card>
          {head(b, true)}
          {b.rows.length ? (
            <Table cols={[...b.columns.map((c): [string] => [c]), ...(acts ? [["", ACTS] as [string, string]] : [])]}>
              {b.rows.map((r, i) => (
                <tr key={i}>
                  {r.cells.map((c, j) => (
                    <td key={j}>
                      <Cell v={c} />
                    </td>
                  ))}
                  {acts && <td className={ACTS}>{btns(r.actions, true)}</td>}
                </tr>
              ))}
            </Table>
          ) : (
            <Body className="text-dim">{b.empty ?? "Nothing here."}</Body>
          )}
        </Card>
      );
    }
    case "text":
      return (
        <Card>
          {head(b)}
          <Body className={cx("whitespace-pre-wrap", b.mono && MONO)}>{b.text}</Body>
        </Card>
      );
    case "actions":
      return <div className="flex flex-wrap gap-1.5 mb-4 [.card+&]:mt-5">{btns(b.items)}</div>;
    case "chart":
      return (
        <Card>
          {head(b)}
          <Body>
            <Chart c={b} tail={(x) => (x.actions?.length ? <span className="flex gap-1">{btns(x.actions, true)}</span> : null)} />
          </Body>
        </Card>
      );
    case "heading":
      return (
        <div className="mt-7 mb-2.5 first:mt-0">
          <h3 className="m-0 text-[15px] font-semibold">{b.text}</h3>
          {b.sub && <div className="text-dim text-md mt-0.5">{b.sub}</div>}
        </div>
      );
  }
}

/** Consecutive half-width blocks share a row; everything else takes the full width. */
function rows(blocks: UiBlock[]): (UiBlock | UiBlock[])[] {
  const out: (UiBlock | UiBlock[])[] = [];
  for (const b of blocks) {
    const last = out.at(-1);
    if (b.half && Array.isArray(last)) last.push(b);
    else out.push(b.half ? [b] : b);
  }
  return out;
}

function Views({ n, plugin }: { n: string; plugin: string }) {
  const views = S.state.plugins.find((p) => p.name === plugin)?.panel?.views;
  if (!views?.length) return null;
  const cur = panelView({ views }, S.pluginView[plugin]);
  return (
    <div className="mb-4">
      <BtnGroup label="View">
        {views.map((v) => (
          <Btn
            key={v.id}
            cls={cx("sm", cur === v.id && "primary")}
            aria-pressed={cur === v.id}
            on={() => {
              S.pluginView[plugin] = v.id;
              render();
              void loadPlugin(n, plugin);
            }}
          >
            {v.label}
          </Btn>
        ))}
      </BtnGroup>
    </div>
  );
}

export function PluginView({ n, plugin }: { n: string; plugin: string }) {
  const st = S.plugin[pluginKey(n, plugin)];
  const label = S.state.plugins.find((p) => p.name === plugin)?.panel?.label ?? plugin;
  const wait = pending(st, `loading ${label} from ${n}…`, () => loadPlugin(n, plugin));
  if (wait) return wait;
  return (
    <>
      <Views n={n} plugin={plugin} />
      {rows(st!.data!).map((r, i) =>
        Array.isArray(r) ? (
          <div key={i} className="card grid gap-5 md:grid-cols-2 [.card+&]:mt-5 [&>.card]:mt-0!">
            {r.map((b, j) => (
              <Block key={j} n={n} plugin={plugin} b={b} />
            ))}
          </div>
        ) : (
          <Block key={i} n={n} plugin={plugin} b={r} />
        ),
      )}
    </>
  );
}
