import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { S, ago, errorMessage, http, sv, tilde } from "../../lib/store";
import type { Volumes } from "../../lib/types";
import { ifOk, run } from "../../lib/jobs";
import { Badge, Btn } from "../../ui/kit";
import { MenuBtn } from "../../ui/menu";
import { confirmDlg, dialog, type Values } from "../../ui/dialog";
import { DEPLOY_HOOKS } from "../../../../core/site/hook-names";
import { hookChoice } from "../hooks";
import { size } from "../shared";
import { LIST, ROW, SIDE, Panel } from "./panel";

/** The project folder this machine deploys the site from: where lf volume add/rm edit its compose.yaml or .landfall.json. */
interface VolumeEdit {
  path: string;
  kind: string;
  environment?: string;
  services: string[];
}

/** The site's Docker volumes and their backups (lf volumes), read when the row opens. */
export function SiteVolumes({ n, name, dir, edit }: { n: string; name: string; dir?: string; edit?: VolumeEdit }) {
  const [d, setD] = useState<Volumes | null>(null);
  const [err, setErr] = useState("");
  // The list first, then the sizes: du reads every file, which takes a while on a big database.
  const gen = useRef(0);
  const load = useCallback(() => {
    const url = (sizes: 0 | 1) => `/api/servers/${encodeURIComponent(n)}/volumes?site=${encodeURIComponent(name)}&sizes=${sizes}`;
    const g = ++gen.current;
    const fresh = () => g === gen.current;
    return http<Volumes>(url(0)).then(
      (x) =>
        fresh() &&
        (setD(x),
        setErr(""),
        http<Volumes>(url(1)).then(
          (y) => fresh() && setD(y),
          () => {},
        )),
      (e) => fresh() && setErr(errorMessage(e)),
    );
  }, [n, name]);
  useEffect(() => void load(), [load]);
  const box = (body: ReactNode, aside: ReactNode = addBtn) => (
    <Panel title="Volumes" count={d?.volumes.length || undefined} aside={aside}>
      {body}
    </Panel>
  );
  const compose = edit?.kind === "compose";
  const env = edit?.environment ? ["-E", edit.environment] : [];
  const where = compose ? "compose.yaml" : ".landfall.json";
  // The folder's deploy hooks, when the site details read them already: the redeploy below runs them.
  const det = edit && S.det[edit.path];
  const hooks = hookChoice(det ? det.hooks?.run : undefined, DEPLOY_HOOKS, "deploy");
  const hookFields = hooks.fields.map((g) => ({ ...g, when: (v: Values) => v.deploy }));
  // Edits the project folder, then (if asked) redeploys from it so the server follows and reads the volumes again.
  const then = (v: Values, next = load) =>
    ifOk(() => v.deploy && edit && run(["deploy", "-y", ...sv(n), ...env, ...hooks.skip(v)], { server: n, cwd: edit.path, after: ifOk(next) }));
  const add =
    edit &&
    (() =>
      dialog({
        title: `Keep a folder of ${name}`,
        text: `A named volume keeps a folder of the container across deploys and rollbacks. It goes into ${where} in ${tilde(edit.path)}, plain ${compose ? "Compose" : "landfall settings"}; a redeploy applies it.`,
        fields: [
          ...(compose && edit.services.length > 1
            ? [
                {
                  name: "service",
                  type: "select" as const,
                  label: "Service",
                  value: edit.services[0],
                  options: edit.services.map((x) => ({ value: x, label: x })),
                },
              ]
            : []),
          {
            name: "path",
            label: "Folder in the container",
            placeholder: "/app/data",
            mono: true,
            required: true,
            check: (x) => (/^\/[\w./-]*\w/.test(String(x)) ? undefined : "An absolute folder, like /app/data"),
          },
          ...(compose
            ? [
                {
                  name: "as",
                  label: "Volume name",
                  placeholder: "from the folder: /app/data is app-data",
                  mono: true,
                  check: (x: unknown) => (!x || /^\w[\w.-]*$/.test(String(x)) ? undefined : "Letters, digits, ., _ and -"),
                },
              ]
            : []),
          { name: "deploy", type: "check", label: "Redeploy now to apply it", value: true },
          ...hookFields,
        ],
        ok: "Add volume",
        onOk: (v) => {
          const spec = compose && v.service ? `${v.service}:${v.path}` : String(v.path);
          run(["volume", "add", spec, ...(v.as ? ["--as", String(v.as)] : []), ...env], { server: n, cwd: edit.path, after: then(v) });
        },
      }));
  const addBtn = add && (
    <Btn cls="sm ghost" title={`Keep a folder of the container across deploys (lf volume add, in ${tilde(edit!.path)})`} on={add}>
      Add…
    </Btn>
  );
  if (err) return box(<p className="m-0 px-3 py-2.5 text-bad">{err}</p>);
  if (!d) return box(<p className="m-0 px-3 py-2.5 faint">reading its volumes…</p>);
  if (!d.volumes.length) return box(<p className="m-0 px-3 py-2.5 dim">none{add && ": Add… keeps a folder, like uploads or a database, across deploys"}</p>);
  // A backup belongs to the volume its name starts with: content-20261027-181500.tar.gz.
  const own = (key: string) => d.backups.filter((b) => b.file.startsWith(`${key}-`) && /^\d{8}-\d{6}/.test(b.file.slice(key.length + 1)));
  const restore = (key: string, list: Volumes["backups"]) =>
    dialog({
      title: `Restore ${key} of ${name}?`,
      text: "Replaces its contents with the backup; the services using it stop meanwhile. The current contents are backed up first: lf undo puts them back.",
      fields: [
        {
          name: "file",
          type: "select",
          label: "Backup",
          value: list[0].file,
          options: list.map((b) => ({ value: b.file, label: `${b.file} · ${size(b.size)} · ${ago(b.time)}` })),
        },
      ],
      ok: "Restore",
      danger: true,
      onOk: (v) => run(["volume", "restore", name, key, v.file, ...sv(n), "-y"], { after: ifOk(load) }),
    });
  const forget = (key: string, list: Volumes["backups"]) =>
    dialog({
      title: `Delete a backup of ${key}?`,
      text: "Deletes the file from the site's backups folder. This cannot be undone.",
      fields: [
        {
          name: "file",
          type: "select",
          label: "Backup",
          value: list.at(-1)!.file,
          options: list.map((b) => ({ value: b.file, label: `${b.file} · ${size(b.size)} · ${ago(b.time)}` })),
        },
      ],
      ok: "Delete",
      danger: true,
      onOk: (v) => run(["volume", "backup", "rm", name, v.file, ...sv(n), "-y"], { after: ifOk(load) }),
    });
  // The UI runs lf from its own folder: suggest absolute paths, next to the project when this machine deploys it.
  const near = (x: string) => (dir ? `${dir.replace(/\/$/, "")}/${x}` : `~/${x}`);
  const push = (v: Volumes["volumes"][number]) =>
    dialog({
      title: `Push into ${v.key} of ${name}?`,
      text: "Replaces its contents with a folder or .tar.gz from this machine; the services using it stop meanwhile. The current contents are backed up first: lf undo puts them back.",
      fields: [{ name: "path", label: "Folder or .tar.gz", value: near(v.key), mono: true, hint: `lf volume push ${name} ${v.key} <path>` }],
      ok: "Push",
      danger: true,
      onOk: (x) => run(["volume", "push", name, v.key, x.path, ...sv(n), "-y"], { after: ifOk(load) }),
    });
  const pull = (v: Volumes["volumes"][number]) =>
    dialog({
      title: `Pull ${v.key} of ${name}`,
      text: "Unpacks its contents into a folder on this machine; the services keep running. Files already there with the same names are overwritten.",
      fields: [{ name: "into", label: "Into folder", value: near(v.key), mono: true, hint: `lf volume pull ${name} ${v.key} --into <folder>` }],
      ok: "Pull",
      onOk: (x) => run(["volume", "pull", name, v.key, "--into", x.into, ...sv(n)]),
    });
  const schedule = () =>
    dialog({
      title: `Scheduled backups of ${name}`,
      text: "Every volume, from the login user's crontab on the server (backups/backup.sh). lf undo puts back the schedule before.",
      fields: [
        {
          name: "every",
          type: "select",
          label: "Every",
          value: /^(\w+),/.exec(d.schedule ?? "")?.[1] ?? "daily",
          options: ["hourly", "daily", "weekly", "off"].map((x) => ({ value: x, label: x })),
        },
        {
          name: "keep",
          label: "Keep per volume",
          value: /keep (\d+)/.exec(d.schedule ?? "")?.[1] ?? "7",
          check: (x, all) => all.every !== "off" && (!/^\d+$/.test(String(x).trim()) || +x < 1 || +x > 1000) && "A number from 1 to 1000",
        },
        {
          name: "offsite",
          label: "Also copy to (optional)",
          value: /offsite (\S+)/.exec(d.schedule ?? "")?.[1] ?? "",
          mono: true,
          hint: "[user@]host:path: rsync over ssh mirrors the backups there. The server's login user needs an ssh key that host accepts.",
        },
      ],
      ok: "Save",
      onOk: (v) =>
        run(
          [
            "volume",
            "backup",
            name,
            "--schedule",
            v.every,
            ...(v.every === "off" ? [] : ["--keep", String(v.keep).trim(), ...(v.offsite.trim() ? ["--offsite", v.offsite.trim()] : [])]),
            ...sv(n),
          ],
          { after: ifOk(load) },
        ),
    });
  // Unmount from the project; the data stays unless asked, and goes only once the redeploy freed it.
  const remove =
    edit &&
    ((v: Volumes["volumes"][number]) =>
      dialog({
        title: `Remove ${v.key} from ${name}?`,
        text: `Takes its mounts out of ${where} in ${tilde(edit.path)}; a redeploy applies it. Its data stays on the server, listed as unused, unless you delete it too.`,
        fields: [
          { name: "deploy", type: "check", label: "Redeploy now to apply it", value: true },
          {
            name: "data",
            type: "check",
            label: "Then delete its data on the server",
            value: false,
            off: (x) => !x.deploy,
            hint: "Backed up to the site's backups folder first: lf undo brings it back.",
          },
          ...hookFields,
        ],
        ok: "Remove",
        danger: true,
        onOk: (x) =>
          run(["volume", "rm", v.key, ...env], {
            server: n,
            cwd: edit.path,
            after: then(
              x,
              x.data ? () => run(["volume", "rm", name, v.key, "--data", ...sv(n), "-y", ...env], { server: n, cwd: edit.path, after: ifOk(load) }) : undefined,
            ),
          }),
      }));
  // No container mounts it: left over from a removed mount or an old release.
  const drop = (v: Volumes["volumes"][number]) =>
    confirmDlg({
      title: `Delete volume ${v.key} of ${name}?`,
      text: "No container uses it. Its contents are saved to the site's backups folder first; lf undo brings the volume back.",
      ok: "Delete",
      danger: true,
      onOk: () => run(["volume", "rm", name, v.key, "--data", ...sv(n), "-y"], { after: ifOk(load) }),
    });
  // Scheduled backups cover every volume: they sit in the box's title.
  const timer = (
    <>
      <span className="faint text-sm">{d.schedule ? `backups ${d.schedule}` : "no scheduled backups"}</span>
      {d.lastRun?.failed.length ? (
        <Badge kind="bad" title="backups/backup.log on the server">
          last backup failed: {d.lastRun.failed.join(", ")}
        </Badge>
      ) : null}
      <Btn cls="sm ghost" title={`Back up every volume on a timer (lf volume backup ${name} --schedule daily)`} on={schedule}>
        Schedule…
      </Btn>
      {addBtn}
    </>
  );
  return box(
    <ul className={LIST}>
      {d.volumes.map((v) => {
        const baks = own(v.key);
        return (
          <li key={v.name} className={ROW}>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <b>{v.key}</b>
                {v.empty ? (
                  <span className="text-warn text-sm" title={`No files yet: fill it with Push… (lf volume push ${name} ${v.key} <folder>)`}>
                    empty
                  </span>
                ) : (
                  v.size !== undefined && <span className="dim text-sm">{size(v.size)}</span>
                )}
                {!v.mounts.length && (
                  <span className="text-warn text-sm" title={`No container mounts it: Delete… removes it (lf volume rm ${name} ${v.key} --data)`}>
                    unused
                  </span>
                )}
                <span className="faint text-sm">
                  {baks.length ? `${baks.length} backup${baks.length === 1 ? "" : "s"}, newest ${ago(baks[0].time)}` : "no backups"}
                </span>
              </div>
              {v.mounts.length > 0 && <div className="faint text-sm mono truncate">{v.mounts.map((x) => `${x.service}:${x.path}`).join(" · ")}</div>}
              {v.dir && (
                <div className="faint text-sm mono truncate" title="Its files on the server, in the site's folder">
                  {v.dir}
                </div>
              )}
            </div>
            {/* An empty volume wants filling; a full one backing up. The rest is under More. */}
            <span className={SIDE}>
              {v.empty ? (
                <Btn cls="sm" title={`Replace its contents with a folder from this machine (lf volume push ${name} ${v.key})`} on={() => push(v)}>
                  Push…
                </Btn>
              ) : (
                <Btn
                  cls="sm"
                  title={`Save it as a .tar.gz in the site's backups folder; the services keep running, a database using it pauses while it is copied (lf volume backup ${name} ${v.key})`}
                  on={() => run(["volume", "backup", name, v.key, ...sv(n)], { after: ifOk(load) })}
                >
                  Back up
                </Btn>
              )}
              <MenuBtn
                title={`More for volume ${v.key}`}
                cls="sm ghost"
                items={[
                  baks.length > 0 && {
                    label: "Restore…",
                    hint: "lf volume restore",
                    title: "Replace its contents with a backup",
                    run: () => restore(v.key, baks),
                  },
                  !v.empty && { label: "Push…", hint: "lf volume push", title: "Replace its contents with a folder from this machine", run: () => push(v) },
                  !v.empty && { label: "Pull…", hint: "lf volume pull", title: "Unpack it into a folder on this machine", run: () => pull(v) },
                  "-",
                  baks.length > 0 && {
                    label: "Delete a backup…",
                    hint: "lf volume backup rm",
                    title: "Delete one of its backups (oldest preselected)",
                    cls: "danger",
                    run: () => forget(v.key, baks),
                  },
                  remove &&
                    v.mounts.length > 0 && {
                      label: "Remove…",
                      hint: "lf volume rm",
                      title: `Unmount it in ${where}, optionally delete its data`,
                      cls: "danger",
                      run: () => remove(v),
                    },
                  !v.mounts.length && {
                    label: "Delete…",
                    hint: "lf volume rm --data",
                    title: "Delete the unused volume (backed up first)",
                    cls: "danger",
                    run: () => drop(v),
                  },
                ]}
              />
            </span>
          </li>
        );
      })}
    </ul>,
    timer,
  );
}
