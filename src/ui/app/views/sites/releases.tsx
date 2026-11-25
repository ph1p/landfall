import { S, ago, render, sv } from "../../lib/store";
import type { Release, SiteStatus } from "../../lib/types";
import { run } from "../../lib/jobs";
import { Badge, Btn } from "../../ui/kit";
import { confirmDlg } from "../../ui/dialog";
import { definedHooks } from "../hooks";
import { LIST, MORE, RELEASES, ROW, Panel } from "./panel";
import { rollbackDialog } from "./actions";
import { gitParts } from "../../../../core/deploy/refs";
import { CommitLink, CiLink } from "../pipeline/links";

/** A release's commit: its tag or commit, linked to the forge, how it was taken, the CI run, and uncommitted changes. */
export function ReleaseGitLine({ g, by }: { g: NonNullable<Release["git"]>; by?: string }) {
  const p = gitParts(g, 7);
  return (
    <span title={[by && `deployed by ${by}`, g.sha ?? g.commit, g.branch && `branch ${g.branch}`].filter(Boolean).join(" · ") || undefined}>
      {" · "}
      <CommitLink url={g.remote} sha={g.sha ?? g.commit} text={p.name} />
      {p.beside && <span className="mono"> {p.beside}</span>}
      {p.dirty && (
        <span className="text-bad" title="Deployed with uncommitted changes">
          {" "}
          dirty
        </span>
      )}
      {p.source && <> · {p.source}</>}
      <CiLink g={g} />
    </span>
  );
}

/** An open site's releases, newest first: switch to one, or delete those that are not live. */
export function SiteReleases({ n, site }: { n: string; site: SiteStatus }) {
  const m = site.meta;
  const name = m.name;
  const managed = !m.adopted;
  const byDate = [...m.releases].sort((a, b) => (a.at < b.at ? 1 : -1));
  // The newest releases; the rest unfold, remembered in S.open.
  const relKey = `rel:${n}/${name}`;
  const allRel = S.open.has(relKey) || byDate.length <= RELEASES + 1;
  const rels = allRel ? byDate : byDate.slice(0, RELEASES);
  const relRows = rels.map((r) => (
    <li key={r.id} className={ROW}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="mono">{r.id}</span>
          {r.id === m.current && <Badge kind="ok">live</Badge>}
        </div>
        <div className="faint text-sm truncate">
          {ago(r.at)}
          {r.services && ` · ${r.services.map((x) => x.name).join(", ")}`}
          {r.hooks && ` · hooks ${definedHooks(r.hooks.run).join(", ")}`}
          {r.git && <ReleaseGitLine g={r.git} by={r.by} />}
          {r.landfall && ` · landfall ${r.landfall}`}
        </div>
      </div>
      {r.id !== m.current && managed && (
        <Btn
          cls="sm shrink-0"
          on={() =>
            rollbackDialog(n, site, {
              to: r,
              argv: ["--to", r.id],
              title: `Switch ${name} to ${r.id}?`,
              text: `Release from ${ago(r.at)} goes live instead of ${m.current}. Volumes keep their data.`,
              ok: "Switch",
            })
          }
        >
          Switch to this
        </Btn>
      )}
      {r.id !== m.current && managed && (
        <Btn
          cls="sm ghost shrink-0"
          title="lf release rm: delete its folder and images"
          on={() =>
            confirmDlg({
              title: `Delete release ${r.id} of ${name}?`,
              text: `Its folder and the images built for it go: Roll back can no longer return to it.\nThis cannot be undone.`,
              ok: "Delete",
              danger: true,
              onOk: () => run(["release", "rm", name, r.id, ...sv(n), "-y"]),
            })
          }
        >
          Delete
        </Btn>
      )}
    </li>
  ));
  const stale = byDate.filter((r) => r.id !== m.current);
  return (
    <Panel
      title="Releases"
      count={m.releases.length}
      aside={
        managed &&
        stale.length > 1 && (
          <Btn
            cls="sm ghost"
            title="lf release rm: delete every release but the live one"
            on={() =>
              confirmDlg({
                title: `Delete ${stale.length} old releases of ${name}?`,
                text: `All but the live one (${m.current}) go, with the images built for them: Roll back has nothing left to return to.\nThis cannot be undone.`,
                ok: "Delete",
                danger: true,
                onOk: () => run(["release", "rm", name, ...sv(n), "-y"]),
              })
            }
          >
            Delete old
          </Btn>
        )
      }
    >
      <ul className={LIST}>
        {relRows}
        {byDate.length > RELEASES + 1 && (
          <li>
            <button type="button" className={MORE} aria-expanded={allRel} onClick={() => (allRel ? S.open.delete(relKey) : S.open.add(relKey), render())}>
              {allRel ? "Show fewer" : `Show ${byDate.length - rels.length} older`}
            </button>
          </li>
        )}
      </ul>
    </Panel>
  );
}
