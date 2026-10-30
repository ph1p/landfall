import { useEffect, useState, type ReactNode } from "react";
import { S, ago, errorMessage, http, render, sv, tilde } from "../lib/store";
import type { External, Overview, SiteMeta, SiteStatus, Volumes } from "../lib/types";
import { ifOk, run, TunnelBtn, tunnelFor } from "../lib/jobs";
import { go } from "../lib/api";
import { ACTS, Badge, Btn, BtnGroup, Card, CardHead, Empty, HIDE, Kv, Lede, MONO, NAME, SHOW, SR, cx, Icon, Table } from "../ui/kit";
import { MenuBtn } from "../ui/menu";
import { confirmDlg, dialog, siteNameError } from "../ui/dialog";
import { Describe, Stack, detected, folderDialog, redeploy, setupFlow } from "./flows";
import { DomainChip, ensureDns, siteSettings } from "./domains";
import { ErrorsCard } from "./traffic";
import { StatusDot, can, isUp, size, tunnelWays } from "./shared";
import { ChevronDown, ChevronRight, Lock } from "lucide-react";

const CHIPS = "flex flex-col gap-[3px] items-start";
const CHIP = "inline-flex items-center gap-0.5 max-w-full";
/** Rows in an open site's boxes: a line between each, actions on the right. */
const LIST = "list-none m-0 p-0 [&>li+li]:border-t [&>li+li]:border-line/60";
const ROW = "flex items-center gap-2.5 px-3 py-2 min-w-0";
const SIDE = "shrink-0 inline-flex items-center gap-1.5";
const MORE = "w-full border-0 rounded-none bg-transparent shadow-none px-3 py-1.5 text-left text-sm text-dim hover:text-fg hover:bg-hover";
/** Releases shown before Show older. */
const RELEASES = 3;
/** On a phone the container buttons show only their icons: the group cannot wrap, and their words widen every row. */
const TIGHT = "narrow:sr-only";

/** A part of an open site: a titled box, its actions right of the title. */
function Panel({ title, count, aside, children }: { title: string; count?: number; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="min-w-0 rounded-md border border-line bg-bg/60">
      <h4 className="m-0 flex min-h-10 items-center gap-2 border-b border-line px-3 py-1.5 text-sm font-semibold">
        {title}
        {count !== undefined && <span className="faint font-normal tabular-nums">{count}</span>}
        {aside && <span className="ml-auto inline-flex flex-wrap items-center justify-end gap-1.5 font-normal">{aside}</span>}
      </h4>
      {children}
    </section>
  );
}

export function SitesView({ n, o }: { n: string; o: Overview }) {
  useEffect(() => ensureDns(n, o));
  const k = can(n);
  if (!o.ready && k && !k.setup) {
    return (
      <Card>
        <Empty title="Not ready for sites">
          <p>{S.facts[n]?.data?.why?.setup ?? ""}, so landfall cannot set it up: sites need /opt/landfall and Traefik, which setup creates.</p>
        </Empty>
      </Card>
    );
  }
  if (!o.ready) {
    return (
      <Card>
        <Empty title="Not set up for landfall yet">
          <p>Setup installs Docker and Traefik, a deploy user and (if you want) a firewall. It shows what it would change first.</p>
          <p><Btn cls="primary" on={() => setupFlow([n])}>Check &amp; set up</Btn></p>
        </Empty>
      </Card>
    );
  }
  if (!o.sites.length) {
    return (
      <>
        <Card>
          <Empty title="No sites yet">
            <p>Deploy a folder with a compose.yaml, a Dockerfile, static files, or an image. It gets HTTPS automatically.</p>
            <p><Btn cls="primary" on={() => folderDialog(S.state.cwd)}>Choose a folder…</Btn> <span className="dim">or drop one here</span></p>
            <p className="faint mono">lf deploy ./dist -d example.com -s {n}</p>
          </Empty>
        </Card>
        <OthersCard n={n} o={o} />
      </>
    );
  }
  return (
    <>
      <Card>
        <Table head={<><th>Site</th><th className={HIDE}>Domains</th><th className={HIDE}>Kind</th><th className={HIDE}>Deployed</th><th><span className={SR}>Actions</span></th></>}>
          {o.sites.map((site) => <SiteRows key={site.meta.name} n={n} site={site} />)}
        </Table>
      </Card>
      <ErrorsCard n={n} />
      <OthersCard n={n} o={o} />
    </>
  );
}

