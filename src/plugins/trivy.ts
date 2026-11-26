// Trivy: scans the images the server runs and the files of its sites. A built-in plugin; lf scan is its full image report.
import { ago } from "../core/lib/ago";
import { bytes } from "../core/lib/format";
import { definePlugin, type PluginContext, type UiAction, type UiBlock } from "../core/plugins/plugin-api";
import { SITE_NAME } from "../core/site/site";
import {
  removeTrivy,
  scanImages,
  SEVERITIES,
  TRIVY,
  TRIVY_ASK,
  TRIVY_CACHE,
  trivyState,
  trivyThere,
  usedBy,
  type ImageScan,
  type TrivyState,
} from "../core/server/scan";

/** One image of the last image scan, without its vulnerability list (lf scan shows that). */
export interface ImageSummary {
  ref: string;
  used: string;
  critical: number;
  high: number;
  medium: number;
  fixable: number;
  eol?: boolean;
  hint?: string;
  error?: string;
}

/** A secret or a misconfiguration in a site's files. Never the secret itself: only where it is and what kind. */
export interface FileFinding {
  site: string;
  file: string;
  line?: number;
  kind: "secret" | "misconfig";
  id: string;
  severity: string;
  title: string;
}

/** What the plugin keeps on this computer per server: the last scans. */
export interface TrivyData {
  images?: { at: string; images: ImageSummary[] };
  files?: { at: string; sites: string[]; findings: FileFinding[]; errors: { site: string; error: string }[] };
}

export const summarize = (scans: ImageScan[]): ImageSummary[] =>
  scans.map((i) => ({
    ref: i.ref,
    used: usedBy(i),
    critical: i.counts.CRITICAL,
    high: i.counts.HIGH,
    medium: i.counts.MEDIUM,
    fixable: i.fixable,
    ...(i.eol && { eol: true }),
    ...(i.hint && { hint: i.hint }),
    ...(i.error && { error: i.error }),
  }));

/**
 * Scans each site's current release for secrets and misconfigurations (Dockerfiles, compose files, …) with Trivy.
 * The folder goes in read-only; .env files and node_modules are skipped: secrets belong there.
 */
export const filesScript = (sitesDir: string, sites: string[], shq: (v: string) => string) => String.raw`
set +e
err=$(mktemp); trap 'rm -f "$err"' EXIT
docker volume inspect ${TRIVY_CACHE} >/dev/null 2>&1 || echo "first scan: Trivy downloads its databases (several GB), this takes a while" >&2
want=${shq(sites.join(" "))}
for site in $(ls -1 ${shq(sitesDir)} 2>/dev/null); do
  [ -z "$want" ] || case " $want " in *" $site "*) ;; *) continue ;; esac
  dir=$(readlink -f ${shq(sitesDir)}/"$site"/current 2>/dev/null) || continue
  [ -d "$dir" ] || continue
  echo "scanning the files of $site" >&2
  printf 'SCAN\t%s\n' "$site"
  docker run --rm -v "$dir":/src:ro -v ${TRIVY_CACHE}:/root/.cache/trivy ${TRIVY} fs --quiet --scanners secret,misconfig \
    --skip-files '**/.env' --skip-files '**/.env.*' --skip-dirs '**/node_modules' --skip-dirs '**/.git' --format json /src 2>"$err" | tr -d '\n'
  rc=$?; echo
  [ "$rc" = 0 ] || printf 'ERR\t%s\n' "$(grep -v '^ *$' "$err" | tail -1)"
done
exit 0
`;

interface FsReport {
  Results?: {
    Target?: string;
    Secrets?: { RuleID?: string; Severity?: string; Title?: string; StartLine?: number }[];
    Misconfigurations?: { ID?: string; AVDID?: string; Severity?: string; Title?: string; Status?: string; CauseMetadata?: { StartLine?: number } }[];
  }[];
}

const SEV = SEVERITIES as readonly string[];
const sevRank = (s: string) => (SEV.includes(s) ? SEV.indexOf(s) : SEV.length);

