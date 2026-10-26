"use strict";
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
function ago(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!isFinite(s)) return "";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

// ---- state ---------------------------------------------------------------

const S = {
  state: null,           // /api/state
  sel: null,             // selected server name
  tab: "sites",
  overview: {},          // name -> {data} | {error} | {loading}
  firewall: {},
  det: {},               // project folder -> what /api/fs detected there (null while reading, false if it failed)
  system: {},            // name -> {data: lf system --json}
  history: {},
  updates: {},
  facts: {},
  stats: {},             // name -> {data: lf stats --json}; reloads every few seconds while the tab is open
  statsLog: {},          // name -> [{cpu, mem}], the last samples, for the sparklines
  disk: {},              // name -> {data: lf disk --json}, only on request: du takes a while
  settings: {},          // name -> {data: lf server config --json + dns of the main domain}
  dns: {},               // name -> {data: {ips, domains: [{domain, ips, ok, https: lf check}]}}; checked again each minute
  traffic: {},           // name -> {data: lf traffic --json --since S.since}
  since: "24h",          // the Traffic tab's range
  errs: {},              // name -> {data: lf traffic --json --since 24h}, for the sites' errors card
  certs: {},             // name -> {data: lf certs --json}
  open: new Set(),       // expanded site rows
  filter: "",            // server list filter
  reach: {},             // name -> {state: ok|login|down, detail, ms} from /api/reach
  reaching: false,
  reachedAt: null,       // when the last check finished
  jobs: new Map(),       // id -> {info, lines, after, actions, es}
  job: null,             // shown job id
};

async function http(path, body) {
  const r = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (r.status === 401) throw new Error("This browser is not logged in. Open the link `lf ui` printed.");
  const data = await r.json().catch(() => ({ error: `${r.status} ${r.statusText}` }));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

// One live region in the top layer, so it shows (and is announced) above an open dialog too.
// action: {label, run} adds a button, e.g. to open the job a toast is about.
let toastTimer;
function toast(msg, action) {
  const t = $("#toast");
  t.textContent = msg;
  if (action) {
    const b = Object.assign(document.createElement("button"), { type: "button", className: "sm", textContent: action.label });
    b.onclick = () => (hideToast(), action.run());
    t.append(b);
  }
  t.hidePopover?.();
  t.showPopover?.();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, Math.max(4000, msg.length * 70) + (action ? 4000 : 0));
}
function hideToast() {
  $("#toast").hidePopover?.();
}
$("#toast").onmouseenter = () => clearTimeout(toastTimer);
$("#toast").onmouseleave = () => (toastTimer = setTimeout(hideToast, 2000));
/** Tell screen readers about a change that has no visible text of its own. */
function say(text) {
  const r = $("#sr-live");
  r.textContent = "";
  setTimeout(() => (r.textContent = text), 50);
}

// Buttons call functions registered per render: data-k="<id>".
let handlers = new Map();
let hid = 0;
function on(fn) {
  const k = String(++hid);
  handlers.set(k, fn);
  return `data-k="${k}"`;
}
/** f: a key that stays the same across renders, so the button keeps its keyboard focus when redrawn. attrs: more HTML attributes. */
function btn(label, fn, cls = "", title = "", f = "", attrs = "") {
  return `<button type="button" class="${cls}" ${on(fn)}${title ? ` title="${esc(title)}"` : ""}${f ? ` data-f="${esc(f)}"` : ""}${attrs ? ` ${attrs}` : ""}>${label}</button>`;
}
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-k]");
  // A click outside an open menu only closes it.
  if (menuEl && !menuEl.contains(e.target)) {
    closeMenu(false);
    e.preventDefault();
    return void e.stopPropagation();
  }
  if (!el || el.disabled) return;
  const fn = handlers.get(el.dataset.k);
  if (fn) {
    e.preventDefault();
    e.stopPropagation();
    fn(e, el);
  }
});

