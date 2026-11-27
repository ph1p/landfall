// Names, formats and the shapes of what app/query.mjs prints, shared by the commands and the panel.
import { bytes, plural } from "../../core/lib/format";

export const PROJECT = "lf-analytics";
export const PREFIX = "/_lf/a/";
export const SNIPPET = `<script src="${PREFIX}s.js" defer></script>`;
export const SITE = /^[a-z0-9][a-z0-9-]*$/;
export const DOMAIN = /^[a-z0-9.-]+$/;
export const FUNNEL = /^[\w .-]{1,40}$/;

/** Per site: off counts visitors by a daily hash (no cookie), on sets a first-party cookie, consent sets it after lfa.consent(). */
export const COOKIE_MODES = ["off", "on", "consent"] as const;
export type CookieMode = (typeof COOKIE_MODES)[number];
export const COOKIE_ABOUT: Record<CookieMode, string> = {
  off: "no cookie: visitors are counted per day by a hash that changes daily",
  on: "first-party cookie lfa_id: returning visitors are recognized; needs consent in the EU",
  consent: "no cookie until the page calls lfa.consent(); then like on",
};

export const CORE = ["LCP", "INP", "CLS"] as const;
export const SHOWN = ["LCP", "INP", "CLS", "TTFB"] as const;
export const METRICS = ["LCP", "INP", "CLS", "FCP", "TTFB"] as const;
export type Metric = (typeof METRICS)[number];
export const LIMITS: Record<Metric, [number, number]> = { LCP: [2500, 4000], INP: [200, 500], CLS: [0.1, 0.25], FCP: [1800, 3000], TTFB: [800, 1800] };
export const ABOUT: Record<Metric, string> = {
  LCP: "Largest Contentful Paint: when the main content shows",
  INP: "Interaction to Next Paint: how fast the page answers clicks and keys",
  CLS: "Cumulative Layout Shift: how much the layout jumps",
  FCP: "First Contentful Paint: when anything shows",
  TTFB: "Time to First Byte: how fast the server answers",
};

// ---- what query.mjs prints ----------------------------------------------------------------------------------------

export type Rating = "good" | "needs-improvement" | "poor";
export type Metrics = Partial<Record<Metric, { p75: number; rating: Rating; n: number }>>;
export interface Totals {
  visitors: number;
  returning: number;
  sessions: number;
  pageviews: number;
  bounce: number | null;
  secs: number | null;
}
export interface SiteRow extends Totals {
  site: string;
  prev?: SiteRow | null;
}
export interface Breakdown {
  value: string;
  sessions: number;
  bounce: number | null;
}
export interface FunnelResult {
  site: string;
  name: string;
  steps: { step: string; sessions: number; ofFirst: number; ofPrev: number }[];
}
export interface Vitals {
  sites: { site: string }[];
  devices: { site: string; device: string; metrics: Metrics; samples: number }[];
  pages: { site: string; page: string; metrics: Metrics; samples: number }[];
}
export interface EventRow {
  site: string;
  name: string;
  count: number;
  visitors: number;
  props: { prop: string; count: number }[];
}
export interface Report {
  empty?: boolean;
  days: number;
  from: number;
  to: number;
  live: { site: string; visitors: number }[];
  total: Totals;
  prevTotal: Totals;
  sites: SiteRow[];
  daily: { day: string; visitors: number; pageviews: number }[];
  pages: {
    site: string;
    path: string;
    views: number;
    visitors: number;
    entries: number;
    exits: number;
    bounce: number | null;
    secs: number | null;
    /** Average of how far each session scrolled down the page, in %. */
    scroll?: number | null;
  }[];
  sources: Breakdown[];
  campaigns: { source: string | null; medium: string | null; campaign: string | null; sessions: number; visitors: number }[];
  devices: Breakdown[];
  browsers: Breakdown[];
  os: Breakdown[];
  countries: Breakdown[];
  langs: Breakdown[];
  events: EventRow[];
  journeys: { site: string; pages: string[]; sessions: number; share: number }[];
  funnels: FunnelResult[];
  vitals: Vitals;
  /** Pageviews per UTC hour (24) and per weekday (7, Sunday first). */
  when?: { hours: number[]; weekdays: number[] };
  /** Only for sites with a cookie; null without one. */
  loyalty?: Loyalty | null;
}
export interface Loyalty {
  sites: string[];
  visitors: number;
  sessions: number;
  visits: { label: string; visitors: number }[];
  /** Visitors first seen in each week, and the % of them back in each later week. */
  cohorts: { week: string; visitors: number; back: number[] }[];
  firstSources: { value: string; visitors: number; returning: number }[];
}
export interface PathReport {
  empty?: boolean;
  days: number;
  page: string;
  views: number;
  before: { path: string; count: number; share: number }[];
  after: { path: string; count: number; share: number }[];
  sources: { ref: string; count: number }[];
}