function SiteRows({ n, site }: { n: string; site: SiteStatus }) {
  const { meta: m, status, services, domains, main, kind } = site;
  const cur = m.releases.find((r) => r.id === m.current);
  const name: string = m.name;
  const open = S.open.has(`${n}/${name}`);
  const up = isUp(status);
  // Adopted sites: landfall runs them, it does not deploy them.
  const managed = !m.adopted;
  const byDate = [...m.releases].sort((a, b) => (a.at < b.at ? 1 : -1));
  const older = byDate.filter((r) => r.at < (cur?.at ?? ""));
  const proj = (S.state.projects ?? []).find((p) => p.server === n && p.name === name);
  const deploys = proj && !m.adopted;
  useEffect(() => {
    if (open && deploys) detected(proj.path);
  });
  const deleteSite = () =>
    dialog({
      title: m.adopted ? `Stop and forget ${name}?` : `Delete ${name} from ${n}?`,
      text: m.adopted
        ? `Runs docker compose down in ${m.adopted}; its files and volumes stay.`
        : "Stops it and removes its files and releases. Its named volumes (databases, uploads) stay unless you delete them too.\nIts files and releases cannot be brought back.",
      fields: m.adopted ? [] : [{ name: "volumes", type: "check", label: "Also delete its volumes", hint: "Databases, uploads: all its data. Each is backed up to the site's backups folder first; lf undo brings them back. lf sites rm --volumes" }],
      ok: m.adopted ? `Forget ${name}` : `Delete ${name}`,
      danger: true,
      typeToConfirm: m.adopted ? "" : name,
      onOk: (v) => run(["sites", "rm", name, ...sv(n), "-y", ...(v.volumes ? ["--volumes"] : [])]),
    });
  const many = services.length > 1;
  const ways = tunnelWays(n, site);
  const svcWays = (svc: string) => ways.filter((w) => w.svc === svc);
  const svcMenu = (x: SiteStatus["services"][number]) => (
    <MenuBtn
      title={`${x.service} of ${name}`}
      cls="sm ghost"
      items={[
        { label: "Logs", hint: `lf logs ${name} ${x.service}`, run: () => run(["logs", name, x.service, ...sv(n), "-f"]) },
        { label: "Restart", hint: "lf restart", run: () => run(["restart", name, x.service, ...sv(n)]) },
        isUp(x.status)
          ? { label: "Stop", hint: "lf stop", run: () => confirmDlg({ title: `Stop ${x.service} of ${name}?`, text: "It stays stopped until you start it again.", ok: "Stop it", danger: true, onOk: () => run(["stop", name, x.service, ...sv(n)]) }) }
          : { label: "Start", hint: "lf start", run: () => run(["start", name, x.service, ...sv(n)]) },
      ]}
    />
  );
  const edit = () => siteSettings(n, site);
  const stop = () => confirmDlg({ title: `Stop ${name}?`, text: `${domains.join(", ") || "The site"} stops answering until you start it again.`, ok: "Stop it", danger: true, onOk: () => run(["stop", name, ...sv(n)]) });
  // The everyday actions sit in the row, each titled with the command it runs; the rest is under More.
  const acts = (
    <div className="inline-flex flex-wrap items-center justify-end gap-1.5 [&>button]:ml-0!">
      {deploys ? (
        <Btn cls="sm primary" title={`Build and upload ${tilde(proj.path)} again, then switch to it (lf deploy)`} on={() => redeploy(proj.path, n, name, proj.kind, proj.environment)}><Icon name="deploy" />Redeploy</Btn>
      ) : m.adopted || m.kind === "image" ? null : (
        <Btn cls="sm" title="Pick the folder it was deployed from" on={() => folderDialog(S.state.cwd, { server: n, name, domains: m.domains })}><Icon name="deploy" />Redeploy</Btn>
      )}
      {(main || managed || deploys) && <Btn cls="sm" title="Domains, login, environment and how it builds (lf domains, lf auth, lf env, lf deploy)" on={edit}><Icon name="edit" />Edit</Btn>}
      <BtnGroup label={`Containers of ${name}`}>
        <Btn cls="sm" title={`Follow the logs of all its services (lf logs ${name} -f)`} on={() => run(["logs", name, ...sv(n), "-f"])}><Icon name="logs" /><span className={TIGHT}>Logs</span></Btn>
        <Btn cls="sm" title={`Restart its containers, a moment offline (lf restart ${name})`} on={() => run(["restart", name, ...sv(n)])}><Icon name="restart" /><span className={TIGHT}>Restart</span></Btn>
        {up
          ? <Btn cls="sm hover:text-bad" title={`Stop its containers (lf stop ${name})`} on={stop}><Icon name="stop" /><span className={TIGHT}>Stop</span></Btn>
          : <Btn cls="sm" title={`Start its containers (lf start ${name})`} on={() => run(["start", name, ...sv(n)])}><Icon name="start" /><span className={TIGHT}>Start</span></Btn>}
      </BtnGroup>
      <MenuBtn
        title={`More for ${name}`}
        cls="sm ghost"
        items={[
          managed && older.length > 0 && {
            label: "Roll back",
            hint: "lf rollback",
            title: `To ${older[0].id} (${ago(older[0].at)})`,
            run: () => confirmDlg({ title: `Roll back ${name}?`, text: `From ${m.current} to ${older[0].id} (${ago(older[0].at)}). Volumes keep their data.`, ok: "Roll back", onOk: () => run(["rollback", name, ...sv(n), "-y"]) }),
          },
          "-",
          domains.length > 0 && { label: "Check now", hint: "lf check", title: `Request ${domains.join(", ")} over HTTPS from this machine: status, time, certificate`, run: () => run(["check", name, ...sv(n)], { server: n }) },
          { label: "Stats", hint: `lf stats ${name}`, title: "CPU, memory and network of its containers right now", run: () => run(["stats", name, ...sv(n)], { server: n }) },
          { label: "Traffic", hint: `lf traffic ${name}`, title: "Its requests, errors, busiest paths and clients", run: () => ((S.focus[n] = name), go(n, "traffic")) },
          "-",
          ...(ways.length > 1 ? ways : ways.slice(0, 1)).map((w) => ({
            label: ways.length > 1 ? `Tunnel to ${w.label}` : "Open via tunnel",
            hint: "lf tunnel",
            title: "An SSH tunnel straight to the container: test it on localhost, no domain needed",
            run: () => run(w.argv, { server: n }),
          })),
          "-",
          { label: m.adopted ? `Forget ${name}` : `Delete ${name}`, cls: "danger", hint: "lf sites rm", run: deleteSite },
        ]}
      />
    </div>
  );
  const toggle = () => (open ? S.open.delete(`${n}/${name}`) : S.open.add(`${n}/${name}`), render());
  const det = open && deploys ? S.det[proj.path] : undefined;
  // The open row: what runs and what you do with it on the left, how it is built and where it lives on the right.
  const svcRows = services.map((x) => {
    const [own, ...named] = svcWays(x.service);
    const live = isUp(x.status);
    return (
      <li key={x.service}>
        <div className={ROW}>
          <StatusDot status={x.status} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2"><b>{x.service}</b><span className="faint text-sm">{x.status.toLowerCase()}</span></div>
            {own?.domains.length ? <div className="faint text-sm truncate">{own.domains.join(" · ")}</div>
            : own?.priv ? <div className="faint text-sm mono">:{own.priv}{own.path ?? ""} private</div>
            : null}
          </div>
          <span className={SIDE}>
            {own && live && <TunnelBtn n={n} argv={own.argv} ports={own.ports} label="Tunnel" compact />}
            {svcMenu(x)}
          </span>
        </div>
        {/* Private ports it names (lf tunnel blog admin), under it. */}
        {named.map((w) => (
          <div key={w.label} className={cx(ROW, "pt-0 pl-9")}>
            <span className="faint" aria-hidden="true">↳</span>
            <span className="min-w-0 flex-1 truncate">{w.label} <span className="faint text-sm mono">:{w.priv}{w.path ?? ""} private</span></span>
            {live && <span className={SIDE}><TunnelBtn n={n} argv={w.argv} ports={w.ports} label="Tunnel" compact /></span>}
          </div>
        ))}
      </li>
    );
  });
  // The newest releases; the rest unfold, remembered in S.open.
  const relKey = `rel:${n}/${name}`;
  const allRel = S.open.has(relKey) || byDate.length <= RELEASES + 1;
  const rels = allRel ? byDate : byDate.slice(0, RELEASES);
  const relRows = rels.map((r) => (
    <li key={r.id} className={ROW}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2"><span className="mono">{r.id}</span>{r.id === m.current && <Badge kind="ok">live</Badge>}</div>
        <div className="faint text-sm truncate">
          {ago(r.at)}
          {r.services && ` · ${r.services.map((x) => x.name).join(", ")}`}
          {r.git && <span className="mono" title={r.by ? `deployed by ${r.by}` : undefined}> · {r.git.commit.slice(0, 7)}{r.git.branch ? ` ${r.git.branch}` : ""}{r.git.dirty ? "*" : ""}</span>}
        </div>
      </div>
      {r.id !== m.current && managed && (
        <Btn
          cls="sm shrink-0"
          on={() => confirmDlg({ title: `Switch ${name} to ${r.id}?`, text: `Release from ${ago(r.at)} goes live instead of ${m.current}. Volumes keep their data.`, ok: "Switch", onOk: () => run(["rollback", name, ...sv(n), "--to", r.id, "-y"]) })}
        >
          Switch to this
        </Btn>
      )}
      {r.id !== m.current && managed && (
        <Btn
          cls="sm ghost shrink-0"
          title="lf release rm: delete its folder and images"
          on={() => confirmDlg({ title: `Delete release ${r.id} of ${name}?`, text: `Its folder and the images built for it go: Roll back can no longer return to it.\nThis cannot be undone.`, ok: "Delete", danger: true, onOk: () => run(["release", "rm", name, r.id, ...sv(n), "-y"]) })}
        >
          Delete
        </Btn>
      )}
    </li>
  ));
  const stale = byDate.filter((r) => r.id !== m.current);
  const facts: [string, ReactNode][] = [];
  facts.push(["Kind", <>{kind}{main || !managed ? "" : <> <span className="dim">· domains set in compose.yaml</span></>}</>]);
  if (managed) facts.push(["Login", m.auth?.length ? `${m.auth.map((a: string) => a.split(":")[0]).join(", ")} (basic auth)` : <span className="dim">public</span>]);
  if (!m.adopted)
    facts.push([
      "Source",
      proj ? <><span className="mono">{tilde(proj.path)}</span> <span className="dim">· redeploy runs there</span></>
      : <span className="dim">not deployed from this machine{m.kind === "image" ? "" : " (or the folder moved): Redeploy picks the folder"}</span>,
    ]);
  facts.push(["Created", `${ago(m.createdAt)} · updated ${ago(m.updatedAt)}`]);
  const detail = (
    <div className="flex flex-col gap-3 py-1.5">
      <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-3">
          <Panel title="Services" count={services.length}>
            {services.length ? <ul className={LIST}>{svcRows}</ul> : <p className="m-0 px-3 py-2.5 dim">none running</p>}
          </Panel>
          <SiteVolumes n={n} name={name} dir={proj?.path} edit={deploys && proj.kind !== "static" ? { path: proj.path, kind: proj.kind, environment: proj.environment, services: services.map((x) => x.service) } : undefined} />
          {m.releases.length > 0 && (
            <Panel
              title="Releases"
              count={m.releases.length}
              aside={managed && stale.length > 1 && (
                <Btn
                  cls="sm ghost"
                  title="lf release rm: delete every release but the live one"
                  on={() => confirmDlg({ title: `Delete ${stale.length} old releases of ${name}?`, text: `All but the live one (${m.current}) go, with the images built for them: Roll back has nothing left to return to.\nThis cannot be undone.`, ok: "Delete", danger: true, onOk: () => run(["release", "rm", name, ...sv(n), "-y"]) })}
                >
                  Delete old
                </Btn>
              )}
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
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          {det !== undefined && (
            <Panel title="Build" aside={det && <Btn cls="sm ghost" title="Change how it builds: lf deploy --build --start" on={edit}>Edit</Btn>}>
              <div className="px-3 py-2.5 text-sm">
                {det ? <><Stack d={det} className="mb-2" /><Describe d={det} before={false} /></>
                : <span className="faint">{det === false ? "cannot read its folder" : "reading its folder…"}</span>}
              </div>
            </Panel>
          )}
          <Panel title="Details"><Kv className="px-3 py-2.5" pairs={facts} /></Panel>
          <Panel title={`On ${n}`}><SiteFiles m={m} /></Panel>
        </div>
      </div>
    </div>
  );
  // A site deployed with no domain is reached by its tunnel; so are private ports, and any tunnel open now.
  const reach = ways.length > 1 ? ways.filter((w) => tunnelFor(n, w.argv) || ((w.priv || w.label === main) && !w.domains.length && isUp(w.status))) : [];
  const where = (
    <>
      {domains.length ? domains.map((d: string) => <DomainChip key={d} n={n} d={d} />)
      : main && !many ? <span className={CHIP}><span className="faint">no domain</span> <TunnelBtn n={n} argv={["tunnel", name, ...sv(n)]} /></span>
      : null}
      {reach.map((w) => (
        <span key={w.label} className={cx(CHIP, "gap-1.5")}>
          <span className="faint" title={w.priv ? `private port ${w.priv}: never routed, reached by tunnel only` : undefined}>{w.label}{w.priv ? " · private" : w.domains.length ? "" : " · no domain"}</span>
          <TunnelBtn n={n} argv={w.argv} ports={w.ports} label="Tunnel" compact />
        </span>
      ))}
    </>
  );
  return (
    <>
      <tr className="cursor-pointer hover:[&>td]:bg-hover" onClick={toggle}>
        <td>
          <div className={NAME}>
            <StatusDot status={status} />
            <button
              type="button"
              className="border-0 bg-transparent shadow-none px-1 py-0.5 -ml-1 inline-flex items-center gap-1 text-inherit font-semibold hover:bg-transparent hover:underline"
              aria-expanded={open}
              onClick={(e) => (e.stopPropagation(), toggle())}
            >
              <b>{name}</b> {open ? <ChevronDown className="size-3.5 text-faint" aria-hidden="true" /> : <ChevronRight className="size-3.5 text-faint" aria-hidden="true" />}
            </button>
            {!!m.auth?.length && <span className="ml-1 text-dim" title="password protected" role="img" aria-label="password protected"><Lock className="size-3" aria-hidden="true" /></span>}
          </div>
          <div className={cx(CHIPS, SHOW, "mt-1")}>{where}</div>
        </td>
        <td className={HIDE}><div className={CHIPS}>{where}</div></td>
        <td className={HIDE}>
          <Badge title={services.map((x) => x.service).join(", ")}>{kind}</Badge>
          {many && (() => {
            const up = services.filter((x) => isUp(x.status)).length;
            return <> <span className={up < services.length ? "text-warn" : "faint"} title={services.map((x) => `${x.service}: ${x.status.toLowerCase()}`).join("\n")}>{up < services.length ? `${up} of ${services.length} up` : `${services.length} services`}</span></>;
          })()}
        </td>
        <td className={cx(HIDE, "dim")}>{cur ? ago(cur.at) : ""}</td>
        <td className={ACTS}>{acts}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={5} className="bg-[color-mix(in_srgb,var(--hover)_60%,transparent)]">
            {detail}
          </td>
        </tr>
      )}
    </>
  );
}

