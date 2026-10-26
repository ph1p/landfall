"use strict";
// ---- dialogs -------------------------------------------------------------

/**
 * A modal form. fields: [{name, label, value, type: text|number|password|textarea|select|check, options, hint, placeholder}],
 * plus, per field: required (true or its message), check(value, values): what is wrong with it, shown under it;
 * when(values): shown only then; off(values): greyed out then; preview(values): a live line under it; mono.
 * Groups: {legend, fields, collapsed, when} (collapsed: a section that opens on click), rows: {row: [fields]}.
 * onOk(values) runs on submit once every shown field checks out; return false to keep it open, or {field, error} to show why.
 * typeToConfirm: a name the user types before the (dangerous) action is enabled.
 */
function dialog({ title, text = "", fields = [], ok = "OK", danger = false, onOk, extra = "", after = "", typeToConfirm = "" }) {
  const dlg = openDlg();
  const flat = (list) => list.flatMap((f) => (f.fields ? flat(f.fields) : f.row ? flat(f.row) : [f]));
  const specs = flat(fields);
  // Whatever shows, hides or greys out with the values: its element id and the rule.
  const live = [];
  const cond = (f) => {
    if (!f.when) return "";
    live.push({ id: `c${live.length}`, when: f.when });
    return ` id="c${live.length - 1}"`;
  };
  const field = (f) => {
    const id = `f-${f.name}`;
    const hint = f.hint ? `<div class="hint">${esc(f.hint)}</div>` : "";
    const below = `${f.preview ? `<div class="hint preview" id="${id}-p" aria-live="polite" hidden></div>` : ""}<div class="field-err" id="${id}-e" hidden></div>`;
    const attrs = `id="${id}" name="${f.name}" aria-describedby="${id}-e"${f.required ? " aria-required=\"true\"" : ""}`;
    if (f.type === "check") {
      return `<label class="check" data-name="${f.name}"${cond(f)}><input type="checkbox" ${attrs} ${f.value ? "checked" : ""}><span>${esc(f.label)}${hint}${below}</span></label>`;
    }
    const label = (input) => `<label data-name="${f.name}"${cond(f)}>${esc(f.label)}${input}${hint}${below}</label>`;
    if (f.type === "select") {
      return label(`<select ${attrs}>${f.options.map((o) => `<option value="${esc(o.value)}" ${o.value === f.value ? "selected" : ""}>${esc(o.label)}</option>`).join("")}</select>`);
    }
    if (f.type === "password") return label(secretInput(attrs, f));
    const cls = f.mono ? ` class="mono"` : "";
    if (f.type === "textarea") return label(`<textarea ${attrs}${cls} placeholder="${esc(f.placeholder)}" spellcheck="false">${esc(f.value)}</textarea>`);
    const num = f.type === "number" ? ` inputmode="numeric"` : "";
    return label(`<input ${attrs}${cls}${num} type="text" value="${esc(f.value)}" placeholder="${esc(f.placeholder)}" autocomplete="off" autocapitalize="off" spellcheck="false">`);
  };
  const group = (f) => {
    if (f.row) return `<div class="form-row"${cond(f)}>${f.row.map(field).join("")}</div>`;
    if (!f.legend) return field(f);
    const id = f.id ? ` data-group="${f.id}"` : "";
    const inner = f.fields.map(group).join("");
    if (f.collapsed !== undefined) {
      return `<details class="fs"${id}${cond(f)}${f.collapsed ? "" : " open"}><summary>${esc(f.legend)}${f.note ? ` <span class="faint">${esc(f.note)}</span>` : ""}</summary><div class="fs-body">${inner}</div></details>`;
    }
    return `<fieldset${id}${cond(f)}><legend>${esc(f.legend)}</legend>${inner}</fieldset>`;
  };
  dlg.innerHTML = `<form method="dialog" novalidate>
    <h2 id="dlg-title">${esc(title)}</h2>
    ${text ? `<div class="text">${esc(text)}</div>` : ""}
    ${extra}
    ${fields.map(group).join("")}
    ${after}
    ${typeToConfirm ? `<label>Type <b class="mono">${esc(typeToConfirm)}</b> to confirm<input id="dlg-confirm" autocomplete="off" spellcheck="false" autocapitalize="off"></label>` : ""}
    <div class="note bad dlg-err" id="dlg-err" role="alert" hidden></div>
    <div class="btns">
      <button type="button" value="cancel" class="ghost" id="dlg-cancel">Cancel</button>
      <button type="submit" value="ok" class="${danger ? "danger solid" : "primary"}">${esc(ok)}</button>
    </div>
  </form>`;
  const form = $("form", dlg);
  const submit = $("button[type=submit]", form);
  const el = (name) => form.elements[name];
  const values = () => Object.fromEntries(specs.map((f) => [f.name, f.type === "check" ? el(f.name).checked : el(f.name).value]));
  // Hidden or greyed out: neither checked nor reported.
  const inPlay = (f) => !el(f.name).disabled && !el(f.name).closest("[hidden]");
  const sync = () => {
    const v = values();
    for (const c of live) $(`#${c.id}`, form).hidden = !c.when(v);
    for (const f of specs) {
      if (f.off) el(f.name).disabled = !!f.off(v);
      if (f.preview) {
        const p = $(`#f-${f.name}-p`, form), line = inPlay(f) ? f.preview(v) : "";
        p.textContent = line || "";
        p.hidden = !line;
      }
    }
  };
  const show = (name, error) => {
    const input = el(name), box = $(`#f-${name}-e`, form);
    if (!input) {
      const err = $("#dlg-err", dlg);
      err.textContent = error;
      err.hidden = false;
      return;
    }
    box.textContent = error ?? "";
    box.hidden = !error;
    if (!error) return void input.removeAttribute("aria-invalid");
    input.setAttribute("aria-invalid", "true");
    // A collapsed section opens to show what is wrong in it.
    const sec = input.closest("details");
    if (sec) sec.open = true;
  };
  const problem = (f, v) => {
    if (!inPlay(f)) return "";
    const value = v[f.name];
    if (f.required && f.type !== "check" && !String(value).trim()) return f.required === true ? `${f.label} is needed` : f.required;
    return f.check?.(typeof value === "string" ? value.trim() : value, v) || "";
  };
  const recheck = (name) => {
    const f = specs.find((s) => s.name === name);
    if (f) show(name, problem(f, values()));
  };
  $("#dlg-cancel", dlg).onclick = () => dlg.close();
  if (typeToConfirm) {
    submit.disabled = true;
    $("#dlg-confirm", dlg).oninput = (e) => (submit.disabled = e.target.value.trim() !== typeToConfirm);
  }
  form.oninput = (e) => {
    sync();
    // Once wrong, a field says so until it is right; before that, only when it is left.
    if (e.target.getAttribute?.("aria-invalid")) recheck(e.target.name);
    $("#dlg-err", dlg).hidden = true;
  };
  form.onchange = (e) => (sync(), e.target.type === "checkbox" || e.target.tagName === "SELECT" ? recheck(e.target.name) : undefined);
  form.addEventListener("focusout", (e) => e.target.name && e.target.value?.trim() && recheck(e.target.name));
  // Cmd/Ctrl+Enter sends from a text area too.
  form.onkeydown = (e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && (e.preventDefault(), form.requestSubmit());
  form.onsubmit = (e) => {
    e.preventDefault();
    if (submit.disabled) return;
    const v = values();
    const bad = specs.map((f) => [f.name, problem(f, v)]);
    for (const [name, error] of bad) show(name, error);
    const first = bad.find(([, error]) => error);
    if (first) return void el(first[0]).focus();
    const r = onOk(v);
    if (r === false) return;
    if (r?.error) {
      show(r.field, r.error);
      el(r.field)?.focus();
      return;
    }
    // Empty before closing: browsers offer to save a password they still see when the form goes away.
    for (const x of form.querySelectorAll(".secret")) x.value = "";
    dlg.close();
  };
  sync();
  dlg.showModal();
  // A dangerous confirm starts on Cancel, so a stray Enter does not delete anything.
  const first = [...form.querySelectorAll("input:not([type=checkbox]), textarea, select")].find((x) => !x.disabled && !x.closest("[hidden], details:not([open])"));
  (first || (danger ? $("#dlg-cancel", dlg) : submit)).focus();
}
const invalid = (field, error) => ({ field, error });
/** For a field's check: what is wrong with a site name (lf deploy's rule). */
const siteNameError = (x) => !new RegExp(S.state.rules.siteName).test(x) && "Lowercase letters, digits and dashes";
/** Space or comma separated words. */
const words = (s) => s.split(/[\s,]+/).filter(Boolean);
/** A domain the CLI takes (a leading *. for a wildcard). */
const domainOk = (d) => new RegExp(S.state.rules.domain, "i").test(d.replace(/^\*\./, ""));
/** For a field's check: what is wrong with a port (empty is the field's own business). */
const portError = (x) => x && !(/^\d+$/.test(x) && +x >= 1 && +x <= 65535) && "A port from 1 to 65535";
/** For a field's check: what is wrong with a login's user or password (lf newLogin's rules). */
const userError = (user) => !new RegExp(S.state.rules.loginName).test(user) && "Only letters, digits and . _ @ -";
const passwordError = (pw) => pw.length < S.state.rules.minPassword && `The password needs at least ${S.state.rules.minPassword} characters`;
/**
 * Passwords here are for servers and sites, not for this page: a masked text field, so browsers
 * and password managers do not offer to save them. Browsers without text masking get a password field.
 */
const MASK = CSS.supports("-webkit-text-security", "disc");
const secretInput = (attrs, f) =>
  `<input ${attrs} class="secret" type="${MASK ? "text" : "password"}" value="${esc(f.value)}" placeholder="${esc(f.placeholder)}" autocomplete="${MASK ? "off" : "new-password"}" autocapitalize="off" spellcheck="false" data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other">`;
/** The shared <dialog>, closed and reset so a new one can take its place. */
function openDlg(cls = "") {
  const dlg = $("#dlg");
  if (dlg.open) dlg.close();
  dlg.className = cls;
  dlg.site = undefined;
  return dlg;
}
const confirmDlg = (o) => dialog({ ...o, onOk: () => o.onOk() });
const promptDlg = (title, text, field, onOk, ok = "OK") => dialog({ title, text, fields: [{ name: "v", ...field }], ok, onOk: (v) => onOk(v.v.trim()) });
