import { useEffect, type ReactNode } from "react";
import { svText, S, plural, render, sv } from "../lib/store";
import { ACCESS_LOG_HINT, accessLogIssue, logLimitText, siteTraffic } from "../../../core/traefik/traffic-merge";
import { bytes, ms } from "../../../core/lib/format";
import type { Cert, Detail, Summary, Traffic } from "../lib/types";
import { ensure, load } from "../lib/api";
import { run } from "../lib/jobs";
import { confirmDlg } from "../ui/dialog";
import { MenuBtn } from "../ui/menu";
import { Actions, Badge, Body, BoneRows, Btn, Card, CardHead, Empty, Note, Spin, Sub, pending, waiting, cx, NUM, HIDE, MONO, Table } from "../ui/kit";
import { Zero, can, size } from "./shared";
import { Meter, Meters } from "./stats";

// ---- traffic ---------------------------------------------------------------

const TRAFFIC_SPANS = [
  ["1h", "Last hour"],
  ["24h", "24 hours"],
  ["7d", "7 days"],
] as const;
const CLASSES = ["2xx", "3xx", "4xx", "5xx"] as const;
const CLASS_COLORS: Record<string, string> = { "2xx": "var(--accent)", "3xx": "var(--faint)", "4xx": "var(--warn)", "5xx": "var(--bad)" };
const count = (v: number) => v.toLocaleString();
const HOUR = new Intl.DateTimeFormat([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
const MINUTE = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit" });

/** Requests per minute or hour, stacked by status class; hover a bar for its numbers. */
function TrafficChart({ series, bucket }: { series: Detail["series"]; bucket: string }) {
  const W = 600,
    H = 120;
  const tot = series.map((x) => x["2xx"] + x["3xx"] + x["4xx"] + x["5xx"]);
  const max = Math.max(1, ...tot);
  const bw = W / series.length;
  const gap = bw > 4 ? 1 : 0;
  const when = (at: string) => (bucket === "hour" ? new Date(`${at}:00:00Z`) : new Date(`${at}:00Z`));
  const label = (at: string) => (bucket === "hour" ? HOUR : MINUTE).format(when(at));
  return (
    <div className="relative">
      <div className="absolute -top-0.5 left-0 text-xs faint">{count(max)}</div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Requests per ${bucket}`}
        className="block w-full h-30 border-b border-line"
      >
        {series.map((x, i) => {
          let y = H;
          const tip = `${label(x.at)}: ${count(tot[i])} requests${(["4xx", "5xx"] as const)
            .filter((k) => x[k])
            .map((k) => `, ${count(x[k])} ${k}`)
            .join("")}`;
          return (
            <g key={x.at}>
              <title>{tip}</title>
              <rect x={i * bw} y={0} width={bw} height={H} fill="transparent" />
              {CLASSES.filter((k) => x[k]).map((k) => {
                const h = Math.max(1, (x[k] / max) * (H - 4));
                y -= h;
                return <rect key={k} x={i * bw + gap / 2} y={y} width={Math.max(0.5, bw - gap)} height={h} fill={CLASS_COLORS[k]} />;
              })}
            </g>
          );
        })}
      </svg>
      <div className="grid grid-cols-3 text-xs faint mt-1">
        {[0, Math.floor(series.length / 2), series.length - 1].map((i, j) => (
          <span key={j} className={["text-left", "text-center", "text-right"][j]}>
            {label(series[i].at)}
          </span>
        ))}
      </div>
      <div className="flex gap-3.5 text-xs text-dim mt-2">
        {Object.entries(CLASS_COLORS).map(([k, col]) => (
          <span key={k}>
            <i className="inline-block w-2.5 h-2.5 rounded-xs mr-1.25 align-[-1px]" style={{ background: col }} />
            {k}
          </span>
        ))}
      </div>
    </div>
  );
}

const ErrorCell = ({ status }: { status: number }) => <Badge kind={status >= 500 ? "bad" : "warn"}>{status}</Badge>;

/** A card with a table, or nothing when there are no rows. */
function List({ title, cols, rows }: { title: string; cols: [string, string?][]; rows: ReactNode[] }) {
  if (!rows.length) return null;
  return (
    <Card>
      <CardHead>{title}</CardHead>
      <Table cols={cols}>{rows}</Table>
    </Card>
  );
}

/** Why Traefik's access log shows nothing here, with a button for `lf traefik access-log` where it can fix it. */
function AccessLogNote({ n, t }: { n: string; t: Traffic }) {
  const issue = accessLogIssue(t);
  if (!issue) return null;
  const fix = (label: string) => (
    <Btn
      cls="sm"
      title="lf traefik access-log: recreates Traefik, requests fail for a moment"
      on={() => run(["traefik", "access-log", ...sv(n), "-y"], { server: n, after: () => (load(n, "traffic", true), []) })}
    >
      {label}
    </Btn>
  );
  if (issue.kind === "file")
    return (
      <Note kind="warn">
        Traefik writes its access log to a file inside its container, and landfall reads its output. Remove <span className="mono">--accesslog.filepath</span>{" "}
        from its command.
      </Note>
    );
  if (issue.kind === "off") return <Note kind="warn">Traefik has no access log, so landfall cannot count requests. {fix("Turn on access log")}</Note>;
  return (
    <Note kind="warn">
      Traefik writes its access log as plain text. {issue.fixable ? fix("Switch to JSON") : `To switch it to JSON, ${ACCESS_LOG_HINT}, then recreate it.`}
    </Note>
  );
}

/** lf traefik access-log on, off and clear: what the proxy's log allows. */
function AccessLogMenu({ n, t }: { n: string; t: Traffic }) {
  const after = () => (load(n, "traffic", true), []);
  const recreate = t.own ? "recreates your Traefik from its compose file" : "rewrites and restarts landfall's Traefik";
  const turn = (on: boolean) => ({
    label: on ? "Turn on" : "Turn off",
    hint: `lf traefik access-log ${on ? "on" : "off"}`,
    run: () =>
      confirmDlg({
        title: `Turn ${on ? "on" : "off"} Traefik's access log on ${n}?`,
        text: `This ${recreate}: requests fail for a moment. lf undo reverts it.${on ? "" : " This tab then has nothing new to count."}`,
        ok: on ? "Turn on" : "Turn off",
        danger: !on,
        onOk: () => run(["traefik", "access-log", on ? "on" : "off", ...sv(n), "-y"], { server: n, after }),
      }),
  });
  const size = t.log?.bytes === undefined ? "" : ` (${bytes(t.log.bytes)})`;
  return (
    <MenuBtn
      title="Traefik's access log"
      label="Access log"
      items={[
        (t.accessLog === "off" || t.accessLog === "common") && turn(true),
        (t.accessLog === "json" || t.accessLog === "common" || t.accessLog === "file") && turn(false),
        "-",
        t.log?.driver === "json-file" && {
          label: "Clear…",
          cls: "danger",
          hint: "lf traefik access-log clear",
          run: () =>
            confirmDlg({
              title: `Empty Traefik's log on ${n}${size}?`,
              text: "The requests counted here and Traefik's own messages go. This cannot be undone.",
              ok: "Empty log",
              danger: true,
              onOk: () => run(["traefik", "access-log", "clear", ...sv(n), "-y"], { server: n, after }),
            }),
        },
      ]}
    />
  );
}

