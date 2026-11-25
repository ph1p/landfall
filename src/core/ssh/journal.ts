import type { Server } from "../lib/config";
import { closeMux, runScript, shq } from "./ssh";
import { ROOT_HINT, rootLogin } from "./privilege";
import { effectiveSsh } from "./sshconfig";
import { JOURNAL, PRELUDE, ROOT, SITES, TRAEFIK_DIR } from "./templates";
import { fail } from "../lib/term";

/** One change landfall made on the server: a line of the journal. */
export interface Step {
  /** Line number in the journal, its id. */
  line: number;
  time: string;
  /** Who ran it on the server; undo logs in as them. */
  user: string;
  what: string;
  /** Shell that reverts it; none = not reversible. */
  undo?: string;
  undone: boolean;
  /** For the steps of an undo: the line it reverted. */
  reverts?: number;
}

/** One landfall invocation: the steps it made, oldest first. */
export interface Run {
  /** 1-based position in the journal, what `lf undo <n>` takes. */
  n: number;
  id: string;
  time: string;
  actor: string;
  cmd: string;
  /** The landfall version that made the run; undefined for runs by landfall before 0.17. */
  landfall?: string;
  steps: Step[];
}

/** Reversible steps not undone yet. */
export const pending = (r: Run) => r.steps.filter((s) => s.undo && !s.undone);

/** time run actor user cmd kind what undo64, tab separated; an undo line's `what` is the line it reverted. */
export function parseJournal(text: string): Run[] {
  const runs = new Map<string, Run>();
  const byLine = new Map<number, Step>();
  text.split("\n").forEach((raw, i) => {
    const [time, id, actor, user, cmd, kind, what, undo64, landfall] = raw.split("\t");
    if (undo64 === undefined || (kind !== "do" && kind !== "undo")) return;
    let run = runs.get(id);
    if (!run) runs.set(id, (run = { n: runs.size + 1, id, time, actor, cmd, ...(landfall && { landfall }), steps: [] }));
    const step: Step = { line: i + 1, time, user, what, undone: false };
    if (kind === "undo") {
      const target = byLine.get(Number(what));
      if (target) target.undone = true;
      step.reverts = Number(what);
      step.what = `undid: ${target?.what ?? `line ${what}`}`;
    } else if (undo64) step.undo = Buffer.from(undo64, "base64").toString();
    byLine.set(step.line, step);
    run.steps.push(step);
  });
  return [...runs.values()];
}

const reEsc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SUBJECT = new RegExp(`${reEsc(SITES)}/[A-Za-z0-9._-]+|${reEsc(TRAEFIK_DIR)}`, "g");

/**
 * What an undo shell puts back: site folders, traefik, and files it restores by absolute path.
 * Undos are full snapshots, so two steps on the same subject only undo newest first.
 */
function subjects(undo: string): Set<string> {
  const out = new Set<string>();
  for (const m of undo.matchAll(SUBJECT)) out.add(m[0]);
  for (const m of undo.matchAll(/restore_file \S+ '?(\/[^\s';]+)/g)) out.add(m[1]);
  return out;
}

/** Pending steps of runs after `after` that put back something `steps` would too: undoing `steps` first clobbers them. */
export function laterConflicts(runs: Run[], after: number, steps: Step[]): { run: Run; subject: string }[] {
  const mine = new Set(steps.filter((x) => x.undo && !x.undone).flatMap((x) => [...subjects(x.undo!)]));
  const found: { run: Run; subject: string }[] = [];
  for (const run of runs.filter((r) => r.n > after)) {
    const hit = pending(run)
      .flatMap((x) => [...subjects(x.undo!)])
      .find((t) => mine.has(t));
    if (hit) found.push({ run, subject: hit });
  }
  return found;
}

/** The users that undoing these steps removes ("created user deploy"). */
export function removedUsers(steps: Step[]): string[] {
  const names = steps
    .filter((x) => x.undo && !x.undone)
    .flatMap((x) => [...x.undo!.matchAll(/\b(?:user_del|userdel(?: -r)?) ([A-Za-z_][\w.-]*)/g)].map((m) => m[1]));
  return [...new Set(names)];
}

/**
 * Runs that stay although the user who made them goes: their sites would run on without an owner, nobody
 * could undo them, and landfall could no longer log in.
 */
export function stillNeeded(runs: Run[], steps: Step[]): { user: string; runs: Run[] }[] {
  const going = new Set(steps.map((x) => x.line));
  return removedUsers(steps)
    .map((user) => ({ user, runs: runs.filter((r) => pending(r).some((x) => x.user === user && !going.has(x.line))) }))
    .filter((x) => x.runs.length);
}

