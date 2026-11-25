import { defineCommand, paintStatus, serverOpt } from "../cmd";
import { serverTarget } from "../target";
import { checkInt } from "../../core/lib/config";
import { isUp } from "../../core/site/status";
import { bytes, duration, pct } from "../../core/lib/format";
import { diskUsage, stats, type DiskUsage, type Stats } from "../../core/server/stats";
import { ROOT } from "../../core/ssh/templates";
import { c, fail, table, printJson } from "../../core/lib/term";

/** A 10-cell bar, yellow from 70%, red from 90%. */
function bar(p: number) {
  const n = Math.max(0, Math.min(10, Math.round(p / 10)));
  const paint = p >= 90 ? c.red : p >= 70 ? c.yellow : c.green;
  return paint("█".repeat(n)) + c.dim("░".repeat(10 - n));
}

const rate = (n: number) => `${bytes(n)}/s`;

function printStats(name: string, s: Stats, site?: string) {
  const ctrs = site ? s.containers.filter((x) => x.site === site || x.project === site) : s.containers;
  if (site && !ctrs.length) fail(`no containers of "${site}" on ${name}. See \`lf ls\``);
  if (!site) {
    const memUsed = s.mem.total - s.mem.available;
    const swapUsed = s.mem.swapTotal - s.mem.swapFree;
    const rows: string[][] = [
      ["cpu", bar(s.cpu), `${s.cpu}%`, c.dim(`${s.cpus} cores · load ${s.load.join(" ")}`)],
      ["memory", bar(pct(memUsed, s.mem.total)), `${pct(memUsed, s.mem.total)}%`, c.dim(`${bytes(memUsed)} / ${bytes(s.mem.total)}`)],
      ...(s.mem.swapTotal
        ? [["swap", bar(pct(swapUsed, s.mem.swapTotal)), `${pct(swapUsed, s.mem.swapTotal)}%`, c.dim(`${bytes(swapUsed)} / ${bytes(s.mem.swapTotal)}`)]]
        : []),
      ...s.disks.map((d) => [
        `disk ${d.mount}`,
        bar(pct(d.used, d.total)),
        `${pct(d.used, d.total)}%`,
        c.dim(`${bytes(d.used)} / ${bytes(d.total)}, ${bytes(d.available)} free`),
      ]),
      ...s.net.map((n) => [`net ${n.iface}`, "", "", `↓ ${rate(n.rx)}  ↑ ${rate(n.tx)}`]),
    ];
    console.log(c.bold(name) + c.dim(` · up ${duration(s.uptime)}`));
    table(rows.map(([k, ...r]) => [c.dim(k), ...r]));
    if (s.procs.length) {
      console.log(`\n${c.bold("Processes")} ${c.dim("(cpu: 100% = one core)")}`);
      table([["pid", "cpu", "memory", "name"].map(c.dim), ...s.procs.slice(0, 8).map((p) => [String(p.pid), `${p.cpu}%`, bytes(p.rss), p.name])]);
    }
  }
  if (!s.docker) console.log(c.dim("\nno access to docker: containers not shown (run lf setup)"));
  else if (ctrs.length) {
    console.log(`\n${c.bold("Containers")}`);
    table([
      ["site", "container", "cpu", "memory", "net in/out since start", "restarts", "status"].map(c.dim),
      ...ctrs.map((x) => [
        x.site ?? c.dim(x.project || "-"),
        x.name,
        isUp(x.status) ? `${Math.round(x.cpu * 10) / 10}%` : "",
        isUp(x.status) ? `${bytes(x.mem)}${x.memLimit && x.memLimit < s.mem.total ? c.dim(` (limit ${bytes(x.memLimit)})`) : ""}` : "",
        isUp(x.status) ? `↓ ${bytes(x.net.rx)}  ↑ ${bytes(x.net.tx)}` : "",
        x.restarts ? c.yellow(String(x.restarts)) : c.dim("0"),
        paintStatus(x.status),
      ]),
    ]);
  }
}

