import type { ReactNode } from "react";
import { plural } from "../../lib/store";
import type { Detected, GitInfo } from "../../lib/types";
import { Badge, cx } from "../../ui/kit";
import { DEPLOY_HOOKS } from "../../../../core/site/hook-names";
import { HookList } from "../hooks";

/** What landfall found in a folder and how it deploys it. */
const ROLE: Record<string, string> = { language: "Language", framework: "Framework", tooling: "Package manager or build tool" };

/** The languages, framework and tools landfall found in a folder, as chips: what it builds with at a glance. */
export function Stack({ d, className }: { d: Detected; className?: string }) {
  if (!d.stack?.length) return null;
  return (
    <div className={cx("flex flex-wrap gap-1.5", className)} aria-label="Detected">
      {d.stack.map((t) => (
        <Badge key={t.label} kind={t.role === "tooling" ? "" : "accent"} className={t.role === "framework" ? "font-semibold" : undefined} title={ROLE[t.role]}>
          {t.label}
        </Badge>
      ))}
    </div>
  );
}

/** plan: a compose project's services too (DeployAside shows them on their own). */
export function Describe({ d, before = true, plan = true }: { d: Detected; before?: boolean; plan?: boolean }) {
  const built = d.build ? (
    <>
      {" "}
      · builds with <code>{d.build}</code> first
    </>
  ) : null;
  const what: ReactNode =
    d.kind === "compose" ? (
      <>
        Compose project <code>{d.compose ?? "compose.yaml"}</code>: built and started on the server;{" "}
        {d.analysis?.auto ? "no x-landfall, so its HTTP ports are routed" : "x-landfall picks the routed services"}
        {plan && <ComposePlan a={d.analysis} />}
      </>
    ) : d.kind === "image" ? (
      d.project?.image ? (
        <>
          Docker image <code>{d.project.image}</code> (from .landfall.json)
        </>
      ) : (
        "Docker image: the server pulls it, or this machine sends it. Nothing is built."
      )
    ) : d.kind === "dockerfile" && d.start ? (
      <>
        {d.runtime} app{d.tool ? ` (${d.tool})` : ""}: built on the server
        {d.build ? (
          <>
            {" "}
            with <code>{d.build}</code>
          </>
        ) : (
          ""
        )}
        , started with <code>{d.start}</code> on port {d.port}
        {d.note && (
          <>
            <br />
            <span className="text-warn">{d.note}</span>
          </>
        )}
      </>
    ) : d.kind === "dockerfile" ? (
      `Dockerfile: built on the server, served on port ${d.port}`
    ) : d.dir ? (
      <>
        Static files from <code>{d.dir === "." ? "./" : d.dir + "/"}</code>
        {d.tool ? ` (where ${d.tool} builds the site)` : ""}
        {d.project?.spa ? " (single-page app)" : ""}
        {built}
      </>
    ) : d.build ? (
      <>
        Static site, built with <code>{d.build}</code> first
      </>
    ) : (
      <span className="text-warn">No compose.yaml, Dockerfile, index.html or build script here.</span>
    );
  return (
    <>
      {what}
      {d.beside && (
        <>
          {" "}
          · with {d.beside.services.join(", ")} from <code>{d.beside.file}</code> beside it
        </>
      )}
      {before && d.project?.server ? (
        <>
          {" "}
          <span className="dim">
            · deployed before to {d.project.server}
            {d.project.domains?.length ? ` as ${d.project.domains.join(", ")}` : ""}
          </span>
        </>
      ) : null}
    </>
  );
}

