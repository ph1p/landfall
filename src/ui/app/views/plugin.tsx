// A plugin's section: the blocks its panel returns, drawn with the page's own parts. Every button runs an lf job.
import { S, sv } from "../lib/store";
import { loadPlugin, pluginKey } from "../lib/api";
import { ifOk, run } from "../lib/jobs";
import { dialog, confirmDlg, type Field } from "../ui/dialog";
import { ACTS, Actions, Badge, Body, Btn, Card, CardHead, Kv, MONO, Note, Sub, Table, cx, pending } from "../ui/kit";
import { actionArgv, actionCommand, type UiAction, type UiBlock, type UiCell } from "../../../core/plugins/plugin-api";

const after = (n: string, plugin: string) => ({ after: ifOk(() => loadPlugin(n, plugin)) });

/** Asks for the action's fields (or a yes) when it has any, then runs it. */
function act(n: string, plugin: string, a: UiAction) {
  const go = (values: Record<string, string | boolean> = {}) => void run([...actionArgv(a, values), ...sv(n)], after(n, plugin));
  if (a.fields?.length) {
    const fields: Field[] = a.fields.map((f) => ({
      name: f.name,
      label: f.label,
      type: f.type ?? "text",
      options: f.options?.map((o) => ({ value: o, label: o })),
      value: f.value ?? (f.type === "check" ? false : f.type === "select" ? f.options?.[0] : ""),
      placeholder: f.placeholder,
      hint: f.hint,
      required: f.required,
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
          {(b.title || b.actions?.length) && (
            <CardHead>
              {b.title}
              <Actions>{btns(b.actions)}</Actions>
            </CardHead>
          )}
          <Body>
            <Kv pairs={b.items.map((i) => [i.label, <Cell key={i.label} v={i.value} />])} />
          </Body>
        </Card>
      );
    case "table": {
      const acts = b.rows.some((r) => r.actions?.length);
      return (
        <Card>
          <CardHead>
            {b.title}
            {b.sub && <Sub>{b.sub}</Sub>}
            <Actions>{btns(b.actions)}</Actions>
          </CardHead>
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
          {b.title && <CardHead>{b.title}</CardHead>}
          <Body className={cx("whitespace-pre-wrap", b.mono && MONO)}>{b.text}</Body>
        </Card>
      );
    case "actions":
      return <div className="flex flex-wrap gap-1.5 mb-4 [.card+&]:mt-5">{btns(b.items)}</div>;
  }
}

export function PluginView({ n, plugin }: { n: string; plugin: string }) {
  const st = S.plugin[pluginKey(n, plugin)];
  const label = S.state.plugins.find((p) => p.name === plugin)?.panel?.label ?? plugin;
  const wait = pending(st, `loading ${label} from ${n}…`, () => loadPlugin(n, plugin));
  if (wait) return wait;
  return st!.data!.map((b, i) => <Block key={i} n={n} plugin={plugin} b={b} />);
}
