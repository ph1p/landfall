import { S, ago, plural, sv } from "../lib/store";
import { run } from "../lib/jobs";
import { confirmDlg, dialog } from "../ui/dialog";
import { Actions, Btn, Card, CardHead, Empty, Sub, pending, cx, HIDE } from "../ui/kit";
import { Check, Dot, RotateCcw, Undo2 } from "lucide-react";

// ---- history -------------------------------------------------------------------

/** The journal: every run landfall made on n, newest first, each with its undo. */
export function HistoryView({ n }: { n: string }) {
  const st = S.history[n];
  const wait = pending(st, "reading the journal…");
  if (wait) return wait;
  const runs = st!.data!;
  if (!runs.length)
    return (
      <Card>
        <Empty title="Nothing yet">
          <p>Every change landfall makes on {n} is logged here, with a way to undo it.</p>
        </Empty>
      </Card>
    );
  const s = sv(n);
  const undo = (argv: string[]) => run(["undo", ...argv, ...s, "-y"], { server: n });
  const total = runs.reduce((a, r) => a + r.pending, 0);
  return (
    <Card>
      <CardHead>
        Journal <Sub>/opt/landfall/journal.log · newest first</Sub>
        <Actions>
          {total > 0 && (
            <Btn
              cls="sm danger"
              on={() =>
                confirmDlg({
                  title: `Undo everything landfall did on ${n}?`,
                  text: `${plural(total, "change")}, newest first. Sites, Traefik, the deploy user and landfall's firewall rules go away.`,
                  ok: "Revert everything",
                  danger: true,
                  typeToConfirm: n,
                  onOk: () => undo(["--all"]),
                })
              }
            >
              Undo everything
            </Btn>
          )}
        </Actions>
      </CardHead>
      {runs.map((r) => {
        const todo = r.steps.filter((x) => x.undo && !x.undone);
        const later = runs.filter((x) => x.n > r.n && x.pending);
        const undoRun = () =>
          dialog({
            title: `Undo #${r.n} ${r.cmd} on ${n}?`,
            text: [
              ...todo.map((x) => `↺ ${x.what}`).reverse(),
              ...(later.length ? ["", `Later runs build on it and stay: ${later.map((x) => `#${x.n}`).join(", ")}`] : []),
            ].join("\n"),
            ok: `Revert ${plural(todo.length, "change")}`,
            danger: true,
            onOk: () => undo([String(r.n)]),
          });
        return (
          <div key={r.n} className="px-4.5 py-3.5 border-b border-line last:border-b-0">
            <div className="flex items-center gap-2.5 flex-wrap">
              <b>#{r.n}</b>
              <span className="font-mono font-semibold text-md">{r.cmd || "?"}</span>
              <span className="dim">{ago(r.time)}</span>
              <span className={cx("faint mono", HIDE)}>
                {r.actor} · {r.id}
                {r.landfall && ` · landfall ${r.landfall}`}
              </span>
              <Actions>
                {r.pending ? (
                  <Btn cls="sm" on={undoRun}>
                    Undo {plural(r.pending, "change")}
                  </Btn>
                ) : (
                  <span className="faint">nothing to undo</span>
                )}
              </Actions>
            </div>
            <ul className="steps list-none mt-2 mb-0 mx-0 pl-1">
              {r.steps.map((x, i) => {
                const [cls, Ico] = x.reverts ? ["fixed", Undo2] : x.undone ? ["undone", Check] : x.undo ? ["", RotateCcw] : ["fixed", Dot];
                return (
                  <li key={i} className={cx("flex gap-2 items-baseline py-0.5 text-md", cls && "text-faint")}>
                    <Ico className="size-3.5 flex-none self-center" aria-hidden="true" />
                    <span className={cx(cls === "undone" && "line-through")}>{x.what}</span>
                    {!x.undo && !x.reverts && <span className="faint">(not reversible)</span>}
                    {x.undone && <span className="faint">(undone)</span>}
                    {x.undo && !x.undone && (
                      <Btn
                        cls="ghost sm"
                        on={() =>
                          confirmDlg({ title: `Undo step ${r.n}.${i + 1}?`, text: x.what, ok: "Undo it", danger: true, onOk: () => undo([`${r.n}.${i + 1}`]) })
                        }
                      >
                        undo
                      </Btn>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </Card>
  );
}
