import { useEffect, useState, type ReactNode } from "react";
import { S, ago, errorMessage, http, render, sv, tilde } from "../lib/store";
import type { External, Overview, SiteMeta, SiteStatus, Volumes } from "../lib/types";
import { ifOk, run, TunnelBtn, tunnelFor } from "../lib/jobs";
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
  const { meta: m, status, services, domains, main, state, kind } = site;
  const cur = m.releases.find((r) => r.id === m.current);
  const name: string = m.name;
  const open = S.open.has(`${n}/${name}`);
  const up = isUp(status);
  const old = state === "old";
  // Adopted and pre-Compose sites: landfall runs them, it does not deploy them.
  const managed = state === "managed";
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
        : "Stops it and removes its files and releases. Its named volumes (databases, uploads) stay unless you delete them too.\nThis cannot be undone.",
      fields: m.adopted ? [] : [{ name: "volumes", type: "check", label: "Also delete its volumes", hint: "Databases, uploads: all its data. lf sites rm --volumes" }],
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
        <Btn cls="sm" title="Pick the folder it was deployed from" on={() => folderDialog(S.state.cwd, { server: n, name, domains: m.domains ?? [], old })}><Icon name="deploy" />Redeploy</Btn>
      )}
      {(main || managed || deploys) && <Btn cls="sm" title="Domains, login, environment and how it builds (lf domains, lf auth, lf env, lf deploy)" on={edit}><Icon name="edit" />Edit</Btn>}
      {!old && (
        <BtnGroup label={`Containers of ${name}`}>
          <Btn cls="sm" title={`Follow the logs of all its services (lf logs ${name} -f)`} on={() => run(["logs", name, ...sv(n), "-f"])}><Icon name="logs" />Logs</Btn>
          <Btn cls="sm" title={`Restart its containers, a moment offline (lf restart ${name})`} on={() => run(["restart", name, ...sv(n)])}><Icon name="restart" />Restart</Btn>
          {up
            ? <Btn cls="sm hover:text-bad" title={`Stop its containers (lf stop ${name})`} on={stop}><Icon name="stop" />Stop</Btn>
            : <Btn cls="sm" title={`Start its containers (lf start ${name})`} on={() => run(["start", name, ...sv(n)])}><Icon name="start" />Start</Btn>}
        </BtnGroup>
      )}
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
  const pairs: [string, ReactNode][] = [];
  if (old) pairs.push(["Old site", <span className="dim">Deployed before sites were Compose projects: {proj ? "redeploy it" : <>run <span className="mono">lf deploy</span> for it</>} once to manage it again.</span>]);
  pairs.push([
    "Services",
    services.length ? (
      <ul className="list-none m-0 p-0">
        {services.map((x) => {
          const [own, ...named] = svcWays(x.service);
          return (
            <li key={x.service} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-[3px]">
              <StatusDot status={x.status} />
              <b>{x.service}</b>
              {own?.domains.map((d) => <Badge key={d}>{d}</Badge>)}
              {own?.priv ? <span className="faint mono">:{own.priv}{own.path ?? ""} private</span> : null}
              <span className="faint">{x.status.toLowerCase()}</span>
              {own && isUp(x.status) && <TunnelBtn n={n} argv={own.argv} ports={own.ports} label="Tunnel" compact />}
              {named.map((w) => isUp(x.status) && (
                <span key={w.label} className="inline-flex items-center gap-1.5">
                  <span className="faint mono">{w.label} :{w.priv}{w.path ?? ""} private</span>
                  <TunnelBtn n={n} argv={w.argv} ports={w.ports} label="Tunnel" compact />
                </span>
              ))}
              {!old && svcMenu(x)}
            </li>
          );
        })}
      </ul>
    ) : <span className="dim">none running</span>,
  ]);
  pairs.push([`On ${n}`, <SiteFiles m={m} state={state} />]);
  if (!old) pairs.push(["Volumes", <SiteVolumes n={n} name={name} dir={proj?.path} />]);
  if (!m.adopted)
    pairs.push([
      "Source",
      proj ? <><span className="mono">{tilde(proj.path)}</span> <span className="dim">· redeploy runs there</span></>
      : <span className="dim">not deployed from this machine{m.kind === "image" ? "" : " (or the folder moved): Redeploy picks the folder"}</span>,
    ]);
  if (det !== undefined)
    pairs.push([
      "Build",
      det ? <><Stack d={det} className="mb-1.5" /><Describe d={det} before={false} /> <Btn cls="sm ghost" title="Change how it builds: lf deploy --build --start" on={edit}>Edit</Btn></>
      : <span className="faint">{det === false ? "cannot read its folder" : "reading its folder…"}</span>,
    ]);
  pairs.push(["Kind", <>{kind}{main || !managed ? "" : <> <span className="dim">· domains set in compose.yaml</span></>}</>]);
  if (managed) pairs.push(["Login", m.auth?.length ? `${m.auth.map((a: string) => a.split(":")[0]).join(", ")} (basic auth)` : <span className="dim">public</span>]);
  pairs.push(["Created", `${ago(m.createdAt)} · updated ${ago(m.updatedAt)}`]);
  if (m.releases.length)
    pairs.push([
      "Releases",
      <ul className="list-none m-0 p-0">
        {byDate.map((r) => (
          <li key={r.id} className="flex items-center gap-2.5 py-[5px]">
            <span className="mono">{r.id}</span>
            <span className="dim">{ago(r.at)}</span>
            {r.services && <span className="faint">{r.services.map((x) => x.name).join(", ")}</span>}
            {r.git && (
              <span className="faint mono" title={r.by ? `deployed by ${r.by}` : undefined}>
                {r.git.commit.slice(0, 7)}
                {r.git.branch ? ` ${r.git.branch}` : ""}
                {r.git.dirty ? "*" : ""}
              </span>
            )}
            {r.id === m.current ? <Badge kind="ok">live</Badge>
            : managed ? (
              <Btn
                cls="sm"
                on={() => confirmDlg({ title: `Switch ${name} to ${r.id}?`, text: `Release from ${ago(r.at)} goes live instead of ${m.current}. Volumes keep their data.`, ok: "Switch", onOk: () => run(["rollback", name, ...sv(n), "--to", r.id, "-y"]) })}
              >
                Switch to this
              </Btn>
            ) : null}
          </li>
        ))}
      </ul>,
    ]);
  // A site deployed with no domain is reached by its tunnel; so are private ports, and any tunnel open now.
  const reach = ways.length > 1 ? ways.filter((w) => tunnelFor(n, w.argv) || ((w.priv || w.label === main) && !w.domains.length && isUp(w.status))) : [];
  const where = (
    <>
      {domains.length ? domains.map((d: string) => <DomainChip key={d} n={n} d={d} />)
      : main && !old && !many ? <span className={CHIP}><span className="faint">no domain</span> <TunnelBtn n={n} argv={["tunnel", name, ...sv(n)]} /></span>
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
            <Kv pairs={pairs} />
          </td>
        </tr>
      )}
    </>
  );
}

