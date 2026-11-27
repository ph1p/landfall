// The analytics collector that runs on the server (node:22-alpine, no dependencies, node:sqlite).
// GET  /_lf/a/s.js  serves the browser script (tracker + web-vitals), with the site's cookie mode filled in.
// POST /_lf/a/e     takes a JSON array of hits and stores them in /data/analytics.db.
//
// Country: the CF-IPCountry or X-Country-Code header of a proxy in front, else the browser's time zone. No IP lookup.
//
// Privacy: by default no cookies and nothing stored in the browser. A visitor is a hash of a random salt, the site, the
// IP address and the user agent. The salt lives only in memory and is replaced every day (UTC), so a visitor cannot be
// followed from one day to the next, and the IP address and user agent are never written anywhere.
// Sites with cookie "on" or "consent" (app/sites.json) send a random id from a first-party cookie instead; the visitor
// is then a hash of the site and that id, so returning visitors can be counted.
import http from "node:http";
import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const DB = "/data/analytics.db";
const KEEP_DAYS = 365;
const MAX_KEEP_DAYS = 3650;
const DAY = 86400;
const MAX_BODY = 8 * 1024;
const MAX_ITEMS = 30;
const SESSION_IDLE = 30 * 60;
const CAP = { LCP: 120000, INP: 60000, CLS: 100, FCP: 120000, TTFB: 120000 };
const BOT = /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|monitor|curl|wget|python|java\/|go-http|httpclient|okhttp|axios|node-fetch/i;

const nowSecs = () => Math.floor(Date.now() / 1000);
const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
};

const client = readFileSync("/app/client.js", "utf8");
/** IANA time zone → country code, for visitors without a country header. */
const ZONES = readJson("/app/tz.json");

