import { useEffect, type ReactNode } from "react";
import { S, ago, render, sv, tilde } from "../../lib/store";
import type { SiteMeta, SiteStatus } from "../../lib/types";
import { run, TunnelBtn, tunnelFor } from "../../lib/jobs";
import { go } from "../../lib/api";
import { ACTS, Badge, Btn, BtnGroup, HIDE, Kv, MONO, NAME, SHOW, cx, Icon } from "../../ui/kit";
import { MenuBtn } from "../../ui/menu";
import { DomainChip, siteSettings } from "../domains";
import { HookList } from "../hooks";
import { StatusDot, isUp, tunnelWays } from "../shared";
import { worse } from "../../../../core/site/status";
import { ChevronDown, ChevronRight, Lock } from "lucide-react";
import { Stack, Describe } from "../flows/describe";
import { deployImage, deployRepo } from "../flows/sources";
import { detected, redeploy } from "../flows/deploy";
import { folderDialog } from "../flows/folder";
import { CHIPS, CHIP, LIST, ROW, SIDE, TIGHT, Panel } from "./panel";
import { SiteVolumes } from "./volumes";
import { SiteAutodeploy } from "./autodeploy";
import { SiteReleases } from "./releases";
import { ServiceMenu, deleteSiteDialog, ejectDialog, rollbackDialog, stopDialog } from "./actions";