/** The project folder this machine deploys the site from: where lf volume add/rm edit its compose.yaml or .landfall.json. */
interface VolumeEdit { path: string; kind: string; environment?: string; services: string[] }

/** The site's Docker volumes and their backups (lf volumes), read when the row opens. */
function SiteVolumes({ n, name, dir, edit }: { n: string; name: string; dir?: string; edit?: VolumeEdit }) {
  const [d, setD] = useState<Volumes | null>(null);
  const [err, setErr] = useState("");
  // The list first, then the sizes: du reads every file, which takes a while on a big database.
  const url = (sizes: 0 | 1) => `/api/servers/${encodeURIComponent(n)}/volumes?site=${encodeURIComponent(name)}&sizes=${sizes}`;
  const load = () =>
    http<Volumes>(url(0)).then(
      (x) => (setD(x), setErr(""), http<Volumes>(url(1)).then(setD, () => {})),
      (e) => setErr(errorMessage(e)),
    );
  useEffect(() => void load(), [n, name]);
  const box = (body: ReactNode, aside: ReactNode = addBtn) => <Panel title="Volumes" count={d?.volumes.length || undefined} aside={aside}>{body}</Panel>;
  const compose = edit?.kind === "compose";
  const env = edit?.environment ? ["-E", edit.environment] : [];
  const where = compose ? "compose.yaml" : ".landfall.json";
  // Edits the project folder, then (if asked) redeploys from it so the server follows and reads the volumes again.
  const then = (deploy: boolean, next = load) => ifOk(() => deploy && edit && run(["deploy", "-y", ...sv(n), ...env], { server: n, cwd: edit.path, after: ifOk(next) }));
  const add = edit && (() =>
    dialog({
      title: `Keep a folder of ${name}`,
      text: `A named volume keeps a folder of the container across deploys and rollbacks. It goes into ${where} in ${tilde(edit.path)}, plain ${compose ? "Compose" : "landfall settings"}; a redeploy applies it.`,
      fields: [
        ...(compose && edit.services.length > 1 ? [{ name: "service", type: "select" as const, label: "Service", value: edit.services[0], options: edit.services.map((x) => ({ value: x, label: x })) }] : []),
        { name: "path", label: "Folder in the container", placeholder: "/app/data", mono: true, required: true, check: (x) => (/^\/[\w.\/-]*\w/.test(String(x)) ? undefined : "An absolute folder, like /app/data") },
        ...(compose ? [{ name: "as", label: "Volume name", placeholder: "from the folder: /app/data is app-data", mono: true, check: (x: unknown) => (!x || /^\w[\w.-]*$/.test(String(x)) ? undefined : "Letters, digits, ., _ and -") }] : []),
        { name: "deploy", type: "check", label: "Redeploy now to apply it", value: true },
      ],
      ok: "Add volume",
      onOk: (v) => {
        const spec = compose && v.service ? `${v.service}:${v.path}` : String(v.path);
        run(["volume", "add", spec, ...(v.as ? ["--as", String(v.as)] : []), ...env], { server: n, cwd: edit.path, after: then(!!v.deploy) });
      },
    }));
  const addBtn = add && <Btn cls="sm ghost" title={`Keep a folder of the container across deploys (lf volume add, in ${tilde(edit!.path)})`} on={add}>Add…</Btn>;
  if (err) return box(<p className="m-0 px-3 py-2.5 text-bad">{err}</p>);
  if (!d) return box(<p className="m-0 px-3 py-2.5 faint">reading its volumes…</p>);
  if (!d.volumes.length) return box(<p className="m-0 px-3 py-2.5 dim">none{add && ": Add… keeps a folder, like uploads or a database, across deploys"}</p>);
  // A backup belongs to the volume its name starts with: content-20261027-181500.tar.gz.
  const own = (key: string) => d.backups.filter((b) => b.file.startsWith(`${key}-`) && /^\d{8}-\d{6}/.test(b.file.slice(key.length + 1)));
  const restore = (key: string, list: Volumes["backups"]) =>
    dialog({
      title: `Restore ${key} of ${name}?`,
      text: "Replaces its contents with the backup; the services using it stop meanwhile. The current contents are backed up first: lf undo puts them back.",
      fields: [{ name: "file", type: "select", label: "Backup", value: list[0].file, options: list.map((b) => ({ value: b.file, label: `${b.file} · ${size(b.size)} · ${ago(b.time)}` })) }],
      ok: "Restore",
      danger: true,
      onOk: (v) => run(["volume", "restore", name, key, v.file, ...sv(n), "-y"], { after: ifOk(load) }),
    });
  const forget = (key: string, list: Volumes["backups"]) =>
    dialog({
      title: `Delete a backup of ${key}?`,
      text: "Deletes the file from the site's backups folder. This cannot be undone.",
      fields: [{ name: "file", type: "select", label: "Backup", value: list.at(-1)!.file, options: list.map((b) => ({ value: b.file, label: `${b.file} · ${size(b.size)} · ${ago(b.time)}` })) }],
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
        { name: "every", type: "select", label: "Every", value: /^(\w+),/.exec(d.schedule ?? "")?.[1] ?? "daily", options: ["hourly", "daily", "weekly", "off"].map((x) => ({ value: x, label: x })) },
        { name: "keep", label: "Keep per volume", value: /keep (\d+)/.exec(d.schedule ?? "")?.[1] ?? "7" },
        { name: "offsite", label: "Also copy to (optional)", value: /offsite (\S+)/.exec(d.schedule ?? "")?.[1] ?? "", mono: true, hint: "[user@]host:path: rsync over ssh mirrors the backups there. The server's login user needs an ssh key that host accepts." },
      ],
      ok: "Save",
      onOk: (v) => run(["volume", "backup", name, "--schedule", v.every, ...(v.every === "off" ? [] : ["--keep", v.keep, ...(v.offsite.trim() ? ["--offsite", v.offsite.trim()] : [])]), ...sv(n)], { after: ifOk(load) }),
    });
  // Unmount from the project; the data stays unless asked, and goes only once the redeploy freed it.
  const remove = edit && ((v: Volumes["volumes"][number]) =>
    dialog({
      title: `Remove ${v.key} from ${name}?`,
      text: `Takes its mounts out of ${where} in ${tilde(edit.path)}; a redeploy applies it. Its data stays on the server, listed as unused, unless you delete it too.`,
      fields: [
        { name: "deploy", type: "check", label: "Redeploy now to apply it", value: true },
        { name: "data", type: "check", label: "Then delete its data on the server", value: false, off: (x) => !x.deploy, hint: "Backed up to the site's backups folder first: lf undo brings it back." },
      ],
      ok: "Remove",
      danger: true,
      onOk: (x) =>
        run(["volume", "rm", v.key, ...env], {
          server: n,
          cwd: edit.path,
          after: then(!!x.deploy, x.data ? () => run(["volume", "rm", name, v.key, "--data", ...sv(n), "-y", ...env], { server: n, cwd: edit.path, after: ifOk(load) }) : undefined),
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
      {d.lastRun?.failed.length ? <Badge kind="bad" title="backups/backup.log on the server">last backup failed: {d.lastRun.failed.join(", ")}</Badge> : null}
      <Btn cls="sm ghost" title={`Back up every volume on a timer (lf volume backup ${name} --schedule daily)`} on={schedule}>Schedule…</Btn>
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
                {v.empty ? <span className="text-warn text-sm" title={`No files yet: fill it with Push… (lf volume push ${name} ${v.key} <folder>)`}>empty</span> : v.size !== undefined && <span className="dim text-sm">{size(v.size)}</span>}
                {!v.mounts.length && <span className="text-warn text-sm" title={`No container mounts it: Delete… removes it (lf volume rm ${name} ${v.key} --data)`}>unused</span>}
                <span className="faint text-sm">{baks.length ? `${baks.length} backup${baks.length === 1 ? "" : "s"}, newest ${ago(baks[0].time)}` : "no backups"}</span>
              </div>
              {v.mounts.length > 0 && <div className="faint text-sm mono truncate">{v.mounts.map((x) => `${x.service}:${x.path}`).join(" · ")}</div>}
              {v.dir && <div className="faint text-sm mono truncate" title="Its files on the server, in the site's folder">{v.dir}</div>}
            </div>
            {/* An empty volume wants filling; a full one backing up. The rest is under More. */}
            <span className={SIDE}>
              {v.empty
                ? <Btn cls="sm" title={`Replace its contents with a folder from this machine (lf volume push ${name} ${v.key})`} on={() => push(v)}>Push…</Btn>
                : <Btn cls="sm" title={`Save it as a .tar.gz in the site's backups folder; the services keep running, a database using it pauses while it is copied (lf volume backup ${name} ${v.key})`} on={() => run(["volume", "backup", name, v.key, ...sv(n)], { after: ifOk(load) })}>Back up</Btn>}
              <MenuBtn
                title={`More for volume ${v.key}`}
                cls="sm ghost"
                items={[
                  baks.length > 0 && { label: "Restore…", hint: "lf volume restore", title: "Replace its contents with a backup", run: () => restore(v.key, baks) },
                  !v.empty && { label: "Push…", hint: "lf volume push", title: "Replace its contents with a folder from this machine", run: () => push(v) },
                  !v.empty && { label: "Pull…", hint: "lf volume pull", title: "Unpack it into a folder on this machine", run: () => pull(v) },
                  "-",
                  baks.length > 0 && { label: "Delete a backup…", hint: "lf volume backup rm", title: "Delete one of its backups (oldest preselected)", cls: "danger", run: () => forget(v.key, baks) },
                  remove && v.mounts.length > 0 && { label: "Remove…", hint: "lf volume rm", title: `Unmount it in ${where}, optionally delete its data`, cls: "danger", run: () => remove(v) },
                  !v.mounts.length && { label: "Delete…", hint: "lf volume rm --data", title: "Delete the unused volume (backed up first)", cls: "danger", run: () => drop(v) },
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

function SiteFiles({ m }: { m: SiteMeta }) {
  const dir = `${S.state.paths.sites}/${m.name}`;
  const box = "px-3 py-2.5 text-sm flex flex-col gap-1.5 min-w-0";
  // Paths and commands break anywhere: inside the table, a line that cannot wrap widens every row on a phone.
  const line = cx(MONO, "block break-all");
  if (m.adopted) return <div className={box}><span className={line}>{m.adopted}</span><span className="dim">its own folder; project <span className="mono">{m.project ?? m.name}</span></span></div>;
  return (
    <div className={box}>
      <span className={line} title={`${dir}/current is releases/${m.current}`}>{dir}/current <span className="dim">→ releases/{m.current}</span></span>
      <span className="faint">compose.yaml · compose.override.yaml (landfall's) · .env (mode 600)</span>
      <span className="faint">run it by hand:</span>
      <code className={cx(line, "rounded-sm bg-hover px-2 py-1")}>cd {dir}/current &amp;&amp; docker compose ps</code>
    </div>
  );
}

function OthersCard({ n, o }: { n: string; o: Overview }) {
  if (!o.others?.length) return null;
  const links = (e: External) => e.domains.map((d: string) => <span key={d} className={CHIP}><a href={`https://${d}`} target="_blank" rel="noopener">{d}</a></span>);
  return (
    <Card>
      <CardHead>Not deployed by landfall <Badge>{o.others.length}</Badge></CardHead>
      <Lede>Containers your Traefik routes, e.g. your own compose projects. Adopting one lists it as a site with logs, restart and stop; it keeps running from its folder.</Lede>
      <Table head={<><th>Name</th><th className={HIDE}>Domains</th><th className={HIDE}>Folder</th><th><span className={SR}>Actions</span></th></>}>
        {o.others.map((e) => (
          <tr key={e.name}>
            <td>
              <div className={NAME}><StatusDot status={e.status} /><b>{e.name}</b>&nbsp;<span className="faint">{e.status.toLowerCase()}</span></div>
              <div className={cx(CHIPS, SHOW, "mt-1")}>{links(e)}</div>
            </td>
            <td className={HIDE}><div className={CHIPS}>{links(e)}</div></td>
            <td className={cx(HIDE, MONO, "dim")}>{e.dir ?? e.containers.join(", ")}</td>
            <td className={ACTS}>
              <Btn cls="sm" title="lf tunnel: an SSH tunnel straight to the container, until you stop it" on={() => run(["tunnel", e.name, ...sv(n)], { server: n })}>Tunnel</Btn>
              {e.dir && <Btn cls="sm" title="lf adopt" on={() => adoptDialog(n, e)}>Adopt</Btn>}
            </td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}

function adoptDialog(n: string, e: External) {
  dialog({
    title: `Adopt ${e.name}?`,
    text: `${e.name} keeps running from ${e.dir} with its own files and Traefik labels. landfall lists it as a site with logs, restart, stop and start; it does not deploy it or change its domains.`,
    fields: [{ name: "name", label: "Site name", value: e.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+/, ""), required: true, check: siteNameError }],
    ok: "Adopt",
    onOk: (v) => run(["adopt", e.name, ...sv(n), "--name", v.name.trim()], { server: n }),
  });
}
