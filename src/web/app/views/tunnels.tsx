import { sv } from "../lib/store";
import type { Overview } from "../lib/types";
import { go } from "../lib/api";
import { TunnelBtn, openTunnels } from "../lib/jobs";
import { ACTS, Badge, Btn, Card, CardHead, Empty, Lede, MONO, NAME, SHOW, HIDE, SR, Scroll, cx } from "../ui/kit";
import { StatusDot } from "./shared";

// ---- tunnels -------------------------------------------------------------------

const Chips = ({ list, className }: { list: string[]; className?: string }) => (
  <div className={cx("flex flex-col gap-[3px] items-start", className)}>
    {list.map((d) => <span key={d} className="inline-flex items-center gap-0.5 max-w-full">{d}</span>)}
  </div>
);

interface Target { name: string; status?: string; serves: string[]; argv: string[] | null; why?: string; other?: boolean }

/** Everything an SSH tunnel reaches on server n, and the tunnels open now. */
export function TunnelsView({ n, o }: { n: string; o: Overview }) {
  if (!o.ready && !o.others.length && !o.unrouted?.length)
    return (
      <Card>
        <Empty title="Nothing to tunnel to yet"><p className="my-[1em]">Set up the server and deploy a site first.</p></Empty>
      </Card>
    );
  const open = openTunnels(n);
  const targets: Target[] = [];
  const dashArgv = ["traefik", "dashboard", ...sv(n)];
  targets.push({ name: "Traefik dashboard", status: o.traefik, serves: o.dashboard.hosts, argv: o.dashboard.tunnel ? dashArgv : null, why: "no tunnel yet: see Traefik" });
  for (const x of o.sites) {
    if (x.state === "old") continue;
    // One row per service when a site has several: each is its own container.
    const many = x.services.length > 1;
    if (!many) targets.push({ name: x.meta.name, status: x.status, serves: x.domains, argv: ["tunnel", x.meta.name, ...sv(n)] });
    else for (const svc of x.services) targets.push({ name: `${x.meta.name} · ${svc.service}`, status: svc.status, serves: svc.service === x.main ? x.domains : [], argv: ["tunnel", x.meta.name, svc.service, ...sv(n)] });
  }
  for (const e of o.others) targets.push({ name: e.name, status: e.status, serves: e.domains, argv: ["tunnel", e.name, ...sv(n)], other: true });
  // Databases, workers: by Compose project and service, else by container name.
  const loose = (o.unrouted ?? []).map((x) => ({ name: x.container, status: x.status, image: x.image, ports: x.ports ?? [], argv: ["tunnel", ...(x.project && x.service ? [x.project, x.service] : [x.container]), ...sv(n)] }));
  return (
    <>
      {open.length > 0 && (
        <Card>
          <Scroll>
            <CardHead>Open <Badge kind="ok">{open.length}</Badge></CardHead>
            <table>
              <tbody>
                {open.map((j) => (
                  <tr key={j.info.id}>
                    <td><b className={MONO}>lf {j.info.argv.filter((a, i, l) => a !== "-s" && l[i - 1] !== "-s").join(" ")}</b></td>
                    <td className={ACTS}><TunnelBtn n={n} argv={j.info.argv} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Scroll>
        </Card>
      )}
      <Card>
        <Scroll>
          <CardHead>Tunnel to</CardHead>
          <Lede>An SSH tunnel forwards a port on this machine to a container on {n}: test a site on localhost with no domain, HTTPS or login. Nothing changes on the server, and closing the tunnel ends it.</Lede>
          <table>
            <thead><tr><th>Container</th><th className={HIDE}>Domains</th><th><span className={SR}>Tunnel</span></th></tr></thead>
            <tbody>
              {targets.map((t) => (
                <tr key={t.name}>
                  <td>
                    <div className={NAME}>{t.status && <StatusDot status={t.status} />}<b>{t.name}</b>{t.other && <>&nbsp;<span className="faint">not landfall's</span></>}</div>
                    <Chips list={t.serves} className={cx(SHOW, "mt-1")} />
                  </td>
                  <td className={HIDE}><Chips list={t.serves} /></td>
                  <td className={ACTS}>
                    {t.argv ? <TunnelBtn n={n} argv={t.argv} /> : <><span className="dim">{t.why}</span> <Btn cls="sm" on={() => go(n, "traefik")}>Traefik</Btn></>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Scroll>
      </Card>
      {loose.length > 0 && (
        <Card>
          <Scroll>
            <CardHead>Other containers <Badge>{loose.length}</Badge></CardHead>
            <Lede>Running, but no domain routes to them: databases, caches, workers. The tunnel goes to the port their image exposes.</Lede>
            <table>
              <thead><tr><th>Container</th><th className={HIDE}>Image</th><th><span className={SR}>Tunnel</span></th></tr></thead>
              <tbody>
                {loose.map((t) => (
                  <tr key={t.name}>
                    <td>
                      <div className={NAME}><StatusDot status={t.status} /><b>{t.name}</b></div>
                      <div className={cx(SHOW, "faint", MONO)}>{t.image}</div>
                    </td>
                    <td className={cx(HIDE, "faint", MONO)}>{t.image}</td>
                    <td className={ACTS}><TunnelBtn n={n} argv={t.argv} ports={t.ports} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Scroll>
        </Card>
      )}
    </>
  );
}
