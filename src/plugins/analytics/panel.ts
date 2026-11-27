// The web UI panel: problems first, then the numbers as stat tiles, charts and tables.
import { bytes, changeText, pct as share } from "../../core/lib/format";
import type { UiAction, UiBar, UiBlock, UiCell, UiField, UiStat } from "../../core/plugins/plugin-api";
import { cookieOf, type State } from "./remote";
import {
  ABOUT,
  change,
  COOKIE_ABOUT,
  COOKIE_MODES,
  countryName,
  dayLabel,
  KEEP_DAYS,
  MAX_KEEP_DAYS,
  storageText,
  dur,
  everyDay,
  flow,
  fmt,
  limitText,
  num,
  pct,
  PREFIX,
  SHOWN,
  SNIPPET,
  verdict,
  type Breakdown,
  type CookieMode,
  type Metric,
  type Metrics,
  type Loyalty,
  type Rating,
  type Report,
  type Vitals,
} from "./shared";

export const VIEWS = [
  { id: "7", label: "7 days" },
  { id: "30", label: "30 days" },
  { id: "90", label: "90 days" },
];

const KIND = { good: "ok", "needs-improvement": "warn", poor: "bad" } as const;
const WORD: Record<Rating, string> = { good: "good", "needs-improvement": "needs work", poor: "poor" };
const COOKIE_WORD: Record<CookieMode, string> = { off: "no cookie", on: "cookie", consent: "after consent" };
const COOKIE_LABEL: Record<CookieMode, string> = {
  off: "No cookie: visitors counted per day",
  on: "Cookie: returning visitors recognized",
  consent: "Cookie after consent (lfa.consent())",
};

const vcell = (m: Metrics, n: Metric): UiCell => {
  const v = m[n];
  return v
    ? { text: fmt(n, v.p75), kind: KIND[v.rating], title: `p75 of ${v.n} samples · ${limitText(n)}\n${ABOUT[n]}` }
    : { text: "–", title: `no ${n} samples yet` };
};
const mono = (text: string, title?: string): UiCell => ({ text, mono: true, ...(title ? { title } : {}) });
const verdictCell = (vd: Rating | undefined, title?: string): UiCell => (vd ? { text: WORD[vd], kind: KIND[vd], ...(title ? { title } : {}) } : "–");
/** The site column, only when more than one site is shown. */
const siteColumn = (multi: boolean) => ({ head: multi ? ["Site"] : [], cell: (row: { site: string }) => (multi ? [row.site] : []) });

const cookieField = (value: CookieMode): UiField => ({
  name: "cookie",
  label: "Cookie",
  type: "select",
  flag: "--cookie",
  options: COOKIE_MODES.map((m) => ({ value: m, label: COOKIE_LABEL[m] })),
  value,
  hint: "A cookie tells returning visitors apart. In the EU it needs the visitor's consent: with consent, the page calls lfa.consent() once it has it.",
});

/** A select of the given sites, or a text field when there are none to pick from. */
const siteField = (sites: string[]): UiField =>
  sites.length
    ? { name: "site", label: "Site", type: "select", options: sites, value: sites[0], required: true }
    : { name: "site", label: "Site", required: true, placeholder: "blog" };
const enableAction = (st: State): UiAction => {
  const free = st.sites.filter((s) => !st.enabled.includes(s));
  return {
    label: "Enable for a site",
    primary: !st.enabled.length,
    argv: ["analytics", "enable"],
    fields: [
      siteField(free),
      {
        name: "domain",
        label: "Domain",
        flag: "--domain",
        placeholder: "default: all of the site's domains",
        hint: "Only needed when the site has no domain landfall knows.",
      },
      cookieField("off"),
    ],
  };
};
const funnelAction = (st: State): UiAction => ({
  label: "Add funnel",
  argv: ["analytics", "funnel"],
  fields: [
    siteField(st.enabled),
    { name: "name", label: "Name", placeholder: "signup", required: true },
    {
      name: "steps",
      label: "Steps",
      placeholder: "/ > /pricing > event:Signup",
      required: true,
      hint: "Pages in order, separated by >. * matches anything (/blog/*), event:Name matches a custom event.",
    },
  ],
});
const uninstallAction: UiAction = {
  label: "Uninstall",
  danger: true,
  argv: ["analytics", "uninstall", "-y"],
  title: "Remove the collector and /opt/landfall/analytics from this server",
  confirm: "Remove the analytics collector from this server? Sites stop counting visits. This cannot be undone.",
  fields: [
    {
      name: "keep-data",
      type: "check",
      flag: "--keep-data",
      label: "Keep the collected data",
      hint: "Unticked, all collected visits and funnels are deleted. Kept, a later enable counts on from them.",
    },
  ],
};