/** filesScript's output: findings per site, most severe first, and the sites whose scan failed. */
export function parseFiles(out: string): Pick<NonNullable<TrivyData["files"]>, "sites" | "findings" | "errors"> {
  const sites: string[] = [];
  const findings: FileFinding[] = [];
  const errors: { site: string; error: string }[] = [];
  let site = "";
  for (const line of out.split("\n")) {
    if (line.startsWith("SCAN\t")) sites.push((site = line.slice(5)));
    else if (line.startsWith("ERR\t") && site) errors.push({ site, error: line.slice(4) || "the scan failed" });
    else if (line.trim().startsWith("{") && site) {
      let r: FsReport;
      try {
        r = JSON.parse(line);
      } catch {
        errors.push({ site, error: "Trivy's output did not parse" });
        continue;
      }
      for (const res of r.Results ?? []) {
        const file = res.Target ?? "";
        for (const s of res.Secrets ?? [])
          findings.push({
            site,
            file,
            ...(s.StartLine && { line: s.StartLine }),
            kind: "secret",
            id: s.RuleID ?? "",
            severity: s.Severity ?? "UNKNOWN",
            title: s.Title ?? "secret",
          });
        for (const m of res.Misconfigurations ?? []) {
          if (m.Status && m.Status !== "FAIL") continue;
          const at = m.CauseMetadata?.StartLine;
          findings.push({
            site,
            file,
            ...(at && { line: at }),
            kind: "misconfig",
            id: m.AVDID ?? m.ID ?? "",
            severity: m.Severity ?? "UNKNOWN",
            title: m.Title ?? "",
          });
        }
      }
    }
  }
  findings.sort((a, b) => sevRank(a.severity) - sevRank(b.severity) || a.site.localeCompare(b.site) || a.file.localeCompare(b.file));
  return { sites, findings, errors };
}

async function askFirst(ctx: PluginContext, t?: TrivyState): Promise<boolean> {
  if (trivyThere(t ?? (await trivyState(ctx.server, false)))) return true;
  return ctx.confirm(`${TRIVY_ASK} Download it to ${ctx.name}? (lf trivy rm deletes it again)`, false);
}

const json = { type: "boolean", desc: "machine-readable output" } as const;

const where = (f: FileFinding) => `${f.file}${f.line ? `:${f.line}` : ""}`;

const sizes = (t: TrivyState) => ({
  image: t.image !== undefined ? bytes(t.image) : "not downloaded",
  cache: t.cache !== undefined ? (t.cache ? bytes(t.cache) : "there") : "not downloaded",
});

