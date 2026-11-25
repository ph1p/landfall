import { S, ago, plural } from "../../lib/store";
import { run } from "../../lib/jobs";
import { confirmDlg, dialog, type Values } from "../../ui/dialog";
import { Badge, Body, Btn, Card, CardHead, Sub, cx, MONO } from "../../ui/kit";
import { compareUrl, hasRule, SOURCE_LABEL, gitParts, type Ref } from "../../../../core/deploy/refs";
import type { EnvRefs } from "../../lib/types";
import { envArgs, EVERY, envLabel, isTagRule } from "./env";
import { ext, CommitLink, CiLink } from "./links";
import { refresh, afterDeploy, promoteBlock } from "./pipeline";
import { type PickedRef, refArgs, refField } from "./ref-picker";

export function EnvCard({ path, e, next, refs, url }: { path: string; e: EnvRefs; next?: EnvRefs; refs: Ref[]; url?: string }) {
  const g = e.running?.git;
  const parts = g && gitParts(g, 7);
  const sha = g?.sha ?? g?.commit;
  const subject = g?.sha ? refs.find((r) => r.sha === g.sha)?.subject : undefined;
  const tagRule = isTagRule(e.rule);
  const newer = (e.behind ?? 0) > 0;
  const compare = g?.sha && e.newest && compareUrl(url, g.sha, e.newest.sha);
  const deployable = !!e.site;
  // The newest a rule allows: --tag latest for tags, the branch head for branches; without a rule, the working tree.
  const latest: string[] | undefined = !e.rule ? [] : tagRule ? ["--tag", "latest"] : e.newest ? ["--ref", e.newest.name] : undefined;
  const block = next && promoteBlock(e, next, refs);
  return (
    <Card className="mt-0!">
      <CardHead>
        {envLabel(e.env)}
        {e.site && (
          <Sub>
            {e.site}
            {e.server && <> on {e.server}</>}
          </Sub>
        )}
      </CardHead>
      <Body className="grid gap-2.5">
        <div className="text-sm">
          <span className="faint">Deploys </span>
          <span className={cx(!e.rule && "dim")}>{e.ruleText}</span>
          {e.auto && (
            <>
              {" "}
              <Badge kind="accent" title={`lf autodeploy: the server checks every ${e.auto} and deploys what the rule allows`}>
                auto · {e.auto}
              </Badge>
            </>
          )}
        </div>
        {e.error ? (
          <div>
            <Badge kind="bad">unreachable</Badge>
            <div className="text-sm text-dim mt-1 wrap-anywhere">{e.error}</div>
          </div>
        ) : !e.site ? (
          <div className="text-sm dim">No site name for this environment in .landfall.json yet: deploy it once.</div>
        ) : e.running === null || e.running === undefined ? (
          <div className="text-sm dim">Nothing deployed yet.</div>
        ) : (
          <div className="grid gap-1 text-md">
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
              {g ? (
                <>
                  <CommitLink url={url} sha={sha!} text={parts!.name} />
                  {parts!.beside && <span className={cx(MONO, "dim")}>{parts!.beside}</span>}
                  {g.dirty && (
                    <span className="text-bad text-sm font-medium" title="Deployed with uncommitted changes">
                      dirty
                    </span>
                  )}
                  <Badge>{SOURCE_LABEL[g.source ?? "local"] ?? g.source}</Badge>
                </>
              ) : (
                <span>
                  {e.running.id} <span className="dim">(not from git)</span>
                </span>
              )}
            </div>
            {subject && <div className="wrap-anywhere">{subject}</div>}
            <div className="text-sm dim">
              {ago(e.running.at)}
              {e.running.by && <> by {e.running.by}</>}
              {e.running.landfall && <> · landfall {e.running.landfall}</>}
              {g && <CiLink g={g} />}
            </div>
          </div>
        )}
        {newer && e.newest && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge kind="warn">{tagRule ? `${e.newest.name} available` : `${plural(e.behind!, "new commit")} on ${e.newest.name}`}</Badge>
            {compare && (
              <a href={compare} {...ext}>
                Compare
              </a>
            )}
          </div>
        )}
        {e.behind === 0 && e.newest && <div className="text-sm text-ok">Runs the newest it allows</div>}
        <div className="flex flex-wrap gap-1.5 mt-1">
          {latest && (
            <Btn
              cls={cx("sm", newer && "primary")}
              disabled={!deployable}
              title={`lf deploy -y${e.env ? ` -E ${e.env}` : ""}${latest.length ? ` ${latest.join(" ")}` : ""}`}
              on={() => run(["deploy", "-y", ...envArgs(e.env), ...latest], { cwd: path, server: e.server, after: afterDeploy(path) })}
            >
              {!e.rule ? "Deploy" : tagRule ? "Deploy latest tag" : `Deploy ${e.newest!.name}`}
            </Btn>
          )}
          <Btn cls="sm" disabled={!deployable} title="Pick a branch or tag to deploy" on={() => deployRefDialog(path, e)}>
            Deploy…
          </Btn>
          {next && (
            <Btn
              cls="sm"
              disabled={!!block}
              title={block ?? `lf promote -y ${e.env} ${next.env}: deploy what runs here to ${next.env}`}
              on={() => run(["promote", "-y", e.env, next.env], { cwd: path, server: next.server, after: afterDeploy(path) })}
            >
              Promote to {next.env}
            </Btn>
          )}
          {g?.sha && (
            <Btn
              cls="sm ghost"
              title={`${["lf autodeploy", ...envArgs(e.env)].join(" ")} ${e.auto ? "--off" : "--every …: the server deploys new commits on its own"}`}
              on={() => autoDialog(path, e)}
            >
              {e.auto ? "Stop auto-deploy" : "Auto-deploy…"}
            </Btn>
          )}
        </div>
        {next && block && <div className="text-xs faint">{block}</div>}
      </Body>
    </Card>
  );
}

