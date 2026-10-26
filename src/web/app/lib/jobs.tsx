import { useLayoutEffect, useRef } from "react";
import { S, http, render, errorMessage, type Any } from "./store";
import { invalidate, refreshState } from "./api";
import { toast, say } from "../ui/toast";
import { confirmDlg, dialog, portError, type Field } from "../ui/dialog";
import { Btn, Spin, cx } from "../ui/kit";

// ---- jobs ----------------------------------------------------------------

export interface JobInfo { id: string; argv: string[]; server?: string; code?: number | null; undoable?: boolean; report?: Any }
export interface JobAction { label: string; run: () => void; cls?: string }
export interface Job {
  info: JobInfo;
  lines: string[];
  after?: (j: Job) => JobAction[] | void;
  actions: JobAction[];
  report?: Any;
  url?: string;
  es?: EventSource;
  /** Set while the panel shows this job: new lines go straight into its output. */
  onLines?: () => void;
}
interface RunOpts { server?: string; password?: string; cwd?: string; retry?: string; after?: Job["after"] }

/**
 * Run `lf <argv>` on the machine running lf ui; output streams into the side panel.
 * after(job) may return follow-up actions [{label, run, cls}] once it ends.
 */
export async function run(argv: string[], o: RunOpts = {}) {
  let info: JobInfo;
  try {
    // A retry runs the job's own argv on the server: the page only has it with passwords masked.
    info = o.retry
      ? await http(`/api/jobs/${encodeURIComponent(o.retry)}/force`, {})
      : await http("/api/jobs", { argv, server: o.server ?? S.sel ?? undefined, password: o.password, cwd: o.cwd });
  } catch (e) {
    return toast(errorMessage(e));
  }
  const j: Job = { info, lines: [], after: o.after, actions: [] };
  S.jobs.set(info.id, j);
  S.job = info.id;
  stream(j);
  render();
  say(`Running lf ${argv.join(" ")}`);
}

export function stream(j: Job) {
  const es = new EventSource(`/api/jobs/${j.info.id}/events?from=${j.lines.length}`);
  j.es = es;
  es.onmessage = (e) => {
    const { from, lines, report } = JSON.parse(e.data);
    if (report) j.report = report;
    j.lines.length = Math.min(j.lines.length, from);
    j.lines.push(...lines);
    j.onLines?.();
    // A tunnel's address shows in the lists once it is up.
    if (isTunnel(j.info) && !j.url && (j.url = tunnelUrl(j))) render();
  };
  es.addEventListener("done", (e) => {
    es.close();
    j.info = JSON.parse((e as MessageEvent).data);
    j.report = j.info.report;
    finished(j);
  });
  // Dropped connection while it still runs: pick up where it left off.
  es.onerror = () => {
    es.close();
    if (j.info.code === undefined) setTimeout(() => stream(j), 1000);
  };
}