export default definePlugin({
  name: "trivy",
  summary: "Scan the server's images and its sites' files for vulnerabilities, secrets and misconfigurations (Trivy).",
  commands: [
    {
      name: "",
      summary: "Show what Trivy keeps on the server and what the last scans found.",
      options: { json },
      async run(ctx, _, o) {
        const t = await trivyState(ctx.server);
        const data = ctx.data.get<TrivyData>() ?? {};
        if (o.json) return ctx.json({ ...t, ...data });
        const { dim, bold } = ctx.color;
        const sz = sizes(t);
        ctx.table([
          [dim("image"), `${TRIVY} ${dim(sz.image)}`],
          [dim("databases"), `${TRIVY_CACHE} ${dim(sz.cache)}`],
          [
            dim("image scan"),
            data.images
              ? `${ago(data.images.at)}: ${data.images.images.filter((i) => i.critical || i.high).length} of ${data.images.images.length} with critical or high`
              : "never (lf trivy images)",
          ],
          [
            dim("file scan"),
            data.files ? `${ago(data.files.at)}: ${data.files.findings.length} findings in ${data.files.sites.length} sites` : "never (lf trivy files)",
          ],
        ]);
        if (data.files?.findings.length) {
          ctx.print("", bold("Findings in site files"));
          ctx.table(data.files.findings.slice(0, 20).map((f) => [f.severity, f.site, where(f), dim(f.title)]));
        }
      },
    },
    {
      name: "images",
      args: "[site...]",
      summary: "Scan the running images for known vulnerabilities and keep a summary for lf trivy and the web UI (lf scan for every detail).",
      options: { json, others: { type: "boolean", desc: "also containers landfall did not deploy", default: true } },
      async run(ctx, args, o) {
        if (!(await askFirst(ctx))) return ctx.log.info("not scanned");
        if (!o.json) ctx.log.step(`scanning the images on ${ctx.name}`);
        const scans = await scanImages(ctx.server, args, !!o.others);
        const images = summarize(scans);
        // Only a scan of everything replaces the summary: one site's scan says nothing about the rest.
        if (!args.length) ctx.data.set({ ...ctx.data.get<TrivyData>(), images: { at: new Date().toISOString(), images } });
        if (o.json) return ctx.json(images);
        if (!images.length) return ctx.log.info("no images to scan");
        const { dim, red } = ctx.color;
        ctx.table([
          ["image", "used by", "crit", "high", "med", "fixable"].map(dim),
          ...images.map((i) => [
            i.ref,
            dim(i.used),
            ...(i.error ? [red("failed"), "", "", ""] : [String(i.critical), String(i.high), String(i.medium), String(i.fixable)]),
          ]),
        ]);
        for (const i of images) if (i.hint) ctx.log.info(`${i.ref}: ${i.hint}`);
        if (!images.some((i) => i.critical || i.high)) ctx.log.ok("no critical or high vulnerabilities");
        else ctx.log.info(dim("lf scan lists them"));
      },
    },
    {
      name: "files",
      args: "[site...]",
      summary: "Scan the sites' current releases for secrets and misconfigurations (.env files are skipped). Changes nothing.",
      options: { json },
      async run(ctx, args, o) {
        for (const a of args) if (!SITE_NAME.test(a)) ctx.fail(`not a site name: ${a}`);
        if (!(await askFirst(ctx))) return ctx.log.info("not scanned");
        if (!o.json) ctx.log.step(`scanning the site files on ${ctx.name}`);
        const out = await ctx.script(filesScript(ctx.paths.sites, args, ctx.shq));
        const res = parseFiles(out);
        for (const a of args) if (!res.sites.includes(a)) ctx.log.warn(`${a}: no deployed release on ${ctx.name}`);
        if (!args.length) ctx.data.set({ ...ctx.data.get<TrivyData>(), files: { at: new Date().toISOString(), ...res } });
        if (o.json) return ctx.json(res);
        for (const e of res.errors) ctx.log.warn(`${e.site}: ${e.error}`);
        if (!res.findings.length) return ctx.log.ok(`nothing found in ${res.sites.length} sites`);
        const { dim } = ctx.color;
        ctx.table([
          ["severity", "site", "file", "kind", "finding"].map(dim),
          ...res.findings.map((f) => [f.severity, f.site, where(f), f.kind, `${f.title} ${dim(f.id)}`]),
        ]);
      },
    },
    {
      name: "rm",
      summary: "Remove Trivy's image and databases from the server (the next scan downloads them again).",
      async run(ctx) {
        ctx.log.step(`removing Trivy from ${ctx.name}`);
        const gone = await removeTrivy(ctx.server);
        return gone.length ? ctx.log.ok(`removed Trivy's ${gone.join(" and ")}`) : ctx.log.info("Trivy is not on the server");
      },
    },
  ],
  aliases: { "trivy remove": "trivy rm", "trivy scan": "trivy images" },
  panel: {
    label: "Trivy",
    group: "Machine",
    icon: "scan",
    async load(ctx): Promise<UiBlock[]> {
      // Without sizes: measuring the databases starts a container and walks GBs. lf trivy shows them.
      const t = await trivyState(ctx.server, false);
      const there = trivyThere(t);
      const data = ctx.data.get<TrivyData>() ?? {};
      const sz = sizes(t);
      // Jobs have no terminal: -y answers the download question, which the dialog asked instead.
      const ask = there ? undefined : `${TRIVY_ASK} Download it?`;
      const scan: UiAction[] = [
        { label: "Scan images", argv: ["trivy", "images", "-y"], primary: true, confirm: ask },
        { label: "Scan site files", argv: ["trivy", "files", "-y"], confirm: ask },
        ...(there
          ? [{ label: "Remove Trivy", argv: ["trivy", "rm"], danger: true, confirm: "Remove Trivy's image and databases? The next scan downloads them again." }]
          : []),
      ];
      const blocks: UiBlock[] = [
        {
          type: "facts",
          items: [
            { label: "Image", value: { text: `${TRIVY} · ${sz.image}`, mono: true } },
            { label: "Databases", value: sz.cache },
            { label: "Image scan", value: data.images ? ago(data.images.at) : "never" },
            { label: "File scan", value: data.files ? ago(data.files.at) : "never" },
          ],
          actions: scan,
        },
      ];
      if (data.images)
        blocks.push({
          type: "table",
          title: "Images",
          sub: `scanned ${ago(data.images.at)}`,
          columns: ["Image", "Used by", "Critical", "High", "Medium", "Fixable", "What to do"],
          rows: data.images.images.map((i) => ({
            cells: [
              { text: i.ref, mono: true, ...(i.eol && { title: "its OS no longer gets security fixes" }) },
              i.used,
              ...(i.error
                ? [{ text: "failed", kind: "bad" as const, title: i.error }, "", "", ""]
                : [
                    { text: String(i.critical), kind: i.critical ? ("bad" as const) : ("" as const) },
                    { text: String(i.high), kind: i.high ? ("warn" as const) : ("" as const) },
                    i.medium,
                    i.fixable,
                  ]),
              i.hint ?? "",
            ],
          })),
          empty: "No running images.",
        });
      if (data.files) {
        for (const e of data.files.errors) blocks.push({ type: "note", kind: "bad", text: `${e.site}: ${e.error}` });
        blocks.push({
          type: "table",
          title: "Site files",
          sub: `${data.files.sites.length} sites, scanned ${ago(data.files.at)}`,
          columns: ["Severity", "Site", "File", "Kind", "Finding"],
          rows: data.files.findings.map((f) => ({
            cells: [
              { text: f.severity, kind: f.severity === "CRITICAL" ? "bad" : f.severity === "HIGH" ? "warn" : "" },
              f.site,
              { text: where(f), mono: true },
              f.kind,
              { text: f.title, title: f.id },
            ],
          })),
          empty: "No secrets or misconfigurations found.",
        });
      }
      return blocks;
    },
  },
});
