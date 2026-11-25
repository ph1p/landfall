import { useCallback, useEffect, useState } from "react";
import { ago, errorMessage, http, sv } from "../../lib/store";
import type { AutodeployView, Release } from "../../lib/types";
import { ifOk, run } from "../../lib/jobs";
import { Btn, Kv, MONO, cx } from "../../ui/kit";
import { MenuBtn } from "../../ui/menu";
import { confirmDlg, dialog } from "../../ui/dialog";
import { ruleText } from "../../../../core/deploy/refs";
import { Panel } from "./panel";
import { envArgs, EVERY } from "../pipeline/env";
import { CommitLink } from "../pipeline/links";

/** lf autodeploy: the server checks the repository on a schedule and deploys new commits of the rule. */
export function SiteAutodeploy(p: { n: string; name: string; on: boolean; git?: Release["git"]; proj?: { path: string; environment?: string } }) {
  const { n, name, on } = p;
  const [v, setV] = useState<AutodeployView | null>(null);
  const [err, setErr] = useState("");
  const load = useCallback(
    () =>
      http<AutodeployView>(`/api/servers/${encodeURIComponent(n)}/autodeploy?site=${encodeURIComponent(name)}`).then(
        (x) => (setV(x), setErr("")),
        (e) => setErr(errorMessage(e)),
      ),
    [n, name],
  );
  useEffect(() => void (on && load()), [on, load]);
  // In its project folder lf reads the environment's rule and the site's folder in the repository; else by name.
  const argv = (...more: string[]) => (p.proj ? ["autodeploy", ...envArgs(p.proj.environment), ...sv(n), ...more] : ["autodeploy", name, ...sv(n), ...more]);
  const opts = { server: n, ...(p.proj && { cwd: p.proj.path }) };
  // Turning it on or off flips `on`, and the effect above reads again; a change or a check keeps it on, so read here.
  const reread = { ...opts, after: ifOk(load) };
  const setUp = () =>
    dialog({
      title: on ? `Auto-deploy of ${name}` : `Let ${name} deploy itself`,
      text: `A cron line on ${n} fetches the repository on a schedule and deploys the newest commit of the branch, or the newest tag, it follows. A commit that changes the compose files, the environment layer, package.json or .landfall.json is left for lf deploy. The server must be able to fetch the repository (lf git key).`,
      fields: [
        { name: "every", label: "Check every", type: "select", value: v?.every ?? "5m", options: EVERY },
        {
          name: "follow",
          label: "Follow",
          placeholder: on ? "what it follows now" : p.proj ? "the environment's rule" : p.git?.branch ? `branch ${p.git.branch}` : "branch or tag glob",
          hint: "Empty keeps the rule. A glob with a * or a v in front of a version follows tags (v*); anything else is a branch.",
          mono: true,
        },
      ],
      ok: on ? "Save" : "Turn on",
      onOk: (x) => {
        const f = String(x.follow ?? "").trim();
        const follow = f ? (/^v[\d*]/.test(f) || f.startsWith("refs/tags/") ? ["--tag", f.replace(/^refs\/tags\//, "")] : ["--branch", f]) : [];
        run(argv("--every", x.every, ...follow), on ? reread : opts);
      },
    });
  const off = () =>
    confirmDlg({
      title: `Stop auto-deploy of ${name}?`,
      text: `The cron line and sites/${name}/autodeploy.sh go. What runs stays. lf undo turns it back on.`,
      ok: "Stop",
      onOk: () => run(argv("--off"), opts),
    });
  const aside = on ? (
    <>
      <Btn cls="sm ghost" title={`lf ${argv("--now").join(" ")}: check once, now`} on={() => run(argv("--now"), reread)}>
        Check now
      </Btn>
      <MenuBtn
        label="More"
        cls="sm ghost"
        items={[
          { label: "Change…", run: setUp },
          { label: "Stop", run: off, cls: "danger", hint: "lf autodeploy --off" },
        ]}
      />
    </>
  ) : (
    <Btn cls="sm ghost" title="lf autodeploy --every: deploy new commits on its own" on={setUp}>
      Turn on…
    </Btn>
  );
  return (
    <Panel title="Auto-deploy" aside={aside}>
      <div className="px-3 py-2.5 text-sm flex flex-col gap-1.5 min-w-0">
        {!on ? (
          <span className="faint">Off. It deploys when you run lf deploy.</span>
        ) : err ? (
          <span className="text-bad">{err}</span>
        ) : !v ? (
          <span className="faint">reading…</span>
        ) : (
          <>
            <Kv
              pairs={[
                ["Follows", <span className="mono break-all">{`${ruleText(v.rule)} of ${v.url ?? "?"}${v.dir ? ` (${v.dir})` : ""}`}</span>],
                ["Every", v.every ?? ""],
                [
                  "Last seen",
                  v.last ? (
                    <span>
                      <span className="mono">{v.last.ref}</span> <CommitLink url={v.url} sha={v.last.sha} text={v.last.sha.slice(0, 7)} />: {v.last.result}{" "}
                      <span className="dim">· {ago(v.last.at)}</span>
                    </span>
                  ) : (
                    <span className="faint">nothing yet</span>
                  ),
                ],
              ]}
            />
            {!v.cron && <span className="text-warn">The crontab has no line for it: nothing runs. Change… puts it back.</span>}
            {v.log.length > 0 && (
              <details>
                <summary className="cursor-pointer dim">Log ({v.log.length} lines)</summary>
                <pre className={cx(MONO, "m-0 mt-1.5 max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-hover px-2 py-1 text-xs")}>
                  {v.log.join("\n")}
                </pre>
              </details>
            )}
          </>
        )}
      </div>
    </Panel>
  );
}
