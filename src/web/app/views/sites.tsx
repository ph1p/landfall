import { useEffect, type ReactNode } from "react";
import { S, ago, render, sv, tilde, type Any } from "../lib/store";
import { run, TunnelBtn } from "../lib/jobs";
import { ACTS, Badge, Btn, Card, CardHead, Empty, HIDE, Kv, Lede, MONO, NAME, SHOW, SR, cx, Table } from "../ui/kit";
import { MenuBtn } from "../ui/menu";
import { confirmDlg, dialog, siteNameError } from "../ui/dialog";
import { Describe, buildSettings, detected, folderDialog, openAfter, setupFlow } from "./flows";
import { DomainChip, authDialog, domainsDialog, ensureDns } from "./domains";
import { ErrorsCard } from "./traffic";
import { StatusDot, can, isUp } from "./shared";

const CHIPS = "flex flex-col gap-[3px] items-start";
const CHIP = "inline-flex items-center gap-0.5 max-w-full";

export function SitesView({ n, o }: { n: string; o: Any }) {
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
            <p><Btn cls="primary" on={() => folderDialog(S.state.cwd)}>Deploy a folder…</Btn> <span className="dim">or drop one here</span></p>
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
          {o.sites.map((site: Any) => <SiteRows key={site.meta.name} n={n} site={site} />)}
        </Table>
      </Card>
      <ErrorsCard n={n} />
      <OthersCard n={n} o={o} />
    </>
  );
}