/** lf autodeploy -E <env>: turn it on with an interval, or off. */
function autoDialog(path: string, e: EnvRefs) {
  const argv = ["autodeploy", ...envArgs(e.env)];
  const opts = { cwd: path, server: e.server };
  if (e.auto)
    return confirmDlg({
      title: `Stop auto-deploy of ${envLabel(e.env)}?`,
      text: `The cron line on ${e.server ?? "the server"} goes. What runs stays. lf undo turns it back on.`,
      ok: "Stop",
      onOk: () => run([...argv, "--off"], { ...opts, after: () => refresh(path) }),
    });
  dialog({
    title: `Auto-deploy ${envLabel(e.env)}`,
    text: `A cron line on ${e.server ?? "the server"} fetches the repository and deploys ${e.ruleText} on its own. A commit that changes the compose files, the environment layer, package.json or .landfall.json waits for lf deploy. The server must be able to fetch the repository (lf git key).`,
    fields: [
      {
        name: "every",
        label: "Check every",
        type: "select",
        value: "5m",
        options: EVERY,
      },
    ],
    ok: "Turn on",
    onOk: (v) => run([...argv, "--every", v.every], { ...opts, after: () => refresh(path) }),
  });
}

/** Deploy… on a board card: any allowed branch or tag to that environment. */
function deployRefDialog(path: string, e: EnvRefs) {
  const refs = S.git[path]?.data?.refs ?? [];
  dialog({
    title: `Deploy to ${envLabel(e.env)}`,
    text: `${e.site}${e.server ? ` on ${e.server}` : ""}. ${hasRule(e.rule) ? `Deploys ${e.ruleText}.` : "Any branch or tag."}`,
    fields: [refField(refs, e.rule)],
    ok: "Deploy",
    onOk: (v: Values) => {
      run(["deploy", "-y", ...envArgs(e.env), ...refArgs(v.ref as PickedRef)], { cwd: path, server: e.server, after: afterDeploy(path) });
    },
  });
}