function finished(j: Job) {
  const { info } = j;
  const failed = info.code !== 0 && info.code !== null;
  j.actions = j.after?.(j) || [];
  // Safety checks refuse what would lock out ssh or break running services; --force overrides after reading why.
  const why = rep(j).force;
  if (failed && !info.argv.includes("--force") && why) {
    j.actions.push({
      label: "Do it anyway (--force)…",
      cls: "danger",
      run: () => confirmDlg({ title: "Override the safety check?", text: why, ok: "Run with --force", danger: true, onOk: () => run([...info.argv, "--force"], { server: info.server, retry: info.id }) }),
    });
  }
  if (info.undoable && info.server && info.code !== null) {
    const server = info.server;
    j.actions.push({
      label: "Undo this",
      run: () =>
        confirmDlg({
          title: `Undo \`lf ${info.argv.join(" ")}\`?`,
          text: `Reverts the changes this command recorded in the journal on ${server}.`,
          ok: "Undo it",
          onOk: () => run(["undo", info.id, "-s", server, "-y"], { server }),
        }),
    });
  }
  if (info.server) invalidate(info.server);
  refreshState().catch(() => {});
  render();
  const what = `lf ${info.argv.join(" ")} ${info.code === 0 ? "done" : info.code === null ? "stopped" : `failed (exit ${info.code})`}`;
  // Closed or showing another job: say so, with a way back to it.
  if (S.job !== info.id) toast(`${info.code === 0 ? "✓" : "✗"} ${what}`, { label: "Show", run: () => showJob(info.id) });
  else say(what);
}
let focusOut = false;
export function showJob(id: string) {
  S.job = id;
  focusOut = true;
  render();
}
/** An after() for run() that calls fn only when the job succeeded. */
export const ifOk = (fn: () => unknown) => (j: Job) => (j.info.code === 0 ? void fn() : undefined);
export const runningJobs = () => [...S.jobs.values()].filter((j) => j.info.code === undefined);
export const isTunnel = (info: JobInfo) => info.argv[0] === "tunnel" || (info.argv[0] === "traefik" && info.argv[1] === "dashboard");
/** Tunnels the UI opened to server n that are still open. */
export const openTunnels = (n: string) => runningJobs().filter((j) => j.info.server === n && isTunnel(j.info));
/** What the job reported through the CLI's report(): never parsed from its text output. */
export const rep = (j: Job): Any => j.report ?? j.info.report ?? {};
export const tunnelUrl = (j: Job): string | undefined => rep(j).url;
/** With --lan: the addresses other devices on the network open it at. */
export const lanUrls = (j: Job): string[] => rep(j).lan ?? [];
export const closeTunnel = (j: Job) => http(`/api/jobs/${j.info.id}/stop`, {}).catch((e) => toast(errorMessage(e)));

/** Jobs started before a reload keep running on the server: list them, and show one still running. */
export function resumeJobs(list: JobInfo[]) {
  const old: Job[] = [];
  for (const info of list.slice().reverse()) {
    const j: Job = { info, lines: [], actions: [] };
    S.jobs.set(info.id, j);
    if (info.code === undefined) stream(j);
    else old.push(j);
  }
  S.job = list.find((j) => j.code === undefined)?.id ?? null;
  return () => {
    // Finished jobs' output only matters once someone opens them: fetch it after the page is up.
    for (const j of old)
      http(`/api/jobs/${j.info.id}`).then(
        (full) => {
          j.lines = full.lines;
          if (S.job === j.info.id) render();
        },
        () => {},
      );
  };
}

/** argv plus --port, --local and --lan, picked in a dialog. ports: the ones the container listens on, if known. */
export function tunnelOptions(n: string, argv: string[], ports: (string | number)[] = []) {
  // A choice only when there is one to make: else free text, empty meaning the CLI's default.
  const port: Field =
    ports.length > 1
      ? { name: "port", label: "Container port", type: "select", value: String(ports[0]), options: ports.map((p) => ({ value: String(p), label: String(p) })) }
      : { name: "port", label: "Container port", type: "number", placeholder: ports[0] ? String(ports[0]) : "the one Traefik routes to, else the one it exposes", value: "", check: portError };
  dialog({
    title: argv[0] === "traefik" ? "Tunnel to the Traefik dashboard" : `Tunnel to ${argv.slice(1).filter((a, i, l) => a !== "-s" && l[i - 1] !== "-s").join(" · ")}`,
    text: `Forwards a port on this machine to it until you close it: lf ${argv.join(" ")}`,
    ok: "Open tunnel",
    fields: [
      ...(argv[0] === "tunnel" ? [port] : []),
      { name: "local", label: "Local port", type: "number", placeholder: "the container's port, else a free one", value: "", hint: "Fails if something else listens on it.", check: portError },
      { name: "lan", label: "Reachable from my network too", type: "check", value: false, hint: "Open it from a phone or another device on the same Wi-Fi. Anyone on that network can reach it." },
    ],
    onOk: (v) => {
      const to = v.port?.trim() ?? "",
        local = v.local.trim();
      run([...argv, ...(to ? ["--port", to] : []), ...(local ? ["-l", local] : []), ...(v.lan ? ["--lan"] : [])], { server: n });
    },
  });
}

