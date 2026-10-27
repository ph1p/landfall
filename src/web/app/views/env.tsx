import { useEffect, useState } from "react";
import { http, errorMessage } from "../lib/store";
import { Btn, cx, MONO } from "../ui/kit";
import { secretProps } from "../ui/dialog";

/** What the table changes: one `lf env` with these pairs and -u keys; bad says why it cannot run yet. */
export interface EnvChange { set: Record<string, string>; unset: string[]; bad?: string }
export const NO_ENV_CHANGE: EnvChange = { set: {}, unset: [] };

/** value: undefined until revealed. edit: what was typed, undefined while unchanged. */
interface Row { key: string; length?: number; value?: string; edit?: string; removed?: boolean; added?: boolean }

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Compose secret names: file names in .secrets.
const SECRET = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const envUrl = (n: string, site: string, reveal: boolean, secrets = false) =>
  `/api/servers/${encodeURIComponent(n)}/${secrets ? "secrets" : "env"}?site=${encodeURIComponent(site)}${reveal ? "&reveal=1" : ""}`;

function change(rows: Row[], KEY_OK = KEY): EnvChange {
  const set: Record<string, string> = {};
  let bad: string | undefined;
  for (const r of rows) {
    if (r.removed || r.edit === undefined || (!r.added && r.edit === r.value)) continue;
    if (r.added && !r.key && !r.edit) continue;
    if (!KEY_OK.test(r.key)) bad ??= `Not a${KEY_OK === SECRET ? " secret" : " variable"} name: ${r.key || "(empty)"}`;
    else if (r.edit.includes("\n")) bad ??= `${r.key}: a value is one line`;
    else set[r.key] = r.edit;
  }
  return { set, unset: rows.filter((r) => r.removed && !r.added).map((r) => r.key), bad };
}

/**
 * The site's .env as rows: values stay hidden (and off the page) until Show values fetches them.
 * secrets: its .secrets files instead, whose values never reach the page; a value typed replaces one.
 */
export function EnvTable({ n, site, onChange, secrets }: { n: string; site: string; onChange: (c: EnvChange) => void; secrets?: boolean }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState("");
  const [shown, setShown] = useState(false);
  useEffect(() => {
    http<{ vars: Row[] }>(envUrl(n, site, false, secrets)).then((d) => setRows(d.vars), (e) => setErr(errorMessage(e)));
  }, []);
  const update = (next: Row[]) => {
    setRows(next);
    onChange(change(next, secrets ? SECRET : KEY));
  };
  const patch = (i: number, p: Partial<Row>) => update(rows!.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const reveal = () =>
    shown
      ? setShown(false)
      : http<{ vars: { key: string; value: string }[] }>(envUrl(n, site, true)).then(
          (d) => {
            const values = new Map(d.vars.map((v) => [v.key, v.value]));
            update(rows!.map((r) => (r.added ? r : { ...r, value: values.get(r.key) })));
            setShown(true);
          },
          (e) => setErr(errorMessage(e)),
        );

  if (err) return <div className="text-bad text-sm">{err}</div>;
  if (!rows) return <div className="text-faint text-sm">Loading {secrets ? "the secrets" : "the .env"}…</div>;
  return (
    <div className="grid gap-1.5">
      {!rows.length && <div className="text-faint text-sm">{secrets ? "No secrets yet." : "No variables yet."}</div>}
      {rows.map((r, i) => (
        <div key={i} className={cx("flex gap-1.5 items-center", r.removed && "opacity-50 line-through")}>
          {r.added ? (
            <input aria-label="Name" className={cx(MONO, "flex-[0_1_38%] min-w-0")} value={r.key} placeholder="NAME" autoComplete="off" spellCheck={false}
              onChange={(e) => {
                // A pasted KEY=VALUE fills both.
                const [k, ...v] = e.target.value.split("=");
                patch(i, v.length ? { key: k.trim(), edit: v.join("=") } : { key: e.target.value.trim() });
              }} />
          ) : (
            <span className={cx(MONO, "flex-[0_1_38%] min-w-0 truncate")} title={r.key}>{r.key}</span>
          )}
          <input
            aria-label={`Value of ${r.key || "the new variable"}`}
            {...(shown || r.added ? { type: "text", autoComplete: "off", spellCheck: false } : secretProps)}
            className={cx(MONO, "flex-1 min-w-0", !shown && !r.added && "secret")}
            disabled={r.removed}
            value={r.edit ?? r.value ?? ""}
            placeholder={r.added ? "value" : `hidden, ${r.length ?? r.value?.length ?? 0} ${secrets ? "bytes" : "characters"}; type to replace`}
            onChange={(e) => patch(i, { edit: !r.added && r.value === undefined && !e.target.value ? undefined : e.target.value })}
          />
          <Btn cls="sm ghost" title={r.removed ? "Keep it" : `Remove ${r.key}`}
            on={() => (r.added ? update(rows.filter((_, j) => j !== i)) : patch(i, { removed: !r.removed }))}>
            {r.removed ? "Keep" : "Remove"}
          </Btn>
        </div>
      ))}
      <div className="flex gap-2">
        <Btn cls="sm" on={() => update([...rows, { key: "", edit: "", added: true }])}>{secrets ? "Add secret" : "Add variable"}</Btn>
        {!secrets && rows.some((r) => !r.added) && <Btn cls="sm ghost" on={reveal}>{shown ? "Hide values" : "Show values"}</Btn>}
      </div>
    </div>
  );
}
