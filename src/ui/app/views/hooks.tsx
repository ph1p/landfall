import { HOOK_WHEN, HOOKS, isLocalHook, type Hook } from "../../../core/hook-names";
import type { ProjectHooks } from "../../../core/hooks";
import type { Group, Values } from "../ui/dialog";

/** package.json's landfall.hooks as a deploy reads them or a release keeps them: hook → npm scripts. */
export type HookRun = ProjectHooks["run"];

/** The defined hooks among `only`, in the order they run. */
export const definedHooks = (run: HookRun | undefined, only: readonly Hook[] = HOOKS): Hook[] => HOOKS.filter((h) => only.includes(h) && run?.[h]?.length);

/** One line per hook: name, scripts, where and when it runs. */
export function HookList({ run, pm, service, only }: { run: HookRun; pm?: string; service?: string; only?: readonly Hook[] }) {
  const list = definedHooks(run, only);
  if (!list.length) return null;
  return (
    <ul className="m-0 p-0 list-none grid gap-1">
      {list.map((h) => (
        <li key={h} className="min-w-0">
          <code>{h}</code> <span className="break-all">{run[h]!.map((s) => `${pm ?? "npm"} run ${s}`).join(", ")}</span>{" "}
          <span className="dim">
            {isLocalHook(h) ? "here" : `on the server${service ? `, in ${service}` : ""}`}, {HOOK_WHEN[h]}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** A dialog section with one box per hook (ticked: it runs); none when no hook applies. */
export function hookFields(run: HookRun | undefined, only: readonly Hook[], note?: string): Group[] {
  const list = definedHooks(run, only);
  if (!list.length) return [];
  return [
    {
      legend: "Hooks",
      note: note ?? "Untick a hook to skip it this once (lf … --skip-hook <name>).",
      fields: list.map((h) => ({
        name: `hook_${h}`,
        type: "check" as const,
        value: true,
        label: `Run ${h} (${run![h]!.join(", ")})`,
        hint: `${isLocalHook(h) ? "Here" : "On the server"}, ${HOOK_WHEN[h]}.`,
      })),
    },
  ];
}

/** --skip-hook per unticked box: by name, so the command says what it leaves out. */
export const skipArgv = (v: Values, run: HookRun | undefined, only: readonly Hook[]): string[] =>
  definedHooks(run, only)
    .filter((h) => v[`hook_${h}`] === false)
    .flatMap((h) => ["--skip-hook", h]);