// A database's address is for a client, not the browser.
const TunnelLink = ({ u }: { u: string }) =>
  u.startsWith("http://") ? (
    <a className="font-mono text-sm" href={u} target="_blank" rel="noopener">{u.replace("http://", "")}</a>
  ) : (
    <code className="font-mono text-sm" title="Connect a client to it">{u}</code>
  );

/** Open a tunnel with argv, or, when it is open, its address and a way to close it. */
export function TunnelBtn({ n, argv, label = "Open tunnel", ports = [] }: { n: string; argv: string[]; label?: string; ports?: (string | number)[] }) {
  // Opened with options, the job's argv goes on after argv.
  const j = openTunnels(n).find((t) => t.info.argv.slice(0, argv.length).join(" ") === argv.join(" "));
  if (!j)
    return (
      <>
        <Btn cls="sm" title={`lf ${argv.join(" ")}: until you close it`} on={() => run(argv, { server: n })}>{label}</Btn>
        <Btn
          cls="sm"
          title="Open it for every device on your network too (a phone, a colleague): anyone there reaches it at this machine's address"
          on={() => run([...argv, "--lan"], { server: n })}
        >
          On network
        </Btn>
        <Btn cls="sm" title="Container port, local port, network" on={() => tunnelOptions(n, argv, ports)}>…</Btn>
      </>
    );
  const url = tunnelUrl(j);
  const lan = lanUrls(j);
  return (
    <>
      {url ? <TunnelLink u={url} /> : <Spin role="img" aria-label="opening" />}
      {lan.length > 0 && (
        <>
          {" "}
          <span className="tunnel-lan" title="From other devices on your network">
            {lan.map((u, i) => <span key={u}>{i > 0 && " "}<TunnelLink u={u} /></span>)}
          </span>
        </>
      )}{" "}
      <Btn cls="sm ghost" on={() => showJob(j.info.id)}>Output</Btn>
      <Btn cls="sm danger" title="Ends the tunnel" on={() => closeTunnel(j)}>Close</Btn>
    </>
  );
}

// ---- the output panel ------------------------------------------------------

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
function lineClass(l: string) {
  if (/^==> /.test(l)) return "c-cyan";
  if (/^\s*✓/.test(l)) return "c-green";
  if (/^\s*!/.test(l)) return "c-yellow";
  if (/^\s*(error|✗|FAIL)/i.test(l)) return "c-red";
  if (/^\$ /.test(l)) return "c-dim";
  return "";
}
/** Adds the lines out does not show yet, keeping a reader's scroll position unless they are at the bottom. */
function appendOutput(out: HTMLElement, j: Job) {
  const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
  const shown = Number(out.dataset.n || 0);
  if (shown > j.lines.length) out.textContent = "";
  const frag = document.createDocumentFragment();
  for (const l of j.lines.slice(out.textContent ? shown : 0)) {
    const div = document.createElement("div");
    const text = l.replace(ANSI, "") || " ";
    // Addresses (a tunnel's localhost one, a deployed site) open in a new tab.
    for (const [i, part] of text.split(/(https?:\/\/[^\s)]+)/).entries()) {
      if (!(i % 2)) div.append(part);
      else div.append(Object.assign(document.createElement("a"), { href: part, textContent: part, target: "_blank", rel: "noopener" }));
    }
    const c = lineClass(text);
    if (c) div.className = c;
    frag.append(div);
  }
  out.append(frag);
  out.dataset.n = String(j.lines.length);
  if (atBottom) out.scrollTop = out.scrollHeight;
}

