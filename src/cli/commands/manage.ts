import { defineCommand, serverOpt } from "../cmd";
import { checkInt, projectServer } from "../../core/lib/config";
import { bytes, plural } from "../../core/lib/format";
import { prune, prunePlan, reboot } from "../../core/server/manage";
import { JOURNAL_KEEP, kept, pruneSummary, reclaimable, removable, removableVolumes, shortName, type PrunePlan } from "../../core/server/reclaim";
import { adminLogin } from "../../core/ssh/privilege";
import { c, confirm, confirmRemoval, fail, info, ok, step, table, warn, printJson } from "../../core/lib/term";

function logSizes(l: NonNullable<PrunePlan["logs"]>) {
  if (!l.root) return `container logs and journal ${c.dim("(sizes need root or passwordless sudo)")}`;
  return `${bytes(l.size)} of container logs, journal ${l.journal ? bytes(l.journal) : c.dim("unknown")}`;
}

function printPlan(name: string, p: PrunePlan) {
  const imgs = removable(p);
  const keep = [
    [kept(p, "release").length, "for rollback"],
    [kept(p, "undo").length, "for undo"],
    [kept(p, "tagged").length, "tagged but unused (--all removes them)"],
  ].filter(([n]) => n) as [number, string][];
  if (imgs.length) {
    console.log(`${c.bold(name)}: ${imgs.length} unused images`);
    table([
      ["image", "size", "created"].map(c.dim),
      ...imgs.slice(0, 20).map((i) => [i.tags.join(", ") || c.dim(i.id.replace("sha256:", "").slice(0, 12)), bytes(i.size), c.dim(i.created.split(" ")[0])]),
    ]);
    if (imgs.length > 20) console.log(c.dim(`… ${imgs.length - 20} more`));
  } else console.log(`${c.bold(name)}: no unused images`);
  console.log(`build cache: ${p.buildCache ? bytes(p.buildCache) : c.dim("0")}${p.all ? "" : c.dim(" reclaimable (--all also removes cache still in use)")}`);
  if (p.networks.length) console.log(`networks: ${p.networks.join(", ")} ${c.dim("(no container uses them)")}`);
  if (p.logs) console.log(`logs: ${logSizes(p.logs)}, journal kept at ${JOURNAL_KEEP}`);
  if (p.volumes) {
    const vols = removableVolumes(p);
    if (vols.length) {
      console.log(`${vols.length} unused volumes, ${c.bold("their data goes for good")}:`);
      table([["volume", "size"].map(c.dim), ...vols.map((v) => [shortName(v.name), v.size ? bytes(v.size) : c.dim("?")])]);
    } else console.log("no unused volumes");
    if (p.leftovers?.length) {
      console.log(`backups of ${p.leftovers.length} removed sites, ${c.bold("gone for good")}:`);
      table([["site", "size"].map(c.dim), ...p.leftovers.map((l) => [l.site, bytes(l.size)])]);
    }
    const site = p.volumes.length - vols.length;
    if (site) keep.push([site, `volumes of existing sites (lf volume rm --data deletes one)`]);
  }
  if (keep.length) console.log(c.dim(`kept: ${keep.map(([n, w]) => `${n} ${w}`).join(", ")}`));
}

export const pruneCmd = defineCommand({
  name: "prune",
  summary:
    "Free disk space: remove unused Docker images, the build cache and unused networks; with --logs also container logs and the systemd journal, with --volumes unused volumes and the backups of removed sites.\n" +
    "Keeps images any container uses (stopped ones too), images of site releases (for rollback) and the ones undo needs. Containers stay.",
  options: {
    server: serverOpt,
    all: { type: "boolean", desc: "also remove unused tagged images (pulled again when needed) and all build cache" },
    logs: { type: "boolean", desc: `also empty every container's logs and shrink the systemd journal to ${JOURNAL_KEEP} (needs root)` },
    volumes: { type: "boolean", desc: "also delete volumes no container mounts and no existing site owns, and the backups lf sites rm kept (gone for good)" },
    "dry-run": { type: "boolean", desc: "only show what would go" },
    json: { type: "boolean", desc: "machine-readable output" },
  },
  async run(_, o) {
    const { name, server } = projectServer(o.server);
    if (!o.json) step(`measuring what can go on ${name}`);
    const plan = await prunePlan(server, { all: o.all, logs: o.logs, volumes: o.volumes });
    if (!plan.docker) fail(`no access to docker on ${name} (run lf setup)`);
    const imgs = removable(plan);
    const vols = removableVolumes(plan);
    const nothing = !imgs.length && !plan.buildCache && !plan.networks.length && !vols.length && !plan.leftovers?.length && !plan.logs;
    if (o["dry-run"] || (o.json && nothing)) return void (o.json ? printJson(plan) : printPlan(name, plan));
    if (!o.json) printPlan(name, plan);
    if (nothing) return ok("nothing to clean up");
    // Logs need root: the plan already knows whether this login has it, ask for another only when not.
    const login = plan.logs && !plan.logs.root ? await adminLogin(server, "emptying logs") : server;
    const question = `\nRemove ${pruneSummary(plan)} (up to ${bytes(reclaimable(plan))})?`;
    if (vols.length || plan.leftovers?.length) await confirmRemoval(question, name);
    else if (!(await confirm(question, true))) return;
    if (!o.json) step("cleaning up");
    const { failed } = await prune(login, plan);
    if (o.json) return void printJson({ ...plan, removed: imgs.length - failed.filter((f) => f.what === "image").length, failed });
    for (const f of failed)
      warn(`${f.name === "-" ? `could not empty the ${f.what}` : `${f.what} ${f.name}: could not remove it`}${f.why ? `: ${f.why}` : ""}`);
    ok(`removed ${pruneSummary(plan, failed)}`);
  },
});

export const rebootCmd = defineCommand({
  name: "reboot",
  summary: "Reboot a server, wait until it is back and check its containers run again.",
  options: {
    server: serverOpt,
    timeout: { type: "string", desc: "seconds to wait for it to come back", default: "300" },
  },
  async run(_, o) {
    const { name, server } = projectServer(o.server);
    const timeout = checkInt(o.timeout, "--timeout", 30, 3600);
    const admin = await adminLogin(server, "rebooting");
    if (!(await confirm(`Reboot ${name}? Its sites are offline for a minute or two.`, false))) return;
    const r = await reboot(admin, {
      timeout,
      onWait: (p) => step(p === "down" ? `rebooting ${name}` : p === "ssh" ? "waiting for ssh" : "waiting for containers"),
    });
    if (!r.back) fail(`${name} did not answer within ${timeout}s. Check its console at the provider`);
    ok(`${name} is back after ${r.seconds}s`);
    if (r.missing.length) warn(`not running again: ${r.missing.join(", ")}. See lf stats -s ${name}`);
    else info(r.before ? `${plural(r.before, "container")} ran before: all run again` : "no containers ran before");
  },
});