const DAYS: [number, string][] = [
  [30, "30 days"],
  [90, "3 months"],
  [180, "6 months"],
  [KEEP_DAYS, "12 months (default)"],
  [730, "2 years"],
  [1825, "5 years"],
];
const SIZES = ["100M", "500M", "1G", "5G", "20G"];
/** 524288000 as "500M", the way --max-size takes it. */
const sizeText = (b: number) =>
  bytes(b)
    .replace(/(\.0)? /, "")
    .replace(/B$/, "");

/** Presets to pick from, plus the current value when it is none of them (set with the CLI). */
function presets(current: string, list: { value: string; label: string }[]) {
  return list.some((o) => o.value === current) ? list : [...list, { value: current, label: `${current} (now)` }];
}

const storageAction = (st: State): UiAction => {
  const days = String(st.storage.keepDays ?? KEEP_DAYS);
  const size = st.storage.maxBytes ? sizeText(st.storage.maxBytes) : "off";
  return {
    label: "Storage",
    argv: ["analytics", "storage", "-y"],
    title: "How much collected data the server keeps",
    confirm: `The collected data takes ${bytes(st.size)} now. Keeping less deletes what no longer fits, and that cannot be undone.`,
    fields: [
      {
        name: "days",
        label: "Keep",
        type: "select",
        flag: "--keep-days",
        options: presets(
          days,
          DAYS.map(([d, label]) => ({ value: String(d), label })),
        ),
        value: days,
        hint: `Older visits are deleted every hour. Any other number of days, up to ${MAX_KEEP_DAYS}: lf analytics storage --keep-days <days>.`,
      },
      {
        name: "size",
        label: "Size limit",
        type: "select",
        flag: "--max-size",
        options: presets(size, [{ value: "off", label: "no limit" }, ...SIZES.map((x) => ({ value: x, label: `${x.slice(0, -1)} ${x.slice(-1)}B` }))]),
        value: size,
        hint: "Past it, the oldest days are deleted, never today's. Any other size: lf analytics storage --max-size 2G.",
      },
    ],
  };
};
const repairAction: UiAction = { label: "Repair collector", primary: true, argv: ["analytics", "repair"], title: "Rewrite its files and start it again" };

