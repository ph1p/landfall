// Analytics: privacy-friendly web analytics on the server itself. A built-in plugin, off until lf analytics enable.
// A small collector (node:22-alpine, SQLite) behind Traefik takes /_lf/a/ on the enabled sites' domains; the script
// tag on their pages sends pageviews, events and web vitals there. Everything stays on the server.
import { bytes } from "../../core/lib/format";
import { definePlugin, type PluginCommand, type PluginContext, type UiBlock } from "../../core/plugins/plugin-api";
import { funnelBlock, panelBlocks, VIEWS, vitalsBlocks } from "./panel";
import {
  applyOrExplain,
  checkEndpoints,
  cookieOf,
  dirOf,
  errText,
  exportData,
  needDocker,
  probe,
  purge,
  query,
  uninstall,
  writeFunnels,
  writeStorage,
  type SiteSettings,
  type State,
} from "./remote";
import {
  COOKIE_ABOUT,
  COOKIE_MODES,
  DOMAIN,
  FUNNEL,
  KEEP_DAYS,
  MAX_KEEP_DAYS,
  MIN_BYTES,
  num,
  parseSize,
  pct,
  PREFIX,
  SITE,
  SNIPPET,
  storageText,
  type CookieMode,
  type PathReport,
  type Report,
  type Storage,
  type Vitals,
} from "./shared";

export function parseDays(ctx: Pick<PluginContext, "fail">, v: unknown) {
  const days = Number(v);
  if (!(days > 0 && days <= 400 && Number.isInteger(days))) ctx.fail(`--days takes a whole number from 1 to 400, not ${v}`);
  return days;
}
function needSite(ctx: PluginContext, site: string | undefined, usage: string): asserts site is string {
  if (!site || !SITE.test(site)) ctx.fail(`usage: ${usage}`);
}
export function parseCookie(ctx: Pick<PluginContext, "fail">, v: unknown): CookieMode | undefined {
  if (v === undefined || v === "") return undefined;
  if (!COOKIE_MODES.includes(v as CookieMode)) ctx.fail(`--cookie takes ${COOKIE_MODES.join(", ")}, not ${v}`);
  return v as CookieMode;
}
/** Funnel steps from argv: separate words, or one word with " > " between steps (as the web UI sends them). */
export const parseSteps = (args: string[]) =>
  args
    .flatMap((a) => a.split(">"))
    .map((s) => s.trim())
    .filter(Boolean);

const days = { type: "string", desc: "look back this many days", default: "7" } as const;
const json = { type: "boolean", desc: "print JSON" } as const;
const limit = (def: number, desc = "rows per list") => ({ type: "string", desc, default: String(def) }) as const;
const rows = (opts: Record<string, any>, def: number) => Number(opts.limit) || def;
const forSite = (site: string | undefined) => (site ? ` for ${site}` : "");
const checkSite = (ctx: PluginContext, site: string | undefined) => {
  if (site && !SITE.test(site)) ctx.fail(`not a site name: ${site}`);
};
const withoutSite = (hosts: Record<string, string>, site: string) => Object.fromEntries(Object.entries(hosts).filter(([, s]) => s !== site));

/** probe, stopped where the collector cannot run. */
async function ready(ctx: PluginContext, o?: { site?: string }) {
  const st = await probe(ctx, o);
  needDocker(ctx, st);
  return st;
}
function needNetwork(ctx: PluginContext, st: State) {
  if (!st.network) ctx.fail(`Traefik's network "${st.proxy.network}" is missing on the server: run lf setup first`);
}

