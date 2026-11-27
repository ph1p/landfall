// Reads /data/analytics.db for the landfall analytics plugin and prints one JSON object.
// node query.mjs <base64 JSON request> [funnels JSON]
// Requests: { op: "report" | "path" | "events" | "vitals" | "purge" | "export", site?, days?, limit?, page?, name?, format? }
// export streams every row as CSV (default) or JSON lines instead of one object; days 0 or unset means all.
import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

// Errors as one line (the plugin shows it), not a stack trace.
process.on("uncaughtException", (e) => {
  console.error(String(e?.errstr ?? e?.message ?? e));
  process.exit(1);
});

const DB = "/data/analytics.db";
const DAY = 86400;
const WEEK = 7 * DAY;
const LIMITS = { LCP: [2500, 4000], INP: [200, 500], CLS: [0.1, 0.25], FCP: [1800, 3000], TTFB: [800, 1800] };
const METRICS = Object.keys(LIMITS);

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const parseJson = (text, fallback) => {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
};

const req = JSON.parse(Buffer.from(process.argv[2] ?? "", "base64").toString() || "{}");
const funnels = parseJson(process.argv[3] || "[]", []);
const now = Math.floor(Date.now() / 1000);
const days = clamp(Number(req.days) || 7, 1, 400);
const limit = clamp(Number(req.limit) || 10, 1, 500);
const site = typeof req.site === "string" ? req.site : "";
const from = now - days * DAY;
const prevFrom = from - days * DAY;

/** Sites with a cookie (app/sites.json). Only their cookie visitors are the same person from one day to the next. */
const siteSettings = parseJson(existsSync("/app/sites.json") ? readFileSync("/app/sites.json", "utf8") : "{}", {}) ?? {};
const cookieSites = Object.keys(siteSettings).filter((k) => ["on", "consent"].includes(siteSettings[k]?.cookie));

const out = (o) => process.stdout.write(JSON.stringify(o));
if (!existsSync(DB)) {
  if (req.op !== "export") out({ empty: true, days, from, to: now });
  process.exit(0);
}

if (req.op === "purge") {
  const db = new DatabaseSync(DB);
  db.exec("PRAGMA busy_timeout = 5000");
  const r = site ? db.prepare("DELETE FROM hits WHERE site = ?").run(site) : db.prepare("DELETE FROM hits").run();
  db.exec("VACUUM");
  out({ deleted: Number(r.changes) });
  process.exit(0);
}

const db = new DatabaseSync(DB, { readOnly: true });
db.exec("PRAGMA busy_timeout = 5000; PRAGMA temp_store = MEMORY");
const all = (sql, ...params) => db.prepare(sql).all(...params);
// Every query filters on time and, when given, the site.
const W = "t >= ? AND t < ? AND (? = '' OR site = ?)";
const w = (a = from, b = now + 1) => [a, b, site, site];

/** Adds one to a key's count. */
const tally = (counts, key) => counts.set(key, (counts.get(key) ?? 0) + 1);
/** A map's entries, largest count first. */
const ranked = (counts, n) => [...counts].sort((a, b) => b[1] - a[1]).slice(0, n);
const share = (n, of) => (of ? Math.round((100 * n) / of) : 0);

/** Per session: site, pageviews, events, engaged seconds, and its entry page's attributes. */
const SESSIONS = `
WITH s AS (
  SELECT sid, site, MIN(vid) vid, MIN(t) t0, SUM(kind = 'pv') pvs, SUM(kind = 'ev') evs, COALESCE(SUM(CASE kind WHEN 'lv' THEN value END), 0) secs
  FROM hits WHERE ${W} GROUP BY sid
),
e AS (
  SELECT sid, path, ref, us, um, uc, country, lang, browser, os, device,
    ROW_NUMBER() OVER (PARTITION BY sid ORDER BY t, rowid) rn
  FROM hits WHERE kind = 'pv' AND ${W}
)
SELECT s.*, e.path entry, e.ref, e.us, e.um, e.uc, e.country, e.lang, e.browser, e.os, e.device
FROM s JOIN e ON e.sid = s.sid AND e.rn = 1`;