/** The site's Docker volumes and their backups (lf volumes), read when the row opens. */
function SiteVolumes({ n, name, dir }: { n: string; name: string; dir?: string }) {
  const [d, setD] = useState<Volumes | null>(null);
  const [err, setErr] = useState("");
  const load = () =>
    http<Volumes>(`/api/servers/${encodeURIComponent(n)}/volumes?site=${encodeURIComponent(name)}`).then((x) => (setD(x), setErr("")), (e) => setErr(errorMessage(e)));
  useEffect(() => void load(), [n, name]);
  if (err) return <span className="text-bad">{err}</span>;
  if (!d) return <span className="faint">reading its volumes…</span>;
  if (!d.volumes.length) return <span className="dim">none</span>;
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
      ],
      ok: "Save",
      onOk: (v) => run(["volume", "backup", name, "--schedule", v.every, ...(v.every === "off" ? [] : ["--keep", v.keep]), ...sv(n)], { after: ifOk(load) }),
    });
  return (
    <>
      <ul className="list-none m-0 p-0">
        {d.volumes.map((v) => {
          const baks = own(v.key);
          return (
            <li key={v.name} className="flex flex-wrap items-center gap-2 py-[3px]">
              <b>{v.key}</b>
              {v.empty ? <span className="text-warn" title={`No files yet: fill it with Push… (lf volume push ${name} ${v.key} <folder>)`}>empty</span> : v.size !== undefined && <span className="dim">{size(v.size)}</span>}
              {v.mounts.length > 0 && <span className="faint mono">{v.mounts.map((x) => `${x.service}:${x.path}`).join(" ")}</span>}
              <span className="faint">{baks.length ? `${baks.length} backup${baks.length === 1 ? "" : "s"}, newest ${ago(baks[0].time)}` : "no backups"}</span>
              <Btn cls="sm" title={`Save it as a .tar.gz in the site's backups folder; the services keep running (lf volume backup ${name} ${v.key})`} on={() => run(["volume", "backup", name, v.key, ...sv(n)], { after: ifOk(load) })}>Back up</Btn>
              {baks.length > 0 && <Btn cls="sm" title={`Replace its contents with a backup (lf volume restore ${name} ${v.key})`} on={() => restore(v.key, baks)}>Restore…</Btn>}
              <Btn cls="sm" title={`Replace its contents with a folder from this machine (lf volume push ${name} ${v.key})`} on={() => push(v)}>Push…</Btn>
              {!v.empty && <Btn cls="sm" title={`Unpack it into a folder on this machine (lf volume pull ${name} ${v.key} --into)`} on={() => pull(v)}>Pull…</Btn>}
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-center gap-2 py-[3px]">
        <span className={d.schedule ? "" : "faint"}>scheduled backups: {d.schedule ?? "none"}</span>
        <Btn cls="sm" title={`Back up every volume on a timer (lf volume backup ${name} --schedule daily)`} on={schedule}>Schedule…</Btn>
      </div>
    </>
  );
}

function SiteFiles({ m, state }: { m: SiteMeta; state: string }) {
  const dir = `${S.state.paths.sites}/${m.name}`;
  if (m.adopted) return <><span className="mono">{m.adopted}</span><div className="dim">its own folder; project <span className="mono">{m.project ?? m.name}</span></div></>;
  if (state === "old") return <span className="mono">{dir}</span>;
  return (
    <>
      <span className="mono">{dir}/current</span> <span className="dim">→ releases/{m.current}</span>
      <div className="faint mono">compose.yaml · compose.override.yaml (landfall's) · .env (mode 600)</div>
      <div className="faint">run it by hand: <span className="mono">cd {dir}/current &amp;&amp; docker compose ps</span></div>
    </>
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
