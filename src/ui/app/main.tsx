import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import "./app.css";
import { S, errorMessage, render, useStore } from "./lib/store";
import { go, loadReach, refreshState, reload, route } from "./lib/api";
import { resumeJobs } from "./lib/jobs";
import { Empty } from "./ui/kit";
import { closeMenu, menuOpen, MenuHost } from "./ui/menu";
import { dialogOpen, DialogHost } from "./ui/dialog";
import { ToastHost } from "./ui/toast";
import { App } from "./views/shell/app";
import { ensureDns } from "./views/domains";
import { listenForDrops } from "./views/flows/drops";
import { sections } from "./views/shared";

let fatal = "";

function Root() {
  useStore();
  useEffect(() => {
    document.title = S.sel ? `${S.sel} · ${S.tab} · landfall` : "landfall";
  });
  return (
    <>
      {fatal ? (
        <Empty title="lf ui">
          <p>{fatal}</p>
        </Empty>
      ) : (
        <App />
      )}
      <MenuHost />
      <DialogHost />
      <ToastHost />
    </>
  );
}

const typing = (e: KeyboardEvent) => !!(e.target as Element | null)?.closest?.("input, textarea, select");
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && menuOpen()) return closeMenu();
  // 1-9: the open server's sections.
  const sec = S.sel && sections(S.sel)[Number(e.key) - 1];
  if (sec && S.sel && !e.metaKey && !e.ctrlKey && !e.altKey && !dialogOpen() && !typing(e)) return go(S.sel, sec[0]);
  if (e.key === "Escape" && !dialogOpen() && S.job && !typing(e)) {
    S.job = null;
    render();
  }
});
addEventListener("hashchange", route);
listenForDrops();

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
  reload(n, "stats");
}, 5_000);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);

(async () => {
  try {
    await refreshState();
    loadReach();
    // Jobs started before a reload keep running on the server: list them, and show one still running.
    const fetchOld = resumeJobs(S.state.jobs);
    route();
    fetchOld();
  } catch (e) {
    fatal = errorMessage(e);
    render();
  }
})();
