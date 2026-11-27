// The browser script, served as /_lf/a/s.js: web-vitals, then the tracker. The collector puts the site's cookie mode
// in place of "@COOKIE@" when it serves the script.
import { readFileSync } from "node:fs";
import type { PluginContext } from "../../core/plugins/plugin-api";
import { PREFIX } from "./shared";

// web-vitals: the build copies it next to the plugin's files; from source (tsx, tests) it is the package in node_modules.
const FROM_SOURCE = import.meta.url.endsWith(".ts");
const DEV_VITALS = new URL("../../../node_modules/web-vitals/dist/web-vitals.iife.js", import.meta.url);

/**
 * Pageviews (also for history.pushState navigation), engaged time and scroll depth per page, events, outbound links,
 * downloads and web vitals. A pageview carries the screen width, the language and the time zone (for the country).
 * Everything is queued and sent with sendBeacon.
 * Cookie mode off: nothing is stored in the browser. on: a random id in the first-party cookie lfa_id (12 months),
 * unless the browser sends Global Privacy Control. consent: the cookie only after lfa.consent(); lfa.consent(false)
 * deletes it. Without an id the collector counts the visitor by the daily hash.
 */
export const TRACKER = String.raw`
;(function () {
  try { if (localStorage.getItem("lfa:ignore")) { window.lfa = function () {}; window.lfa.consent = function () {}; return; } } catch (e) {}
  if (window.__lfa) return;
  window.__lfa = 1;
  var MODE = "@COOKIE@", K = "lfa_id", id = null;
  var E = ${JSON.stringify(PREFIX + "e")}, q = [], cur = null, first = true, active = 0, shown = 0, depth = 0, sent = 0;
  var visible = function () { return document.visibilityState === "visible"; };
  function readId() { var m = document.cookie.match(/(?:^|; )lfa_id=([A-Za-z0-9_-]{16,32})/); return m ? m[1] : null; }
  function writeId(v) {
    var tail = "; Path=/; SameSite=Lax" + (location.protocol === "https:" ? "; Secure" : "");
    document.cookie = v ? K + "=" + v + "; Max-Age=31536000" + tail : K + "=; Max-Age=0" + tail;
  }
  function newId() {
    var a = new Uint8Array(16), s = "";
    crypto.getRandomValues(a);
    for (var i = 0; i < a.length; i++) s += ("0" + a[i].toString(16)).slice(-2);
    return s;
  }
  if (MODE !== "off") {
    id = readId();
    if (!id && MODE === "on" && !navigator.globalPrivacyControl) { id = newId(); writeId(id); }
  }
  function send() {
    while (q.length) {
      var batch = q.splice(0, 30);
      if (id) batch[0].i = id;
      var body = JSON.stringify(batch);
      if (!(navigator.sendBeacon && navigator.sendBeacon(E, body))) {
        try { fetch(E, { method: "POST", body: body, keepalive: true }).catch(function () {}); } catch (e) {}
      }
    }
  }
  // Closes the engaged time of the current page into the queue.
  function seal() {
    if (shown) active += Date.now() - shown;
    shown = visible() ? Date.now() : 0;
    var s = Math.round(active / 1000);
    if (cur && s > 0) q.push({ k: "lv", p: cur, v: s });
    active = 0;
    if (cur && depth > sent) { q.push({ k: "sd", p: cur, v: depth }); sent = depth; }
  }
  // How far down the page the visitor got, in percent of its height.
  function scrolled() {
    var h = document.documentElement.scrollHeight;
    var d = h > 0 ? Math.min(100, Math.round(((scrollY + innerHeight) / h) * 100)) : 100;
    if (d > depth) depth = d;
  }
  addEventListener("scroll", scrolled, { passive: true });
  function pageview() {
    var p = location.pathname;
    if (p === cur) return;
    seal();
    cur = p;
    depth = 0;
    sent = 0;
    setTimeout(scrolled, 0);
    var tz = "";
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) {}
    var hit = { k: "pv", p: p, w: innerWidth, l: navigator.language, z: tz }, u = new URLSearchParams(location.search), utm = {}, any = false;
    if (first) { hit.r = document.referrer; first = false; }
    ["source", "medium", "campaign"].forEach(function (n) { var v = u.get("utm_" + n); if (v) { utm[n[0]] = v; any = true; } });
    if (!any && u.get("ref")) { utm.s = u.get("ref"); any = true; }
    if (any) hit.u = utm;
    q.push(hit);
    send();
  }
  function event(name, props) {
    if (!name) return;
    q.push({ k: "ev", p: location.pathname, n: String(name), x: props && typeof props === "object" ? props : undefined });
    send();
  }
  // The visitor said yes (or no, with false) to the analytics cookie.
  event.consent = function (yes) {
    if (MODE === "off") return;
    if (yes === false) { id = null; writeId(""); return; }
    if (!id) { id = readId() || newId(); writeId(id); }
  };
  var queued = window.lfa && window.lfa.q;
  window.lfa = event;
  ["pushState", "replaceState"].forEach(function (m) {
    var orig = history[m];
    history[m] = function () { var r = orig.apply(this, arguments); setTimeout(pageview, 0); return r; };
  });
  addEventListener("popstate", function () { setTimeout(pageview, 0); });
  document.addEventListener("visibilitychange", function () {
    if (visible()) shown = Date.now();
    else { seal(); shown = 0; send(); }
  });
  addEventListener("pagehide", function () { seal(); shown = 0; send(); });
  document.addEventListener("click", function (e) {
    var el = e.target && e.target.closest && e.target.closest("[data-lfa],a[href]");
    if (!el) return;
    if (el.hasAttribute("data-lfa")) return event(el.getAttribute("data-lfa"));
    var a = el, file = /\.(pdf|zip|dmg|exe|msi|pkg|deb|rpm|apk|csv|xlsx?|docx?|pptx?|mp3|mp4|mov|tar|gz|tgz|7z|rar)$/i;
    if (!/^https?:$/.test(a.protocol)) return;
    if (a.host !== location.host) event("Outbound link", { url: a.hostname + a.pathname });
    else if (file.test(a.pathname)) event("Download", { file: a.pathname });
  }, true);
  function vital(m) { q.push({ k: "vt", n: m.name, v: m.name === "CLS" ? +m.value.toFixed(4) : Math.round(m.value), p: location.pathname }); }
  if (window.webVitals) { webVitals.onLCP(vital); webVitals.onINP(vital); webVitals.onCLS(vital); webVitals.onFCP(vital); webVitals.onTTFB(vital); }
  pageview();
  if (queued) queued.forEach(function (a) { event(a[0], a[1]); });
})();`;

/** web-vitals and the tracker, as one script. */
export function clientJs(ctx: PluginContext): string {
  const vitals = FROM_SOURCE ? readFileSync(DEV_VITALS, "utf8") : ctx.file("web-vitals.iife.js");
  // The source map comment points at a file the collector does not serve.
  return vitals.replace(/\n\/\/# sourceMappingURL=\S+\s*$/, "\n") + TRACKER;
}
