import { defineCommand, serverOpt } from "../cmd";
import { checkInt, projectServer } from "../config";
import { bytes } from "../facts";
import { kept, prune, prunePlan, reboot, removable, type PrunePlan } from "../manage";
import { adminLogin } from "../privilege";
import { c, confirm, fail, info, ok, step, table, warn } from "../ui";

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
  if (keep.length) console.log(c.dim(`kept: ${keep.map(([n, w]) => `${n} ${w}`).join(", ")}`));
}

export const pruneCmd = defineCommand({
  name: "prune",
  summary:
    "Free disk space: remove unused Docker images and the build cache.\n" +
    "Keeps images any container uses (stopped ones too), images of site releases (for rollback) and the ones undo needs. Volumes and containers stay.",
  options: {
    server: serverOpt,
    all: { type: "boolean", desc: "also remove unused tagged images (pulled again when needed) and all build cache" },
    "dry-run": { type: "boolean", desc: "only show what would go" },
    json: { type: "boolean", desc: "machine-readable output" },
  },
  async run(_, o) {
    const { name, server } = projectServer(o.server);
    const plan = await prunePlan(server, !!o.all);
    if (!plan.docker) fail(`no access to docker on ${name} (run lf setup)`);
    const imgs = removable(plan);
    if (o["dry-run"] || (o.json && !imgs.length && !plan.buildCache)) return void (o.json ? console.log(JSON.stringify(plan, null, 2)) : printPlan(name, plan));
    if (!o.json) printPlan(name, plan);
    if (!imgs.length && !plan.buildCache) return ok("nothing to clean up");
    // Sizes count shared layers in each image: the sum is what could go at most.
    const most = imgs.reduce((n, i) => n + i.size, 0) + plan.buildCache;
    if (!(await confirm(`\nRemove ${imgs.length} images and the build cache (up to ${bytes(most)})?`, true))) return;
    if (!o.json) step("cleaning up");
    const res = await prune(server, plan);
    if (o.json) return void console.log(JSON.stringify({ ...plan, removed: res.images - res.failed.length, failed: res.failed }, null, 2));
    for (const f of res.failed) warn(`${f}: could not remove it (in use?)`);
    ok(`removed ${res.images - res.failed.length} images and the build cache`);
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