export function SiteRows({ n, site }: { n: string; site: SiteStatus }) {
  const { meta: m, status, services, domains, redirects, redirectTo, main, kind, scale } = site;
  const cur = m.releases.find((r) => r.id === m.current);
  const name = m.name;
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
  }, [open, deploys, proj?.path]);
  const many = services.length > 1;
  const ways = tunnelWays(n, site);
  const svcWays = (svc: string) => ways.filter((w) => w.svc === svc);
  const edit = () => siteSettings(n, site);
  const stop = () => stopDialog(n, site);
  // The everyday actions sit in the row, each titled with the command it runs; the rest is under More.
  const acts = (
    <div className="inline-flex flex-wrap items-center justify-end gap-1.5 [&>button]:ml-0!">
      {deploys ? (
        <Btn
          cls="sm primary"
          title={`Build and upload ${tilde(proj.path)} again, then switch to it (lf deploy)`}
          on={() => redeploy(proj.path, n, name, proj.kind, proj.environment)}
        >
          <Icon name="deploy" />
          Redeploy
        </Btn>
      ) : m.kind === "image" ? (
        <Btn
          cls="sm"
          title="Deploy an image to it again: the same tag pulls anew (lf deploy --image)"
          on={() => deployImage({ server: n, name, domains: m.domains, redirects: m.redirects })}
        >
          <Icon name="deploy" />
          Redeploy
        </Btn>
      ) : cur?.git?.remote && (cur.git.source === "server" || cur.git.source === "ci") && !deploys ? (
        <Btn
          cls="sm"
          title={`Fetch ${cur.git.tag ?? cur.git.branch ?? "the default branch"} again on the server and deploy it (lf deploy --git)`}
          on={() => deployRepo({ url: cur.git!.remote, ref: cur.git!.tag ?? cur.git!.branch, name, server: n })}
        >
          <Icon name="deploy" />
          Redeploy
        </Btn>
      ) : m.adopted ? null : (
        <Btn
          cls="sm"
          title="Pick the folder it was deployed from"
          on={() => folderDialog(S.state.cwd, { server: n, name, domains: m.domains, redirects: m.redirects })}
        >
          <Icon name="deploy" />
          Redeploy
        </Btn>
      )}
      {(main || managed || deploys) && (
        <Btn cls="sm" title="Domains, login, environment and how it builds (lf domains, lf auth, lf env, lf deploy)" on={edit}>
          <Icon name="edit" />
          Edit
        </Btn>
      )}
      <BtnGroup label={`Containers of ${name}`}>
        <Btn cls="sm" title={`Follow the logs of all its services (lf logs ${name} -f)`} on={() => run(["logs", name, ...sv(n), "-f"])}>
          <Icon name="logs" />
          <span className={TIGHT}>Logs</span>
        </Btn>
        <Btn cls="sm" title={`Restart its containers, a moment offline (lf restart ${name})`} on={() => run(["restart", name, ...sv(n)])}>
          <Icon name="restart" />
          <span className={TIGHT}>Restart</span>
        </Btn>
        {up ? (
          <Btn cls="sm hover:text-bad" title={`Stop its containers (lf stop ${name})`} on={stop}>
            <Icon name="stop" />
            <span className={TIGHT}>Stop</span>
          </Btn>
        ) : (
          <Btn cls="sm" title={`Start its containers (lf start ${name})`} on={() => run(["start", name, ...sv(n)])}>
            <Icon name="start" />
            <span className={TIGHT}>Start</span>
          </Btn>
        )}
      </BtnGroup>
      <MenuBtn
        title={`More for ${name}`}
        cls="sm ghost"
        dots
        items={[
          managed &&
            older.length > 0 && {
              label: "Roll back",
              hint: "lf rollback",
              title: `To ${older[0].id} (${ago(older[0].at)})`,
              run: () =>
                rollbackDialog(n, site, {
                  to: older[0],
                  title: `Roll back ${name}?`,
                  text: `From ${m.current} to ${older[0].id} (${ago(older[0].at)}). Volumes keep their data.`,
                  ok: "Roll back",
                }),
            },
          "-",
          domains.length > 0 && {
            label: "Check now",
            hint: "lf check",
            title: `Request ${domains.join(", ")} over HTTPS from this machine: status, time, certificate`,
            run: () => run(["check", name, ...sv(n)], { server: n }),
          },
          {
            label: "Stats",
            hint: `lf stats ${name}`,
            title: "CPU, memory and network of its containers right now",
            run: () => run(["stats", name, ...sv(n)], { server: n }),
          },
          {
            label: "Traffic",
            hint: `lf traffic ${name}`,
            title: "Its requests, errors, busiest paths and clients",
            run: () => ((S.focus[n] = name), go(n, "traffic")),
          },
          "-",
          ...(ways.length > 1 ? ways : ways.slice(0, 1)).map((w) => ({
            label: ways.length > 1 ? `Tunnel to ${w.label}` : "Open via tunnel",
            hint: "lf tunnel",
            title: "An SSH tunnel straight to the container: test it on localhost, no domain needed",
            run: () => run(w.argv, { server: n }),
          })),
          "-",
          deploys &&
            m.kind === "compose" && {
              label: "Eject…",
              hint: "lf eject",
              title: `Write its Traefik labels into ${tilde(proj.path)}, to run it behind your own Traefik`,
              run: () => ejectDialog(n, name, proj.path),
            },
          { label: m.adopted ? `Forget ${name}` : `Delete ${name}`, cls: "danger", hint: "lf sites rm", run: () => deleteSiteDialog(n, site) },
        ]}
      />
    </div>
  );
  const toggle = () => (open ? S.open.delete(`${n}/${name}`) : S.open.add(`${n}/${name}`), render());
  const det = open && deploys ? S.det[proj.path] : undefined;
  // The open row: what runs and what you do with it on the left, how it is built and where it lives on the right.
  // One row per service; replicas show as a count, the row as its worst container.
  const bySvc = new Map<string, { x: (typeof services)[number]; count: number }>();
  for (const y of services) {
    const e = bySvc.get(y.service);
    if (!e) bySvc.set(y.service, { x: y, count: 1 });
    else {
      e.count++;
      if (worse(y.status, e.x.status)) e.x = y;
    }
  }
  const svcRows = [...bySvc.values()].map(({ x, count }) => {
    const [own, ...named] = svcWays(x.service);
    const live = isUp(x.status);
    const r = scale?.[x.service];
    const want = r?.replicas ?? count;
    const opts = cur?.services.find((y) => y.name === x.service)?.opts;
    return (
      <li key={x.service}>
        <div className={ROW}>
          <StatusDot status={r && r.running < want ? "Up (health: starting)" : x.status} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <b>{x.service}</b>
              {want !== 1 && (
                <span className="mono text-sm" title={r ? `${r.replicas} wanted (${r.source})` : `${count} containers`}>
                  ×{want}
                  {r && (
                    <span className="faint">
                      {" "}
                      · {r.running}/{want} up
                    </span>
                  )}
                </span>
              )}
              <span className="faint text-sm">{x.status.toLowerCase()}</span>
              {r?.update === "rolling" && (
                <Badge title="x-landfall.update: rolling: new containers start and get ready before the old ones stop">rolling</Badge>
              )}
              {r?.split && <Badge title={`Traffic split ${r.split}: lf weight`}>weight {r.weight}</Badge>}
              {r?.match && <Badge title={`Requests with ${r.match} always reach this service: x-landfall.match`}>{r.match}</Badge>}
              {opts?.sticky && <Badge title="Sticky sessions: a cookie pins a client to one container">sticky</Badge>}
              {opts?.healthcheck && <Badge title={`Traefik checks ${opts.healthcheck.path}`}>health check</Badge>}
              {opts?.ratelimit && <Badge title={`${opts.ratelimit.average} requests/s per client`}>rate limit</Badge>}
            </div>
            {own?.domains.length ? (
              <div className="faint text-sm truncate">{own.domains.join(" · ")}</div>
            ) : own?.priv ? (
              <div className="faint text-sm mono">
                :{own.priv}
                {own.path ?? ""} private
              </div>
            ) : null}
          </div>
          <span className={SIDE}>
            {own && live && <TunnelBtn n={n} argv={own.argv} ports={own.ports} label="Tunnel" compact />}
            <ServiceMenu n={n} site={site} x={x} />
          </span>
        </div>
        {/* Private ports it names (lf tunnel blog admin), under it. */}
        {named.map((w) => (
          <div key={w.label} className={cx(ROW, "pt-0 pl-9")}>
            <span className="faint" aria-hidden="true">
              ↳
            </span>
            <span className="min-w-0 flex-1 truncate">
              {w.label}{" "}
              <span className="faint text-sm mono">
                :{w.priv}
                {w.path ?? ""} private
              </span>
            </span>
            {live && (
              <span className={SIDE}>
                <TunnelBtn n={n} argv={w.argv} ports={w.ports} label="Tunnel" compact />
              </span>
            )}
          </div>
        ))}
      </li>
    );
  });
  const facts: [string, ReactNode][] = [];
  facts.push([
    "Kind",
    <>
      {kind}
      {main || !managed ? (
        ""
      ) : (
        <>
          {" "}
          <span className="dim">· domains set in compose.yaml</span>
        </>
      )}
    </>,
  ]);
  if (managed) facts.push(["Login", m.auth?.length ? `${m.auth.map((a) => a.split(":")[0]).join(", ")} (basic auth)` : <span className="dim">public</span>]);
  if (!m.adopted)
    facts.push([
      "Source",
      proj ? (
        <>
          <span className="mono">{tilde(proj.path)}</span> <span className="dim">· redeploy runs there</span>
        </>
      ) : (
        <span className="dim">not deployed from this machine{m.kind === "image" ? "" : " (or the folder moved): Redeploy picks the folder"}</span>
      ),
    ]);
  if (cur?.hooks)
    facts.push([
      "Hooks",
      <>
        <HookList hooks={cur.hooks} />
        <span className="dim text-sm">The live release&apos;s, from package.json: rollback and Delete run them, a deploy reads them anew.</span>
      </>,
    ]);
  facts.push(["Created", `${ago(m.createdAt)} · updated ${ago(m.updatedAt)}`]);
  const detail = (
    <div className="flex flex-col gap-3 py-1.5">
      <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-3">
          <Panel title="Services" count={services.length}>
            {services.length ? <ul className={LIST}>{svcRows}</ul> : <p className="m-0 px-3 py-2.5 dim">none running</p>}
          </Panel>
          <SiteVolumes
            n={n}
            name={name}
            dir={proj?.path}
            edit={
              deploys && proj.kind !== "static"
                ? { path: proj.path, kind: proj.kind, environment: proj.environment, services: services.map((x) => x.service) }
                : undefined
            }
          />
          {m.releases.length > 0 && <SiteReleases n={n} site={site} />}
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          {det !== undefined && (
            <Panel
              title="Build"
              aside={
                det && (
                  <Btn cls="sm ghost" title="Change how it builds: lf deploy --build --start" on={edit}>
                    Edit
                  </Btn>
                )
              }
            >
              <div className="px-3 py-2.5 text-sm">
                {det ? (
                  <>
                    <Stack d={det} className="mb-2" />
                    <Describe d={det} before={false} />
                  </>
                ) : (
                  <span className="faint">{det === false ? "cannot read its folder" : "reading its folder…"}</span>
                )}
              </div>
            </Panel>
          )}
          <Panel title="Details">
            <Kv className="px-3 py-2.5" pairs={facts} />
          </Panel>
          {managed && (m.autodeploy || cur?.git?.sha) && (
            <SiteAutodeploy n={n} name={name} on={!!m.autodeploy} git={cur?.git} proj={deploys ? proj : undefined} />
          )}
          <Panel title={`On ${n}`}>
            <SiteFiles m={m} />
          </Panel>
        </div>
      </div>
    </div>
  );
  // A site deployed with no domain is reached by its tunnel; so are private ports, and any tunnel open now.
  const reach = ways.length > 1 ? ways.filter((w) => tunnelFor(n, w.argv) || ((w.priv || w.label === main) && !w.domains.length && isUp(w.status))) : [];
  const where = (
    <>
      {domains.length ? (
        [...domains.map((d) => <DomainChip key={d} n={n} d={d} />), ...redirects.map((d) => <DomainChip key={d} n={n} d={d} to={redirectTo} />)]
      ) : main && !many ? (
        <span className={CHIP}>
          <span className="faint">no domain</span> <TunnelBtn n={n} argv={["tunnel", name, ...sv(n)]} />
        </span>
      ) : null}
      {reach.map((w) => (
        <span key={w.label} className={cx(CHIP, "gap-1.5")}>
          <span className="faint" title={w.priv ? `private port ${w.priv}: never routed, reached by tunnel only` : undefined}>
            {w.label}
            {w.priv ? " · private" : w.domains.length ? "" : " · no domain"}
          </span>
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
              <b>{name}</b>{" "}
              {open ? <ChevronDown className="size-3.5 text-faint" aria-hidden="true" /> : <ChevronRight className="size-3.5 text-faint" aria-hidden="true" />}
            </button>
            {!!m.auth?.length && (
              <span className="ml-1 text-dim" title="password protected" role="img" aria-label="password protected">
                <Lock className="size-3" aria-hidden="true" />
              </span>
            )}
          </div>
          <div className={cx(CHIPS, SHOW, "mt-1")}>{where}</div>
          {/* On a phone the actions go under the name: in their own narrow column they stack one per line. */}
          <div className={cx(SHOW, "mt-2 [&>div]:justify-start!")}>{acts}</div>
        </td>
        <td className={HIDE}>
          <div className={CHIPS}>{where}</div>
        </td>
        <td className={HIDE}>
          <Badge title={services.map((x) => x.service).join(", ")}>{kind}</Badge>
          {many &&
            (() => {
              const up = services.filter((x) => isUp(x.status)).length;
              return (
                <span
                  className={cx("block mt-1 text-sm", up < services.length ? "text-warn" : "faint")}
                  title={services.map((x) => `${x.service}: ${x.status.toLowerCase()}`).join("\n")}
                >
                  {up < services.length ? `${up} of ${services.length} up` : `${services.length} services`}
                </span>
              );
            })()}
        </td>
        <td className={cx(HIDE, "dim")}>{cur ? ago(cur.at) : ""}</td>
        {/* One line: wrapped, the ⋯ menu would sit alone under the buttons. */}
        <td className={cx(ACTS, HIDE, "[&>div]:flex-nowrap")}>{acts}</td>
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

function SiteFiles({ m }: { m: SiteMeta }) {
  const dir = `${S.state.paths.sites}/${m.name}`;
  const box = "px-3 py-2.5 text-sm flex flex-col gap-1.5 min-w-0";
  // Paths and commands break anywhere: inside the table, a line that cannot wrap widens every row on a phone.
  const line = cx(MONO, "block break-all");
  if (m.adopted)
    return (
      <div className={box}>
        <span className={line}>{m.adopted}</span>
        <span className="dim">
          its own folder; project <span className="mono">{m.project ?? m.name}</span>
        </span>
      </div>
    );
  return (
    <div className={box}>
      <span className={line} title={`${dir}/current is releases/${m.current}`}>
        {dir}/current <span className="dim">→ releases/{m.current}</span>
      </span>
      <span className="faint">compose.yaml · compose.override.yaml (landfall's) · .env (mode 600)</span>
      <span className="faint">run it by hand:</span>
      <code className={cx(line, "rounded-sm bg-hover px-2 py-1")}>cd {dir}/current &amp;&amp; docker compose ps</code>
    </div>
  );
}