export const statsCmd = defineCommand({
  name: "stats",
  args: "[site]",
  summary: "Show live CPU, memory, disk, network, the busiest processes and each container's usage.\nWith a site, only its containers.",
  options: {
    server: serverOpt,
    watch: { type: "boolean", short: "w", desc: "refresh until Ctrl-C" },
    interval: { type: "string", desc: "seconds between refreshes with --watch", default: "5" },
    json: { type: "boolean", desc: "machine-readable output" },
  },
  async run([site], o) {
    const { name, server } = serverTarget(o);
    if (o.json) {
      if (o.watch) fail("--watch and --json do not go together: run lf stats --json in a loop");
      return void printJson(await stats(server));
    }
    if (!o.watch) return printStats(name, await stats(server), site);
    const every = checkInt(o.interval, "--interval", 1, 3600) * 1000;
    for (;;) {
      const s = await stats(server);
      // Home + clear: one frame per sample, not a scrolling log.
      if (process.stdout.isTTY) process.stdout.write("\x1b[H\x1b[2J");
      printStats(name, s, site);
      console.log(c.dim(`\n${new Date().toLocaleTimeString()} · every ${every / 1000}s · Ctrl-C to stop`));
      await new Promise((r) => setTimeout(r, every));
    }
  },
});

function printDisk(name: string, d: DiskUsage) {
  console.log(c.bold(name));
  table(
    d.disks.map((x) => [
      c.dim(x.mount),
      bar(pct(x.used, x.total)),
      `${pct(x.used, x.total)}%`,
      c.dim(`${bytes(x.used)} / ${bytes(x.total)}, ${bytes(x.available)} free`),
    ]),
  );
  if (d.docker && d.dockerDf.length) {
    console.log(`\n${c.bold("Docker")}`);
    table([
      ["", "count", "in use", "size", "reclaimable"].map(c.dim),
      ...d.dockerDf.map((x) => [x.type, String(x.count), String(x.active), bytes(x.size), x.reclaimable ? c.yellow(bytes(x.reclaimable)) : c.dim("0")]),
    ]);
  } else if (!d.docker) console.log(c.dim("\nno access to docker: images, volumes and logs not shown"));
  if (d.sites.length) {
    console.log(`\n${c.bold("Sites")} ${c.dim(`(${ROOT} ${bytes(d.landfall)})`)}`);
    table([["site", "files", "releases"].map(c.dim), ...d.sites.map((x) => [x.name, bytes(x.size), `${x.releases} · ${bytes(x.releasesSize)}`])]);
  }
  const vols = d.volumes.filter((x) => x.size > 0).slice(0, 10);
  if (vols.length) {
    console.log(`\n${c.bold("Volumes")} ${c.dim("(largest)")}`);
    table([["volume", "size", "used by"].map(c.dim), ...vols.map((x) => [x.name, bytes(x.size), x.links ? String(x.links) : c.yellow("nothing")])]);
  }
  const logs = d.logs.filter((x) => (x.size ?? 0) > 0).slice(0, 10);
  if (logs.length) {
    console.log(`\n${c.bold("Container logs")} ${c.dim("(largest)")}`);
    table(logs.map((x) => [x.container, bytes(x.size!)]));
  }
  const notes = [
    d.journald ? `systemd journal: ${bytes(d.journald)}` : "",
    d.root ? "" : "sizes below root-owned folders and container logs need root or passwordless sudo: they may be missing",
  ].filter(Boolean);
  if (notes.length) console.log("\n" + notes.map((n) => c.dim(n)).join("\n"));
}

export const diskCmd = defineCommand({
  name: "disk",
  summary: "Show where a server's disk space goes: filesystems, Docker images, volumes, build cache, sites and container logs.",
  options: { server: serverOpt, json: { type: "boolean", desc: "machine-readable output" } },
  async run(_, o) {
    const { name, server } = serverTarget(o);
    const d = await diskUsage(server);
    if (o.json) return void printJson(d);
    printDisk(name, d);
  },
});
