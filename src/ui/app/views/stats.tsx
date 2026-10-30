import type { ReactNode } from "react";
import { svText, S, http, plural, render, sv, errorMessage } from "../lib/store";
import type { DiskUsage, PrunePlan } from "../lib/types";
import { STATS_LOG, fetchInto, load } from "../lib/api";
import { run } from "../lib/jobs";
import { dialog, type Values } from "../ui/dialog";
import { JOURNAL_KEEP, kept, reclaimable, removable, removableVolumes, shortName, totalSize } from "../../../core/reclaim";
import { toast } from "../ui/toast";
import { Badge, Body, Btn, Card, CardHead, Actions, Note, Spin, Sub, Loading, pending, cx, NUM, HIDE, Table } from "../ui/kit";
import { Zero, pct, StatusDot, isUp, size } from "./shared";
import { RotateCw } from "lucide-react";

// ---- stats ---------------------------------------------------------------------

/** A sparkline of 0-100 values, oldest left. */
function Spark({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const pts = values.map((v, i) => `${((STATS_LOG - values.length + i) / (STATS_LOG - 1)) * 100},${24 - (Math.min(100, v) / 100) * 22}`).join(" ");
  return (
    <svg viewBox="0 0 100 26" preserveAspectRatio="none" aria-hidden="true" className="flex-1 min-w-0 h-[26px] text-accent">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** A tile with a big value, a bar when p is a percentage, and a line under it. */
export function Meter({ label, p, value, sub, line, hint }: { label: string; p: number | null; value: ReactNode; sub: ReactNode; line?: ReactNode; hint?: string }) {
  const bar = p === null ? "" : p >= 90 ? "bg-bad" : p >= 70 ? "bg-warn" : "bg-ok";
  return (
    <div className="bg-panel border border-line rounded-md px-3.5 py-3 shadow-xs min-w-0" title={hint}>
      <div className="flex justify-between gap-2 text-sm text-dim"><span className="overflow-hidden text-ellipsis whitespace-nowrap">{label}</span></div>
      <div className="flex items-end gap-2.5 text-[20px] font-semibold tabular-nums mt-0.5 mb-1.5 whitespace-nowrap">{value}{line}</div>
      {p !== null && (
        <div className="h-1.5 rounded-[3px] bg-line overflow-hidden" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={p}>
          <i className={cx("block h-full rounded-[3px]", bar)} style={{ width: `${Math.min(100, p)}%` }} />
        </div>
      )}
      <div className="text-xs text-faint mt-1.5 overflow-hidden text-ellipsis whitespace-nowrap">{sub}</div>
    </div>
  );
}
export const Meters = ({ children }: { children: ReactNode }) => <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3 mb-5">{children}</div>;

/** Live usage of one server: meters, the busiest processes and containers, disk usage on request. */
export function StatsView({ n }: { n: string }) {
  const st = S.stats[n];
  const wait = pending(st, `measuring ${n} for a second…`, () => load(n, "stats", true));
  if (wait) return wait;
  const s = st!.data!;
  const log = S.statsLog[n] ?? [];
  const memUsed = s.mem.total - s.mem.available;
  const swapUsed = s.mem.swapTotal - s.mem.swapFree;
  const procs = s.procs.slice(0, 8);
  const up = (x: { status: string }) => isUp(x.status);
  return (
    <>
      <Meters>
        <Meter label="CPU" p={s.cpu} value={`${s.cpu}%`} sub={`${plural(s.cpus, "core")} · load ${s.load.join(" ")}`} line={<Spark values={log.map((x) => x.cpu)} />} hint="Busy share of all cores over one second; load is the 1, 5 and 15 minute average" />
        <Meter label="Memory" p={pct(memUsed, s.mem.total)} value={`${pct(memUsed, s.mem.total)}%`} sub={`${size(memUsed)} of ${size(s.mem.total)}`} line={<Spark values={log.map((x) => x.mem)} />} hint="Used, without caches the kernel gives back when needed" />
        {!!s.mem.swapTotal && <Meter label="Swap" p={pct(swapUsed, s.mem.swapTotal)} value={`${pct(swapUsed, s.mem.swapTotal)}%`} sub={`${size(swapUsed)} of ${size(s.mem.swapTotal)}`} />}
        {s.disks.map((d) => (
          <Meter key={d.mount} label={`Disk ${d.mount}`} p={pct(d.used, d.total)} value={`${pct(d.used, d.total)}%`} sub={`${size(d.used)} of ${size(d.total)} · ${size(d.available)} free`} />
        ))}
        {s.net.map((x) => <Meter key={x.iface} label={`Network ${x.iface}`} p={null} value={`↓ ${size(x.rx)}/s`} sub={`↑ ${size(x.tx)}/s`} />)}
      </Meters>
      {!s.docker ? (
        <Note>No access to Docker on {n}: containers are not shown. Set up the server to fix that.</Note>
      ) : (
        s.containers.length > 0 && (
          <Card>
            <CardHead>Containers <Badge>{s.containers.length}</Badge></CardHead>
            <Table head={<><th>Container</th><th className={HIDE}>Site</th><th className={NUM}>CPU</th><th className={NUM}>Memory</th><th className={cx(NUM, HIDE)} title="Received and sent since the container started">Network in / out</th><th className={cx(NUM, HIDE)}>Restarts</th></>}>
              {s.containers.map((x) => (
                <tr key={x.name}>
                  <td><StatusDot status={x.status} /><span className="mono">{x.name}</span><div className="faint">{x.image}</div></td>
                  <td className={HIDE}>{x.site ? <b>{x.site}</b> : <span className="faint">{x.project || "-"}</span>}</td>
                  <td className={NUM}>{up(x) ? `${Math.round(x.cpu * 10) / 10}%` : ""}</td>
                  <td className={NUM}>
                    {up(x) ? (
                      <>
                        {size(x.mem)}
                        {x.memLimit && x.memLimit < s.mem.total ? <div className="faint" title="Set by mem_limit or deploy.resources in its compose file">limit {size(x.memLimit)}</div> : null}
                      </>
                    ) : (
                      <span className="faint">{x.status}</span>
                    )}
                  </td>
                  <td className={cx(NUM, HIDE)} title="since the container started">{up(x) ? <>↓ {size(x.net.rx)} <span className="faint">·</span> ↑ {size(x.net.tx)}</> : ""}</td>
                  <td className={cx(NUM, HIDE)}>{x.restarts ? <Badge kind="warn">{x.restarts}</Badge> : <Zero />}</td>
                </tr>
              ))}
            </Table>
          </Card>
        )
      )}
      {procs.length > 0 && (
        <Card>
          <CardHead>Processes <Sub>busiest and largest · cpu 100% = one core</Sub></CardHead>
          <Table head={<><th>Name</th><th className={NUM}>CPU</th><th className={NUM}>Memory</th><th className={cx(NUM, HIDE)}>PID</th></>}>
            {procs.map((p) => (
              <tr key={p.pid}><td className="mono">{p.name}</td><td className={NUM}>{p.cpu}%</td><td className={NUM}>{size(p.rss)}</td><td className={cx(NUM, "faint", HIDE)}>{p.pid}</td></tr>
            ))}
          </Table>
        </Card>
      )}
      <DiskCard n={n} />
      <p className="faint my-3.5">
        {st.loading && <><Spin />{" "}</>}
        {st.error && <><span className="text-bad">last sample failed: {st.error}</span> · </>}
        measured {new Date(s.at).toLocaleTimeString()} · new sample every 5s while this tab is open · <span className="mono">lf stats -w{svText(n)}</span>
      </p>
    </>
  );
}

function loadDisk(n: string) {
  fetchInto("disk", n, "/disk");
  render();
}
/** d: the loaded disk usage, which has the log sizes the plan only measures for --logs. */
// Servers whose clean-up plan is being worked out: it takes a few seconds, the button says so.
const planning = new Set<string>();
function pruneFlow(n: string, d: DiskUsage) {
  if (planning.has(n)) return;
  planning.add(n);
  render();
  const done = () => (planning.delete(n), render());
  http<PrunePlan>(`/api/servers/${encodeURIComponent(n)}/prune`).finally(done).then((p) => {
    // The plan comes unsized: the disk view has every volume's size already.
    const sizes = new Map(d.volumes.map((v) => [v.name, v.size]));
    for (const v of p.volumes ?? []) v.size = sizes.get(v.name) ?? 0;
    p.volumes?.sort((a, b) => b.size - a.size);
    const imgs = removable(p);
    const tagged = kept(p, "tagged");
    const vols = removableVolumes(p);
    const left = p.leftovers ?? [];
    const logs = { root: d.root, size: d.logs.reduce((t, l) => t + (l.size ?? 0), 0), journal: d.journald };
    // The plan as the ticked boxes make it: --all frees the tagged images too.
    const most = (v: Values) => reclaimable({ ...p, images: v.all ? p.images.map((i) => (i.keep === "tagged" ? { ...i, keep: undefined } : i)) : p.images, logs: v.logs ? logs : undefined, volumes: v.volumes ? p.volumes : undefined, leftovers: v.volumes ? left : undefined });
    const keep = ([[kept(p, "release").length, "for rollback"], [kept(p, "undo").length, "for undo"], [kept(p, "used").length, "in use"]] as const).filter(([k]) => k).map(([k, w]) => `${k} ${w}`).join(", ");
    dialog({
      title: `Clean up ${n}?`,
      text: `${plural(imgs.length, "unused image")}, ${size(p.buildCache)} of build cache${p.networks.length ? ` and ${plural(p.networks.length, "unused network")}` : ""}.${keep ? ` Kept: ${keep}.` : ""} Containers stay.`,
      fields: [
        ...(tagged.length ? [{ name: "all", type: "check" as const, label: `Also ${plural(tagged.length, "unused tagged image")}`, hint: "Pulled again when a site needs them" }] : []),
        ...(vols.length || left.length
          ? [{
              name: "volumes",
              type: "check" as const,
              label: `Also delete ${[vols.length && plural(vols.length, "unused volume"), left.length && `the backups of ${plural(left.length, "removed site")}`].filter(Boolean).join(" and ")} (${size(totalSize(vols) + totalSize(left))})`,
              hint: `${vols.length ? `No container mounts these volumes and no site owns them: ${vols.slice(0, 3).map((x) => shortName(x.name)).join(", ")}${vols.length > 3 ? ", …" : ""}. ` : ""}${left.length ? `Backups lf sites rm kept: ${left.slice(0, 3).map((l) => l.site).join(", ")}${left.length > 3 ? ", …" : ""}. ` : ""}Gone for good. lf prune --volumes`,
            }]
          : []),
        {
          name: "logs",
          type: "check",
          label: `Also empty container logs${d.root ? ` (${size(logs.size)})` : ""} and shrink the systemd journal${d.journald ? ` (${size(d.journald)})` : ""}`,
          hint: `Old log lines are gone for good; the journal keeps its newest ${JOURNAL_KEEP}. Needs root. lf prune --logs`,
          // Last field, so the total sits under all the boxes.
          preview: (v) => `Frees up to ${size(most(v))}${v.logs && !d.root ? " and the logs" : ""}.`,
        },
      ],
      ok: "Clean up",
      danger: true,
      onOk: (v) => run(["prune", ...sv(n), "-y", ...(v.all ? ["--all"] : []), ...(v.logs ? ["--logs"] : []), ...(v.volumes ? ["--volumes"] : [])], { server: n, after: () => (loadDisk(n), []) }),
    });
  }, (e) => toast(errorMessage(e)));
}

const H3 = ({ children }: { children: ReactNode }) => <h3 className="mt-4 mx-[18px] mb-1.5 text-sm text-dim font-semibold">{children}</h3>;

function DiskCard({ n }: { n: string }) {
  const st = S.disk[n];
  const head = (acts: ReactNode) => (
    <CardHead>Disk usage <Sub>images, volumes, build cache, sites and logs</Sub><Actions>{acts}</Actions></CardHead>
  );
  if (!st)
    return (
      <Card>
        {head(<Btn cls="sm" on={() => loadDisk(n)} title="lf disk: sums up folders, takes a few seconds">Analyze</Btn>)}
        <Body className="dim">Where the space goes. Sums up folders on the server, so only on request.</Body>
      </Card>
    );
  if (!st.data)
    return (
      <Card>
        {head(st.loading ? null : <Btn cls="sm" on={() => loadDisk(n)}>Retry</Btn>)}
        {st.loading ? <Loading>adding up folders…</Loading> : <Body><Note kind="bad" className="m-0">{st.error}</Note></Body>}
      </Card>
    );
  const d = st.data;
  const vols = d.volumes.filter((x) => x.size > 0).slice(0, 10);
  const lg = d.logs.filter((x) => (x.size ?? 0) > 0).slice(0, 10);
  const notes = [
    d.journald ? `systemd journal: ${size(d.journald)}` : "",
    d.docker ? "" : "No access to Docker: images, volumes and logs are not shown.",
    d.root ? "" : "Without root or passwordless sudo, root-owned folders and container logs may be missing.",
  ].filter(Boolean);
  return (
    <Card>
      {head(
        <>
          {d.docker && <Btn cls="sm" on={() => pruneFlow(n, d)} disabled={planning.has(n)} title="lf prune: remove unused images, the build cache and optionally logs">{planning.has(n) && <><Spin />{" "}</>}Clean up</Btn>}
          <Btn cls="sm" on={() => loadDisk(n)} title="Analyze again" aria-label="Analyze again"><RotateCw className="inline-block size-3.5 -mt-px align-middle" aria-hidden="true" /></Btn>
        </>,
      )}
      {d.dockerDf.length > 0 && (
        <>
          <H3>Docker</H3>
          <Table cols={[["Kind"], ["Count", NUM], ["In use", NUM], ["Size", NUM], ["Reclaimable", NUM]]}>
            {d.dockerDf.map((x) => (
              <tr key={x.type}>
                <td>{x.type}</td><td className={NUM}>{x.count}</td><td className={NUM}>{x.active}</td><td className={NUM}>{size(x.size)}</td>
                <td className={NUM}>{x.reclaimable ? <Badge kind="warn">{size(x.reclaimable)}</Badge> : <Zero />}</td>
              </tr>
            ))}
          </Table>
        </>
      )}
      {d.sites.length > 0 && (
        <>
          <H3>Sites <span className="faint mono">{S.state.paths.sites}</span></H3>
          <Table cols={[["Site"], ["Files", NUM], ["Releases", NUM]]}>
            {d.sites.map((x) => (
              <tr key={x.name}><td>{x.name}</td><td className={NUM}>{size(x.size)}</td><td className={NUM}>{x.releases} · {size(x.releasesSize)}</td></tr>
            ))}
          </Table>
        </>
      )}
      {vols.length > 0 && (
        <>
          <H3>Largest volumes</H3>
          <Table cols={[["Volume"], ["Size", NUM], ["Used by", NUM]]}>
            {vols.map((x) => (
              <tr key={x.name}><td className="mono">{x.name}</td><td className={NUM}>{size(x.size)}</td><td className={NUM}>{x.links ? plural(x.links, "container") : <Badge kind="warn">nothing</Badge>}</td></tr>
            ))}
          </Table>
        </>
      )}
      {lg.length > 0 && (
        <>
          <H3>Largest container logs</H3>
          <Table cols={[["Container"], ["Size", NUM]]}>
            {lg.map((x) => <tr key={x.container}><td className="mono">{x.container}</td><td className={NUM}>{size(x.size ?? 0)}</td></tr>)}
          </Table>
        </>
      )}
      {notes.length ? <Body className="faint">{notes.map((x, i) => <div key={i}>{x}</div>)}</Body> : <div className="h-2" />}
    </Card>
  );
}