/** What is wrong, worst first, each with the button that fixes it where there is one. */
export function problems(st: State): UiBlock[] {
  if (st.docker === "missing") return [{ type: "note", kind: "bad", text: "Docker is not installed on this server. Run lf setup first." }];
  if (st.docker === "noaccess")
    return [
      { type: "note", kind: "bad", text: "This login cannot use Docker. Add it to the docker group (lf setup does), or pick a root login under Settings." },
    ];
  const out: UiBlock[] = [];
  if (st.broken) out.push({ type: "note", kind: "bad", text: `${st.broken}. Repair rewrites it from what it can still read.`, actions: [repairAction] });
  if (st.queryError) out.push({ type: "note", kind: "bad", text: `Could not read the collected data: ${st.queryError}` });
  if (!st.enabled.length) return out;
  if (!st.network)
    out.push({
      type: "note",
      kind: "bad",
      text: `Traefik's network "${st.proxy.network}" is missing, so the collector cannot be reached. Set Traefik up again with lf setup, then repair.`,
      actions: [repairAction],
    });
  if (!st.collector)
    out.push({ type: "note", kind: "bad", text: "The collector container is gone. Visits are not counted until it runs again.", actions: [repairAction] });
  else if (!st.running) {
    const why = st.collector.restarts ? `keeps restarting (${st.collector.restarts} restarts)` : `is ${st.collector.status}`;
    out.push({ type: "note", kind: "bad", text: `The collector ${why}. Visits are not counted until it runs again.`, actions: [repairAction] });
    if (st.logs.length) out.push({ type: "text", title: "Collector log (last lines)", text: st.logs.join("\n"), mono: true });
  }
  const seen = new Set(((st.data as Report | undefined)?.sites ?? []).map((s) => s.site));
  for (const site of st.enabled) {
    if (seen.has(site)) continue;
    const t = st.tags[site];
    if (!t) out.push({ type: "note", kind: "warn", text: `${site}: no visits in this range. Is ${SNIPPET} in its pages?` });
    else if (t.endpoint && t.endpoint !== "200" && t.endpoint !== "000")
      out.push({
        type: "note",
        kind: "bad",
        text: `${site}: https://${t.host}${PREFIX}s.js answers ${t.endpoint}. Traefik does not route it to the collector.`,
        actions: [repairAction],
      });
    else if (!t.tag && t.page === "200")
      out.push({ type: "note", kind: "warn", text: `${site}: no visits yet, and https://${t.host}/ does not load the script. Add ${SNIPPET} to its pages.` });
    else if (t.tag) out.push({ type: "note", kind: "info", text: `${site}: the script is on https://${t.host}/. Visits show up here as they come in.` });
    else
      out.push({
        type: "note",
        kind: "warn",
        text: `${site}: no visits in this range. https://${t.host}/ answered ${t.page || "nothing"}, so landfall could not check for the script.`,
      });
  }
  return out;
}

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** Pageviews by hour of the day and by weekday. */
function whenBlocks(w: NonNullable<Report["when"]>): UiBlock[] {
  const total = w.weekdays.reduce((n, x) => n + x, 0);
  return [
    { type: "heading", text: "When they visit", sub: "in UTC" },
    {
      type: "chart",
      chart: "line",
      half: true,
      title: "Hour of the day",
      sub: "pageviews per hour",
      labels: w.hours.map((_, h) => `${String(h).padStart(2, "0")}:00`),
      series: [{ name: "Pageviews", values: w.hours }],
      unit: "pageviews",
    },
    {
      type: "chart",
      chart: "bars",
      half: true,
      title: "Day of the week",
      sub: "pageviews per weekday",
      // Monday first; the query counts Sunday as 0.
      items: WEEKDAYS.map((label, i) => {
        const n = w.weekdays[(i + 1) % 7] ?? 0;
        return { label, value: n, text: `${num(n)} · ${share(n, total)}%` };
      }),
    },
  ];
}

/** What a cookie adds: visits per visitor, weekly retention, and what brought loyal visitors the first time. */
function loyaltyBlocks(l: Loyalty, multi: boolean): UiBlock[] {
  const out: UiBlock[] = [
    {
      type: "heading",
      text: "Loyalty",
      sub: `Only visitors with the cookie${multi ? ` on ${l.sites.join(", ")}` : ""}: ${num(l.visitors)} visitors, ${num(l.sessions)} visits. Visitors without it (no consent yet, Global Privacy Control) are left out.`,
    },
    {
      type: "chart",
      chart: "bars",
      half: true,
      title: "Visits per visitor",
      sub: "sessions in this range",
      items: l.visits.map((v) => ({ label: v.label, value: v.visitors, text: `${num(v.visitors)} · ${share(v.visitors, l.visitors)}%` })),
    },
    {
      type: "chart",
      chart: "bars",
      half: true,
      title: "First visit came from",
      sub: "the source of each visitor's very first visit, and how many came back on another day",
      items: l.firstSources.map((s) => ({
        label: s.value,
        value: s.visitors,
        text: `${num(s.visitors)} · ${share(s.returning, s.visitors)}% back`,
        title: `${num(s.visitors)} visitors, ${num(s.returning)} came back on another day`,
      })),
      empty: "Nothing yet.",
    },
  ];
  if (l.cohorts.length) {
    const n = Math.max(0, ...l.cohorts.map((c) => c.back.length));
    out.push({
      type: "table",
      title: "Retention",
      sub: "visitors first seen in a week, and the share of them seen again 1, 2, 3… weeks later",
      columns: ["First week", "Visitors", ...Array.from({ length: n }, (_, i) => `+${i + 1} wk`)],
      rows: l.cohorts.map((c) => ({
        cells: [
          c.week,
          num(c.visitors),
          ...Array.from({ length: n }, (_, i): UiCell =>
            i < c.back.length && c.visitors ? { text: `${c.back[i]}%`, kind: c.back[i] ? "ok" : undefined } : "",
          ),
        ],
      })),
    });
  }
  return out;
}

