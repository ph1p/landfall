import { defineCommand, serverOpt } from "../cmd";
import { resolveServer, type Server } from "../config";
import { parseRule, type Rule } from "../inventory";
import { findRun, laterConflicts, pending, readJournal, undoSteps, type Run, type Step } from "../journal";
import { JOURNAL } from "../templates";
import { ago, c, confirm, confirmRemoval, fail, info, ok, step, warn } from "../ui";
import { firewallState, guardSsh } from "./firewall";
import { historyView } from "../views";

/** One step as `lf history` and `lf undo` print it. */
export function stepLine(x: Step, i: number) {
  const n = c.dim(`${i + 1}.`.padStart(4));
  if (x.reverts) return `${n} ${c.dim("↩ " + x.what)}`;
  if (x.undone) return `${n} ${c.dim(`✓ ${x.what} (undone)`)}`;
  if (x.undo) return `${n} ${c.cyan("↺")} ${x.what}`;
  return `${n} ${c.dim("· " + x.what + " (not reversible)")}`;
}

const unq = (spec: string) => spec.trim().replace(/\\(.)/g, "$1");
const same = (a: Rule, b: Rule) => a.action === b.action && a.port === b.port && a.proto === b.proto && a.from === b.from;

/** Refuses an undo that would leave ufw on without a way in over ssh, like `lf firewall rm` does. */
export async function guardUndo(server: Server, todo: Step[], force?: boolean) {
  if (!todo.some((x) => x.undo!.includes("ufw"))) return;
  const fw = await firewallState(server);
  let rules = [...fw.rules];
  let ufw = fw.ufw;
  for (const x of [...todo].sort((a, b) => b.line - a.line)) {
    for (const line of x.undo!.split("\n")) {
      const del = line.match(/\$SUDO ufw --force delete (.+?) >\/dev\/null/);
      const add = line.match(/\$SUDO ufw (prepend |insert (\d+) )?((?:allow|deny|reject|limit) .+?) >\/dev\/null/);
      if (del) {
        const gone = parseRule(unq(del[1]));
        const i = rules.findIndex((r) => same(r, gone));
        if (i >= 0) rules.splice(i, 1);
      } else if (add) {
        const r = parseRule(unq(add[3]));
        if (add[2]) rules.splice(Number(add[2]) - 1, 0, r);
        else rules = add[1] ? [r, ...rules] : [...rules, r];
      }
      else if (/\$SUDO ufw disable/.test(line)) ufw = "inactive";
      else if (/\$SUDO ufw --force enable/.test(line)) ufw = "active";
    }
  }
  await guardSsh({ ...fw, ufw }, rules, force);
}

const runLine = (r: Run) =>
  `${c.bold(`#${r.n}`.padEnd(5))} ${c.dim(ago(r.time).padEnd(9))} ${c.bold(r.cmd || "?")}  ${c.dim(`${r.actor} · ${r.id}`)}`;

export const historyLog = defineCommand({
  name: "history",
  summary: "What landfall changed on a server, newest first. ↺ marks steps `lf undo` can revert.",
  options: {
    server: serverOpt,
    n: { type: "string", short: "n", desc: "runs to show", default: "20" },
    json: { type: "boolean", desc: "machine-readable output" },
  },
  async run(_, o) {
    const { name, server } = resolveServer(o.server);
    if (o.json) return console.log(JSON.stringify(await historyView(server, Number(o.n) || 20), null, 2));
    const runs = (await readJournal(server)).reverse().slice(0, Number(o.n) || 20);
    if (!runs.length) return info(`nothing in ${JOURNAL} on ${name} yet`);
    for (const r of runs) {
      console.log(runLine(r));
      r.steps.forEach((x, i) => console.log(stepLine(x, i)));
    }
    const open = runs.find((r) => pending(r).length);
    if (open) console.log(c.dim(`\nlf undo reverts #${open.n}; lf undo <n> picks a run, <n>.<step> one step`));
  },
});

export const historyUndo = defineCommand({
  name: "undo",
  args: "[run|run.step]",
  summary: "Revert what landfall did: the latest run, run <n> from `lf history`, one step <n>.<m>, or --all.",
  options: {
    server: serverOpt,
    all: { type: "boolean", desc: "everything landfall did that can be reverted" },
    force: { type: "boolean", desc: "even if it leaves ufw on without an ssh rule, or a later run changed the same site or file" },
  },
  async run([ref], o) {
    const { name, server } = resolveServer(o.server);
    const runs = await readJournal(server);
    let steps: Step[];
    let label: string;
    if (o.all) {
      steps = runs.flatMap((r) => r.steps);
      label = `everything landfall did on ${name}`;
    } else {
      const run = ref ? findRun(runs, ref) : [...runs].reverse().map((r) => ({ run: r, steps: r.steps })).find((x) => pending(x.run).length);
      if (!run) return ok(`nothing to undo on ${name}`);
      ({ steps } = run);
      label = `#${run.run.n} ${run.run.cmd} (${ago(run.run.time)})`;
      // Undo puts whole files and sites back as they were: a later run on the same one would silently lose its
      // changes, and undoing that one afterwards would bring this run's changes back.
      const clash = laterConflicts(runs, run.run.n, steps);
      if (clash.length && !o.force) {
        fail(
          `later runs changed the same things: ${clash.map((x) => `#${x.run.n} ${x.run.cmd} (${x.subject})`).join(", ")}. ` +
            `Undo those first, newest first, or pass --force`,
        );
      }
      const later = runs.filter((r) => r.n > run.run.n && pending(r).length);
      if (later.length) warn(`later runs build on it and stay: ${later.map((r) => `#${r.n} ${r.cmd}`).join(", ")}`);
    }
    const todo = steps.filter((x) => x.undo && !x.undone);
    if (!todo.length) return ok(`nothing left to undo in ${label}`);
    step(`undo ${label}`);
    for (const x of [...todo].reverse()) console.error(`  ${c.cyan("↺")} ${x.what}`);
    const stays = steps.filter((x) => !x.undo && !x.reverts);
    for (const x of stays) console.error(`  ${c.dim(`· ${x.what} stays (not reversible)`)}`);
    await guardUndo(server, todo, o.force);
    const question = `Revert ${todo.length} change${todo.length > 1 ? "s" : ""} on ${name}?`;
    if (o.all) await confirmRemoval(question, name);
    else if (!(await confirm(question, false))) fail("cancelled");
    await undoSteps(server, todo);
    ok(`reverted ${todo.length} change${todo.length > 1 ? "s" : ""} on ${name}`);
    if (todo.some((x) => x.what.startsWith("created user")))
      info(c.dim(`lf still logs in to ${name} as that user: lf server rm ${name}, or lf setup again`));
  },
});
