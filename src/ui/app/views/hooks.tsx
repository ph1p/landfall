import { HOOK_WHEN, HOOKS, isLocalHook, type Hook } from "../../../core/site/hook-names";
import type { ProjectHooks } from "../../../core/site/hooks";
import type { Group, Values } from "../ui/dialog";

/** package.json's landfall.hooks as a deploy reads them or a release keeps them: hook → npm scripts. */
type HookRun = ProjectHooks["run"];

/** The defined hooks among `only`, in the order they run. */
export const definedHooks = (run: HookRun | undefined, only: readonly Hook[] = HOOKS): Hook[] => HOOKS.filter((h) => only.includes(h) && run?.[h]?.length);

/** One line per hook: name, scripts, where and when it runs. */
export function HookList({ hooks, only }: { hooks: Pick<ProjectHooks, "run" | "service"> & { pm?: string }; only?: readonly Hook[] }) {
  const { run, pm = "npm", service } = hooks;
  const list = definedHooks(run, only);
  if (!list.length) return null;
  return (
    <ul className="m-0 p-0 list-none grid gap-1">
      {list.map((h) => (
        <li key={h} className="min-w-0">
          <code>{h}</code> <span className="break-all">{run[h]!.map((s) => `${pm} run ${s}`).join(", ")}</span>{" "}
          <span className="dim">
            {isLocalHook(h) ? "here" : `on the server${service ? `, in ${service}` : ""}`}, {HOOK_WHEN[h]}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The hooks `lf <cmd>` would run among `only`, as a dialog section with one box each (ticked: it runs; none when no hook
 * applies), and `skip(v)`: a --skip-hook per unticked box, by name, so the command says what it leaves out.
 */
export function hookChoice(run: HookRun | undefined, only: readonly Hook[], cmd: string, lead?: string): { fields: Group[]; skip: (v: Values) => string[] } {
  const list = definedHooks(run, only);
  const fields: Group[] = list.length
    ? [
        {
          legend: "Hooks",
          note: `${lead ? `${lead} ` : ""}Untick ${list.length > 1 ? "one" : "it"} to skip it this once: lf ${cmd} --skip-hook <name>`,
          fields: list.map((h) => ({
            name: `hook_${h}`,
            type: "check" as const,
            value: true,
            label: `Run ${h} (${run![h]!.join(", ")})`,
            hint: `${isLocalHook(h) ? "Here" : "On the server"}, ${HOOK_WHEN[h]}.`,
          })),
        },
      ]
    : [];
  return { fields, skip: (v) => list.filter((h) => v[`hook_${h}`] === false).flatMap((h) => ["--skip-hook", h]) };
}
