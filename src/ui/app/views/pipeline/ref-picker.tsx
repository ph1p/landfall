import { useMemo, useState } from "react";
import { ago } from "../../lib/store";
import type { Spec } from "../../ui/dialog";
import { Badge, cx, MONO } from "../../ui/kit";
import { hasRule, refMatches, ruleText, sortBranches, sortTags, type Ref, type RefKind, type RefRule } from "../../../../core/deploy/refs";
import { short } from "./env";

export interface PickedRef {
  name: string;
  kind: RefKind;
}

/** The deploy flag for a picked ref: --tag for a tag, --ref for a branch. */
export const refArgs = (r: PickedRef) => (r.kind === "tag" ? ["--tag", r.name] : ["--ref", r.name]);

/** Refs the rule allows first (tags newest first, then branches by date), the others after them. */
export function orderRefs(refs: Ref[], rule: RefRule | undefined) {
  const all = [...sortBranches(refs.filter((r) => r.kind === "branch")), ...sortTags(refs.filter((r) => r.kind === "tag"))];
  return [...all.filter((r) => refMatches(rule, r)), ...all.filter((r) => !refMatches(rule, r))];
}

/** A searchable list of the checkout's branches and tags; those the rule does not allow are greyed out. */
export function RefPicker({ refs, rule, value, onChange }: { refs: Ref[]; rule?: RefRule; value: PickedRef | null; onChange: (r: PickedRef) => void }) {
  const [q, setQ] = useState("");
  const ordered = useMemo(() => orderRefs(refs, rule), [refs, rule]);
  const shown = ordered.filter((r) => !q || r.name.toLowerCase().includes(q.toLowerCase()));
  const picked = value && refs.find((r) => r.kind === value.kind && r.name === value.name);
  return (
    <div className="grid gap-1.5">
      <input
        type="search"
        aria-label="Search branches and tags"
        placeholder={`Search ${refs.length} ${refs.length === 1 ? "branch or tag" : "branches and tags"}`}
        autoComplete="off"
        spellCheck={false}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && e.preventDefault()}
      />
      <ul role="listbox" aria-label="Branches and tags" className="m-0 p-0 list-none max-h-60 overflow-y-auto border border-line rounded-md">
        {shown.slice(0, 100).map((r) => {
          const ok = refMatches(rule, r);
          const on = value?.kind === r.kind && value.name === r.name;
          return (
            <li key={`${r.kind}:${r.name}`} role="option" aria-selected={on} aria-disabled={!ok}>
              <button
                type="button"
                disabled={!ok}
                title={ok ? `${r.kind} ${r.name}` : `Not allowed: this deploys ${ruleText(rule)}`}
                onClick={() => onChange({ name: r.name, kind: r.kind })}
                className={cx(
                  "w-full text-left flex items-center gap-2 px-2.5 py-1.5 border-0 rounded-none shadow-none bg-transparent text-md",
                  "border-b border-line last:border-b-0",
                  on ? "bg-accent-bg!" : "hover:bg-hover",
                  !ok && "opacity-45 cursor-not-allowed",
                )}
              >
                <Badge kind={r.kind === "tag" ? "accent" : ""}>{r.kind}</Badge>
                <span className={cx(MONO, "font-medium")}>{r.name}</span>
                <span className={cx(MONO, "faint")}>{short(r.sha)}</span>
                <span className="dim truncate min-w-0 flex-1">{r.subject}</span>
                {r.date && <span className="faint text-xs whitespace-nowrap">{ago(r.date)}</span>}
              </button>
            </li>
          );
        })}
        {!shown.length && <li className="px-2.5 py-2 dim text-sm">No branch or tag matches “{q}”.</li>}
      </ul>
      <div className="text-sm dim font-mono wrap-anywhere" aria-live="polite">
        {picked
          ? `${picked.kind} ${picked.name} · ${short(picked.sha)} ${picked.subject ?? ""}`
          : hasRule(rule)
            ? `Allowed: ${ruleText(rule)}`
            : "Pick a branch or tag"}
      </div>
    </div>
  );
}

/** The ref-picker field of a form: a clean export of the commit picked (lf deploy --ref/--tag). */
export const refField = (refs: Ref[], rule: RefRule | undefined, extra: Partial<Spec> = {}): Spec =>
  ({
    name: "ref",
    type: "custom",
    value: null,
    check: (x: PickedRef | null) => !x && "Pick a branch or tag",
    render: (v: PickedRef | null, set: (x: PickedRef) => void) => <RefPicker refs={refs} rule={rule} value={v} onChange={set} />,
    hint: "Deploys a clean copy of the commit: nothing uncommitted, nothing ignored.",
    ...extra,
  }) as Spec;