/** The sessions of a range as a temp table, built on first use: the report groups the same sessions many ways. */
const sessTables = new Map();
function sessions(a = from, b = now + 1) {
  const key = `${a}:${b}`;
  let name = sessTables.get(key);
  if (!name) {
    name = `temp.sess${sessTables.size}`;
    db.prepare(`CREATE TABLE ${name} AS ${SESSIONS}`).run(...w(a, b), ...w(a, b));
    sessTables.set(key, name);
  }
  return name;
}

function overview(a, b) {
  const rows = all(
    `SELECT site, COUNT(DISTINCT vid) visitors, COUNT(*) sessions, SUM(pvs) pageviews,
       ROUND(100.0 * SUM(pvs <= 1 AND evs = 0) / COUNT(*)) bounce, ROUND(AVG(secs)) secs
     FROM ${sessions(a, b)} GROUP BY site ORDER BY visitors DESC`,
  );
  // Returning: seen before the range, or on more than one day in it. Only cookie visitors can be: the cookieless hash
  // changes every day.
  const returning = new Map(
    all(
      `WITH v AS (SELECT site, vid, COUNT(DISTINCT date(t, 'unixepoch')) d FROM hits WHERE kind = 'pv' AND ${W} GROUP BY site, vid)
       SELECT site, SUM(d > 1 OR EXISTS (SELECT 1 FROM hits o WHERE o.site = v.site AND o.vid = v.vid AND o.t < ?)) n FROM v GROUP BY site`,
      ...w(a, b),
      a,
    ).map((r) => [r.site, Number(r.n) || 0]),
  );
  for (const r of rows) r.returning = returning.get(r.site) ?? 0;
  return rows;
}

const sum = (rows, key) => rows.reduce((n, r) => n + (Number(r[key]) || 0), 0);
/** Averages weighted by sessions, so a big site counts for more than a small one. */
const weighted = (rows, key, sessions) => (sessions ? Math.round(rows.reduce((n, r) => n + r[key] * r.sessions, 0) / sessions) : null);
function total(rows) {
  const sessions = sum(rows, "sessions");
  return {
    visitors: sum(rows, "visitors"),
    returning: sum(rows, "returning"),
    sessions,
    pageviews: sum(rows, "pageviews"),
    bounce: weighted(rows, "bounce", sessions),
    secs: weighted(rows, "secs", sessions),
  };
}

/** Sessions grouped by an attribute of their entry page. */
const bySession = (expr, n = limit) =>
  all(
    `SELECT ${expr} value, COUNT(*) sessions, COUNT(DISTINCT vid) visitors, ROUND(100.0 * SUM(pvs <= 1 AND evs = 0) / COUNT(*)) bounce
     FROM ${sessions()} GROUP BY 1 ORDER BY sessions DESC LIMIT ?`,
    n,
  );

/** The pageviews and events of each session, in order (for journeys, flows and funnels). */
function streams() {
  const bySid = new Map();
  for (const r of all(`SELECT site, sid, kind, path, name FROM hits WHERE kind IN ('pv', 'ev') AND ${W} ORDER BY sid, t, rowid`, ...w())) {
    let s = bySid.get(r.sid);
    if (!s) bySid.set(r.sid, (s = { site: r.site, steps: [] }));
    s.steps.push(r);
  }
  return [...bySid.values()];
}

const pathsOf = (steps) => steps.filter((x) => x.kind === "pv").map((x) => x.path);
/** Pages of a session without repeats in a row (a reload is not a step). */
const pagesOf = (steps) => pathsOf(steps).filter((p, i, a) => i === 0 || p !== a[i - 1]);

function journeys(ss) {
  const counts = new Map();
  for (const s of ss) {
    const pages = pagesOf(s.steps).slice(0, 4);
    if (pages.length) tally(counts, `${s.site}\t${pages.join("\t")}`);
  }
  const n = ss.length || 1;
  return ranked(counts, limit).map(([key, sessions]) => {
    const [s, ...pages] = key.split("\t");
    return { site: s, pages, sessions, share: share(sessions, n) };
  });
}