/** A breakdown (sources, devices…) as bars: sessions, their share and the bounce rate on hover. */
function bars(title: string, rows: Breakdown[], sub?: string, show?: number): UiBlock {
  const total = rows.reduce((n, r) => n + r.sessions, 0);
  return {
    type: "chart",
    chart: "bars",
    half: true,
    title,
    ...(sub ? { sub } : {}),
    ...(show ? { show } : {}),
    items: rows.map((r) => ({
      label: String(r.value),
      value: r.sessions,
      text: `${num(r.sessions)} · ${share(r.sessions, total)}%`,
      title: `${num(r.sessions)} sessions, ${pct(r.bounce)} bounced`,
    })),
    empty: "Nothing yet.",
  };
}

/** A funnel as a chart: sessions per step, the steps where half or more drop off in yellow. */
export function funnelBlock(f: Report["funnels"][number], multi: boolean): UiBlock {
  const last = f.steps.at(-1);
  return {
    type: "chart",
    chart: "funnel",
    title: `Funnel: ${f.name}`,
    sub: `${multi ? `${f.site} · ` : ""}${pct(last?.ofFirst ?? 0)} of sessions that start it reach the end. Other pages in between are fine.`,
    items: f.steps.map((s, i): UiBar => ({
      label: s.step,
      value: s.sessions,
      text: num(s.sessions),
      mono: true,
      kind: i > 0 && s.ofPrev < 50 ? "warn" : undefined,
    })),
    actions: [
      { label: "Remove", danger: true, argv: ["analytics", "funnel", f.site, f.name, "--rm"], confirm: `Remove the funnel ${f.name}? Collected data stays.` },
    ],
  };
}

/** Web vitals per site and device, then the pages: only the slow ones, or all of them (pages: how many). */
export function vitalsBlocks(v: Vitals, multi: boolean, pages?: number): UiBlock[] {
  const site = siteColumn(multi);
  const out: UiBlock[] = [
    {
      type: "heading",
      text: "Speed",
      sub: "Core Web Vitals, p75: 3 in 4 visits were this fast or faster. Green good, yellow needs work, red poor.",
    },
    {
      type: "table",
      title: "Web vitals",
      columns: ["Site", "Device", "Verdict", ...SHOWN, "Samples"],
      rows: v.devices.map((g) => ({
        cells: [g.site, g.device, verdictCell(verdict(g.metrics), "the worst of LCP, INP and CLS"), ...SHOWN.map((n) => vcell(g.metrics, n)), num(g.samples)],
      })),
    },
  ];
  const list = pages
    ? v.pages.slice(0, pages).map((x) => ({ ...x, vd: verdict(x.metrics) }))
    : v.pages.flatMap((x) => {
        const vd = verdict(x.metrics);
        return vd && vd !== "good" ? [{ ...x, vd }] : [];
      });
  if (list.length)
    out.push({
      type: "table",
      title: pages ? "Pages" : "Slow pages",
      columns: [...site.head, "Page", "Verdict", ...SHOWN, "Samples"],
      rows: list.map((x) => ({
        cells: [...site.cell(x), mono(x.page), verdictCell(x.vd), ...SHOWN.map((n) => vcell(x.metrics, n)), num(x.samples)],
      })),
    });
  return out;
}

/**
 * The panel, and the text of lf analytics report. o.site: only this site. o.text: for the terminal, without the
 * snippet and the hints that are buttons in the web UI.
 */