const COLUMNS = ["t", "site", "sid", "vid", "kind", "path", "name", "value", "props", "ref", "us", "um", "uc", "country", "lang", "browser", "os", "device"];
const db = new DatabaseSync(DB);
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 3000;
CREATE TABLE IF NOT EXISTS hits (
  t INTEGER NOT NULL, site TEXT NOT NULL, sid TEXT NOT NULL, vid TEXT NOT NULL,
  kind TEXT NOT NULL,          -- pv pageview, ev event, lv engaged seconds on a page, sd scroll depth in %, vt web vital
  path TEXT, name TEXT, value REAL, props TEXT,
  ref TEXT, us TEXT, um TEXT, uc TEXT,
  country TEXT, lang TEXT, browser TEXT, os TEXT, device TEXT
);
CREATE INDEX IF NOT EXISTS hits_site_t ON hits (site, t);
CREATE INDEX IF NOT EXISTS hits_sid ON hits (sid, t);
CREATE INDEX IF NOT EXISTS hits_vid ON hits (site, vid, t);
CREATE INDEX IF NOT EXISTS hits_t ON hits (t);
`);
const insert = db.prepare(`INSERT INTO hits (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map(() => "?").join(", ")})`);
/** One row; columns the hit does not name are NULL. */
const addHit = (hit) => insert.run(...COLUMNS.map((c) => hit[c] ?? null));

// How much to keep: app/storage.json ({ keepDays, maxBytes }), written by lf analytics storage. Reread every minute;
// a change prunes at once, else once an hour.
const retention = () => {
  const { keepDays, maxBytes } = readJson("/app/storage.json");
  return {
    days: Number(keepDays) > 0 ? Math.min(Number(keepDays), MAX_KEEP_DAYS) : KEEP_DAYS,
    maxBytes: Number(maxBytes) > 0 ? Number(maxBytes) : 0,
  };
};
/** Bytes the rows take; pages freed by DELETE are reused, so the file stops growing at about this size. */
const pragmas = ["page_count", "freelist_count", "page_size"].map((n) => db.prepare(`PRAGMA ${n}`));
const usedBytes = () => {
  const [pages, free, size] = pragmas.map((q) => Object.values(q.get())[0]);
  return (pages - free) * size;
};
const deleteBefore = db.prepare("DELETE FROM hits WHERE t < ?");
const oldestHit = db.prepare("SELECT MIN(t) t FROM hits");
const prune = () => {
  try {
    const { days, maxBytes } = retention();
    let deleted = deleteBefore.run(nowSecs() - days * DAY).changes;
    // Over the size limit: drop the oldest day until it fits, but never today's hits.
    for (let i = 0; maxBytes && i < MAX_KEEP_DAYS && usedBytes() > maxBytes; i++) {
      const oldest = oldestHit.get()?.t;
      if (oldest == null || oldest > Date.now() / 1000 - DAY) break;
      deleted += deleteBefore.run(oldest + DAY).changes;
    }
    if (deleted) {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      console.error(`prune: deleted ${deleted} old hits`);
    }
  } catch (e) {
    console.error("prune:", e.message);
  }
};
let retentionSeen = JSON.stringify(retention());
let prunedAt = Date.now();
prune();
setInterval(() => {
  const current = JSON.stringify(retention());
  if (current === retentionSeen && Date.now() - prunedAt <= 3600 * 1000) return;
  retentionSeen = current;
  prunedAt = Date.now();
  prune();
}, 60 * 1000).unref();

// host → site and site → settings; reread every 30 s.
let hosts = {};
let sites = {};
let hostsAt = 0;
const siteOf = (host) => {
  if (Date.now() - hostsAt > 30000) {
    hosts = readJson("/app/hosts.json");
    sites = readJson("/app/sites.json");
    hostsAt = Date.now();
  }
  return hosts[host];
};
const MODES = ["off", "on", "consent"];
const cookieOf = (site) => (MODES.includes(sites[site]?.cookie) ? sites[site].cookie : "off");
/** The browser script per cookie mode. */
const scripts = new Map(MODES.map((m) => [m, Buffer.from(client.replace('"@COOKIE@"', JSON.stringify(m)))]));

// The day's salt and the open sessions (visitor hash → session). Both forgotten at midnight UTC.
let salt = { day: "", key: Buffer.alloc(0) };
let sessions = new Map();
const today = () => new Date().toISOString().slice(0, 10);
const dailyVisitor = (site, ip, ua) => {
  if (salt.day !== today()) {
    salt = { day: today(), key: randomBytes(32) };
    sessions = new Map();
  }
  // "~" marks a daily visitor: base64url has no "~", so the queries can tell them from cookie visitors.
  return "~" + createHash("sha256").update(salt.key).update(`${site}\n${ip}\n${ua}`).digest("base64url").slice(0, 15);
};
const COOKIE_ID = /^[A-Za-z0-9_-]{16,32}$/;
/** A cookie visitor: the same on every day, so a returning visitor is counted as one. */
const cookieVisitor = (site, id) => createHash("sha256").update(`id\n${site}\n${id}`).digest("base64url").slice(0, 16);
const sessionOf = (vid, t) => {
  let s = sessions.get(vid);
  if (!s || t - s.last > SESSION_IDLE) {
    s = { sid: randomBytes(9).toString("base64url"), device: "" };
    sessions.set(vid, s);
  }
  s.last = t;
  return s;
};
setInterval(() => {
  const t = Date.now() / 1000;
  for (const [vid, s] of sessions) if (t - s.last > SESSION_IDLE) sessions.delete(vid);
}, 60000).unref();

// First match wins: Edge and Opera also say Chrome, Chrome also says Safari.
const BROWSERS = [
  [/Edg\//, "Edge"],
  [/OPR\/|Opera/, "Opera"],
  [/SamsungBrowser/, "Samsung Internet"],
  [/Firefox\/|FxiOS/, "Firefox"],
  [/Chrome\/|CriOS/, "Chrome"],
  [/Safari\//, "Safari"],
];
const SYSTEMS = [
  [/iPhone|iPad|iPod/, "iOS"],
  [/Android/, "Android"],
  [/Windows/, "Windows"],
  [/CrOS/, "ChromeOS"],
  [/Mac OS X|Macintosh/, "macOS"],
  [/Linux/, "Linux"],
];
const firstMatch = (list, ua) => list.find(([re]) => re.test(ua))?.[1] ?? "Other";
const browserOf = (ua) => firstMatch(BROWSERS, ua);
const osOf = (ua) => firstMatch(SYSTEMS, ua);
/** By viewport width when the page sent one, else by user agent. */
const deviceOf = (width, ua) => {
  if (width > 0) return width < 768 ? "mobile" : width < 1024 ? "tablet" : "desktop";
  if (/iPad|Tablet/.test(ua)) return "tablet";
  return /Mobi|Android/.test(ua) ? "mobile" : "desktop";
};

const str = (v, n) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);
const pathOf = (p) => (typeof p === "string" && p.startsWith("/") ? p.split(/[?#]/)[0].slice(0, 200) : "/");
const EVENT_NAME = /^[\w .:/@&+-]{1,60}$/u;
const PROP_KEY = /^[\w .:-]{1,40}$/;

/** Referrer domain, or null for none and for links within the same site. */
const refOf = (r, site) => {
  if (typeof r !== "string" || !r) return null;
  try {
    const host = new URL(r).hostname.toLowerCase();
    if (!host || hosts[host] === site) return null;
    return host.replace(/^www\./, "").slice(0, 100);
  } catch {
    return null;
  }
};

/** At most 10 keys, values cut to 100 characters, null when nothing is left. */
const propsOf = (x) => {
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  const out = {};
  for (const [k, v] of Object.entries(x).slice(0, 10)) {
    if (!PROP_KEY.test(k)) continue;
    if (typeof v === "string") out[k] = v.slice(0, 100);
    else if ((typeof v === "number" && Number.isFinite(v)) || typeof v === "boolean") out[k] = v;
  }
  return Object.keys(out).length ? JSON.stringify(out) : null;
};

/** The proxy's country header; XX is Cloudflare's "unknown". */
const headerCountry = (req) =>
  str(req.headers["cf-ipcountry"] || req.headers["x-country-code"], 2)
    ?.toUpperCase()
    .replace(/[^A-Z]/g, "") || null;

function store(site, req, list) {
  const ua = String(req.headers["user-agent"] || "");
  if (!ua || BOT.test(ua)) return;
  const forwarded = String(req.headers["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();
  const ip = forwarded || req.socket.remoteAddress || "";
  const t = nowSecs();
  const id = cookieOf(site) === "off" ? undefined : list.find((h) => typeof h?.i === "string" && COOKIE_ID.test(h.i))?.i;
  const vid = id ? cookieVisitor(site, id) : dailyVisitor(site, ip, ua);
  const s = sessionOf(vid, t);

  const header = headerCountry(req);
  const zone = list.find((h) => h?.k === "pv" && typeof h.z === "string")?.z;
  const country = (header !== "XX" && header) || (zone && Object.hasOwn(ZONES, zone) ? ZONES[zone] : null) || s.country || null;
  if (country) s.country = country;
  const browser = browserOf(ua);
  const os = osOf(ua);

  db.exec("BEGIN");
  try {
    for (const h of list.slice(0, MAX_ITEMS)) {
      if (!h || typeof h !== "object") continue;
      const base = { t, site, sid: s.sid, vid, path: pathOf(h.p) };
      switch (h.k) {
        case "pv": {
          s.device = deviceOf(Number(h.w) || 0, ua);
          s.lang = str(h.l, 16)?.split("-")[0].toLowerCase() || null;
          const utm = h.u && typeof h.u === "object" ? h.u : {};
          addHit({
            ...base,
            kind: "pv",
            ref: refOf(h.r, site),
            us: str(utm.s, 100),
            um: str(utm.m, 100),
            uc: str(utm.c, 100),
            country,
            lang: s.lang,
            browser,
            os,
            device: s.device,
          });
          break;
        }
        case "ev": {
          const name = str(h.n, 60);
          if (!name || !EVENT_NAME.test(name)) break;
          addHit({ ...base, kind: "ev", name, props: propsOf(h.x), country, lang: s.lang, browser, os, device: s.device || deviceOf(0, ua) });
          break;
        }
        case "lv": {
          const secs = Number(h.v);
          if (secs > 0 && secs <= 3600) addHit({ ...base, kind: "lv", value: Math.round(secs) });
          break;
        }
        case "sd": {
          const depth = Math.round(Number(h.v));
          if (depth > 0 && depth <= 100) addHit({ ...base, kind: "sd", value: depth });
          break;
        }
        case "vt": {
          const value = Number(h.v);
          if (!Object.hasOwn(CAP, h.n) || !Number.isFinite(value) || value < 0 || value > CAP[h.n]) break;
          addHit({ ...base, kind: "vt", name: h.n, value, browser, os, device: s.device || deviceOf(0, ua) });
          break;
        }
      }
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

http
  .createServer((req, res) => {
    const host = String(req.headers.host || "")
      .replace(/:\d+$/, "")
      .toLowerCase();
    const site = siteOf(host);
    if (!site) return res.writeHead(404).end();
    if (req.method === "GET" && req.url.startsWith("/_lf/a/s.js")) {
      return res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=3600" }).end(scripts.get(cookieOf(site)));
    }
    if (req.method !== "POST" || req.url !== "/_lf/a/e") return res.writeHead(404).end();
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) req.destroy();
    });
    req.on("end", () => {
      let list;
      try {
        list = JSON.parse(body);
      } catch {
        return res.writeHead(400).end();
      }
      if (!Array.isArray(list)) return res.writeHead(400).end();
      try {
        store(site, req, list);
      } catch (e) {
        console.error("store:", e.message);
        return res.writeHead(500).end();
      }
      res.writeHead(204).end();
    });
  })
  .listen(8080, () => console.log("analytics collector on :8080"));
