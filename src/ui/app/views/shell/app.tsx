import { S, tilde, useStore } from "../../lib/store";
import { runningJobs, showJob, JobPanel } from "../../lib/jobs";
import { Btn, Spin, badgeClass, cx, MONO } from "../../ui/kit";
import { folderDialog } from "../flows/folder";
import { deployHere } from "../flows/deploy";
import { copy } from "../domains";
import { Main } from "./main";
import { Nav, Pick } from "./nav";

export function App() {
  useStore();
  if (!S.state) return null;
  const job = S.job && S.jobs.get(S.job);
  return (
    <div
      className={cx(
        "grid grid-rows-[56px_minmax(0,1fr)] h-screen max-[760px]:grid-cols-[minmax(0,1fr)]! max-[760px]:grid-rows-[56px_auto_minmax(0,1fr)]",
        job ? "grid-cols-[248px_minmax(0,1fr)_clamp(360px,32vw,520px)] max-[1100px]:grid-cols-[220px_minmax(0,1fr)]" : "grid-cols-[248px_minmax(0,1fr)]",
      )}
    >
      <Header />
      <Nav />
      <Pick />
      <main
        className={cx("@container min-w-0", S.map ? "overflow-hidden" : "overflow-auto px-8 pt-7 pb-12 max-[760px]:px-4 max-[760px]:pt-4 max-[760px]:pb-10")}
      >
        <Main />
      </main>
      <JobPanel />
    </div>
  );
}

// ---- header -----------------------------------------------------------------

function Header() {
  const st = S.state;
  const p = st.project;
  const running = runningJobs().length;
  return (
    <header className="col-span-full flex items-center gap-3 px-5 border-b border-line bg-panel max-[760px]:px-3.5 max-[760px]:gap-2">
      <a className="flex items-center gap-2.25 text-fg hover:no-underline" href="#/">
        <span className="font-mono font-bold text-[17px] tracking-[-.04em]">
          <span className="text-accent">&gt;</span>landfall
        </span>
        <small className="font-medium text-faint text-xs tracking-normal px-1.75 py-px rounded-full bg-hover max-[760px]:hidden">{st.version}</small>
      </a>
      {st.update && (
        <button
          type="button"
          className={cx(badgeClass("accent"), "cursor-pointer hover:brightness-110 max-[760px]:hidden")}
          title={`landfall ${st.update.latest} is available. Click to copy: ${st.updateCommand}`}
          onClick={() => copy(st.updateCommand)}
        >
          {st.update.latest} available
        </button>
      )}
      <div className="ml-auto flex items-center gap-2 text-dim text-md min-w-0 max-[760px]:[&_button]:px-2.5 max-[760px]:[&_button]:text-md">
        {S.jobs.size > 0 && !S.job && (
          <Btn on={() => showJob([...S.jobs.keys()].pop()!)} title="Show command output">
            {running ? <Spin className="size-2.5! mr-1" aria-hidden="true" /> : null}Jobs{running ? ` · ${running} running` : ""}
          </Btn>
        )}
        <span className={cx("overflow-hidden text-ellipsis whitespace-nowrap max-w-[36vw] max-[760px]:hidden", MONO)} title={st.cwd}>
          {p ? (
            <>
              <b>{p.name}</b> · {p.domains.join(", ")}
            </>
          ) : (
            tilde(st.cwd)
          )}
        </span>
        <Btn on={() => folderDialog(st.cwd)} title="Pick a folder, a recent project, or drop one here">
          Choose folder…
        </Btn>
        <Btn cls="primary" on={deployHere} title={`Check how ${st.cwd} deploys, then deploy it (lf deploy${p ? ", settings from .landfall.json" : ""})`}>
          Review & deploy…
        </Btn>
      </div>
    </header>
  );
}
