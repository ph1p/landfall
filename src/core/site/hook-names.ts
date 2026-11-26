/** The lifecycle hooks, in the order they run. No node: imports, the web page reads them too. */
export const LOCAL_HOOKS = ["prebuild", "postbuild", "predeploy", "onfailure"] as const;
export const SERVER_HOOKS = ["release", "verify", "postdeploy", "prerollback", "postrollback", "predestroy"] as const;
export const HOOKS = [...LOCAL_HOOKS, ...SERVER_HOOKS] as const;
export type LocalHook = (typeof LOCAL_HOOKS)[number];
export type ServerHook = (typeof SERVER_HOOKS)[number];
export type Hook = (typeof HOOKS)[number];

/** What a deploy runs: everything but the rollback and removal hooks. */
export const DEPLOY_HOOKS: readonly Hook[] = [...LOCAL_HOOKS, "release", "verify", "postdeploy"];
export const ROLLBACK_HOOKS: readonly Hook[] = ["prerollback", "postrollback"];
export const isLocalHook = (h: Hook) => (LOCAL_HOOKS as readonly string[]).includes(h);

/**
 * Where a project's hooks come from, told apart by the package manager: package.json's are npm scripts run with
 * it, .landfall.json's are shell commands. `what` says entries as the output shows them. Kept free of node: the web
 * page uses it; hooks.ts adds how each kind runs.
 */
export function hookSource(pm: string | undefined) {
  return pm
    ? { file: "package.json", key: "landfall.hooks", serviceKey: "landfall.service", what: (entries: readonly string[]) => `${pm} run ${entries.join(", ")}` }
    : { file: ".landfall.json", key: "hooks", serviceKey: "hookService", what: (entries: readonly string[]) => entries.join("; ") };
}

/** When each hook runs, as the docs and the web page say it. */
export const HOOK_WHEN: Record<Hook, string> = {
  prebuild: "before the build",
  postbuild: "after the build",
  predeploy: "before the upload",
  onfailure: "when the deploy fails",
  release: "before the new release starts",
  verify: "once it runs, before it goes live",
  postdeploy: "after it went live",
  prerollback: "before a rollback leaves the release",
  postrollback: "after a rollback reached the release",
  predestroy: "before the site is removed",
};
