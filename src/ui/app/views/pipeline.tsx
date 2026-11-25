// Git-aware deploys: a project's environments side by side (lf refs), its git rules (lf git track), a ref picker.
import { useMemo, useState } from "react";
import { S, ago, plural, tilde, useStore } from "../lib/store";
import { goPipeline, loadGit, loadRefs } from "../lib/api";
import { run, type Job } from "../lib/jobs";
import { dialog, words, type Spec, type Values } from "../ui/dialog";
import { Actions, Badge, Body, Btn, Card, CardHead, Empty, Sub, cx, pending, MONO } from "../ui/kit";
import {
  allows,
  commitUrl,
  compareUrl,
  ENVIRONMENT_NAME,
  hasRule,
  list,
  namesAt,
  one,
  overlaps,
  refMatches,
  ruleText,
  sortBranches,
  sortTags,
  SOURCE_LABEL,
  gitParts,
  sameRule,
  type Ref,
  type RefKind,
  type RefRule,
} from "../../../core/refs";
import type { ReleaseGit } from "../../../core/compose";
import type { EnvRefs } from "../lib/types";
import { openAfter } from "./flows";
import { ciDialog } from "./ci";

const envArgs = (env: string) => (env ? ["-E", env] : []);
const envLabel = (env: string) => env || "project";
const short = (sha?: string) => sha?.slice(0, 7) ?? "";
const isTagRule = (r: RefRule | undefined) => list(r?.tag).length > 0;
const ext = { target: "_blank", rel: "noopener noreferrer" };

/** The folders remembered here (lf deploy) whose .landfall.json has git rules, for the side list. */
export function pipelineProjects(): { path: string; name: string }[] {
  const seen = new Map<string, string>();
  for (const p of S.state.projects ?? []) if (p.hasGitRules && !seen.has(p.path)) seen.set(p.path, p.name);
  return [...seen].map(([path, name]) => ({ path, name: path.split("/").pop() || name }));
}

/** A quiet link on a project row: its pipeline when it has git rules, else setting them up when it is a git checkout. */
export function GitLink({ p }: { p: { path: string; inGit: boolean; hasGitRules: boolean } }) {
  const { path } = p;
  if (!p.inGit) return null;
  return p.hasGitRules ? (
    <a href={`#git/${encodeURIComponent(path)}`} title="Every environment's git rule, what runs there and what is newer">
      Pipeline
    </a>
  ) : (
    <a href="#" onClick={(e) => (e.preventDefault(), rulesEditor(path))} title="Say which branches or tags each environment deploys (lf git track)">
      Set up git deploys
    </a>
  );
}

// ---- the board -----------------------------------------------------------------