export async function readJournal(s: Server): Promise<Run[]> {
  const unreadable = `echo "cannot read ${JOURNAL}: log in as its owner, or with passwordless sudo" >&2; exit 1`;
  const { stdout } = await runScript(s, `cat ${JOURNAL} 2>/dev/null || sudo -n cat ${JOURNAL} 2>/dev/null || [ ! -e ${JOURNAL} ] || { ${unreadable}; }`, {
    capture: true,
  });
  return parseJournal(stdout);
}

/** A run by number (`3`, `#3`) or id; with `.m`, only its m-th step. */
export function findRun(runs: Run[], ref: string): { run: Run; steps: Step[] } {
  const m = ref.match(/^#?(\d+)(?:\.(\d+))?$/);
  const run = m ? runs[Number(m[1]) - 1] : runs.find((r) => r.id === ref);
  if (!run) fail(`no run ${ref} in the journal (\`lf log\` lists them)`);
  if (!m?.[2]) return { run: run!, steps: run!.steps };
  const step = run!.steps[Number(m[2]) - 1];
  if (!step) fail(`run #${run!.n} has ${run!.steps.length} steps, not ${m[2]}`);
  return { run: run!, steps: [step!] };
}

/** How a step's undo runs: as the user that made it; root's steps as root or through passwordless sudo. */
export async function loginFor(s: Server, user: string): Promise<{ login: Server; sudo?: boolean }> {
  const me = effectiveSsh(s).user;
  if (user === me || me === "root") return { login: s };
  if (user !== "root") return { login: { ...s, user } };
  const { stdout } = await runScript(s, "sudo -n true 2>/dev/null && echo yes || true", { capture: true });
  if (stdout.trim() === "yes") return { login: s, sudo: true };
  // The same fallback as every other root step: root's key login, else the sudo admin's.
  const other = await rootLogin(s);
  if (other) return other.user === "root" ? { login: other } : { login: other, sudo: true };
  return fail(`undoing this needs root: ${me} has no passwordless sudo, and no root or admin key login works; ${ROOT_HINT}`);
}

const UNDO_STEP = String.raw`
undo_step() { # undo_step <line> <undo shell, base64>
  # Two undos at once must not both revert a step: the second waits here, then finds it done.
  [ -e ${ROOT}/.undo.lock ] || touch ${ROOT}/.undo.lock 2>/dev/null || true
  if [ -r ${ROOT}/.undo.lock ] && command -v flock >/dev/null 2>&1; then exec 9<${ROOT}/.undo.lock; flock 9; fi
  if awk -F'\t' -v l="$1" '$6 == "undo" && $7 == l {f = 1} END {exit !f}' ${JOURNAL} 2>/dev/null; then
    echo "journal line $1 was already undone" >&2
  else
    set +e
    ( set -e; eval "$(printf %s "$2" | base64 -d)" )
    rc=$?
    set -e
    [ "$rc" = 0 ] || { echo "could not undo journal line $1 (exit $rc); later steps are undone, the rest is kept" >&2; exit 1; }
    _journal undo "$1" ""
  fi
  exec 9<&-
}`;

/** Reverts steps newest first, each as the user that made it; stops at the first that fails. */
export async function undoSteps(s: Server, steps: Step[]) {
  const todo = steps.filter((x) => x.undo && !x.undone).sort((a, b) => b.line - a.line);
  const groups: { group: Step[]; login: Server; sudo?: boolean }[] = [];
  // Every login is settled before the first step: a missing one must not leave the server half undone.
  for (let i = 0; i < todo.length;) {
    let j = i;
    while (j < todo.length && todo[j].user === todo[i].user) j++;
    const group = todo.slice(i, j);
    let at = await loginFor(s, todo[i].user);
    // Nobody removes the account they are logged in with: userdel refuses while its session runs.
    const self = removedUsers(group).find((u) => u === effectiveSsh(at.login).user);
    if (self) {
      const other = await rootLogin(s);
      if (!other) return fail(`cannot remove ${self} while logged in as ${self}: this needs root's or the admin's key login`);
      at = other.user === "root" ? { login: other } : { login: other, sudo: true };
    }
    groups.push({ group, ...at });
    i = j;
  }
  const used: Server[] = [s];
  for (const { group, login, sudo } of groups) {
    const calls = group.map((x) => `undo_step ${x.line} ${shq(Buffer.from(x.undo!).toString("base64"))}`);
    // userdel refuses while landfall is still logged in as that user through a lingering ssh mux. Only then:
    // a fresh session would lose groups (docker) that an earlier undo already took away.
    if (group.some((x) => /userdel|user_del/.test(x.undo!))) await Promise.all(used.map((x) => closeMux(x)));
    await runScript(login, [PRELUDE, UNDO_STEP, ...calls].join("\n"), { sudo });
    used.push(login);
  }
  return todo.length;
}
