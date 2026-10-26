import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { S, type Any } from "../lib/store";
import { Btn, cx, noteClass } from "./kit";

// ---- the shared <dialog> ---------------------------------------------------

/** What the one <dialog> shows: a new key replaces its content, so a dialog opened from another's OK swaps in place. */
export const D = { node: null as ReactNode, cls: "", key: 0, site: undefined as Any, focus: null as HTMLElement | null };
let redraw: () => void = () => {};
let el: HTMLDialogElement | null = null;
/** Show node in the dialog; site: the one files dropped while it is open redeploy. Returns its key. */
export function openDialog(node: ReactNode, cls = "", site?: Any) {
  D.node = node;
  D.cls = cls;
  D.site = site;
  redraw();
  return ++D.key;
}
export const closeDialog = () => el?.close();
export const dialogOpen = () => !!el?.open;
/** Focus x once the dialog is open (showModal would move it otherwise). */
export const focusInDialog = (x: HTMLElement | null) => void (D.focus = x);

export function DialogHost() {
  const [, setN] = useState(0);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    el = ref.current;
    redraw = () => setN((n) => n + 1);
  }, []);
  useEffect(() => {
    const d = ref.current!;
    if (D.node && !d.open) d.showModal();
    D.focus?.focus();
    D.focus = null;
  });
  return (
    <dialog
      ref={ref}
      aria-labelledby="dlg-title"
      className={cx("p-0", D.cls === "wide" && "w-[min(680px,calc(100vw-32px))]")}
      onClose={() => {
        if (ref.current?.open) return;
        D.node = null;
        D.site = undefined;
        redraw();
      }}
    >
      {D.node && <Fragment key={D.key}>{D.node}</Fragment>}
    </dialog>
  );
}

// The pieces of a dialog's form, for dialogs that are not a FormDialog.
export const DFORM = "px-6 pt-[22px] grid grid-cols-[minmax(0,1fr)] gap-3.5 min-h-0 overflow-y-auto overscroll-contain";
export const DTITLE = "m-0 text-[17px] font-semibold tracking-[-.01em]";
export const DTEXT = "text-dim whitespace-pre-wrap text-md";
/** The buttons stay in view while a long form scrolls. */
export const DBTNS = "flex justify-end gap-2 sticky bottom-0 z-1 bg-panel -mx-6 px-6 pt-3 pb-[18px] border-t border-line";

// ---- form dialogs ------------------------------------------------------------

export type Values = Record<string, Any>;
type Problem = string | false | null | undefined | 0;
export interface Field {
  name: string;
  label?: string;
  value?: string | boolean;
  type?: "text" | "number" | "password" | "textarea" | "select" | "check";
  options?: { value: string; label: string }[];
  hint?: string;
  placeholder?: string;
  /** true, or the message when it is empty. */
  required?: boolean | string;
  /** What is wrong with the (trimmed) value, shown under it. */
  check?: (value: Any, values: Values) => Problem;
  /** Shown only then. */
  when?: (values: Values) => unknown;
  /** Greyed out then. */
  off?: (values: Values) => unknown;
  /** A live line under it. */
  preview?: (values: Values) => string | false | null | undefined;
  mono?: boolean;
}
/** collapsed: a section that opens on click (open unless true). */
export interface Group { legend: string; fields: Spec[]; collapsed?: boolean; note?: string; id?: string; when?: (values: Values) => unknown }
export interface Row { row: Field[]; when?: (values: Values) => unknown }
export type Spec = Field | Group | Row;
export interface DialogSpec {
  title: string;
  text?: string;
  fields?: Spec[];
  ok?: string;
  danger?: boolean;
  /** Runs on submit once every shown field checks out; false keeps it open, {field, error} shows why. */
  onOk: (values: Values) => unknown;
  extra?: ReactNode;
  after?: ReactNode;
  /** A name the user types before the (dangerous) action is enabled. */
  typeToConfirm?: string;
}

/** A modal form; see DialogSpec and Field. */
export function dialog(spec: DialogSpec) {
  let key = 0;
  key = openDialog(<FormDialog spec={spec} isCurrent={() => D.key === key} />);
}
export const invalid = (field: string, error: string) => ({ field, error });
export const confirmDlg = (o: Omit<DialogSpec, "onOk"> & { onOk: () => unknown }) => dialog({ ...o, onOk: () => o.onOk() });
export const promptDlg = (title: string, text: string, field: Omit<Field, "name">, onOk: (v: string) => unknown, ok = "OK") =>
  dialog({ title, text, fields: [{ name: "v", ...field }], ok, onOk: (v) => onOk(String(v.v).trim()) });