/** Traefik's access log: requests, errors, response times, by site and path. */
export function TrafficView({ n }: { n: string }) {
  useEffect(() => ensure("certs", n, "/certs"));
  const st = S.traffic[n];
  const spans = (
    <Actions className="m-0 mb-3.5">
      {TRAFFIC_SPANS.map(([v, l]) => (
        <Btn key={v} cls={`sm${S.since === v ? " primary" : ""}`} title={`lf traffic --since ${v}`} on={() => ((S.since = v), load(n, "traffic", true))}>
          {l}
        </Btn>
      ))}
      {st?.data?.proxy && (
        <span className="ml-auto">
          <AccessLogMenu n={n} t={st.data} />
        </span>
      )}
    </Actions>
  );
  const wait = pending(st, "reading Traefik's access log…");
  if (wait)
    return (
      <>
        {spans}
        {wait}
      </>
    );
  const t = st!.data!;
  if (!t.proxy) return <Note>No Traefik on {n}: nothing to count. Set up the server to install it.</Note>;
  // A log landfall cannot read: why, and the fix, instead of an empty span.
  const logNote = <AccessLogNote n={n} t={t} />;
  if (t.format !== "json" && accessLogIssue(t))
    return (
      <>
        {logNote}
        <CertsCard n={n} />
      </>
    );
  if (t.format === "none")
    return (
      <>
        {spans}
        <Card>
          <Empty title="No requests in this span">
            <p className="dim">
              Traefik's access log has nothing from the last {S.since}.
              {t.own && t.accessLog === "unknown" && <> If your Traefik has no access log, {ACCESS_LOG_HINT}.</>}
            </p>
          </Empty>
        </Card>
        <CertsCard n={n} />
      </>
    );
  // One site alone, from the hosts already read: the same numbers as lf traffic <site>.
  const focus = S.focus[n];
  const show = (site?: string) => ((S.focus[n] = site), render());
  const back = focus && (
    <Btn cls="sm" title="every site again" on={() => show()}>
      ← All sites
    </Btn>
  );
  const T = focus ? siteTraffic(t, focus) : t.total;
  const cmd = `lf traffic${focus ? ` ${focus}` : ""} --since ${S.since}${svText(n)}`;
  if (!T)
    return (
      <>
        {spans}
        <Card>
          <Empty title={`No requests for ${focus} in this span`}>
            <p className="dim">Traefik's access log has nothing for it from the last {S.since}.</p>
            {back}
          </Empty>
        </Card>
      </>
    );
  const errs = T.classes["4xx"] + T.classes["5xx"];
  const pct = (v: number) => (T.requests ? Math.round((v / T.requests) * 1000) / 10 : 0);
  const other = t.hosts.filter((h) => !h.site);
  const row = (key: string, label: ReactNode, x: Summary, site: string) => (
    <tr key={key} className="cursor-pointer hover:[&>td]:bg-hover" title={`lf traffic ${site}`} onClick={() => show(site)}>
      <td>{label}</td>
      <td className={NUM}>{count(x.requests)}</td>
      <td className={NUM}>{x.classes["4xx"] ? <Badge kind="warn">{count(x.classes["4xx"])}</Badge> : <Zero />}</td>
      <td className={NUM}>{x.classes["5xx"] ? <Badge kind="bad">{count(x.classes["5xx"])}</Badge> : <Zero />}</td>
      <td className={cx(NUM, HIDE)}>{ms(x.p50)}</td>
      <td className={cx(NUM, HIDE)}>{ms(x.p95)}</td>
      <td className={cx(NUM, HIDE)}>{size(x.bytes)}</td>
    </tr>
  );
  const reach =
    t.from && +new Date(t.from) - (Date.now() - t.since * 1000) > (t.bucket === "hour" ? 2 * 3_600_000 : 120_000)
      ? ` · the log reaches back to ${new Date(t.from).toLocaleString()}`
      : "";
  return (
    <>
      {focus ? (
        <div className="flex items-center gap-2.5 mb-3.5">
          {back}
          <b>{focus}</b>
          <span className="faint">{t.sites.find((x) => x.site === focus)?.hosts.join(" ") ?? ""}</span>
        </div>
      ) : null}
      {logNote}
      {spans}
      <Meters>
        <Meter label="Requests" p={null} value={count(T.requests)} sub={`${focus ? focus : plural(t.sites.length, "site")} · ${size(T.bytes)} sent`} />
        <Meter label="Server errors" p={null} value={count(T.classes["5xx"])} sub={`${pct(T.classes["5xx"])}% · 5xx: the site failed`} />
        <Meter label="Client errors" p={null} value={count(T.classes["4xx"])} sub={`${pct(T.classes["4xx"])}% · 4xx: not found, denied`} />
        <Meter
          label="Response time"
          p={null}
          value={ms(T.p50)}
          sub={`median · 95% within ${ms(T.p95)}`}
          hint="From Traefik receiving the request to the last byte sent"
        />
      </Meters>
      <Card>
        <CardHead>
          Requests per {t.bucket} {errs ? <Sub>{count(errs)} failed</Sub> : null}
        </CardHead>
        <Body>
          <TrafficChart series={T.series} bucket={t.bucket} />
        </Body>
      </Card>
      {!focus && (
        <Card>
          <CardHead>
            By site <Sub>click one for its paths, errors and clients</Sub>
          </CardHead>
          <Table
            head={
              <>
                <th>Site</th>
                <th className={NUM}>Requests</th>
                <th className={NUM}>4xx</th>
                <th className={NUM}>5xx</th>
                <th className={cx(NUM, HIDE)}>Median</th>
                <th className={cx(NUM, HIDE)}>95%</th>
                <th className={cx(NUM, HIDE)}>Sent</th>
              </>
            }
          >
            {t.sites.map((x) =>
              row(
                `s:${x.site}`,
                <>
                  <b>{x.site}</b>
                  <div className="faint">{x.hosts.join(" ")}</div>
                </>,
                x,
                x.site,
              ),
            )}
            {other.slice(0, 10).map((h) => row(`h:${h.host}`, <span className="mono dim">{h.host}</span>, h, h.host))}
          </Table>
          {other.length > 0 && (
            <Body className="faint pt-0">
              Hosts without a site: bots asking for the server's IP or old domains{other.length > 10 ? `, ${other.length - 10} more` : ""}.
            </Body>
          )}
        </Card>
      )}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(320px,1fr))] gap-x-4 gap-y-5 mt-5 [&>.card]:mt-0! [&+.card]:mt-5">
        <List
          title="Failing requests"
          cols={[["Status"], ["Path"], ["Requests", NUM]]}
          rows={T.errors.map((e, i) => (
            <tr key={i}>
              <td>
                <ErrorCell status={e.status} />
              </td>
              <td className="mono">{e.path}</td>
              <td className={NUM}>{count(e.count)}</td>
            </tr>
          ))}
        />
        <List
          title="Busiest paths"
          cols={[["Path"], ["Requests", NUM], ["Failed", NUM]]}
          rows={T.paths.map((p) => (
            <tr key={p.path}>
              <td className="mono">{p.path}</td>
              <td className={NUM}>{count(p.count)}</td>
              <td className={NUM}>{p.errors ? <Badge kind="warn">{count(p.errors)}</Badge> : null}</td>
            </tr>
          ))}
        />
      </div>
      <List
        title="Clients"
        cols={[["IP"], ["Requests", NUM]]}
        rows={T.ips.map((i) => (
          <tr key={i.ip}>
            <td className="mono">{i.ip}</td>
            <td className={NUM}>{count(i.count)}</td>
          </tr>
        ))}
      />
      {!focus && <CertsCard n={n} />}
      <p className="faint mt-3.5">
        {st.loading && (
          <>
            <Spin />{" "}
          </>
        )}
        from Traefik's access log{t.log && logLimitText(t.log) && <> ({logLimitText(t.log)})</>}, read {new Date(t.at).toLocaleTimeString()}
        {reach} · <span className="mono">{cmd}</span>
      </p>
    </>
  );
}