/**
 * A "⋯" button for the less used actions. items: [{label, run, cls, title, hint}] or "-" for a divider;
 * falsy items are skipped. The menu keeps its own handlers, so a render while it is open leaves it working.
 */
function menuBtn(items, title = "More actions", cls = "sm") {
  items = items.filter(Boolean);
  if (!items.length) return "";
  return btn("⋯", (e, el) => openMenu(el, items), `${cls} more`, title, "", `aria-haspopup="menu" aria-expanded="false" aria-label="${esc(title)}"`);
}
let menuAnchor = null;
let menuEl = null;
function openMenu(anchor, items) {
  closeMenu(false);
  menuAnchor = anchor;
  anchor.setAttribute("aria-expanded", "true");
  const m = Object.assign(document.createElement("div"), { id: "menu", className: "menu" });
  m.setAttribute("role", "menu");
  m.innerHTML = items
    .map((it, i) => it === "-" ? `<hr role="separator">` : `<button type="button" role="menuitem" data-i="${i}" class="${it.cls ?? ""}"${it.title ? ` title="${esc(it.title)}"` : ""}><span>${esc(it.label)}</span>${it.hint ? `<span class="k">${esc(it.hint)}</span>` : ""}</button>`)
    .join("");
  m.onclick = (e) => {
    const b = e.target.closest("button[data-i]");
    if (!b) return;
    closeMenu();
    items[b.dataset.i].run();
  };
  m.onkeydown = (e) => {
    const all = [...m.querySelectorAll("button")];
    const i = all.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      all[(i + (e.key === "ArrowDown" ? 1 : all.length - 1)) % all.length].focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      all[e.key === "Home" ? 0 : all.length - 1].focus();
    }
  };
  // Keep focus where it is on mousedown: a browser that does not focus clicked buttons would blur the menu and close it before the click.
  m.onmousedown = (e) => e.preventDefault();
  m.addEventListener("focusout", (e) => {
    if (!m.contains(e.relatedTarget)) closeMenu(false);
  });
  document.body.append(m);
  menuEl = m;
  const r = anchor.getBoundingClientRect();
  m.style.left = `${Math.max(8, Math.min(r.right - m.offsetWidth, innerWidth - m.offsetWidth - 8))}px`;
  m.style.top = `${r.bottom + 4 + m.offsetHeight > innerHeight - 8 ? Math.max(8, r.top - m.offsetHeight - 4) : r.bottom + 4}px`;
  $("button", m)?.focus({ preventScroll: true });
}
/** restore: focus goes back to the "⋯" button (Esc, or an item that opens no dialog). */
function closeMenu(restore = true) {
  const m = menuEl;
  if (!m) return;
  // Removing the focused item fires focusout, which calls closeMenu again: clear menuEl first so that call is a no-op.
  menuEl = null;
  m.remove();
  menuAnchor?.setAttribute("aria-expanded", "false");
  if (restore && menuAnchor?.isConnected) menuAnchor.focus({ preventScroll: true });
  menuAnchor = null;
}
addEventListener("resize", () => closeMenu(false));
document.addEventListener("scroll", (e) => e.target.closest?.("#menu") || closeMenu(false), true);

/** The -s flag for server n, and the open server. */
const sv = (n) => ["-s", n];
const serverNamed = (n) => S.state?.servers.find((s) => s.name === n);
const server = () => serverNamed(S.sel);
const tilde = (p) => p.replace(/^\/(Users|home)\/[^/]+/, "~");

// ---- routing: #/<server>/<tab> ---------------------------------------------

function go(sel, tab = S.tab) {
  const hash = sel ? `#/${encodeURIComponent(sel)}/${tab}` : "#/";
  if (location.hash !== hash) location.hash = hash;
  else route();
}
function route() {
  const [, name, tab] = location.hash.split("/");
  S.sel = name ? decodeURIComponent(name) : null;
  S.tab = tab in STORE ? tab : "sites";
  if (S.sel && server()) load(S.sel, S.tab);
  render();
}
window.addEventListener("hashchange", route);

// ---- loading -------------------------------------------------------------