/** The output, filled outside React: lines arrive many a second, and a reader's scroll position must stay. */
function JobOut({ j }: { j: Job }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const out = ref.current!;
    appendOutput(out, j);
    out.scrollTop = out.scrollHeight;
    j.onLines = () => appendOutput(out, j);
    return () => void (j.onLines = undefined);
  }, [j]);
  // Output fetched after the first render (an old job's) comes in through a render.
  useLayoutEffect(() => {
    appendOutput(ref.current!, j);
    if (focusOut) ref.current!.focus({ preventScroll: true });
    focusOut = false;
  });
  return (
    <div
      ref={ref}
      tabIndex={0}
      role="region"
      aria-label="Output"
      className="job-out flex-1 overflow-auto bg-term text-term-fg font-mono text-[12.5px] leading-[1.6] px-3.5 py-3 whitespace-pre-wrap break-words"
    />
  );
}

export function JobPanel() {
  const j = S.jobs.get(S.job ?? "");
  if (!j) return null;
  const { info } = j;
  const running = info.code === undefined;
  const status = running ? (
    <><Spin /> running</>
  ) : info.code === null ? (
    <span className="text-dim">stopped</span>
  ) : info.code === 0 ? (
    <span className="text-ok">✓ done</span>
  ) : (
    <span className="text-bad">✗ failed (exit {info.code})</span>
  );
  const others = [...S.jobs.values()].reverse();
  const stop = () => {
    const doStop = () => http(`/api/jobs/${info.id}/stop`, {}).catch((e) => toast(errorMessage(e)));
    if (!info.undoable) return void doStop();
    confirmDlg({ title: `Stop lf ${info.argv[0]}?`, text: "What it changed so far stays. Undo it from History.", ok: "Stop it", danger: true, onOk: doStop });
  };
  return (
    <aside
      id="job"
      aria-label="Command output"
      className="border-l border-line bg-panel flex flex-col min-w-0 max-[1100px]:fixed max-[1100px]:inset-[56px_0_0_auto] max-[1100px]:w-[min(560px,100vw)] max-[1100px]:z-5 max-[1100px]:shadow-lg max-[760px]:inset-[56px_0_0_0] max-[760px]:w-screen"
    >
      <div className="px-3.5 py-2.5 border-b border-line flex items-center gap-2 min-h-12">
        <span className="font-mono text-sm font-semibold overflow-hidden text-ellipsis whitespace-nowrap flex-1" title={`lf ${info.argv.join(" ")}`}>$ lf {info.argv.join(" ")}</span>
        <Btn cls="ghost sm" title="Close (Esc)" aria-label="Close output" on={() => ((S.job = null), render())}>✕</Btn>
      </div>
      <JobOut key={info.id} j={j} />
      <div className="px-3.5 py-2.5 border-t border-line flex gap-1.5 flex-wrap items-center">
        <span className="mr-auto text-md">{status}</span>
        {running && <Btn cls="danger" title={info.undoable ? "Changes made so far stay" : undefined} on={stop}>Stop</Btn>}
        {(running ? [] : j.actions).map((a, i) => (
          <Btn key={a.label} cls={a.cls ?? (i === 0 ? "primary" : "")} on={a.run}>{a.label}</Btn>
        ))}
      </div>
      {others.length > 1 && (
        <div className="border-t border-line max-h-[28%] overflow-auto p-1">
          {others.map((o) => {
            const [cls, ico] = o.info.code === undefined ? ["", "…"] : o.info.code === 0 ? ["text-ok", "✓"] : o.info.code === null ? ["", "■"] : ["text-bad", "✗"];
            return (
              <button
                key={o.info.id}
                type="button"
                className={cx(
                  "flex w-full gap-2 border-0 rounded-sm shadow-none text-left bg-transparent px-2.5 py-1.5 font-mono text-sm font-normal text-dim",
                  o.info.id === S.job && "bg-accent-bg! text-fg",
                )}
                onClick={() => showJob(o.info.id)}
              >
                <span className={cls}>{ico}</span>
                <span className="overflow-hidden text-ellipsis">lf {o.info.argv.join(" ")}</span>
              </button>
            );
          })}
        </div>
      )}
    </aside>
  );
}