/** For a field's check: what is wrong with a site name (lf deploy's rule). */
export const siteNameError = (x: string) => !new RegExp(S.state.rules.siteName).test(x) && "Lowercase letters, digits and dashes";
/** Space or comma separated words. */
export const words = (s: string) => s.split(/[\s,]+/).filter(Boolean);
/** A domain the CLI takes (a leading *. for a wildcard). */
export const domainOk = (d: string) => new RegExp(S.state.rules.domain, "i").test(d.replace(/^\*\./, ""));
/** For a field's check: what is wrong with a port (empty is the field's own business). */
export const portError = (x: string) => x && !(/^\d+$/.test(x) && +x >= 1 && +x <= 65535) && "A port from 1 to 65535";
/** For a field's check: what is wrong with a login's user or password (lf newLogin's rules). */
export const userError = (user: string) => !new RegExp(S.state.rules.loginName).test(user) && "Only letters, digits and . _ @ -";
export const passwordError = (pw: string) => pw.length < S.state.rules.minPassword && `The password needs at least ${S.state.rules.minPassword} characters`;

/**
 * Passwords here are for servers and sites, not for this page: a masked text field, so browsers
 * and password managers do not offer to save them. Browsers without text masking get a password field.
 */
const MASK = CSS.supports("-webkit-text-security", "disc");
export const secretProps = {
  className: "secret",
  type: MASK ? "text" : "password",
  autoComplete: MASK ? "off" : "new-password",
  autoCapitalize: "off",
  spellCheck: false,
  "data-1p-ignore": "",
  "data-lpignore": "true",
  "data-bwignore": "",
  "data-form-type": "other",
};

type When = (values: Values) => unknown;
/** Every field with the whens of the groups and rows around it. */
const flat = (list: Spec[], whens: When[] = []): { f: Field; whens: When[] }[] =>
  list.flatMap((s) => {
    const w = s.when ? [...whens, s.when] : whens;
    return "fields" in s ? flat(s.fields, w) : "row" in s ? flat(s.row, w) : [{ f: s, whens: w }];
  });

const HINT = "text-sm font-normal text-faint mt-1";