const commands: PluginCommand[] = [
  {
    name: "enable",
    tenant: true,
    args: "<site>",
    summary: "Collect analytics on a site's domains, or change its cookie mode (then add the script tag to its pages)",
    options: {
      domain: { type: "string", desc: "domain to collect on (default: the site's domains)", multiple: true },
      cookie: { type: "string", desc: "off (default): no cookie, visitors counted per day; on: cookie lfa_id; consent: cookie after lfa.consent()" },
    },
    async run(ctx, [site], opts) {
      needSite(ctx, site, "lf analytics enable <site> [--domain <domain>] [--cookie off|on|consent]");
      const cookie = parseCookie(ctx, opts.cookie);
      const st = await ready(ctx, { site });
      needNetwork(ctx, st);
      const had = Object.keys(st.hosts).filter((d) => st.hosts[d] === site);
      const given = ((opts.domain as string[] | undefined) ?? []).filter(Boolean).map((d) => d.toLowerCase());
      const want = given.length ? given : [...new Set([...had, ...st.domains])].sort();
      if (!want.length)
        ctx.fail(
          st.sites.includes(site)
            ? `${site} has no domain in its Traefik routers (is it running, with a domain?): pass --domain`
            : `no site ${site} on this server${st.sites.length ? ` (sites: ${st.sites.join(", ")})` : ""}; pass --domain to collect anyway`,
        );
      for (const d of want) {
        if (!DOMAIN.test(d)) ctx.fail(`not a domain: ${d}`);
        if (st.hosts[d] && st.hosts[d] !== site) ctx.fail(`${d} is already collected for ${st.hosts[d]}: lf analytics disable ${st.hosts[d]} first`);
      }
      const hosts = withoutSite(st.hosts, site);
      for (const d of want) hosts[d] = site;
      const before = cookieOf(st, site);
      const mode = cookie ?? before;
      const settings: SiteSettings = { ...st.settings };
      if (mode === "off") delete settings[site];
      else settings[site] = { ...settings[site], cookie: mode };
      const what = had.length
        ? `analytics: ${site} on ${want.join(", ")}${mode !== before ? `, cookie ${before} → ${mode}` : ""}`
        : `analytics: collect for ${site} (${want.join(", ")}, cookie ${mode})`;
      ctx.log.step(had.length ? `updating analytics for ${site}` : `collecting analytics for ${site} on ${want.join(", ")}`);
      checkEndpoints(ctx, await applyOrExplain(ctx, st, hosts, settings, what));
      ctx.log.ok(`the collector answers ${PREFIX} on ${want.join(", ")} · cookie ${mode}: ${COOKIE_ABOUT[mode]}`);
      if (mode === "on") ctx.log.warn("in the EU the cookie needs the visitor's consent: use --cookie consent and call lfa.consent() from your consent banner");
      if (!had.length) ctx.print("Add this tag to the <head> of the site's pages:", "", `  ${SNIPPET}`, "");
      if (mode === "consent" && before !== "consent")
        ctx.print("When the visitor agrees in your consent banner, call:", "", "  lfa.consent()          // lfa.consent(false) when they withdraw", "");
    },
  },
  {
    name: "disable",
    tenant: true,
    args: "<site>",
    summary: "Stop collecting analytics for a site (its data stays until --purge)",
    options: { purge: { type: "boolean", desc: "also delete the site's collected data (cannot be undone)" } },
    async run(ctx, [site], opts) {
      needSite(ctx, site, "lf analytics disable <site> [--purge]");
      const st = await ready(ctx);
      const hosts = withoutSite(st.hosts, site);
      const settings: SiteSettings = { ...st.settings };
      delete settings[site];
      if (Object.keys(hosts).length === Object.keys(st.hosts).length && !st.settings[site]) ctx.log.info(`${site} has no analytics collection`);
      else {
        ctx.log.step(`stopping analytics for ${site}`);
        await applyOrExplain(ctx, st, hosts, settings, `analytics: stop collecting for ${site}`);
        ctx.log.ok(`stopped collecting for ${site}; remove ${SNIPPET} from its pages`);
        if (!Object.keys(hosts).length) ctx.log.info("no site collects anymore: the collector is stopped");
      }
      if (opts.purge) {
        if (!(await ctx.confirm(`Delete all collected analytics of ${site}? This cannot be undone.`, false))) return 1;
        const n = await purge(ctx, site);
        ctx.log.ok(`deleted ${n ?? "the"} collected hits of ${site}`);
      }
    },
  },
  {
    name: "uninstall",
    tenant: true,
    summary: "Remove the collector and its files from the server, collected data included (--keep-data keeps it)",
    options: { "keep-data": { type: "boolean", desc: "keep the collected data and funnels in /opt/landfall/analytics" } },
    async run(ctx, _args, opts) {
      const keep = !!opts["keep-data"];
      const st = await probe(ctx);
      if (!st.installed && !st.collector) return ctx.log.info("analytics is not installed on this server");
      const sites = st.enabled.length ? ` It stops collecting for ${st.enabled.join(", ")}.` : "";
      const q = keep
        ? `Remove the analytics collector from ${ctx.name}?${sites} The collected data stays.`
        : `Remove the analytics collector from ${ctx.name} and delete all collected data?${sites} This cannot be undone.`;
      if (!(await ctx.confirm(q, false))) return 1;
      ctx.log.step("removing the analytics collector");
      if (!(await uninstall(ctx, keep))) return ctx.log.info("analytics is not installed on this server");
      ctx.log.ok(keep ? `removed the collector; the data stays in ${dirOf(ctx)}/data` : `removed the collector and ${dirOf(ctx)}`);
      if (st.enabled.length) ctx.log.info(`remove ${SNIPPET} from the pages of ${st.enabled.join(", ")}`);
    },
  },
  {
    name: "repair",
    tenant: true,
    summary: "Rewrite the collector's files and start it again (after an error or a landfall update)",
    async run(ctx) {
      const st = await ready(ctx);
      if (!st.enabled.length) return ctx.log.info("no site collects analytics: nothing to repair (lf analytics enable <site>)");
      needNetwork(ctx, st);
      ctx.log.step(`rewriting and starting the collector for ${st.enabled.join(", ")}`);
      checkEndpoints(ctx, await applyOrExplain(ctx, st, st.hosts, st.settings, "analytics: rewrote and restarted the collector"));
      ctx.log.ok("the collector runs");
    },
  },
  {
    name: "report",
    tenant: true,
    args: "[site]",
    summary: "Visitors, pages, sources, journeys, funnels, events, devices and web vitals",
    options: { days, limit: limit(10), json },
    async run(ctx, [site], opts) {
      checkSite(ctx, site);
      const n = parseDays(ctx, opts.days);
      const st = await query(ctx, { op: "report", site, days: n, limit: rows(opts, 10) });
      const r = st.data as Report;
      if (opts.json) {
        const cookies = Object.fromEntries([...new Set([...st.enabled, ...(r.sites ?? []).map((s) => s.site)])].map((s) => [s, cookieOf(st, s)]));
        return ctx.json({ collector: st.collector?.status ?? "missing", enabled: st.enabled, cookies, ...r });
      }
      if (r.empty || !r.sites.length) return ctx.log.info(`no visits in the last ${n} days${forSite(site)}`);
      ctx.blocks(panelBlocks(st, n, { site, text: true }));
    },
  },
  {
    name: "path",
    tenant: true,
    args: "<site> <page>",
    summary: "Where visitors of a page came from and where they went next",
    options: { days, limit: limit(10), json },
    async run(ctx, [site, page], opts) {
      needSite(ctx, site, "lf analytics path <site> <page>");
      if (!page?.startsWith("/")) ctx.fail(`a page is a path like /pricing, not ${page ?? "nothing"}`);
      const n = parseDays(ctx, opts.days);
      const st = await query(ctx, { op: "path", site, page, days: n, limit: rows(opts, 10) });
      const r = st.data as PathReport;
      if (opts.json) return ctx.json(r);
      if (r.empty || !r.views) return ctx.log.info(`no views of ${page} on ${site} in the last ${n} days`);
      const list = (title: string, rows: PathReport["before"]): UiBlock => ({
        type: "chart",
        chart: "bars",
        half: true,
        title,
        items: rows.map((x) => ({ label: x.path, value: x.count, text: `${num(x.count)} · ${pct(x.share)}`, mono: true })),
      });
      ctx.blocks([
        { type: "heading", text: `${page} on ${site}`, sub: `${num(r.views)} views in ${r.days} days` },
        list("Came from", r.before),
        list("Went next", r.after),
        ...(r.sources.length
          ? [
              {
                type: "table",
                title: "Sources of sessions that started here",
                columns: ["Source", "Sessions"],
                rows: r.sources.map((x) => ({ cells: [x.ref, num(x.count)] })),
              } satisfies UiBlock,
            ]
          : []),
      ]);
    },
  },
  {
    name: "events",
    tenant: true,
    args: "[site]",
    summary: "Custom events, outbound links and downloads, with their top properties",
    options: { days, limit: limit(20, "events to list"), json },
    async run(ctx, [site], opts) {
      checkSite(ctx, site);
      const n = parseDays(ctx, opts.days);
      const st = await query(ctx, { op: "events", site, days: n, limit: rows(opts, 20) });
      const r = st.data as { empty?: boolean; events: Report["events"] };
      if (opts.json) return ctx.json(r);
      if (r.empty || !r.events.length) return ctx.log.info(`no events in the last ${n} days${forSite(site)}`);
      ctx.blocks([
        {
          type: "table",
          title: "Events",
          sub: "custom events (lfa), outbound links and downloads",
          columns: ["Site", "Event", "Count", "Visitors", "Top properties"],
          rows: r.events.map((e) => ({ cells: [e.site, e.name, num(e.count), num(e.visitors), e.props.map((x) => `${x.prop} (${x.count})`).join(", ")] })),
        },
      ]);
    },
  },
  {
    name: "vitals",
    tenant: true,
    args: "[site]",
    summary: "Core Web Vitals (p75 of LCP, INP, CLS, FCP, TTFB) per site, device and page",
    options: { days, limit: limit(20, "pages to list"), json },
    async run(ctx, [site], opts) {
      checkSite(ctx, site);
      const n = parseDays(ctx, opts.days);
      const max = rows(opts, 20);
      const st = await query(ctx, { op: "vitals", site, days: n, limit: max });
      const r = st.data as Vitals & { empty?: boolean };
      if (opts.json) return ctx.json(r);
      if (r.empty || !r.sites.length) return ctx.log.info(`no web vitals in the last ${n} days${forSite(site)}`);
      ctx.blocks(vitalsBlocks(r, !site && r.sites.length > 1, max));
    },
  },
  {
    name: "funnels",
    tenant: true,
    args: "[site]",
    summary: "The funnels and how many sessions reach each step",
    options: { days, json },
    async run(ctx, [site], opts) {
      checkSite(ctx, site);
      const n = parseDays(ctx, opts.days);
      const st = await query(ctx, { op: "report", site, days: n, limit: 1 });
      const list: Report["funnels"] =
        (st.data as Report).funnels ??
        st.funnels.filter((f) => !site || f.site === site).map((f) => ({ ...f, steps: f.steps.map((step) => ({ step, sessions: 0, ofFirst: 0, ofPrev: 0 })) }));
      if (opts.json) return ctx.json({ days: n, funnels: list });
      if (!list.length) return ctx.log.info("no funnels: lf analytics funnel <site> <name> <step> <step> ...");
      ctx.blocks(list.map((f) => funnelBlock(f, true)));
    },
  },
  {
    name: "funnel",
    tenant: true,
    args: "<site> <name> [<step>...]",
    summary: "Define a funnel: pages in order (* matches anything) or event:Name; --rm removes it",
    options: { rm: { type: "boolean", desc: "remove the funnel (collected data stays)" } },
    async run(ctx, [site, name, ...rest], opts) {
      const usage = "lf analytics funnel <site> <name> <step> <step> ...  (e.g. / /pricing event:Signup), or --rm";
      needSite(ctx, site, usage);
      if (!name || !FUNNEL.test(name)) ctx.fail(`a funnel name has letters, digits, spaces, dots and dashes: ${name ?? ""}\n  usage: ${usage}`);
      const st = await ready(ctx);
      const exists = st.funnels.some((f) => f.site === site && f.name === name);
      const others = st.funnels.filter((f) => !(f.site === site && f.name === name));
      if (opts.rm) {
        if (!exists) ctx.fail(`no funnel ${name} for ${site}`);
        await writeFunnels(ctx, others, `analytics: removed funnel ${name} of ${site}`);
        return ctx.log.ok(`removed funnel ${name}`);
      }
      const steps = parseSteps(rest);
      if (steps.length < 2) ctx.fail(`a funnel needs at least two steps\n  usage: ${usage}`);
      if (steps.length > 10) ctx.fail("a funnel has at most 10 steps");
      for (const s of steps)
        if (!(s.startsWith("/") || /^event:[\w .:/@&+-]{1,60}$/.test(s))) ctx.fail(`a step is a page like /pricing or /blog/*, or event:Name, not ${s}`);
      if (!st.enabled.includes(site)) ctx.log.warn(`${site} does not collect analytics: lf analytics enable ${site}`);
      await writeFunnels(ctx, [...others, { site, name, steps }], `analytics: ${exists ? "changed" : "added"} funnel ${name} for ${site}`);
      ctx.log.ok(`${exists ? "changed" : "added"} funnel ${name}: ${steps.join(" → ")}`);
      ctx.log.info("it counts collected data too: lf analytics funnels");
    },
  },
  {
    name: "export",
    tenant: true,
    args: "[site]",
    summary: "Print the collected hits as CSV (or JSON lines), one row per pageview, event, vital and visit",
    options: {
      days: { type: "string", desc: "only the last this many days (default: everything)" },
      format: { type: "string", desc: "csv (default) or jsonl", default: "csv" },
    },
    async run(ctx, [site], opts) {
      checkSite(ctx, site);
      const format = String(opts.format) as "csv" | "jsonl";
      if (format !== "csv" && format !== "jsonl") ctx.fail(`--format takes csv or jsonl, not ${format}`);
      const back = opts.days === undefined ? 0 : Number(opts.days);
      if (!(Number.isInteger(back) && back >= 0)) ctx.fail(`--days takes a whole number, not ${opts.days}`);
      ctx.log.step(`exporting ${site ? `the hits of ${site}` : "all hits"}${back ? ` of the last ${back} days` : ""} as ${format}`);
      await exportData(ctx, { site, days: back || undefined, format });
    },
  },
  {
    name: "storage",
    tenant: true,
    summary: "Show or set how much collected data the server keeps: days, and a size limit",
    options: {
      "keep-days": { type: "string", desc: `delete hits older than this many days (default ${KEEP_DAYS})` },
      "max-size": { type: "string", desc: "delete the oldest days while the data is larger: 500M, 2G, or off (default off)" },
      json,
    },
    async run(ctx, _args, opts) {
      const st = await probe(ctx);
      const next: Storage = { ...st.storage };
      if (opts["keep-days"] !== undefined) {
        const n = Number(opts["keep-days"]);
        if (!(Number.isInteger(n) && n >= 1 && n <= MAX_KEEP_DAYS))
          ctx.fail(`--keep-days takes a whole number from 1 to ${MAX_KEEP_DAYS}, not ${opts["keep-days"]}`);
        if (n === KEEP_DAYS) delete next.keepDays;
        else next.keepDays = n;
      }
      if (opts["max-size"] !== undefined) {
        const b = parseSize(String(opts["max-size"]));
        if (b === undefined) ctx.fail(`--max-size takes a size like 500M or 2G, or off, not ${opts["max-size"]}`);
        if (b && b < MIN_BYTES) ctx.fail(`--max-size is at least ${bytes(MIN_BYTES)}`);
        if (b) next.maxBytes = b;
        else delete next.maxBytes;
      }
      const changed = JSON.stringify(next) !== JSON.stringify(st.storage);
      if (changed) {
        if (!st.installed) ctx.fail("analytics is not installed on this server: lf analytics enable <site> first");
        const lower =
          (next.keepDays ?? KEEP_DAYS) < (st.storage.keepDays ?? KEEP_DAYS) || (next.maxBytes && (!st.storage.maxBytes || next.maxBytes < st.storage.maxBytes));
        if (
          lower &&
          !(await ctx.confirm(
            `Keep less data (${storageText(next)})? The collector deletes what no longer fits within a minute. This cannot be undone.`,
            false,
          ))
        )
          return 1;
        await writeStorage(ctx, next, `analytics: storage ${storageText(next)}`);
        ctx.log.ok(`analytics data is ${storageText(next)}`);
        if (!st.running && st.enabled.length) ctx.log.warn("the collector is not running: it applies this when it starts (lf analytics repair)");
      }
      const view = { keepDays: next.keepDays ?? KEEP_DAYS, maxBytes: next.maxBytes ?? null, size: st.size };
      if (opts.json) return ctx.json(view);
      if (!changed) ctx.print(`Collected data is ${storageText(next)}. It takes ${bytes(st.size)} now.`);
    },
  },
];

export default definePlugin({
  name: "analytics",
  summary: "Privacy-friendly web analytics on your own server: visitors, sources, user journeys, funnels, events, web vitals",
  aliases: { vitals: "analytics vitals" },
  commands,
  panel: {
    tenant: true,
    label: "Analytics",
    group: "Monitoring",
    icon: "activity",
    views: VIEWS,
    async load(ctx, view) {
      const n = Number(view) || 7;
      try {
        return panelBlocks(await probe(ctx, { tags: true, query: { op: "report", days: n, limit: 10 } }), n);
      } catch (e) {
        return [
          { type: "note", kind: "bad", text: `Could not read the analytics from this server: ${errText(e)}` },
          { type: "actions", items: [{ label: "Check from the CLI", argv: ["analytics", "report"], title: "lf analytics report shows the full error" }] },
        ];
      }
    },
  },
});