const glob = (p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
/** A funnel step: "event:<name>" matches that event, anything else a page path (* is a wildcard). */
const matcher = (step) => {
  if (step.startsWith("event:")) {
    const name = step.slice(6);
    return (x) => x.kind === "ev" && x.name === name;
  }
  const re = glob(step);
  return (x) => x.kind === "pv" && re.test(x.path);
};

/** Sessions that reached each step, in order (other pages in between are fine). */
function funnel(f, ss) {
  const matchers = f.steps.map(matcher);
  const reached = f.steps.map(() => 0);
  for (const s of ss) {
    if (s.site !== f.site) continue;
    let i = 0;
    for (const x of s.steps) if (i < matchers.length && matchers[i](x)) i++;
    for (let j = 0; j < i; j++) reached[j]++;
  }
  return {
    site: f.site,
    name: f.name,
    steps: f.steps.map((step, i) => ({
      step,
      sessions: reached[i],
      ofFirst: share(reached[i], reached[0]),
      ofPrev: i === 0 ? 100 : share(reached[i], reached[i - 1]),
    })),
  };
}

const p75 = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.75) - 1)];
};
const rate = (metric, v) => (v <= LIMITS[metric][0] ? "good" : v <= LIMITS[metric][1] ? "needs-improvement" : "poor");

function vitals() {
  const rows = all(`SELECT site, path, name, value, device FROM hits WHERE kind = 'vt' AND ${W}`, ...w());
  const group = (keyOf) => {
    const groups = new Map();
    for (const r of rows) {
      const key = keyOf(r);
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { key, site: r.site, samples: 0, values: {} }));
      g.samples++;
      (g.values[r.name] ??= []).push(r.value);
    }
    return [...groups.values()].map(({ values, ...g }) => {
      const metrics = {};
      for (const m of METRICS) {
        if (!values[m]) continue;
        const p = p75(values[m]);
        metrics[m] = { p75: p, n: values[m].length, rating: rate(m, p) };
      }
      return { ...g, metrics };
    });
  };
  const second = (key) => key.split("\t")[1];
  return {
    samples: rows.length,
    sites: group((r) => r.site).sort((a, b) => a.site.localeCompare(b.site)),
    devices: group((r) => `${r.site}\t${r.device === "desktop" ? "desktop" : "mobile"}`)
      .map((g) => ({ ...g, device: second(g.key) }))
      .sort((a, b) => a.site.localeCompare(b.site) || a.device.localeCompare(b.device)),
    pages: group((r) => `${r.site}\t${r.path}`)
      .map((g) => ({ ...g, page: second(g.key) }))
      .sort((a, b) => b.samples - a.samples)
      .slice(0, limit),
  };
}

function events() {
  const list = all(
    `SELECT site, name, COUNT(*) count, COUNT(DISTINCT vid) visitors FROM hits WHERE kind = 'ev' AND ${W} GROUP BY site, name ORDER BY count DESC LIMIT ?`,
    ...w(),
    limit,
  );
  if (!list.length) return list;
  // The properties of the newest 5000 hits of each listed event, in one query.
  const props = new Map(list.map((e) => [`${e.site}\t${e.name}`, new Map()]));
  const rows = all(
    `SELECT site, name, props FROM (
       SELECT site, name, props, ROW_NUMBER() OVER (PARTITION BY site, name ORDER BY t DESC) rn
       FROM hits WHERE kind = 'ev' AND props IS NOT NULL AND ${W} AND (site, name) IN (VALUES ${list.map(() => "(?, ?)").join(", ")})
     ) WHERE rn <= 5000`,
    ...w(),
    ...list.flatMap((e) => [e.site, e.name]),
  );
  for (const r of rows) {
    const counts = props.get(`${r.site}\t${r.name}`);
    for (const [k, v] of Object.entries(parseJson(r.props, {}) ?? {})) tally(counts, `${k}=${v}`);
  }
  for (const e of list) e.props = ranked(props.get(`${e.site}\t${e.name}`), 5).map(([prop, count]) => ({ prop, count }));
  return list;
}

