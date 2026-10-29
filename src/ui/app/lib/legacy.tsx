/**
 * Backwards compatibility in the web UI: sites and traefik set up by older landfall versions.
 * Goes with src/core/legacy.ts. Besides the imports, that leaves the `old` checks in views/sites.tsx
 * and Redeploy.old (lib/types.ts, views/flows.tsx).
 */
import { sv } from "./store";
import { run, type RunOpts } from "./jobs";
import { Btn, Note } from "../ui/kit";

/** A site deployed before sites were Compose projects: landfall shows it, but only a deploy manages it again. */
export const isOldSite = (state: string) => state === "old";

export function OldSiteNote({ redeploy }: { redeploy: boolean }) {
  return <Note>Deployed before sites were Compose projects: {redeploy ? "redeploy it" : <>run <span className="mono">lf deploy</span> for it</>} once to manage it again.</Note>;
}

/** Traefik set up before the dashboard tunnel: setup again adds it. */
export function OldTraefikTunnel({ n, opts }: { n: string; opts: RunOpts }) {
  return <><span className="dim">set up by an older landfall</span> <Btn cls="sm" title="Re-runs lf traefik setup, which adds it" on={() => run(["traefik", "setup", ...sv(n)], opts)}>Enable tunnel</Btn></>;
}
