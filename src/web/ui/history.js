"use strict";
// ---- history -------------------------------------------------------------------

function historyView(n) {
  const st = S.history[n];
  const wait = pending(st, "reading the journal…");
  if (wait) return wait;
  const runs = st.data;
  if (!runs.length) return `<div class="card"><div class="body empty"><h2>Nothing yet</h2><p>Every change landfall makes on ${esc(n)} is logged here, with a way to undo it.</p></div></div>`;
  const s = sv(n);
  const undo = (argv) => run(["undo", ...argv, ...s, "-y"], { server: n });
  const total = runs.reduce((a, r) => a + r.pending, 0);
  const items = runs
    .map((r) => {
      const todo = r.steps.filter((x) => x.undo && !x.undone);
      const later = runs.filter((x) => x.n > r.n && x.pending);
      const undoRun = () =>
        dialog({
          title: `Undo #${r.n} ${r.cmd} on ${n}?`,
          text: [...todo.map((x) => `↺ ${x.what}`).reverse(), ...(later.length ? ["", `Later runs build on it and stay: ${later.map((x) => `#${x.n}`).join(", ")}`] : [])].join("\n"),
          ok: `Revert ${plural(todo.length, "change")}`,
          danger: true,
          onOk: () => undo([String(r.n)]),
        });
      const steps = r.steps
        .map((x, i) => {
          const [cls, ico] = x.reverts ? ["fixed", "↩"] : x.undone ? ["undone", "✓"] : x.undo ? ["", "↺"] : ["fixed", "·"];
          const one = x.undo && !x.undone
            ? btn("undo", () => confirmDlg({ title: `Undo step ${r.n}.${i + 1}?`, text: x.what, ok: "Undo it", danger: true, onOk: () => undo([`${r.n}.${i + 1}`]) }), "ghost sm")
            : "";
          return `<li class="${cls}"><span class="ico">${ico}</span><span class="what">${esc(x.what)}</span>${!x.undo && !x.reverts ? `<span class="faint">(not reversible)</span>` : ""}${x.undone ? `<span class="faint">(undone)</span>` : ""}${one}</li>`;
        })
        .join("");
      return `<div class="run">
        <div class="top"><b>#${r.n}</b><span class="cmd">${esc(r.cmd || "?")}</span><span class="dim">${esc(ago(r.time))}</span>
          <span class="faint mono hide-sm">${esc(r.actor)} · ${esc(r.id)}</span>
          <span class="actions">${r.pending ? btn(`Undo ${plural(r.pending, "change")}`, undoRun, "sm") : `<span class="faint">nothing to undo</span>`}</span></div>
        <ul class="steps">${steps}</ul></div>`;
    })
    .join("");
  return `
    <div class="card">
      <h2>Journal <span class="dim" style="font-weight:400">/opt/landfall/journal.log · newest first</span>
        <span class="actions">${total ? btn("Undo everything", () => confirmDlg({ title: `Undo everything landfall did on ${n}?`, text: `${plural(total, "change")}, newest first. Sites, Traefik, the deploy user and landfall's firewall rules go away.`, ok: "Revert everything", danger: true, typeToConfirm: n, onOk: () => undo(["--all"]) }), "sm danger") : ""}</span></h2>
      ${items}
    </div>`;
}