function report() {
  const sites = overview(from, now + 1);
  const prev = overview(prevFrom, from);
  const prevBySite = new Map(prev.map((r) => [r.site, r]));
  for (const s of sites) s.prev = prevBySite.get(s.site) ?? null;
  const daily = all(
    `SELECT date(t, 'unixepoch') day, COUNT(DISTINCT site || vid) visitors, SUM(kind = 'pv') pageviews FROM hits WHERE kind IN ('pv', 'ev') AND ${W} GROUP BY day ORDER BY day`,
    ...w(),
  );
  const pages = all(
    `WITH pv AS (
       SELECT site, sid, vid, path, t,
         ROW_NUMBER() OVER (PARTITION BY sid ORDER BY t, rowid) rn,
         ROW_NUMBER() OVER (PARTITION BY sid ORDER BY t DESC, rowid DESC) rd,
         COUNT(*) OVER (PARTITION BY sid) n
       FROM hits WHERE kind = 'pv' AND ${W}
     ),
     lv AS (SELECT site, path, SUM(value) secs FROM hits WHERE kind = 'lv' AND ${W} GROUP BY site, path),
     sd AS (
       SELECT site, path, AVG(m) depth FROM (SELECT site, path, MAX(value) m FROM hits WHERE kind = 'sd' AND ${W} GROUP BY site, path, sid)
       GROUP BY site, path
     )
     SELECT pv.site, pv.path, COUNT(*) views, COUNT(DISTINCT vid) visitors, SUM(rn = 1) entries, SUM(rd = 1) exits,
       ROUND(100.0 * SUM(rn = 1 AND n = 1) / MAX(SUM(rn = 1), 1)) bounce,
       ROUND(COALESCE(MAX(lv.secs), 0) * 1.0 / COUNT(*)) secs, ROUND(MAX(sd.depth)) scroll
     FROM pv LEFT JOIN lv ON lv.site = pv.site AND lv.path = pv.path LEFT JOIN sd ON sd.site = pv.site AND sd.path = pv.path
     GROUP BY pv.site, pv.path ORDER BY views DESC LIMIT ?`,
    ...w(),
    ...w(),
    ...w(),
    limit,
  );
  const ss = streams();
  return {
    days,
    from,
    to: now,
    live: all(`SELECT site, COUNT(DISTINCT vid) visitors FROM hits WHERE t >= ? GROUP BY site`, now - 300),
    total: total(sites),
    prevTotal: total(prev),
    sites,
    daily,
    pages,
    sources: bySession("COALESCE(ref, '(direct)')"),
    campaigns: all(
      `SELECT us source, um medium, uc campaign, COUNT(*) sessions, COUNT(DISTINCT vid) visitors FROM ${sessions()}
       WHERE us IS NOT NULL OR um IS NOT NULL OR uc IS NOT NULL GROUP BY 1, 2, 3 ORDER BY sessions DESC LIMIT ?`,
      limit,
    ),
    devices: bySession("device", 5),
    browsers: bySession("browser", 8),
    os: bySession("os", 8),
    countries: bySession("COALESCE(country, '?')", 250),
    langs: bySession("COALESCE(lang, '?')", 10),
    events: events(),
    journeys: journeys(ss),
    funnels: funnels.filter((f) => !site || f.site === site).map((f) => funnel(f, ss)),
    vitals: vitals(),
    when: when(),
    loyalty: loyalty(),
  };
}

/** Pageviews per hour of the day and per day of the week (UTC; 0 is Sunday). */
function when() {
  const hours = Array(24).fill(0);
  const weekdays = Array(7).fill(0);
  const rows = all(
    `SELECT CAST(strftime('%w', t, 'unixepoch') AS INTEGER) wd, CAST(strftime('%H', t, 'unixepoch') AS INTEGER) h, COUNT(*) n
     FROM hits WHERE kind = 'pv' AND ${W} GROUP BY 1, 2`,
    ...w(),
  );
  for (const r of rows) {
    hours[r.h] += r.n;
    weekdays[r.wd] += r.n;
  }
  return { hours, weekdays };
}

