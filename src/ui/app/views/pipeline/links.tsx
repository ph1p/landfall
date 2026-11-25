import { MONO } from "../../ui/kit";
import { commitUrl } from "../../../../core/deploy/refs";
import type { ReleaseGit } from "../../../../core/site/meta";
import { rulesEditor } from "./rules";

export const ext = { target: "_blank", rel: "noopener noreferrer" };

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