const STORE = { sites: "overview", tunnels: "overview", stats: "stats", traffic: "traffic", traefik: "settings", facts: "facts", updates: "updates", firewall: "firewall", system: "system", history: "history", settings: "settings" };
const URLS = { sites: "", tunnels: "", stats: "/stats", traffic: "/traffic", traefik: "/config", facts: "/facts", updates: "/updates", firewall: "/firewall", system: "/system", history: "/history", settings: "/config" };
// A server's sections, in the list and as tabs on phones; keys 1-9 switch between them.
const SECTIONS = [["sites", "Sites"], ["tunnels", "Tunnels"], ["stats", "Stats"], ["traffic", "Traffic"], ["traefik", "Traefik"], ["updates", "Updates"], ["firewall", "Firewall"], ["system", "System"], ["history", "History"], ["settings", "Settings"]];

// The overview and facts drive the header, so every tab needs them.
const needs = (tab) => (STORE[tab] === "overview" ? ["sites", "facts"] : ["sites", "facts", tab]);
/** Fetches server n's url into S[store][n]: loading, then { data } or { error }, and renders. */
function fetchInto(store, n, url, then) {
  // Keep what is shown while it reloads; views show a spinner only when they have nothing yet.
  S[store][n] = { ...S[store][n], loading: true, error: undefined };
  return http(`/api/servers/${encodeURIComponent(n)}${url}`).then(
    (data) => (then?.(data), (S[store][n] = { data }), render()),
    (e) => ((S[store][n] = { error: e.message }), render()),
  );
}
/** A spinner while st has nothing to show yet, or its error; "" once there is data. what is HTML. */
const pending = (st, what) =>
  !st || (st.loading && !st.data) ? `<div class="loading"><span class="spin"></span> ${what}</div>` : st.error ? `<div class="note bad">${esc(st.error)}</div>` : "";

function load(name, tab, force = false) {
  for (const t of needs(tab)) {
    if (S[STORE[t]][name] && !force) continue;
    fetchInto(STORE[t], name, `${URLS[t]}${t === "traffic" ? `?since=${S.since}` : ""}`, t === "stats" ? (data) => logStats(name, data) : undefined);
  }
}
function invalidate(name) {
  delete S.dns[name];
  delete S.errs[name];
  delete S.certs[name];
  // What is on screen reloads in place; other tabs reload when opened.
  const shown = new Set(S.sel === name ? needs(S.tab).map((t) => STORE[t]) : []);
  for (const k of Object.values(STORE)) if (!shown.has(k)) delete S[k][name];
  if (S.sel === name) load(name, S.tab, true);
}
async function refreshState() {
  S.state = await http("/api/state");
  render();
}
/** Which servers take landfall's ssh login; the server caches each answer for 30s unless fresh. */
async function loadReach(fresh = false) {
  if (S.reaching) return;
  S.reaching = true;
  renderNav();
  try {
    S.reach = await http(`/api/reach${fresh ? "?fresh=1" : ""}`);
    S.reachedAt = new Date();
  } catch (e) {
    toast(`Checking servers failed: ${e.message}`);
  } finally {
    S.reaching = false;
    // The home tiles show the dots too; an open server's view stays as it is.
    S.sel ? renderNav() : render();
  }
}
const REACH_DOT = { ok: ["up", "reachable"], login: ["warn", "login refused"], down: ["down", "unreachable"] };
function reachDot(n) {
  const r = S.reach[n];
  if (!r) return `<span class="dot" role="img" aria-label="not checked yet" title="${S.reaching ? "Checking…" : "Not checked yet"}"></span>`;
  const [cls, word] = REACH_DOT[r.state];
  const tip = r.state === "ok" ? `Key login works (${r.ms} ms)` : r.state === "login" ? `sshd answers but refuses the login: ${r.detail}` : `Unreachable: ${r.detail}`;
  return `<span class="dot ${cls}" role="img" aria-label="${word}" title="${esc(tip)}"></span>`;
}
