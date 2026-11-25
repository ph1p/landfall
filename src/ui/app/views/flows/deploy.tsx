import { S, http, render, sv, tilde, errorMessage } from "../../lib/store";
import type { Browse } from "../../lib/types";
import { run, rep, type Job, type JobAction } from "../../lib/jobs";
import { toast } from "../../ui/toast";
import { dialog } from "../../ui/dialog";
import { DEPLOY_HOOKS } from "../../../../core/site/hook-names";
import { hookChoice } from "../hooks";
import { deployDialog } from "./deploy-dialog";

/** After a deploy: offer the address it printed. */
export function openAfter(j: Job): JobAction[] | undefined {
  if (j.info.code !== 0) return;
  const url = rep(j).url;
  if (url) return [{ label: `Open ${url.replace("https://", "")}`, run: () => void window.open(url, "_blank", "noopener") }];
}

export const browse = (path?: string) => http<Browse>(`/api/fs${path ? `?path=${encodeURIComponent(path)}` : ""}`);

/** What a site's folder holds and how it builds: detected once per folder, for the site details. Call from an effect. */
export function detected(path: string) {
  if (path in S.det) return;
  S.det[path] = null;
  browse(path).then(
    (x) => ((S.det[path] = x.detected), render()),
    () => ((S.det[path] = false), render()),
  );
}

/** Redeploy a folder with its saved settings (.landfall.json), after saying exactly what runs. */
export function redeploy(path: string, server: string, name: string, kind?: string, environment?: string) {
  const argv = ["deploy", "-y", ...sv(server), ...(environment ? ["-E", environment] : [])];
  // The folder's hooks, when the site details read them already.
  const choice = hookChoice(S.det[path] ? S.det[path].hooks?.run : undefined, DEPLOY_HOOKS, "deploy");
  dialog({
    title: `Redeploy ${name} to ${server}?`,
    text: `${kind === "static" ? "Runs its build here (if it has one), uploads" : "Uploads"} ${tilde(path)} with its saved settings and makes it the live release. The current release stays for Roll back.`,
    extra: (
      <code className="block mono text-sm px-3 py-2 rounded-md bg-hover wrap-anywhere">
        cd {tilde(path)} && lf {argv.join(" ")}
      </code>
    ),
    fields: choice.fields,
    ok: "Redeploy",
    onOk: (v) => run([...argv, ...choice.skip(v)], { server, cwd: path, after: openAfter }),
  });
}

/** Detect the project in path, then open the deploy dialog for it. */
export function deployFrom(path: string, server?: string) {
  browse(path).then(
    (x) => deployDialog(x.detected, { server }),
    (e) => toast(errorMessage(e)),
  );
}

export const deployHere = () => deployFrom(S.state.cwd);
