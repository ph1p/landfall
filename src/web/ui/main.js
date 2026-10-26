"use strict";
// ---- top level -----------------------------------------------------------

function render() {
  if (!S.state) return;
  // Every render re-registers the buttons it draws (dialogs wire their own buttons).
  handlers = new Map();
  const scroll = $("#main").scrollTop;
  // innerHTML drops the focused button: find its redrawn twin by its data-f key.
  const f = document.activeElement?.dataset?.f;
  // So is what someone was typing into the add-rule form.
  const form = $("#addrule"), typed = form && [...form.elements].filter((el) => el.name).map((el) => [el.name, el.value]);
  const typing = form?.contains(document.activeElement) && document.activeElement.name;
  renderHeader();
  renderNav();
  renderMain();
  renderJob();
  $("#main").scrollTop = scroll;
  const again = typed && $("#addrule");
  if (again) {
    for (const [k, v] of typed) again.elements[k].value = v;
    if (typing) again.elements[typing].focus({ preventScroll: true });
  }
  if (f && !document.activeElement?.closest?.("#dlg, #menu")) [...document.querySelectorAll("[data-f]")].find((el) => el.dataset.f === f)?.focus({ preventScroll: true });
  document.title = S.sel ? `${S.sel} · ${S.tab} · landfall` : "landfall";
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && menuEl) return closeMenu();
  // 1-9: the open server's sections.
  const sec = S.sel && sections(S.sel)[Number(e.key) - 1];
  if (sec && S.sel && !e.metaKey && !e.ctrlKey && !e.altKey && !$("#dlg").open && !e.target.closest?.("input, textarea, select")) return go(S.sel, sec[0]);
  if (e.key === "Escape" && !$("#dlg").open && S.job && !e.target.closest?.("input, textarea, select")) {
    S.job = null;
    render();
  }
});

$("#filter").addEventListener("input", (e) => {
  S.filter = e.target.value.trim();
  renderNav();
});
$("#add-server").onclick = () => addServer();
// Servers go up and down: check again each minute while the page is visible.
setInterval(() => document.hidden || loadReach(), 60_000);
// Sites answer or not: check their domains again each minute while their tab is open.
setInterval(() => {
  const n = S.sel;
  if (document.hidden || !n || S.tab !== "sites") return;
  ensureDns(n, S.overview[n]?.data, true);
}, 60_000);
// Live stats: a new sample every 5s while the tab is open, unless the last one is still running.
setInterval(() => {
  const n = S.sel;
  if (document.hidden || !n || S.tab !== "stats" || S.stats[n]?.loading || S.overview[n]?.error) return;
  load(n, "stats", true);
}, 5_000);

(async () => {
  try {
    await refreshState();
    loadReach();
    // Jobs started before a reload keep running on the server: list them, and show one still running.
    const old = [];
    for (const info of S.state.jobs.slice().reverse()) {
      const j = { info, lines: [], actions: [] };
      S.jobs.set(info.id, j);
      if (info.code === undefined) stream(j);
      else old.push(j);
    }
    S.job = S.state.jobs.find((j) => j.code === undefined)?.id ?? null;
    route();
    // Finished jobs' output only matters once someone opens them: fetch it after the page is up.
    for (const j of old) {
      http(`/api/jobs/${j.info.id}`).then((full) => {
        j.lines = full.lines;
        if (S.job === j.info.id) render();
      }, () => {});
    }
  } catch (e) {
    $("#main").innerHTML = `<div class="empty"><h2>lf ui</h2><p>${esc(e.message)}</p></div>`;
  }
})();
