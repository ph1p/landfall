import { type Server } from "./config";
import { runScript, shq } from "./ssh";
import { imageStatus, type ImageStatus } from "./updates";

/** Pinned: a scanner reads every image, so it never changes under you. */
export const TRIVY = "aquasec/trivy:0.76.1";
/** Trivy's vulnerability database (~80 MB), downloaded on the first scan and kept between scans. */
export const TRIVY_CACHE = "landfall-trivy";

export const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface Vuln {
  id: string;
  pkg: string;
  installed: string;
  /** The version that fixes it; none yet when empty. */
  fixed?: string;
  severity: Severity;
  title?: string;
}

export interface ImageScan {
  /** sha256:… */
  id: string;
  ref: string;
  /** The sites (or traefik) and services running it. */
  used: { name: string; service?: string }[];
  /** "debian 12.5". */
  os?: string;
  /** Its OS no longer gets security fixes. */
  eol?: boolean;
  counts: Record<Severity, number>;
  /** Vulnerabilities a newer package version fixes. */
  fixable: number;
  /** Most severe first, fixable first. */
  vulns: Vuln[];
  /** What to do about them. */
  hint?: string;
  /** Run by containers landfall did not deploy (lf scan --others). */
  other?: boolean;
  error?: string;
}

/**
 * Scans each image with Trivy in a container. The image goes in as a `docker save` tar on stdin:
 * the scanner gets no docker socket, so it cannot touch anything else on the server.
 */
export const scanScript = (ids: string[]) => String.raw`
set +e
err=$(mktemp)
for id in ${ids.map(shq).join(" ")}; do
  printf 'SCAN\t%s\n' "$id"
  docker save "$id" | docker run --rm -i --entrypoint sh -v ${TRIVY_CACHE}:/root/.cache/trivy ${TRIVY} -c 'cat > /tmp/i.tar && trivy image --quiet --input /tmp/i.tar --scanners vuln --format json' 2>"$err" | tr -d '\n'
  rc=$?; echo
  [ "$rc" = 0 ] || printf 'ERR\t%s\n' "$(grep -v '^ *$' "$err" | tail -1)"
done
rm -f "$err"
exit 0
`;

interface TrivyReport {
  Metadata?: { OS?: { Family?: string; Name?: string; EOSL?: boolean } };
  Results?: { Vulnerabilities?: { VulnerabilityID: string; PkgName: string; InstalledVersion: string; FixedVersion?: string; Severity?: string; Title?: string }[] }[];
}

const rank = (v: Vuln) => SEVERITIES.indexOf(v.severity) * 2 + (v.fixed ? 0 : 1);

/** One image's Trivy JSON: counts per severity and the vulnerabilities, deduplicated across its layers. */
export function parseReport(json: string): Pick<ImageScan, "os" | "eol" | "counts" | "fixable" | "vulns"> {
  const r = JSON.parse(json) as TrivyReport;
  const seen = new Map<string, Vuln>();
  for (const res of r.Results ?? [])
    for (const v of res.Vulnerabilities ?? []) {
      const key = `${v.VulnerabilityID} ${v.PkgName} ${v.InstalledVersion}`;
      if (seen.has(key)) continue;
      const severity = (SEVERITIES as readonly string[]).includes(v.Severity ?? "") ? (v.Severity as Severity) : "UNKNOWN";
      seen.set(key, {
        id: v.VulnerabilityID,
        pkg: v.PkgName,
        installed: v.InstalledVersion,
        ...(v.FixedVersion && { fixed: v.FixedVersion }),
        severity,
        ...(v.Title && { title: v.Title }),
      });
    }
  const vulns = [...seen.values()].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, vulns.filter((v) => v.severity === s).length])) as Record<Severity, number>;
  const os = r.Metadata?.OS;
  return {
    ...(os?.Family && { os: `${os.Family} ${os.Name ?? ""}`.trim() }),
    ...(os?.EOSL && { eol: true }),
    counts,
    fixable: vulns.filter((v) => v.fixed).length,
    vulns,
  };
}

/** Splits scanScript's output into each image's report or error. */
export function parseScan(out: string): Map<string, { json?: string; error?: string }> {
  const res = new Map<string, { json?: string; error?: string }>();
  let id = "";
  for (const line of out.split("\n")) {
    if (line.startsWith("SCAN\t")) res.set((id = line.slice(5)), {});
    else if (line.startsWith("ERR\t") && id) res.get(id)!.error = line.slice(4) || "the scan failed";
    else if (line.trim().startsWith("{") && id) res.get(id)!.json = line;
  }
  return res;
}