function SiteRows({ n, site }: { n: string; site: Any }) {
  const { meta: m, status, services, domains, main, state, kind } = site;
  const cur = m.releases.find((r: Any) => r.id === m.current);
  const name: string = m.name;
  const open = S.open.has(`${n}/${name}`);
  const up = isUp(status);
  const old = state === "old";
  // Adopted and pre-Compose sites: landfall runs them, it does not deploy them.
  const managed = state === "managed";
  const byDate = [...m.releases].sort((a: Any, b: Any) => (a.at < b.at ? 1 : -1));
  const older = byDate.filter((r: Any) => r.at < (cur?.at ?? ""));
  const proj = (S.state.projects ?? []).find((p: Any) => p.server === n && p.name === name);
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
  const svcMenu = (x: Any) => (
    <MenuBtn
      title={`${x.service} of ${name}`}
      cls="sm ghost"
      items={[
        { label: "Logs", hint: `lf logs ${name} ${x.service}`, run: () => run(["logs", name, x.service, ...sv(n), "-f"]) },
        { label: "Restart", hint: "lf restart", run: () => run(["restart", name, x.service, ...sv(n)]) },
        isUp(x.status)
          ? { label: "Stop…", hint: "lf stop", run: () => confirmDlg({ title: `Stop ${x.service} of ${name}?`, text: "It stays stopped until you start it again.", ok: "Stop it", danger: true, onOk: () => run(["stop", name, x.service, ...sv(n)]) }) }
          : { label: "Start", hint: "lf start", run: () => run(["start", name, x.service, ...sv(n)]) },
      ]}
    />
  );
  const editBuild = () => buildSettings(proj.path, { server: n, name, domains: m.domains ?? [], old });
  const acts = (
    <>
      {deploys ? (
        <Btn
          cls="sm primary"
          title={`lf deploy in ${proj.path}`}
          on={() =>
            confirmDlg({
              title: `Redeploy ${name}?`,
              text: `From ${tilde(proj.path)}${proj.kind === "static" ? " (runs its build first, if it has one)" : ""}.`,
              ok: "Deploy",
              onOk: () => run(["deploy", "-y", ...sv(n)], { server: n, cwd: proj.path, after: openAfter }),
            })
          }
        >
          Redeploy
        </Btn>
      ) : m.adopted || m.kind === "image" ? null : (
        <Btn cls="sm" title="Pick the folder it was deployed from" on={() => folderDialog(S.state.cwd, { server: n, name, domains: m.domains ?? [], old })}>Redeploy…</Btn>
      )}
      {!old && <Btn cls="sm" title="Follow the logs of all its services" on={() => run(["logs", name, ...sv(n), "-f"])}>Logs</Btn>}
      <MenuBtn
        title={`More for ${name}`}
        items={[
          !old && { label: "Restart", hint: "lf restart", run: () => run(["restart", name, ...sv(n)]) },
          old ? null
          : up ? { label: "Stop…", hint: "lf stop", run: () => confirmDlg({ title: `Stop ${name}?`, text: `${domains.join(", ") || "The site"} stops answering until you start it again.`, ok: "Stop it", danger: true, onOk: () => run(["stop", name, ...sv(n)]) }) }
          : { label: "Start", hint: "lf start", run: () => run(["start", name, ...sv(n)]) },
          managed && older.length > 0 && {
            label: "Roll back…",
            hint: "lf rollback",
            title: `To ${older[0].id} (${ago(older[0].at)})`,
            run: () => confirmDlg({ title: `Roll back ${name}?`, text: `From ${m.current} to ${older[0].id} (${ago(older[0].at)}). Volumes keep their data.`, ok: "Roll back", onOk: () => run(["rollback", name, ...sv(n), "-y"]) }),
          },
          "-",
          !old && { label: "Open via tunnel", hint: "lf tunnel", title: "An SSH tunnel straight to the container: test it on localhost, no domain needed", run: () => run(["tunnel", name, ...sv(n)], { server: n }) },
          main && { label: "Domains…", hint: "lf domains", run: () => domainsDialog(n, m) },
          managed && { label: m.auth?.length ? "Login…" : "Password…", hint: "lf auth", title: "Protect the site with a user and password", run: () => authDialog(n, m) },
          managed && { label: "Environment…", hint: "lf env", run: () => envDialog(n, name) },
          deploys && { label: "Build settings…", hint: "lf deploy --build --start", title: "What it builds and starts with, its port, static or Node.js", run: editBuild },
          "-",
          { label: m.adopted ? `Forget ${name}…` : `Delete ${name}…`, cls: "danger", hint: "lf sites rm", run: deleteSite },
        ]}
      />
    </>
  );
  const toggle = () => (open ? S.open.delete(`${n}/${name}`) : S.open.add(`${n}/${name}`), render());
  const svcDomains = (svc: string): string[] => (svc === main ? m.domains : (cur?.services?.find((x: Any) => x.name === svc)?.domains ?? []));
  const det = open && deploys ? S.det[proj.path] : undefined;
  const pairs: [string, ReactNode][] = [];
  if (old) pairs.push(["Old site", <span className="dim">Deployed before sites were Compose projects: {proj ? "redeploy it" : <>run <span className="mono">lf deploy</span> for it</>} once to manage it again.</span>]);
  pairs.push([
    "Services",
    services.length ? (
      <ul className="list-none m-0 p-0">
        {services.map((x: Any) => (
          <li key={x.service} className="flex items-center gap-2 py-[3px]">
            <StatusDot status={x.status} />
            <b>{x.service}</b>
            {svcDomains(x.service).length > 0 && <Badge>{svcDomains(x.service).join(" ")}</Badge>}
            <span className="faint">{x.status.toLowerCase()}</span>
            {!old && svcMenu(x)}
          </li>
        ))}
      </ul>
    ) : <span className="dim">none running</span>,
  ]);
  pairs.push([`On ${n}`, <SiteFiles m={m} state={state} />]);
  if (!m.adopted)
    pairs.push([
      "Source",
      proj ? <><span className="mono">{tilde(proj.path)}</span> <span className="dim">· redeploy runs there</span></>
      : <span className="dim">not deployed from this machine{m.kind === "image" ? "" : " (or the folder moved): Redeploy… picks the folder"}</span>,
    ]);
  if (det !== undefined)
    pairs.push([
      "Build",
      det ? <><Describe d={det} before={false} /> <Btn cls="sm ghost" title="Build settings: lf deploy --build --start" on={editBuild}>Edit…</Btn></>
      : <span className="faint">{det === false ? "cannot read its folder" : "reading its folder…"}</span>,
    ]);
  pairs.push(["Kind", <>{kind}{main || !managed ? "" : <> <span className="dim">· domains set in compose.yaml</span></>}</>]);
  if (managed) pairs.push(["Login", m.auth?.length ? `${m.auth.map((a: string) => a.split(":")[0]).join(", ")} (basic auth)` : <span className="dim">public</span>]);
  pairs.push(["Created", `${ago(m.createdAt)} · updated ${ago(m.updatedAt)}`]);
  if (m.releases.length)
    pairs.push([
      "Releases",
      <ul className="list-none m-0 p-0">
        {byDate.map((r: Any) => (
          <li key={r.id} className="flex items-center gap-2.5 py-[5px]">
            <span className="mono">{r.id}</span>
            <span className="dim">{ago(r.at)}</span>
            {r.services && <span className="faint">{r.services.map((x: Any) => x.name).join(", ")}</span>}
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
  // A site deployed with no domain is reached by its tunnel.
  const where = domains.length ? domains.map((d: string) => <DomainChip key={d} n={n} d={d} />)
    : main && !old ? <span className={CHIP}><span className="faint">no domain</span> <TunnelBtn n={n} argv={["tunnel", name, ...sv(n)]} /></span>
    : null;
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
              <b>{name}</b> <span className="faint" aria-hidden="true">{open ? "▾" : "▸"}</span>
            </button>
            {m.auth?.length > 0 && <span className="text-xs ml-1" title="password protected" role="img" aria-label="password protected">🔒</span>}
          </div>
          <div className={cx(CHIPS, SHOW, "mt-1")}>{where}</div>
        </td>
        <td className={HIDE}><div className={CHIPS}>{where}</div></td>
        <td className={HIDE}>
          <Badge title={services.map((x: Any) => x.service).join(", ")}>{kind}</Badge>
          {services.length > 1 && <> <span className="faint">{services.length} services</span></>}
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

function SiteFiles({ m, state }: { m: Any; state: string }) {
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

function OthersCard({ n, o }: { n: string; o: Any }) {
  if (!o.others?.length) return null;
  const links = (e: Any) => e.domains.map((d: string) => <span key={d} className={CHIP}><a href={`https://${d}`} target="_blank" rel="noopener">{d}</a></span>);
  return (
    <Card>
      <CardHead>Not deployed by landfall <Badge>{o.others.length}</Badge></CardHead>
      <Lede>Containers your Traefik routes, e.g. your own compose projects. Adopting one lists it as a site with logs, restart and stop; it keeps running from its folder.</Lede>
      <Table head={<><th>Name</th><th className={HIDE}>Domains</th><th className={HIDE}>Folder</th><th><span className={SR}>Actions</span></th></>}>
        {o.others.map((e: Any) => (
          <tr key={e.name}>
            <td>
              <div className={NAME}><StatusDot status={e.status} /><b>{e.name}</b>&nbsp;<span className="faint">{e.status.toLowerCase()}</span></div>
              <div className={cx(CHIPS, SHOW, "mt-1")}>{links(e)}</div>
            </td>
            <td className={HIDE}><div className={CHIPS}>{links(e)}</div></td>
            <td className={cx(HIDE, MONO, "dim")}>{e.dir ?? e.containers.join(", ")}</td>
            <td className={ACTS}>
              <Btn cls="sm" title="lf tunnel: an SSH tunnel straight to the container, until you stop it" on={() => run(["tunnel", e.name, ...sv(n)], { server: n })}>Tunnel</Btn>
              {e.dir && <Btn cls="sm" title="lf adopt" on={() => adoptDialog(n, e)}>Adopt…</Btn>}
            </td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}

function adoptDialog(n: string, e: Any) {
  dialog({
    title: `Adopt ${e.name}?`,
    text: `${e.name} keeps running from ${e.dir} with its own files and Traefik labels. landfall lists it as a site with logs, restart, stop and start; it does not deploy it or change its domains.`,
    fields: [{ name: "name", label: "Site name", value: e.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+/, ""), required: true, check: siteNameError }],
    ok: "Adopt",
    onOk: (v) => run(["adopt", e.name, ...sv(n), "--name", v.name.trim()], { server: n }),
  });
}

function envDialog(n: string, name: string) {
  dialog({
    title: `Environment of ${name}`,
    text: "Changes recreate the container. Leave both empty to only show the current values.",
    fields: [
      {
        name: "set", label: "Set (KEY=VALUE, one per line)", type: "textarea", value: "", placeholder: "DATABASE_URL=postgres://…\nLOG_LEVEL=info",
        check: (x: string) => x.split("\n").map((l) => l.trim()).filter((l) => l && !/^[^=]+=/.test(l)).map((l) => `Not KEY=VALUE: ${l.slice(0, 40)}`)[0],
      },
      { name: "unset", label: "Remove (names, space separated)", value: "", placeholder: "OLD_KEY" },
    ],
    ok: "Apply",
    onOk: (v) => {
      const pairs = v.set.split("\n").map((l: string) => l.trim()).filter((l: string) => l && l.includes("="));
      const unset = v.unset.split(/[\s,]+/).filter(Boolean).flatMap((k: string) => ["-u", k]);
      run(["env", name, ...sv(n), ...pairs, ...unset]);
    },
  });
}