const refresh = (path: string) => loadRefs(path, true);
/** After a deploy from the board: read the environments again, offer the address it printed. */
const afterDeploy = (path: string) => (j: Job) => {
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
function promoteBlock(e: EnvRefs, next: EnvRefs, refs: Ref[]): string | undefined {
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

function EnvCard({ path, e, next, refs, url }: { path: string; e: EnvRefs; next?: EnvRefs; refs: Ref[]; url?: string }) {
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
        </div>
        {next && block && <div className="text-xs faint">{block}</div>}
      </Body>
    </Card>
  );
}

/** A commit, linked to the forge when the remote is one landfall knows. */
export function CommitLink({ url, sha, text, title = sha }: { url?: string; sha: string; text: string; title?: string }) {
  const href = commitUrl(url, sha);
  return href ? (
    <a className={MONO} href={href} title={title} {...ext}>
      {text}
    </a>
  ) : (
    <span className={MONO} title={title}>
      {text}
    </span>
  );
}

/** " · CI run": the CI run that deployed a release, if one did. */
export const CiLink = ({ g }: { g: ReleaseGit }) =>
  g.ci?.url ? (
    <>
      {" · "}
      <a href={g.ci.url} {...ext}>
        {g.ci.provider === "gitlab" ? "GitLab job" : "CI run"}
      </a>
    </>
  ) : null;

// ---- picking a ref -----------------------------------------------------------------

export interface PickedRef {
  name: string;
  kind: RefKind;
}
/** The deploy flag for a picked ref: --tag for a tag, --ref for a branch. */
export const refArgs = (r: PickedRef) => (r.kind === "tag" ? ["--tag", r.name] : ["--ref", r.name]);

/** Refs the rule allows first (tags newest first, then branches by date), the others after them. */
function orderRefs(refs: Ref[], rule: RefRule | undefined) {
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
      <ul role="listbox" aria-label="Branches and tags" className="m-0 p-0 list-none max-h-[240px] overflow-y-auto border border-line rounded-md">
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

// ---- the rules editor ---------------------------------------------------------------

const ruleOf = (v: Values, i: number): RefRule | undefined => {
  const branch = words(v[`b${i}`] ?? "");
  const tag = words(v[`t${i}`] ?? "");
  if (!branch.length && !tag.length) return undefined;
  return {
    ...(branch.length && { branch: one(branch) }),
    ...(tag.length && { tag: one(tag) }),
    ...(v[`p${i}`] && { prerelease: true }),
    ...(v[`c${i}`] && { requireClean: true }),
  };
};
/** lf git track for one environment: its new rule, or --off. */
function trackArgv(env: string, rule: RefRule | undefined): string[] {
  if (!rule) return ["git", "track", ...envArgs(env), "--off"];
  return [
    "git",
    "track",
    ...envArgs(env),
    ...list(rule.branch).flatMap((b) => ["--branch", b]),
    ...list(rule.tag).flatMap((t) => ["--tag", t]),
    rule.prerelease ? "--prerelease" : "--no-prerelease",
    rule.requireClean ? "--require-clean" : "--no-require-clean",
  ];
}

/** Runs the jobs one after another: each writes the same .landfall.json. */
function chain(path: string, jobs: string[][]) {
  const [first, ...rest] = jobs;
  if (!first) return;
  run(first, {
    cwd: path,
    after: (j) => {
      if (j.info.code !== 0) return;
      if (rest.length) chain(path, rest);
      else refresh(path);
    },
  });
}

/** Which branches and tags each environment deploys: one row per environment, written with lf git track. */
export async function rulesEditor(path: string) {
  // A fresh read: the rules may have changed since the page loaded.
  const before = S.git[path]?.data;
  const info = (await loadGit(path, true)) ?? before;
  const rules = info?.rules ?? {};
  const refs = info?.refs ?? [];
  const envs = Object.keys(rules);
  if (!envs.includes("")) envs.unshift("");
  const ADD = envs.length;
  const rulesFrom = (v: Values) => {
    const out: Record<string, RefRule | undefined> = {};
    envs.forEach((e, i) => (out[e] = ruleOf(v, i)));
    if (v.newName?.trim()) out[v.newName.trim()] = ruleOf(v, ADD);
    return out;
  };
  const previewOf = (i: number, env: () => string) => (v: Values) => {
    const rule = ruleOf(v, i);
    if (!rule) return "deploys anything";
    const hits = orderRefs(refs, rule).filter((r) => refMatches(rule, r));
    const all = rulesFrom(v);
    const clash = overlaps(all, hits)
      .filter((x) => x.includes(env()))
      .flat()
      .filter((x) => x !== env());
    const names = hits.slice(0, 4).map((r) => r.name);
    const more = hits.length > 4 ? ` and ${hits.length - 4} more` : "";
    const head = hits.length ? `matches ${names.join(", ")}${more}` : "matches nothing here yet";
    return clash.length ? `${head}  ⚠ overlaps ${[...new Set(clash)].map(envLabel).join(", ")}: --for-ref cannot pick` : head;
  };
  const rowFor = (i: number, rule: RefRule | undefined, env: () => string, when?: (v: Values) => unknown): Spec[] => [
    {
      row: [
        {
          name: `b${i}`,
          label: "Branches",
          value: list(rule?.branch).join(", "),
          mono: true,
          placeholder: "main, release/*",
          suggest: refs.filter((r) => r.kind === "branch").map((r) => r.name),
        },
        { name: `t${i}`, label: "Tags", value: list(rule?.tag).join(", "), mono: true, placeholder: "v*", preview: previewOf(i, env) },
      ],
      when,
    },
    { name: `p${i}`, type: "check", label: "Pre-release tags (v1.2.0-rc.1) too", value: !!rule?.prerelease, off: (v) => !words(v[`t${i}`] ?? "").length },
    { name: `c${i}`, type: "check", label: "Only a clean working tree: refuse uncommitted changes", value: !!rule?.requireClean, off: (v) => !ruleOf(v, i) },
  ];
  dialog({
    title: "Git deploys",
    text: `Which branches or tags each environment of ${tilde(path)} deploys, in .landfall.json. A deploy of something else is refused. Empty: it deploys anything. Globs: * stays within a /, ** crosses it.`,
    fields: [
      ...envs.map((env, i) => ({
        legend: env ? `Environment ${env}` : envs.length > 1 ? "The project (no -E)" : "The project",
        fields: rowFor(i, rules[env], () => env),
      })),
      {
        legend: "Add an environment",
        collapsed: true,
        note: "A new environment in .landfall.json (lf git track -E <name>). Give it a site name with lf deploy -E <name> -n <site>.",
        fields: [
          {
            name: "newName",
            label: "Name",
            placeholder: "staging",
            check: (x: string) => x && (!ENVIRONMENT_NAME.test(x) ? "Lowercase letters, digits and dashes" : envs.includes(x) && `${x} is listed above`),
          },
          ...rowFor(ADD, undefined, () => ""),
        ],
      },
    ],
    ok: "Save",
    onOk: (v) => {
      const jobs: string[][] = [];
      envs.forEach((env, i) => {
        const next = ruleOf(v, i);
        if (!sameRule(next, hasRule(rules[env]) ? rules[env] : undefined)) jobs.push(trackArgv(env, next));
      });
      const add = v.newName?.trim();
      if (add) {
        const rule = ruleOf(v, ADD);
        if (!rule) return { field: `b${ADD}`, error: `Say what ${add} deploys: a branch or a tag` };
        jobs.push(trackArgv(add, rule));
      }
      if (!jobs.length) return;
      chain(path, jobs);
      if (add || envs.some((e, i) => !hasRule(rules[e]) && ruleOf(v, i))) goPipeline(path);
    },
  });
}