/** What fixes an image's vulnerabilities, from what kind of image it is. */
export function scanHint(s: Pick<ImageScan, "eol" | "fixable">, img: ImageStatus): string | undefined {
  const tips: string[] = [];
  if (s.eol) tips.push("its OS no longer gets security fixes: move to a newer base image");
  if (img.state === "rebuild") {
    if (s.fixable) tips.push("built on the server: redeploy, the build pulls the newest base image");
  } else if (img.state === "update") tips.push(`a newer ${img.ref} is out: lf update ${img.name} --images`);
  else if (img.newer) tips.push(`newer version ${img.newer}: switch to it`);
  else if (s.fixable && img.kind === "proxy") tips.push("not landfall's traefik: update it where it was set up");
  else if (s.fixable) tips.push(`the newest ${img.ref} still has them: a newer tag or another image fixes them`);
  return tips.join("; ") || undefined;
}

/** Every running container: name, image id, image ref, compose project and service (empty outside compose). */
export const CONTAINERS = String.raw`docker ps -q | xargs -r docker inspect -f '{{.Name}}{{"\t"}}{{.Image}}{{"\t"}}{{.Config.Image}}{{"\t"}}{{index .Config.Labels "com.docker.compose.project"}}{{"\t"}}{{index .Config.Labels "com.docker.compose.service"}}'`;

export interface Container {
  name: string;
  id: string;
  ref: string;
  project?: string;
  service?: string;
}

export const parseContainers = (out: string): Container[] =>
  out
    .split("\n")
    .map((l) => l.split("\t"))
    .filter((f) => f.length >= 3 && f[1].startsWith("sha256:"))
    .map(([name, id, ref, project = "", service = ""]) => ({ name: name.replace(/^\//, ""), id, ref, ...(project && { project }), ...(service && { service }) }));

/** What fixes the vulnerabilities of an image landfall did not deploy. */
export function otherHint(s: Pick<ImageScan, "eol" | "fixable">, ref: string): string | undefined {
  const tips: string[] = [];
  if (s.eol) tips.push("its OS no longer gets security fixes: move to a newer base image");
  if (s.fixable) tips.push(`not deployed by landfall: pull a newer ${ref} (or rebuild it) where it was set up`);
  return tips.join("; ") || undefined;
}

/**
 * Scans the images landfall's traefik and the sites run (only those named, when given), each image once;
 * with others, also those of every other running container (named by compose project or container).
 * Changes nothing but Trivy's cache volume.
 */
export async function scanImages(s: Server, names: string[] = [], others = false): Promise<ImageScan[]> {
  const all = await imageStatus(s);
  const imgs = all.filter((i) => i.id && (!names.length || names.includes(i.name)));
  type Entry = { ref: string; used: ImageScan["used"]; hint: (r: Pick<ImageScan, "eol" | "fixable">) => string | undefined; other?: boolean };
  const byId = new Map<string, Entry>();
  for (const i of imgs) {
    const e = byId.get(i.id!) ?? { ref: i.ref, used: [], hint: (r) => scanHint(r, i) };
    e.used.push({ name: i.name, ...(i.service && { service: i.service }) });
    byId.set(i.id!, e);
  }
  if (others) {
    const known = new Set(all.map((i) => i.container));
    const { stdout } = await runScript(s, CONTAINERS, { capture: true });
    for (const c of parseContainers(stdout)) {
      const name = c.project ?? c.name;
      if (known.has(c.name) || (names.length && !names.includes(name) && !names.includes(c.name))) continue;
      const e = byId.get(c.id) ?? { ref: c.ref, used: [], hint: (r) => otherHint(r, c.ref), other: true };
      e.used.push({ name, ...(c.project && c.service && { service: c.service }) });
      byId.set(c.id, e);
    }
  }
  if (!byId.size) return [];
  const { stdout } = await runScript(s, scanScript([...byId.keys()]), { capture: true });
  const out = parseScan(stdout);
  return [...byId].map(([id, e]) => {
    const base = { id, ref: e.ref, used: e.used, ...(e.other && { other: true }) };
    const empty = { counts: Object.fromEntries(SEVERITIES.map((x) => [x, 0])) as Record<Severity, number>, fixable: 0, vulns: [] };
    const r = out.get(id);
    if (!r?.json) return { ...base, ...empty, error: r?.error ?? "no report" };
    try {
      const rep = parseReport(r.json);
      const hint = e.hint(rep);
      return { ...base, ...rep, ...(hint && { hint }) };
    } catch {
      return { ...base, ...empty, error: "Trivy's report was not readable" };
    }
  });
}