const VISITS = [
  ["1 visit", 1, 1],
  ["2 visits", 2, 2],
  ["3–5 visits", 3, 5],
  ["6–10 visits", 6, 10],
  ["more than 10", 11, Infinity],
];

/**
 * What only a cookie can tell: how often visitors come, whether they come back in later weeks, and what brought them
 * the first time. Only cookie visitors of cookie sites; null without such a site.
 */
function loyalty() {
  const list = cookieSites.filter((s) => !site || s === site);
  if (!list.length) return null;
  const IN = `site IN (${list.map(() => "?").join(", ")}) AND vid NOT LIKE '~%'`;
  const perCount = all(
    `SELECT n, COUNT(*) visitors FROM (SELECT COUNT(DISTINCT sid) n FROM hits WHERE kind = 'pv' AND t >= ? AND t < ? AND ${IN} GROUP BY site, vid) GROUP BY n`,
    from,
    now + 1,
    ...list,
  );
  const visitors = sum(perCount, "visitors");
  const sessions = perCount.reduce((n, r) => n + r.n * r.visitors, 0);
  const visits = VISITS.map(([label, lo, hi]) => ({
    label,
    visitors: sum(
      perCount.filter((r) => r.n >= lo && r.n <= hi),
      "visitors",
    ),
  }));
  return { sites: list, visitors, sessions, visits, cohorts: cohorts(IN, list), firstSources: firstSources(IN, list) };
}

/** Weekly cohorts: visitors first seen in week i of the range, and the share of them seen again in each later week. */
function cohorts(IN, list) {
  const weeks = Math.min(13, Math.floor(days / 7));
  if (weeks < 2) return [];
  const start = now - weeks * WEEK;
  // First seen in the range: a hit in it and none before (an index lookup per visitor, not a scan of all history).
  const firstWeek = new Map(
    all(
      `SELECT site || ' ' || vid k, MIN(t) f FROM hits h WHERE kind = 'pv' AND t >= ? AND ${IN} GROUP BY site, vid
       HAVING NOT EXISTS (SELECT 1 FROM hits o WHERE o.site = h.site AND o.vid = h.vid AND o.kind = 'pv' AND o.t < ?)`,
      start,
      ...list,
      start,
    ).map((r) => [r.k, Math.floor((r.f - start) / WEEK)]),
  );
  const seen = new Map();
  for (const r of all(
    `SELECT site || ' ' || vid k, CAST((t - ?) / ${WEEK} AS INTEGER) wk FROM hits WHERE kind = 'pv' AND t >= ? AND ${IN} GROUP BY 1, 2`,
    start,
    start,
    ...list,
  )) {
    if (!firstWeek.has(r.k)) continue;
    let weeksSeen = seen.get(r.k);
    if (!weeksSeen) seen.set(r.k, (weeksSeen = new Set()));
    weeksSeen.add(Math.min(weeks - 1, r.wk));
  }
  const members = Array.from({ length: weeks }, () => []);
  for (const [k, week] of firstWeek) members[week]?.push(k);
  return members.map((cohort, i) => ({
    week: new Date((start + i * WEEK) * 1000).toISOString().slice(0, 10),
    visitors: cohort.length,
    back: Array.from({ length: weeks - i - 1 }, (_, d) => share(cohort.filter((k) => seen.get(k)?.has(i + 1 + d)).length, cohort.length)),
  }));
}

