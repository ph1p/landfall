import { defineCommand, serverOpt } from "../cmd";
import { checkInt, projectServer } from "../../core/config";
import { bytes } from "../../core/facts";
import { JOURNAL_KEEP, kept, prune, prunePlan, pruneLogs, reboot, reclaimable, removable, type PrunePlan } from "../../core/manage";
import { adminLogin } from "../../core/privilege";
import { c, confirm, fail, info, ok, step, table, warn } from "../../core/term";

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
  if (p.logs) console.log(`logs: ${logSizes(p.logs)}, journal kept at ${JOURNAL_KEEP}`);
  if (keep.length) console.log(c.dim(`kept: ${keep.map(([n, w]) => `${n} ${w}`).join(", ")}`));
}

export const pruneCmd = defineCommand({
  name: "prune",
  summary:
    "Free disk space: remove unused Docker images and the build cache, with --logs also container logs and the systemd journal.\n" +
    "Keeps images any container uses (stopped ones too), images of site releases (for rollback) and the ones undo needs. Volumes and containers stay.",
  options: {
    server: serverOpt,
    all: { type: "boolean", desc: "also remove unused tagged images (pulled again when needed) and all build cache" },
    logs: { type: "boolean", desc: `also empty every container's logs and shrink the systemd journal to ${JOURNAL_KEEP} (needs root)` },
    "dry-run": { type: "boolean", desc: "only show what would go" },
    json: { type: "boolean", desc: "machine-readable output" },
  },
  async run(_, o) {
    const { name, server } = projectServer(o.server);
    const plan = await prunePlan(server, !!o.all, !!o.logs);
    if (!plan.docker) fail(`no access to docker on ${name} (run lf setup)`);
    const imgs = removable(plan);
    const images = imgs.length > 0 || plan.buildCache > 0;
    const nothing = !images && !plan.logs;
    if (o["dry-run"] || (o.json && nothing)) return void (o.json ? console.log(JSON.stringify(plan, null, 2)) : printPlan(name, plan));
    if (!o.json) printPlan(name, plan);
    if (nothing) return ok("nothing to clean up");
    // The plan already knows whether this login is root: ask for another only when not.
    const admin = plan.logs && (plan.logs.root ? server : await adminLogin(server, "emptying logs"));
    const what = `${imgs.length} images, the build cache${plan.logs ? ", container logs and old journal entries" : ""}`;
    if (!(await confirm(`\nRemove ${what} (up to ${bytes(reclaimable(plan))})?`, true))) return;
    if (!o.json) step("cleaning up");
    const res = images ? await prune(server, plan) : { images: 0, failed: [] };
    if (admin) await pruneLogs(admin);
    if (o.json) return void console.log(JSON.stringify({ ...plan, removed: res.images - res.failed.length, failed: res.failed }, null, 2));
    for (const f of res.failed) warn(`${f}: could not remove it (in use?)`);
    ok(`removed ${res.images - res.failed.length} images and the build cache${admin ? `, emptied container logs, journal down to ${JOURNAL_KEEP}` : ""}`);
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
    else info("all containers that ran before run again");
  },
});
