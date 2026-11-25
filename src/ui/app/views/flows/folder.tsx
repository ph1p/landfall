import { S, tilde, errorMessage } from "../../lib/store";
import type { Browse, Redeploy } from "../../lib/types";
import { toast } from "../../ui/toast";
import { Btn, cx } from "../../ui/kit";
import { openDialog, closeDialog, DFORM, DTITLE, DTEXT, DBTNS } from "../../ui/dialog";
import { Stack, Describe, DETECTED } from "./describe";
import { deployDialog } from "./deploy-dialog";
import { deployImage, deployRepo } from "./sources";
import { browse, deployFrom } from "./deploy";
import { skipped, upload } from "./drops";

export const ROW =
  "flex gap-2.5 items-baseline border-0 rounded-none shadow-none font-normal border-b border-line last:border-b-0 text-left bg-transparent px-3 py-[7px] min-w-0 hover:bg-hover";

export const LIST = "grid border border-line rounded-md max-h-[260px] overflow-auto";

const PICK = "inline text-accent cursor-pointer text-md font-normal";

/**
 * Pick a folder on this machine: recent projects, a folder browser, or drop/choose files to upload.
 * site: an existing site the folder redeploys (one this machine does not remember a folder for).
 */
export async function folderDialog(path?: string, site?: Redeploy, server?: string) {
  let b: Browse;
  try {
    b = await browse(path);
  } catch (e) {
    return toast(errorMessage(e));
  }
  // Files dropped while it is open redeploy the site too.
  openDialog(<FolderDialog b={b} site={site} server={server} />, "wide", site);
}

function FolderDialog({ b, site, server }: { b: Browse; site?: Redeploy; server?: string }) {
  const recent = site ? [] : (S.state.projects ?? []).slice(0, 8);
  const parts = b.path.split("/").filter(Boolean);
  const to = (p: string) => () => void folderDialog(p, site, server);
  const crumb = "px-1.5! py-px!";
  return (
    <form method="dialog" className={DFORM} onSubmit={(e) => (e.preventDefault(), deployDialog(b.detected, { site, server }))}>
      <h2 id="dlg-title" className={DTITLE}>
        {site ? `Redeploy ${site.name}` : "Deploy a folder"}
      </h2>
      {site && (
        <div className={DTEXT}>
          This machine does not know which folder {site.name} on {site.server} was deployed from. Pick it: this machine remembers it, so the next redeploy is
          one click. Dropped files are not remembered.
        </div>
      )}
      {recent.length > 0 && (
        <fieldset>
          <legend>Recent</legend>
          <div className={LIST}>
            {recent.map((r) => (
              <button key={r.path} type="button" className={ROW} title="Deploy again" onClick={() => deployFrom(r.path, server)}>
                <b>{r.name}</b>
                <span className="dim">
                  → {r.server}
                  {r.domains[0] ? ` · ${r.domains[0]}` : ""}
                </span>
                <span className="faint mono ml-auto overflow-hidden text-ellipsis">{tilde(r.path)}</span>
              </button>
            ))}
          </div>
        </fieldset>
      )}
      <div className="flex flex-wrap gap-0.5 items-center mono">
        <Btn cls={cx("ghost sm", crumb)} on={to("/")}>
          /
        </Btn>
        {parts.map((x, i) => [
          i > 0 && (
            <span key={`s${i}`} className="faint">
              /
            </span>
          ),
          <Btn key={i} cls={cx("ghost sm", crumb)} on={to("/" + parts.slice(0, i + 1).join("/"))}>
            {x}
          </Btn>,
        ])}{" "}
        <Btn cls={cx("ghost sm", crumb)} on={to(b.home)} title="Home">
          ~
        </Btn>
      </div>
      <div className={LIST}>
        {b.parent && (
          <button type="button" className={ROW} onClick={to(b.parent)}>
            ↑ ..
          </button>
        )}
        {b.dirs.length ? (
          b.dirs.map((d) => (
            <button key={d} type="button" className={ROW} onClick={to(b.path.replace(/\/$/, "") + "/" + d)}>
              📁 {d}
            </button>
          ))
        ) : (
          <div className={cx(ROW, "faint hover:bg-transparent")}>no subfolders</div>
        )}
      </div>
      <div className={DETECTED}>
        <Stack d={b.detected} className="mb-2" />
        <b>{b.detected.name}</b>: <Describe d={b.detected} />
      </div>
      <div className="border-[1.5px] border-dashed border-line-strong rounded-md p-3.5 text-center text-dim text-md">
        Or drop a folder or .zip anywhere ·{" "}
        <label className={PICK}>
          choose a folder
          <input
            type="file"
            hidden
            multiple
            // a spread, so it type-checks whether or not React's types know webkitdirectory
            {...{ webkitdirectory: "" }}
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              upload(
                files.filter((f) => !skipped(f.webkitRelativePath)).map((f) => [f, f.webkitRelativePath || f.name]),
                files[0]?.webkitRelativePath.split("/")[0],
                site,
              );
            }}
          />
        </label>{" "}
        ·{" "}
        <label className={PICK}>
          choose a .zip
          <input
            type="file"
            hidden
            accept=".zip,.tar,.tgz,.gz"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) upload([[f, f.name]], f.name, site);
            }}
          />
        </label>{" "}
        ·{" "}
        <button
          type="button"
          className={cx(PICK, "border-0 bg-transparent p-0 shadow-none")}
          title="Run an image from a registry or this machine's Docker (lf deploy --image)"
          onClick={() => deployImage(site)}
        >
          a Docker image
        </button>{" "}
        ·{" "}
        <button
          type="button"
          className={cx(PICK, "border-0 bg-transparent p-0 shadow-none")}
          title="The server fetches a branch or tag itself (lf deploy --git)"
          onClick={() => deployRepo(site && { name: site.name, server: site.server })}
        >
          a git repository
        </button>
      </div>
      <div className={DBTNS}>
        <Btn cls="ghost" id="dlg-cancel" on={closeDialog}>
          Cancel
        </Btn>
        <Btn type="submit" cls="primary" title="Check its settings, then deploy">
          Next
        </Btn>
      </div>
    </form>
  );
}
