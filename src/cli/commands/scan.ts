import { defineCommand, serverOpt } from "../cmd";
import { resolveServer } from "../../core/config";
import { removeTrivy, scanImages, SEVERITIES, TRIVY, TRIVY_ASK, TRIVY_CACHE, trivyState, trivyThere, type ImageScan, type Severity } from "../../core/scan";
import { c, confirm, info, ok, step, table, warn, printJson } from "../../core/term";

const COLOR: Record<Severity, (s: string) => string> = { CRITICAL: c.red, HIGH: c.yellow, MEDIUM: (s) => s, LOW: c.dim, UNKNOWN: c.dim };
const SHORT: Record<Severity, string> = { CRITICAL: "crit", HIGH: "high", MEDIUM: "med", LOW: "low", UNKNOWN: "?" };

const usedBy = (i: ImageScan) => i.used.map((u) => (u.service ? `${u.name}/${u.service}` : u.name)).join(", ");

function printScan(scans: ImageScan[], all: boolean, fixable: boolean) {
  table([
    ["image", "used by", ...SEVERITIES.slice(0, 4).map((s) => SHORT[s]), "fixable"].map(c.dim),
    ...scans.map((i) => [
      i.ref + (i.eol ? c.red(" (OS end of life)") : "") + (i.other ? c.dim(" (not landfall's)") : ""),
      c.dim(usedBy(i)),
      ...(i.error ? [c.red("failed"), "", "", ""] : SEVERITIES.slice(0, 4).map((s) => (i.counts[s] ? COLOR[s](String(i.counts[s])) : c.dim("0")))),
      i.error ? "" : String(i.fixable),
    ]),
  ]);
  for (const i of scans) {
    if (i.error) {
      warn(`${i.ref}: ${i.error}`);
      continue;
    }
    // Critical and high by default: the ones worth acting on.
    const shown = i.vulns.filter((v) => (all || v.severity === "CRITICAL" || v.severity === "HIGH") && (!fixable || v.fixed));
    if (!shown.length && !i.hint) continue;
    console.log(`\n${c.bold(i.ref)} ${c.dim(i.os ?? "")}`);
    const top = all ? shown : shown.slice(0, 15);
    table(
      top.map((v) => [
        "  " + COLOR[v.severity](SHORT[v.severity]),
        v.id,
        v.pkg,
        c.dim(v.installed),
        v.fixed ? `→ ${v.fixed}` : c.dim("no fix yet"),
        c.dim((v.title ?? "").slice(0, 60)),
      ]),
    );
    if (top.length < shown.length) console.log(c.dim(`  … ${shown.length - top.length} more (--all)`));
    if (i.hint) console.log(`  ${c.cyan(i.hint)}`);
  }
}

export const scanCmd = defineCommand({
  name: "scan",
  args: "[site...]",
  summary:
    "Scan the images every running container uses (traefik, the sites, and what landfall did not deploy) for known vulnerabilities (Trivy), and say what fixes them. Changes nothing.\n" +
    `Runs ${TRIVY} on the server; the image goes in on stdin, the scanner gets no docker socket. ` +
    `The first scan asks, then downloads its databases (several GB) into the volume ${TRIVY_CACHE}; --remove deletes image and volume again.`,
  options: {
    server: serverOpt,
    all: { type: "boolean", desc: "list every vulnerability, not just critical and high" },
    fixable: { type: "boolean", desc: "only those a newer package fixes" },
    others: {
      type: "boolean",
      desc: "also the containers landfall did not deploy, named by compose project or container (--no-others: only traefik and the sites)",
      default: true,
    },
    json: { type: "boolean", desc: "machine-readable output" },
    remove: { type: "boolean", desc: "remove Trivy's image and databases from the server instead of scanning" },
  },
  async run(args, o) {
    const { name, server } = resolveServer(o.server);
    if (o.remove) {
      step(`removing Trivy from ${name}`);
      const gone = await removeTrivy(server);
      return gone.length ? ok(`removed Trivy's ${gone.join(" and ")}`) : info("Trivy is not on the server");
    }
    if (!trivyThere(await trivyState(server)) && !(await confirm(`${TRIVY_ASK} Download it to ${name}? (lf scan --remove deletes it again)`, false)))
      return info("not scanned");
    if (!o.json) step(`scanning the images on ${name}`);
    const scans = await scanImages(server, args, !!o.others);
    if (o.json) return void printJson(scans);
    if (!scans.length) return info(args.length ? `no running images of ${args.join(", ")}` : "no images to scan");
    printScan(scans, !!o.all, !!o.fixable);
    const bad = scans.filter((i) => i.counts.CRITICAL || i.counts.HIGH).length;
    if (!bad) ok("no critical or high vulnerabilities");
  },
});