function FormDialog({ spec, isCurrent }: { spec: DialogSpec; isCurrent: () => boolean }) {
  const { title, text = "", fields = [], ok = "OK", danger = false, onOk, extra, after, typeToConfirm = "" } = spec;
  const specs = flat(fields);
  const form = useRef<HTMLFormElement>(null);
  const [values, setValues] = useState<Values>(() => Object.fromEntries(specs.map(({ f }) => [f.name, f.type === "check" ? !!f.value : String(f.value ?? "")])));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formErr, setFormErr] = useState("");
  const [typed, setTyped] = useState("");

  const shown = (whens: When[], v: Values) => whens.every((w) => w(v));
  // Hidden or greyed out: neither checked nor reported.
  const inPlay = ({ f, whens }: (typeof specs)[number], v: Values) => shown(whens, v) && !f.off?.(v);
  const problem = (x: (typeof specs)[number], v: Values): string => {
    const { f } = x;
    if (!inPlay(x, v)) return "";
    const value = v[f.name];
    if (f.required && f.type !== "check" && !String(value).trim()) return f.required === true ? `${f.label} is needed` : f.required;
    return f.check?.(typeof value === "string" ? value.trim() : value, v) || "";
  };
  const input = (name: string) => form.current?.elements.namedItem(name) as HTMLElement | null;
  // A collapsed section opens to show what is wrong in it.
  const reveal = (name: string) => {
    const sec = input(name)?.closest("details");
    if (sec) sec.open = true;
  };
  const show = (name: string, error: string) => {
    if (!specs.some((x) => x.f.name === name)) return setFormErr(error);
    setErrors((e) => ({ ...e, [name]: error }));
    if (error) reveal(name);
  };
  const recheck = (name: string, v: Values) => {
    const x = specs.find((s) => s.f.name === name);
    if (x) show(name, problem(x, v));
  };
  const set = (f: Field, value: string | boolean) => {
    const v = { ...values, [f.name]: value };
    setValues(v);
    setFormErr("");
    // Once wrong, a field says so until it is right; before that, only when it is left. Checkboxes and selects check right away.
    if (errors[f.name] || f.type === "check" || f.type === "select") recheck(f.name, v);
  };
  const close = () => isCurrent() && closeDialog();

  const submitOff = !!typeToConfirm && typed.trim() !== typeToConfirm;
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (submitOff) return;
    const bad = specs.map((x) => [x.f.name, problem(x, values)] as const);
    setErrors(Object.fromEntries(bad));
    for (const [name, error] of bad) if (error) reveal(name);
    const first = bad.find(([, error]) => error);
    if (first) return void input(first[0])?.focus();
    const r = onOk(values) as Any;
    if (r === false) return;
    if (r?.error) {
      show(r.field, r.error);
      input(r.field)?.focus();
      return;
    }
    // Empty before closing: browsers offer to save a password they still see when the form goes away.
    for (const x of form.current!.querySelectorAll<HTMLInputElement>(".secret")) x.value = "";
    close();
  };

  useEffect(() => {
    const f = form.current!;
    // A dangerous confirm starts on Cancel, so a stray Enter does not delete anything.
    const first = [...f.querySelectorAll<HTMLElement>("input:not([type=checkbox]), textarea, select")].find((x) => !(x as HTMLInputElement).disabled && !x.closest("details:not([open])"));
    focusInDialog(first ?? f.querySelector<HTMLElement>(danger ? "#dlg-cancel" : "button[type=submit]"));
  }, []);

  const field = (f: Field): ReactNode => {
    const x = specs.find((s) => s.f.name === f.name)!;
    if (!shown(x.whens, values)) return null;
    const id = `f-${f.name}`;
    const error = errors[f.name];
    const line = f.preview && inPlay(x, values) ? f.preview(values) : "";
    const attrs = {
      id,
      name: f.name,
      "aria-describedby": `${id}-e`,
      "aria-required": f.required ? true : undefined,
      "aria-invalid": error ? true : undefined,
      disabled: !!f.off?.(values),
      onBlur: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => e.target.value?.trim() && recheck(f.name, values),
    };
    const hint = f.hint && <div className={HINT}>{f.hint}</div>;
    const below = (
      <>
        {line && <div className={cx(HINT, "text-dim! font-mono wrap-anywhere")} id={`${id}-p`} aria-live="polite">{line}</div>}
        {error && <div className="field-err text-bad text-sm font-[450] mt-1" id={`${id}-e`}>{error}</div>}
      </>
    );
    const str = String(values[f.name]);
    const onChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => set(f, e.target.value);
    if (f.type === "check")
      return (
        <label key={f.name} className="flex gap-2 items-start text-fg text-md font-normal">
          <input type="checkbox" {...attrs} className="w-auto mt-[3px]" checked={!!values[f.name]} onChange={(e) => set(f, e.target.checked)} />
          <span>{f.label}{hint}{below}</span>
        </label>
      );
    let control: ReactNode;
    const mono = f.mono ? "mono" : undefined;
    if (f.type === "select")
      control = (
        <select {...attrs} value={str} onChange={onChange}>
          {f.options!.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
    else if (f.type === "password") control = <input {...attrs} {...secretProps} value={str} placeholder={f.placeholder} onChange={onChange} />;
    else if (f.type === "textarea") control = <textarea {...attrs} className={mono} value={str} placeholder={f.placeholder} spellCheck={false} onChange={onChange} />;
    else
      control = (
        <input {...attrs} className={mono} inputMode={f.type === "number" ? "numeric" : undefined} type="text" value={str} placeholder={f.placeholder} autoComplete="off" autoCapitalize="off" spellCheck={false} onChange={onChange} />
      );
    return <label key={f.name}>{f.label}{control}{hint}{below}</label>;
  };
  const group = (s: Spec, i: number): ReactNode => {
    if (s.when && !s.when(values)) return null;
    if ("row" in s) return <div key={i} className="flex gap-2.5 flex-wrap items-end [&>label]:flex-[1_1_140px]">{s.row.map(field)}</div>;
    if (!("fields" in s)) return field(s);
    const inner = s.fields.map(group);
    if (s.collapsed !== undefined)
      return (
        <details key={i} className="fs border border-line rounded-md" data-group={s.id} open={!s.collapsed}>
          <summary className="cursor-pointer px-3.5 py-2.5 text-sm font-semibold flex gap-2 items-baseline rounded-md hover:bg-hover">
            {s.legend}
            {s.note && <span className="text-faint font-normal overflow-hidden text-ellipsis whitespace-nowrap">{s.note}</span>}
          </summary>
          <div className="px-3.5 pt-0.5 pb-3 grid gap-2.5">{inner}</div>
        </details>
      );
    return <fieldset key={i} data-group={s.id}><legend>{s.legend}</legend>{inner}</fieldset>;
  };

  return (
    <form
      ref={form}
      method="dialog"
      noValidate
      className={DFORM}
      onSubmit={submit}
      // Cmd/Ctrl+Enter sends from a text area too.
      onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && (e.preventDefault(), form.current!.requestSubmit())}
    >
      <h2 id="dlg-title" className={DTITLE}>{title}</h2>
      {text && <div className={DTEXT}>{text}</div>}
      {extra}
      {fields.map(group)}
      {after}
      {typeToConfirm && (
        <label>
          Type <b className="mono">{typeToConfirm}</b> to confirm
          <input id="dlg-confirm" autoComplete="off" spellCheck={false} autoCapitalize="off" value={typed} onChange={(e) => (setTyped(e.target.value), setFormErr(""))} />
        </label>
      )}
      {formErr && <div className={cx(noteClass("bad"), "m-0")} id="dlg-err" role="alert">{formErr}</div>}
      <div className={DBTNS}>
        <Btn cls="ghost" id="dlg-cancel" on={closeDialog}>Cancel</Btn>
        <button type="submit" className={cx(danger ? "bg-bad-solid! border-bad-solid! text-white! hover:brightness-110" : "bg-accent-solid! border-accent-solid! text-white! hover:brightness-110")} disabled={submitOff}>
          {ok}
        </button>
      </div>
    </form>
  );
}