/** A compose project's services as a deploy would run them: what each is built from, port to domains, private ports, volumes, problems. */
function ComposePlan({ a }: { a?: Detected["analysis"] }) {
  if (!a) return null;
  return (
    <span className="block mt-1.5">
      {(a.services ?? []).map((s) => {
        const about = a.about?.[s.name];
        const routes = (a.routes ?? []).filter((r) => r.service === s.name || r.members?.includes(s.name));
        const priv = Object.entries(s.private ?? {});
        return (
          <span key={s.name} className="block">
            <code>{s.name}</code> <span className="dim">{about?.build !== undefined ? `built from ${about.build}` : (about?.image ?? "")}</span>
            {routes.map((r) => (
              <span key={`${r.port}:${r.domains[0]}`} className="block pl-4">
                <code>:{r.service === s.name ? r.port : s.port}</code>{" "}
                <span className="dim">
                  → {r.domains.join(", ")}
                  {r.members && ` · split with ${r.members.filter((m) => m !== s.name).join(", ")}`}
                </span>
              </span>
            ))}
            {priv.map(([k, p]) => (
              <span key={k} className="block pl-4">
                <code>
                  :{p}
                  {s.paths?.[k] ?? ""}
                </code>{" "}
                <span className="dim">
                  private, <code>lf tunnel … {k}</code>
                </span>
              </span>
            ))}
            {!routes.length && !priv.length && (
              <span className="block pl-4 dim">{s.own ? "routed by its own traefik labels" : "no port reached from outside"}</span>
            )}
            {about?.volumes?.length ? <span className="block pl-4 dim">volumes: {about.volumes.join(", ")}</span> : null}
          </span>
        );
      })}
      {[...(a.errors ?? []), ...(a.warnings ?? [])].map((e) => (
        <span key={e} className="block text-warn">
          {e}
        </span>
      ))}
      {a.notes?.map((n) => (
        <span key={n} className="block dim">
          {n}
        </span>
      ))}
    </span>
  );
}

export const DETECTED = "text-md px-3 py-2.5 rounded-md bg-hover";

const ASIDE_HEAD = "m-0 mb-1.5 text-sm font-semibold text-dim";

/** The images a deploy pulls, so it is plain what runs: as they are, or as the base a build starts from. */
export function UsedImages({ d }: { d: Detected }) {
  if (!d.images?.length) return null;
  return (
    <ul className="m-0 p-0 list-none grid gap-1">
      {d.images.map((i) => (
        <li key={`${i.service} ${i.ref}`} className="min-w-0">
          <code className="break-all">{i.ref}</code> <span className="dim">{i.base ? `base of ${i.service}` : i.service}</span>
        </li>
      ))}
    </ul>
  );
}

/** The deploy dialog's right column: what landfall found, the services it runs and the images it pulls. */
export function DeployAside({ d, g }: { d: Detected; g?: GitInfo }) {
  const repo = g?.repo;
  return (
    <>
      <div>
        <Stack d={d} className="mb-2" />
        <Describe d={d} plan={false} />
      </div>
      {repo && (
        <div>
          <h3 className={ASIDE_HEAD}>Git</h3>
          <p className="m-0">
            <span className="font-mono text-sm">{repo.branch ?? "detached HEAD"}</span>{" "}
            <span className="font-mono text-sm text-faint">{repo.commit.slice(0, 7)}</span>
          </p>
          {repo.subject && <p className="m-0 text-dim wrap-anywhere">{repo.subject}</p>}
          <p className={cx("m-0", repo.dirty ? "text-bad" : "text-faint")}>
            {repo.dirty ? `${plural(repo.dirty, "file")} with uncommitted changes` : "No uncommitted changes"}
          </p>
        </div>
      )}
      {d.kind === "compose" && d.analysis ? (
        <div>
          <h3 className={ASIDE_HEAD}>Services</h3>
          <ComposePlan a={d.analysis} />
        </div>
      ) : null}
      {d.images?.length ? (
        <div>
          <h3 className={ASIDE_HEAD}>Images</h3>
          <UsedImages d={d} />
        </div>
      ) : null}
      {d.hooks || d.hooksError ? (
        <div>
          <h3 className={ASIDE_HEAD}>Hooks</h3>
          {d.hooks && <HookList hooks={d.hooks} only={DEPLOY_HOOKS} />}
          {d.hooksError && <p className="m-0 text-bad">{d.hooksError}</p>}
        </div>
      ) : null}
    </>
  );
}