export function panelBlocks(st: State, days: number, o: { site?: string; text?: boolean } = {}): UiBlock[] {
  const blocks = problems(st);
  if (st.docker !== "ok") return blocks;
  const r = (st.data ?? {}) as Partial<Report>;
  const hasData = !!r.sites?.length;
  if (!st.enabled.length && !hasData) {
    return [
      ...blocks,
      {
        type: "note",
        kind: "info",
        text: "See who visits your sites: pageviews, visitors, where they come from, which paths they take, where they drop off, custom events and how fast pages feel (Core Web Vitals). A small collector on this server stores everything; no IP addresses, nothing sent elsewhere, and no cookie unless you turn one on.",
        actions: [enableAction(st), ...(st.installed ? [uninstallAction] : [])],
      },
    ];
  }
  const before = `the ${days} days before`;
  const sitesSeen = [...new Set([...st.enabled, ...(r.sites ?? []).map((s) => s.site)])].filter((s) => !o.site || s === o.site);
  const done = () => (o.text ? blocks : addSnippet(st, blocks));
  const multi = sitesSeen.length > 1;
  const site = siteColumn(multi);
  const anyCookie = sitesSeen.some((s) => cookieOf(st, s) !== "off");
  const t = r.total;
  const p = r.prevTotal;
  const live = (r.live ?? []).reduce((n, x) => n + x.visitors, 0);
  // The change only when the period before had data; "new" when it had none but this one has.
  const vs = (cur: number | null | undefined, prev: number | null | undefined) =>
    prev ? { change: change(cur ?? 0, prev) } : cur && p ? { change: null } : {};
  const was = (prev: string) => `${prev} in ${before}`;
  const daily = hasData && r.daily && r.to ? everyDay({ days, to: r.to, daily: r.daily }) : [];
  const spark = (k: "visitors" | "pageviews") => (daily.length > 1 ? { spark: daily.map((d) => d[k]) } : {});
  const stats: UiStat[] = [
    { label: "Live now", value: live, kind: live ? "ok" : "", note: "last 5 minutes", title: "visitors in the last 5 minutes" },
    { label: "Visitors", value: num(t?.visitors ?? 0), ...vs(t?.visitors, p?.visitors), ...spark("visitors"), title: was(num(p?.visitors ?? 0)) },
    ...(anyCookie
      ? [
          {
            label: "Returning",
            value: num(t?.returning ?? 0),
            ...vs(t?.returning, p?.returning),
            title: "visitors with the cookie who came on more than one day (only sites with a cookie)",
          },
        ]
      : []),
    { label: "Pageviews", value: num(t?.pageviews ?? 0), ...vs(t?.pageviews, p?.pageviews), ...spark("pageviews"), title: was(num(p?.pageviews ?? 0)) },
    { label: "Sessions", value: num(t?.sessions ?? 0), ...vs(t?.sessions, p?.sessions), title: was(num(p?.sessions ?? 0)) },
    {
      label: "Bounce rate",
      value: pct(t?.bounce),
      ...vs(t?.bounce, p?.bounce),
      lowerIsBetter: true,
      title: `sessions with one page and no event; ${was(pct(p?.bounce))}`,
    },
    { label: "Time on site", value: dur(t?.secs), ...vs(t?.secs, p?.secs), title: `average engaged time per session (tab visible); ${was(dur(p?.secs))}` },
  ];
  blocks.push({
    type: "stats",
    title: `Last ${days} days${o.site ? ` · ${o.site}` : ""}`,
    sub: `${collectorText(st)} · ${bytes(st.size)} stored, ${storageText(st.storage)}`,
    items: stats,
    actions: [
      enableAction(st),
      ...(st.enabled.length ? [funnelAction(st)] : []),
      ...(st.installed ? [storageAction(st)] : []),
      { label: "Repair", argv: ["analytics", "repair"], title: "Rewrite the collector's files and start it again (also after a landfall update)" },
      ...(st.installed ? [uninstallAction] : []),
    ],
  });

  if (daily.length) {
    blocks.push({
      type: "chart",
      chart: "line",
      title: "Visitors and pageviews",
      sub: "per UTC day",
      labels: daily.map((d) => dayLabel(d.day)),
      series: [
        { name: "Visitors", values: daily.map((d) => d.visitors) },
        { name: "Pageviews", values: daily.map((d) => d.pageviews) },
      ],
    });
  }

  const bySite = new Map((r.sites ?? []).map((s) => [s.site, s]));
  const liveBy = new Map((r.live ?? []).map((x) => [x.site, x.visitors]));
  blocks.push({
    type: "table",
    title: "Sites",
    columns: ["Site", "Visitors", "vs. before", "Pageviews", "Bounce", "Time", ...(anyCookie ? ["Returning"] : []), "Cookie", "Live"],
    rows: sitesSeen.map((name) => {
      const s = bySite.get(name);
      const on = st.enabled.includes(name);
      const mode = cookieOf(st, name);
      const c = change(s?.visitors, s?.prev?.visitors);
      const cookie: UiCell = on ? { text: COOKIE_WORD[mode], title: COOKIE_ABOUT[mode] } : "–";
      const ret = anyCookie ? [mode === "off" ? { text: "–", title: "only counted with a cookie" } : num(s?.returning ?? 0)] : [];
      const numbers: UiCell[] = s
        ? [
            num(s.visitors),
            c == null
              ? { text: "new", title: `nothing in ${before}` }
              : { text: changeText(c), kind: c >= 0 ? "ok" : "warn", title: `compared with ${before}` },
            num(s.pageviews),
            pct(s.bounce),
            dur(s.secs),
            ...ret,
          ]
        : [on ? { text: "no visits", title: `nothing yet: is ${SNIPPET} in its pages?` } : "–", ...Array<UiCell>(anyCookie ? 5 : 4).fill("–")];
      return {
        cells: [name, ...numbers, cookie, liveBy.get(name) ?? 0],
        actions: on
          ? [
              { label: "Cookie", argv: ["analytics", "enable", name], title: "Change how visitors are counted", fields: [cookieField(mode)] },
              { label: "Disable", danger: true, argv: ["analytics", "disable", name], confirm: `Stop collecting analytics for ${name}? Collected data stays.` },
            ]
          : [{ label: "Enable", argv: ["analytics", "enable", name], title: "collected before, not now" }],
      };
    }),
  });
  if (!hasData) return done();

  if (r.sources?.length || r.campaigns?.length) {
    blocks.push({ type: "heading", text: "Where visitors come from" }, bars("Sources", r.sources ?? [], "the referring site of each session's first page"), {
      type: "chart",
      chart: "bars",
      half: true,
      title: "Campaigns",
      sub: "utm_source / utm_medium / utm_campaign (?ref= counts as source)",
      items: (r.campaigns ?? []).map((c) => ({
        label: [c.source, c.medium, c.campaign].map((x) => x ?? "–").join(" / "),
        value: c.sessions,
        text: num(c.sessions),
        title: `${num(c.sessions)} sessions, ${num(c.visitors)} visitors`,
      })),
      empty: "No campaign links yet. Add ?utm_source=newsletter to a link.",
    });
  }

  blocks.push(
    { type: "heading", text: "What they do" },
    {
      type: "table",
      title: "Pages",
      // Flow is a row button: the web UI has it, the terminal does not.
      sub: `Entries: sessions that started here. Exits: sessions that ended here.${o.text ? "" : " Flow shows where visitors came from and went next."}`,
      columns: [...site.head, "Page", "Views", "Visitors", "Time", "Scroll", "Entries", "Exits", "Bounce"],
      rows: (r.pages ?? []).map((x) => ({
        cells: [
          ...site.cell(x),
          mono(x.path),
          num(x.views),
          num(x.visitors),
          dur(x.secs),
          x.scroll != null ? { text: pct(x.scroll), title: "how far down visitors scrolled, on average" } : "–",
          num(x.entries),
          num(x.exits),
          x.entries ? pct(x.bounce) : "–",
        ],
        actions: [{ label: "Flow", argv: ["analytics", "path", x.site, x.path], title: `lf analytics path ${x.site} ${x.path}` }],
      })),
    },
  );
  if (r.journeys?.length)
    blocks.push({
      type: "chart",
      chart: "bars",
      title: "User journeys",
      sub: "the first pages of each session, in order",
      items: r.journeys.map((j) => ({
        label: `${multi ? `${j.site}: ` : ""}${flow(j.pages)}`,
        value: j.sessions,
        text: `${num(j.sessions)} · ${j.share}%`,
        mono: true,
      })),
    });
  for (const f of r.funnels ?? []) blocks.push(funnelBlock(f, multi));
  if (!r.funnels?.length && st.enabled.length && !o.text)
    blocks.push({
      type: "note",
      text: "Funnels show where visitors drop off on the way to a goal, for example / > /pricing > /signup.",
      actions: [funnelAction(st)],
    });
  if (r.events?.length)
    blocks.push({
      type: "chart",
      chart: "bars",
      title: "Events",
      sub: "custom events (lfa), outbound links and downloads",
      items: r.events.map((e) => ({
        label: `${multi ? `${e.site}: ` : ""}${e.name}`,
        value: e.count,
        text: `${num(e.count)} · ${num(e.visitors)} visitors`,
        title: e.props.length ? `top properties: ${e.props.map((x) => `${x.prop} (${x.count})`).join(", ")}` : undefined,
      })),
    });

  blocks.push(
    { type: "heading", text: "Who visits" },
    bars("Devices", r.devices ?? [], "by screen width: under 768 px mobile, under 1024 px tablet"),
    bars("Browsers", r.browsers ?? []),
    bars("Operating systems", r.os ?? []),
    bars("Languages", r.langs ?? [], "the browser's language"),
  );
  const known = r.countries?.filter((c) => c.value !== "?").length ?? 0;
  if (r.countries && known)
    blocks.push(
      bars(
        `Countries (${known})`,
        r.countries.map((c) => ({ ...c, value: countryName(c.value) })),
        "from a proxy's country header, else the browser's time zone",
        10,
      ),
    );
  if (r.when?.hours.some(Boolean)) blocks.push(...whenBlocks(r.when));
  if (r.loyalty?.visitors) blocks.push(...loyaltyBlocks(r.loyalty, multi));

  if (r.vitals?.sites?.length) blocks.push(...vitalsBlocks(r.vitals, multi));
  return done();
}