/** Each site domain's certificate: days left, who issued it, why getting one failed. */
export function CertsCard({ n }: { n: string }) {
  const st = S.certs[n];
  const head = (
    <CardHead>
      Certificates <Sub className={MONO}>lf certs</Sub>
    </CardHead>
  );
  if (waiting(st))
    return (
      <Card aria-busy="true">
        {head}
        <BoneRows rows={2} />
      </Card>
    );
  const wait = pending(st, "reading certificates…");
  if (wait)
    return (
      <Card>
        {head}
        <Body>{wait}</Body>
      </Card>
    );
  const r = st!.data!;
  if (!r.domains.length) return null;
  const days = (c?: Cert) =>
    !c ? (
      <Badge kind="bad">none</Badge>
    ) : c.days < 7 ? (
      <Badge kind="bad">{c.days < 0 ? "expired" : plural(c.days, "day")}</Badge>
    ) : c.staging ? (
      <Badge kind="warn">staging</Badge>
    ) : (
      <Badge kind={c.days < 30 ? "warn" : "ok"}>{plural(c.days, "day")}</Badge>
    );
  return (
    <Card>
      {head}
      {r.denied.length > 0 && (
        <Body>
          <Note kind="warn" className="m-0">
            {r.denied.join(", ")} needs root to read: this login has no passwordless sudo.
          </Note>
        </Body>
      )}
      <Table
        head={
          <>
            <th>Domain</th>
            <th className={HIDE}>Site</th>
            <th>Left</th>
            <th className={HIDE}>Expires</th>
            <th className={HIDE}>Issuer</th>
          </>
        }
      >
        {r.domains.map((d) => (
          <tr key={d.domain}>
            <td>
              {d.domain}
              {d.error && (!d.cert || d.cert.days < 30) ? <div className="faint text-bad!">{d.error.error}</div> : null}
            </td>
            <td className={cx(HIDE, "dim")}>{d.site ?? `→ ${d.redirect}`}</td>
            <td>{days(d.cert)}</td>
            <td className={cx(HIDE, "dim")}>{d.cert ? new Date(d.cert.expires).toLocaleDateString() : ""}</td>
            <td className={cx(HIDE, "faint")}>{d.cert?.issuer ?? ""}</td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}

/** The sites tab: what failed in the last 24 hours, only when something did. */
export function ErrorsCard({ n }: { n: string }) {
  const docker = !!can(n)?.docker;
  useEffect(() => {
    if (docker) ensure("errs", n, "/traffic?since=24h");
  });
  if (!docker) return null;
  const t = S.errs[n]?.data;
  if (!t || t.format !== "json") return null;
  const rows = t.hosts
    .flatMap((h) => h.errors.map((e) => ({ ...e, where: h.site ?? h.host, site: !!h.site })))
    .filter((e) => e.site || e.status >= 500)
    .sort((a, b) => +(b.status >= 500) - +(a.status >= 500) || b.count - a.count)
    .slice(0, 6);
  if (!rows.length) return null;
  const fives = t.total.classes["5xx"];
  return (
    <Card>
      <CardHead>
        Errors in the last 24h{" "}
        <Sub>
          {fives ? `${count(fives)} server errors · ` : ""}
          {count(t.total.classes["4xx"])} client errors
        </Sub>
        <Actions>
          <Btn cls="sm" on={() => (location.hash = `#/${encodeURIComponent(n)}/traffic`)}>
            Traffic
          </Btn>
        </Actions>
      </CardHead>
      <Table
        head={
          <>
            <th>Status</th>
            <th>Site</th>
            <th>Path</th>
            <th className={NUM}>Requests</th>
          </>
        }
      >
        {rows.map((e, i) => (
          <tr key={i}>
            <td>
              <ErrorCell status={e.status} />
            </td>
            <td>{e.site ? <b>{e.where}</b> : <span className="mono dim">{e.where}</span>}</td>
            <td className="mono">{e.path}</td>
            <td className={NUM}>{count(e.count)}</td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}
