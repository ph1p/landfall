// The CI wizard: what lf ci init would write and set (GET /api/ci), then lf ci init as a job, then what is left to do.
import { useEffect, useState } from "react";
import { errorMessage, http } from "../lib/store";
import { run } from "../lib/jobs";
import type { CiView } from "../lib/types";
import { closeDialog, confirmDlg, DBTNS, DFORM, DTEXT, DTITLE, openDialog } from "../ui/dialog";
import { Badge, Btn, Note, cx, PRE } from "../ui/kit";
import { ruleText } from "../../../core/deploy/refs";

type Forge = CiView["forge"];
const FORGE_NAMES: Record<Forge, string> = { github: "GitHub Actions", gitlab: "GitLab CI" };
const ext = { target: "_blank", rel: "noopener noreferrer" };

/** Opens the CI wizard for the project folder at path. */
export const ciDialog = (path: string) => void openDialog(<CiDialog path={path} />, "wide");

function CiDialog({ path }: { path: string }) {
  const [forge, setForge] = useState<Forge | undefined>();
  const [nonce, setNonce] = useState(0);
  const [st, setSt] = useState<{ data?: CiView; error?: string }>({});
  const [force, setForce] = useState(false);
  useEffect(() => {
    let live = true;
    setSt((s) => ({ data: s.data }));
    const q = `?path=${encodeURIComponent(path)}${forge ? `&forge=${forge}` : ""}`;
    http<CiView>(`/api/ci${q}`).then(
      (data) => live && setSt({ data }),
      (e) => live && setSt({ error: errorMessage(e) }),
    );
    return () => void (live = false);
  }, [path, forge, nonce]);

  const v = st.data;
  const shown = forge ?? v?.forge;
  const loading = !st.data && !st.error;
  const blocked = !v || (v.exists === "other" && !force);
  const argv = ["ci", "init", ...(shown ? [shown] : []), "-y", ...(force ? ["--force"] : [])];
  const setUp = () => {
    closeDialog();
    run(argv, {
      cwd: path,
      after: (j) => {
        if (j.info.code !== 0 || !v) return;
        openDialog(<CiDone v={v} />, "wide");
        return [{ label: `Open ${FORGE_NAMES[v.forge]}`, run: () => void window.open(v.runsPage, "_blank", "noopener") }];
      },
    });
  };
  const remove = () =>
    v &&
    confirmDlg({
      title: `Stop deploying from ${v.name}`,
      text: `lf ci rm removes the CI key from ${v.servers.map((s) => s.name).join(", ")} and the secrets from ${v.repo}. Delete ${v.file} in git afterwards.`,
      ok: "Remove",
      danger: true,
      onOk: () => run(["ci", "rm", v.forge, "-y"], { cwd: path }),
    });

  return (
    <form method="dialog" className={DFORM} onSubmit={(e) => (e.preventDefault(), !blocked && setUp())}>
      <h2 id="dlg-title" className={DTITLE}>
        Deploy from CI
      </h2>
      <div className={DTEXT}>
        lf ci init writes a CI job from the git rules in .landfall.json. A push of a branch or tag an environment deploys then runs lf deploy in CI. The job
        logs in with its own ssh key, which only it has.
      </div>
      <div className="flex gap-1.5" role="group" aria-label="Forge">
        {(Object.keys(FORGE_NAMES) as Forge[]).map((f) => (
          <Btn key={f} cls={cx("sm", shown === f && "primary")} aria-pressed={shown === f} on={() => setForge(f)}>
            {FORGE_NAMES[f]}
          </Btn>
        ))}
      </div>
      {loading && <p className="dim text-md m-0">Reading the repository and its rules…</p>}
      {st.error && <Note kind="bad">{st.error}</Note>}
      {v && (
        <>
          {v.loggedIn ? (
            <div className="text-md">
              <Badge kind="ok">{v.cli} logged in</Badge> <span className="dim">sets the secrets on {v.repo}.</span>
            </div>
          ) : (
            <Note>
              {v.cli} is not installed or not logged in. Run <code>{v.cli} auth login</code> in a terminal, then check again. Without it, lf ci init writes the
              secrets to files for you to add on{" "}
              <a href={v.secretsPage} {...ext}>
                the secrets page
              </a>
              .{" "}
              <Btn cls="sm" on={() => setNonce((n) => n + 1)}>
                Check again
              </Btn>
            </Note>
          )}
          {v.exists === "ours" && (
            <Note kind="info">
              CI is set up already. Setting it up again makes a new key and replaces {v.file}.{" "}
              <Btn cls="sm danger" on={remove}>
                Remove CI…
              </Btn>
            </Note>
          )}
          {v.exists === "other" && (
            <Note kind="bad">
              {v.file} exists and lf did not write it.{" "}
              <label>
                <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> Replace it (--force)
              </label>
            </Note>
          )}
          {v.untracked && <Note>.landfall.json is not in git. Commit it too: the job reads it.</Note>}
          <fieldset>
            <legend>What deploys</legend>
            <ul className="m-0 pl-5 text-md">
              {v.targets.map((t) => (
                <li key={t.env}>
                  <b>{t.env || "the project"}</b>:{" "}
                  {v.fallbackBranch ? `pushes to ${v.fallbackBranch}` : ruleText({ branch: t.branches, tag: t.tags, prerelease: t.prerelease })}{" "}
                  <span className="dim">→ {t.server}</span>
                </li>
              ))}
            </ul>
            {v.fallbackBranch && (
              <p className="dim text-sm mb-0">No git rules yet: the job deploys pushes to the current branch. Rules… sets them per environment.</p>
            )}
          </fieldset>
          <fieldset>
            <legend>What changes</legend>
            <ul className="m-0 pl-5 text-md">
              {v.servers.map((s) => (
                <li key={s.name}>
                  a CI key for <span className="mono">{s.user}</span> on {s.name} <span className="dim">(no shell, no forwarding; lf undo removes it)</span>
                </li>
              ))}
              <li>
                the secrets <span className="mono">{v.secrets.join(", ")}</span> on {v.repo}
              </li>
              <li>
                <span className="mono">{v.file}</span>, here: you commit and push it
              </li>
            </ul>
            {v.include && <p className="dim text-sm mb-0">Your .gitlab-ci.yml needs an include of it; the job's output shows the lines.</p>}
          </fieldset>
          <details>
            <summary className="cursor-pointer text-md">{v.file}</summary>
            <pre className={cx(PRE, "max-h-80 mt-2")}>{v.yaml}</pre>
          </details>
        </>
      )}
      <div className={DBTNS}>
        <Btn cls="ghost" id="dlg-cancel" on={closeDialog}>
          Cancel
        </Btn>
        <Btn type="submit" cls="primary" disabled={blocked} title={`lf ${argv.join(" ")}`}>
          Set up
        </Btn>
      </div>
    </form>
  );
}

/** After lf ci init: commit the file, then watch the runs. */
function CiDone({ v }: { v: CiView }) {
  return (
    <form method="dialog" className={DFORM} onSubmit={(e) => (e.preventDefault(), closeDialog())}>
      <h2 id="dlg-title" className={DTITLE}>
        CI is set up
      </h2>
      <div className={DTEXT}>
        lf ci init wrote {v.file}. If {v.cli} was not logged in, the job's output names the files with the secrets: add them on the secrets page, then delete
        the files. Commit and push the job to start deploying:
      </div>
      <pre className={PRE}>{`git add ${v.here}${v.untracked ? " .landfall.json" : ""} && git commit -m "ci: deploy with landfall" && git push`}</pre>
      {v.include && (
        <>
          <div className={DTEXT}>Add this to your .gitlab-ci.yml as well:</div>
          <pre className={PRE}>{v.include}</pre>
        </>
      )}
      <div className="text-md">
        <a href={v.runsPage} {...ext}>
          {FORGE_NAMES[v.forge]} runs
        </a>
        {" · "}
        <a href={v.secretsPage} {...ext}>
          Secrets
        </a>
      </div>
      <div className={DBTNS}>
        <Btn type="submit" cls="primary">
          Done
        </Btn>
      </div>
    </form>
  );
}
