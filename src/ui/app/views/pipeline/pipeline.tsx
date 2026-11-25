// Git-aware deploys: a project's environments side by side (lf refs), its git rules (lf git track), a ref picker.
import { S, plural, tilde, useStore } from "../../lib/store";
import { loadRefs } from "../../lib/api";
import type { Job } from "../../lib/jobs";
import { Actions, Btn, Card, Empty, pending } from "../../ui/kit";
import { allows, namesAt, type Ref } from "../../../../core/deploy/refs";
import type { EnvRefs } from "../../lib/types";
import { ciDialog } from "../ci";
import { openAfter } from "../flows/deploy";
import { envLabel, short, isTagRule } from "./env";
import { EnvCard } from "./env-card";
import { rulesEditor } from "./rules";

/** The folders remembered here (lf deploy) whose .landfall.json has git rules, for the side list. */
export function pipelineProjects(): { path: string; name: string }[] {
  const seen = new Map<string, string>();
  for (const p of S.state.projects ?? []) if (p.hasGitRules && !seen.has(p.path)) seen.set(p.path, p.name);
  return [...seen].map(([path, name]) => ({ path, name: path.split("/").pop() || name }));
}

export const refresh = (path: string) => loadRefs(path, true);

/** After a deploy from the board: read the environments again, offer the address it printed. */
export const afterDeploy = (path: string) => (j: Job) => {
  refresh(path);
  return openAfter(j);
};

export function PipelineView({ path }: { path: string }) {
  useStore();
  const st = S.refs[path];
  const g = S.git[path]?.data;
  const name = path.split("/").pop();
  const head = (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-4">
      <h1 className="m-0 text-[20px] font-semibold tracking-[-.01em]">{name}</h1>
      <span className="dim mono text-sm" title={path}>
        {tilde(path)}
      </span>
      {g?.repo && (
        <span className="dim text-sm">
          on <span className="mono">{g.repo.branch ?? short(g.repo.sha)}</span>
          {g.repo.dirty > 0 && <span className="text-bad"> · {plural(g.repo.dirty, "uncommitted change")}</span>}
        </span>
      )}
      <Actions>
        <Btn cls="sm" on={() => refresh(path)} disabled={st?.loading} title="Read the checkout and every environment's server again (lf refs)">
          Refresh
        </Btn>
        <Btn cls="sm" on={() => rulesEditor(path)} title="Which branches or tags each environment deploys (lf git track)">
          Rules…
        </Btn>
        <Btn cls="sm" on={() => ciDialog(path)} title="Deploy the pushes the rules allow from GitHub Actions or GitLab CI (lf ci init)">
          Deploy from CI…
        </Btn>
      </Actions>
    </div>
  );
  const wait = pending(st, "Reading each environment's server…", () => refresh(path));
  if (wait)
    return (
      <>
        {head}
        {wait}
      </>
    );
  const view = st!.data!;
  if (!view.repo)
    return (
      <>
        {head}
        <Card>
          <Empty title="Not a git checkout">
            <p>{tilde(path)} is not in a git repository with a commit. Git deploys need one.</p>
          </Empty>
        </Card>
      </>
    );
  const refs = g?.refs ?? [];
  const envs = view.envs;
  return (
    <>
      {head}
      <div className="grid gap-4 items-start grid-cols-[repeat(auto-fit,minmax(260px,1fr))]">
        {envs.map((e, i) => (
          <EnvCard key={e.env} path={path} e={e} next={e.env ? envs.slice(i + 1).find((x) => x.env) : undefined} refs={refs} url={view.url} />
        ))}
      </div>
      {st?.loading && <p className="dim text-sm mt-3">Reading again…</p>}
    </>
  );
}

/** Why promoting what runs in e to next is refused: the CLI's check (lf promote), on this checkout's refs. */
export function promoteBlock(e: EnvRefs, next: EnvRefs, refs: Ref[]): string | undefined {
  if (e.error) return `${envLabel(e.env)} could not be read`;
  const g = e.running?.git;
  if (!g) return e.running ? "What runs here was not deployed from git" : "Nothing runs here yet";
  const names = namesAt(g.sha ?? "", refs, [
    { name: g.tag, kind: "tag" },
    { name: g.branch, kind: "branch" },
  ]);
  if (allows(next.rule, names)) return undefined;
  return `${next.env} deploys ${next.ruleText}; this commit is not one${isTagRule(next.rule) ? ": tag it first" : ""}`;
}