function collectorText(st: State): string {
  if (!st.collector) return st.enabled.length ? "collector missing" : "collector not installed";
  if (st.running) return "collector running";
  return `collector ${st.collector.restarts ? "restarting" : st.collector.status}`;
}

function addSnippet(st: State, blocks: UiBlock[]): UiBlock[] {
  const modes = new Set(st.enabled.map((s) => cookieOf(st, s)));
  if (st.enabled.length)
    blocks.push({
      type: "text",
      title: "Add to the <head> of every page",
      text: [
        SNIPPET,
        "",
        "Custom events:",
        `  lfa("Signup", { plan: "pro" })          // from your code`,
        `  <button data-lfa="Signup">              // on click, no code`,
        ...(modes.has("consent")
          ? [
              "",
              "Cookie consent (sites with cookie mode consent):",
              "  lfa.consent()                           // the visitor agreed",
              "  lfa.consent(false)                      // withdrawn: deletes the cookie",
            ]
          : []),
        "",
        "Outbound links, downloads and page changes of single-page apps are counted on their own.",
        'Exclude your own visits: localStorage.setItem("lfa:ignore", "1") in the browser console.',
      ].join("\n"),
      mono: true,
    });
  const privacy = [
    "No IP address is stored. Without a cookie, a visitor is a hash of IP address and browser with a salt that is replaced every day, so visitors are counted per day and nothing is stored in the browser.",
  ];
  if (modes.has("on") || modes.has("consent"))
    privacy.push(
      "Sites with a cookie store a random id in the first-party cookie lfa_id for 12 months, so returning visitors are recognized. In the EU that cookie needs the visitor's consent: use cookie mode consent and call lfa.consent() from your consent banner.",
    );
  blocks.push({ type: "note", text: privacy.join(" ") });
  return blocks;
}