// ---- numbers --------------------------------------------------------------------------------------------------------

export function fmt(n: Metric, v: number | undefined): string {
  if (v === undefined) return "–";
  if (n === "CLS") return v.toFixed(2);
  return v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`;
}
export const limitText = (n: Metric) => `good ≤ ${fmt(n, LIMITS[n][0])}, poor > ${fmt(n, LIMITS[n][1])}`;
/** The worst rating of LCP, INP and CLS. */
export function verdict(m: Metrics): Rating | undefined {
  const r = CORE.map((n) => m[n]?.rating).filter(Boolean);
  if (!r.length) return undefined;
  if (r.includes("poor")) return "poor";
  return r.includes("needs-improvement") ? "needs-improvement" : "good";
}
export const num = (n: number | null | undefined) =>
  n == null ? "–" : n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
export const pct = (n: number | null | undefined) => (n == null ? "–" : `${n}%`);
export function dur(s: number | null | undefined): string {
  if (s == null) return "–";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
/** Percent change, or null when there is nothing to compare with. */
export const change = (cur: number | undefined, prev: number | undefined) => (!prev ? null : Math.round((100 * ((cur ?? 0) - prev)) / prev));
export const flow = (pages: string[]) => pages.join(" → ");

/** Every UTC day of the report's range, also the empty ones. */
export function everyDay(r: Pick<Report, "days" | "to" | "daily">) {
  const days = new Map(r.daily.map((d) => [d.day, d]));
  const out: Report["daily"] = [];
  for (let i = r.days - 1; i >= 0; i--) {
    const day = new Date((r.to - i * 86400) * 1000).toISOString().slice(0, 10);
    out.push(days.get(day) ?? { day, visitors: 0, pageviews: 0 });
  }
  return out;
}
export const dayLabel = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" });

const regions = (() => {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" });
  } catch {
    return null;
  }
})();
/** "DE" as "🇩🇪 Germany"; "?" as "unknown". */
export function countryName(code: string): string {
  if (!/^[A-Z]{2}$/.test(code)) return "unknown";
  const flag = String.fromCodePoint(...[...code].map((ch) => 0x1f1a5 + ch.charCodeAt(0)));
  let name = code;
  try {
    name = regions?.of(code) ?? code;
  } catch {}
  return `${flag} ${name}`;
}

/** How much data the collector keeps (app/storage.json). Unset means the defaults: 365 days, no size limit. */
export interface Storage {
  keepDays?: number;
  maxBytes?: number;
}
export const KEEP_DAYS = 365;
export const MAX_KEEP_DAYS = 3650;
/** The smallest size limit: below that one busy day may not fit. */
export const MIN_BYTES = 10 * 1024 * 1024;

/** "500M", "2G", "750MB", "1.5gb" → bytes; "off" → 0; anything else → undefined. */
export function parseSize(v: string): number | undefined {
  if (/^(off|none|0)$/i.test(v.trim())) return 0;
  const m = /^(\d+(?:\.\d+)?)\s*([kmgt])i?b?$/i.exec(v.trim());
  if (!m) return undefined;
  return Math.round(Number(m[1]) * 1024 ** ("kmgt".indexOf(m[2].toLowerCase()) + 1));
}

/** "kept 365 days" / "kept 90 days, at most 500 MB", for the CLI and the panel. */
export function storageText(s: Storage) {
  const days = s.keepDays || KEEP_DAYS;
  return `kept ${plural(days, "day")}${s.maxBytes ? `, at most ${bytes(s.maxBytes)}` : ""}`;
}