/** The source of each visitor's very first session, and how many of them came on more than one day. */
const firstSources = (IN, list) =>
  all(
    `WITH a AS (SELECT DISTINCT site, vid FROM hits WHERE kind = 'pv' AND t >= ? AND ${IN}),
     v AS (
       SELECT a.site, a.vid, MIN(h.t) f, COUNT(DISTINCT date(h.t, 'unixepoch')) d
       FROM a JOIN hits h ON h.site = a.site AND h.vid = a.vid AND h.kind = 'pv' GROUP BY a.site, a.vid
     )
     SELECT COALESCE(h.ref, '(direct)') value, COUNT(*) visitors, SUM(v.d > 1) "returning"
     FROM v JOIN hits h ON h.rowid = (SELECT MIN(rowid) FROM hits x WHERE x.site = v.site AND x.vid = v.vid AND x.t = v.f AND x.kind = 'pv')
     GROUP BY 1 ORDER BY visitors DESC LIMIT ?`,
    from,
    ...list,
    limit,
  );

/** Where visitors of one page came from, and where they went next. */
function path() {
  const page = String(req.page || "/");
  const before = new Map();
  const after = new Map();
  let views = 0;
  for (const s of streams()) {
    const paths = pathsOf(s.steps);
    paths.forEach((p, i) => {
      if (p !== page || paths[i - 1] === page) return;
      views++;
      let next = i + 1;
      while (paths[next] === page) next++;
      tally(before, i === 0 ? "(entry)" : paths[i - 1]);
      tally(after, next >= paths.length ? "(exit)" : paths[next]);
    });
  }
  const list = (counts) => ranked(counts, limit).map(([path, count]) => ({ path, count, share: share(count, views) }));
  const sources = all(
    `SELECT COALESCE(ref, '(direct)') ref, COUNT(*) count FROM ${sessions()} WHERE entry = ? GROUP BY 1 ORDER BY count DESC LIMIT ?`,
    page,
    limit,
  );
  return { days, page, views, before: list(before), after: list(after), sources };
}

const EXPORT_COLUMNS = [
  ["time", "t"],
  ["site", "site"],
  ["session", "sid"],
  ["visitor", "vid"],
  ["kind", "kind"],
  ["path", "path"],
  ["name", "name"],
  ["value", "value"],
  ["props", "props"],
  ["referrer", "ref"],
  ["utm_source", "us"],
  ["utm_medium", "um"],
  ["utm_campaign", "uc"],
  ["country", "country"],
  ["lang", "lang"],
  ["browser", "browser"],
  ["os", "os"],
  ["device", "device"],
];

/** A CSV cell. One that starts like a formula is prefixed with ' so a spreadsheet shows it instead of running it. */
const csvCell = (v) => {
  if (v == null) return "";
  let s = String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

/** Every stored hit, oldest first, written in chunks so a big database never sits in memory. */
function exportRows() {
  const back = Math.max(Number(req.days) || 0, 0);
  const rows = db
    .prepare(`SELECT ${EXPORT_COLUMNS.map(([, col]) => col).join(", ")} FROM hits WHERE t >= ? AND (? = '' OR site = ?) ORDER BY t`)
    .iterate(back ? now - back * DAY : 0, site, site);
  const jsonl = req.format === "jsonl";
  const line = jsonl
    ? (r, time) => JSON.stringify(Object.fromEntries(EXPORT_COLUMNS.map(([label, col]) => [label, col === "t" ? time : (r[col] ?? null)])))
    : (r, time) => EXPORT_COLUMNS.map(([, col]) => (col === "t" ? time : csvCell(r[col]))).join(",");
  let buf = jsonl ? "" : EXPORT_COLUMNS.map(([label]) => label).join(",") + "\n";
  for (const r of rows) {
    buf += line(r, new Date(r.t * 1000).toISOString()) + "\n";
    if (buf.length > 1 << 16) {
      process.stdout.write(buf);
      buf = "";
    }
  }
  process.stdout.write(buf);
}

const ops = { report, path, events: () => ({ days, events: events() }), vitals: () => ({ days, ...vitals() }) };
// Export ends by itself instead of process.exit, which can cut off output still queued for a pipe.
if (req.op === "export") exportRows();
else if (Object.hasOwn(ops, req.op)) out(ops[req.op]());
else {
  console.error(`unknown op ${req.op}`);
  process.exit(2);
}
