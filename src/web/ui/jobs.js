"use strict";
// ---- jobs ----------------------------------------------------------------

/**
 * Run `lf <argv>` on the machine running lf ui; output streams into the side panel.
 * after(job) may return follow-up actions [{label, run, cls}] once it ends.
 */
async function run(argv, o = {}) {
  let info;
  try {
    // A retry runs the job's own argv on the server: the page only has it with passwords masked.
    info = o.retry
      ? await http(`/api/jobs/${encodeURIComponent(o.retry)}/force`, {})
      : await http("/api/jobs", { argv, server: o.server ?? S.sel ?? undefined, password: o.password, cwd: o.cwd });
  } catch (e) {
    return toast(e.message);
  }
  const j = { info, lines: [], after: o.after, actions: [] };
  S.jobs.set(info.id, j);
  S.job = info.id;
  stream(j);
  render();
  say(`Running lf ${argv.join(" ")}`);
}

function stream(j) {
  const es = new EventSource(`/api/jobs/${j.info.id}/events?from=${j.lines.length}`);
  j.es = es;
  es.onmessage = (e) => {
    const { from, lines, report } = JSON.parse(e.data);
    if (report) j.report = report;
    j.lines.length = Math.min(j.lines.length, from);
    j.lines.push(...lines);
    if (S.job === j.info.id) appendOutput(j);
    // A tunnel's address shows in the lists once it is up.
    if (isTunnel(j.info) && !j.url && (j.url = tunnelUrl(j))) render();
  };
  es.addEventListener("done", (e) => {
    es.close();
    j.info = JSON.parse(e.data);
    j.report = j.info.report;
    finished(j);
  });
  // Dropped connection while it still runs: pick up where it left off.
  es.onerror = () => {
    es.close();
    if (j.info.code === undefined) setTimeout(() => stream(j), 1000);
  };
}

function finished(j) {
  const { info } = j;
  const failed = info.code !== 0 && info.code !== null;
  j.actions = (j.after && j.after(j)) || [];
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
    j.actions.push({
      label: "Undo this",
      run: () =>
        confirmDlg({
          title: `Undo \`lf ${info.argv.join(" ")}\`?`,
          text: `Reverts the changes this command recorded in the journal on ${info.server}.`,
          ok: "Undo it",
          onOk: () => run(["undo", info.id, "-s", info.server, "-y"], { server: info.server }),
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
function showJob(id) {
  S.job = id;
  render();
  $("#job .job-out")?.focus({ preventScroll: true });
}
/** An after() for run() that calls fn only when the job succeeded. */
const ifOk = (fn) => (j) => (j.info.code === 0 ? void fn() : undefined);
const runningJobs = () => [...S.jobs.values()].filter((j) => j.info.code === undefined);
const isTunnel = (info) => info.argv[0] === "tunnel" || (info.argv[0] === "traefik" && info.argv[1] === "dashboard");
/** Tunnels the UI opened to server n that are still open. */
const openTunnels = (n) => runningJobs().filter((j) => j.info.server === n && isTunnel(j.info));
/** What the job reported through the CLI's report(): never parsed from its text output. */
const rep = (j) => j.report ?? j.info.report ?? {};
const tunnelUrl = (j) => rep(j).url;
/** With --lan: the addresses other devices on the network open it at. */
const lanUrls = (j) => rep(j).lan ?? [];
const closeTunnel = (j) => http(`/api/jobs/${j.info.id}/stop`, {}).catch((e) => toast(e.message));
/** argv plus --port, --local and --lan, picked in a dialog. ports: the ones the container listens on, if known. */
function tunnelOptions(n, argv, ports = []) {
  // A choice only when there is one to make: else free text, empty meaning the CLI's default.
  const port = ports.length > 1
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
      const to = v.port?.trim() ?? "", local = v.local.trim();
      run([...argv, ...(to ? ["--port", to] : []), ...(local ? ["-l", local] : []), ...(v.lan ? ["--lan"] : [])], { server: n });
    },
  });
}
/** Open a tunnel with argv, or, when it is open, its address and a way to close it. */
function tunnelBtn(n, argv, label = "Open tunnel", ports = []) {
  // Opened with options, the job's argv goes on after argv.
  const j = openTunnels(n).find((t) => t.info.argv.slice(0, argv.length).join(" ") === argv.join(" "));
  if (!j)
    return `${btn(label, () => run(argv, { server: n }), "sm", `lf ${argv.join(" ")}: until you close it`)}${btn(
      "On network",
      () => run([...argv, "--lan"], { server: n }),
      "sm",
      "Open it for every device on your network too (a phone, a colleague): anyone there reaches it at this machine's address",
    )}${btn("…", () => tunnelOptions(n, argv, ports), "sm", "Container port, local port, network")}`;
  const url = tunnelUrl(j);
  // A database's address is for a client, not the browser.
  const link = (u) => u.startsWith("http://") ? `<a class="tunnel-url" href="${esc(u)}" target="_blank" rel="noopener">${esc(u.replace("http://", ""))}</a>` : `<code class="tunnel-url" title="Connect a client to it">${esc(u)}</code>`;
  const lan = lanUrls(j);
  const addr = !url ? `<span class="spin" role="img" aria-label="opening"></span>` : link(url);
  return `${addr}${lan.length ? ` <span class="tunnel-lan" title="From other devices on your network">${lan.map(link).join(" ")}</span>` : ""}
    ${btn("Output", () => showJob(j.info.id), "sm ghost")}${btn("Close", () => closeTunnel(j), "sm danger", "Ends the tunnel")}`;
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
function lineClass(l) {
  if (/^==> /.test(l)) return "c-cyan";
  if (/^\s*✓/.test(l)) return "c-green";
  if (/^\s*!/.test(l)) return "c-yellow";
  if (/^\s*(error|✗|FAIL)/i.test(l)) return "c-red";
  if (/^\$ /.test(l)) return "c-dim";
  return "";
}
function appendOutput(j) {
  const out = $("#job .job-out");
  if (!out) return;
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
  out.dataset.n = j.lines.length;
  if (atBottom) out.scrollTop = out.scrollHeight;
}

function renderJob() {
  const el = $("#job");
  const j = S.jobs.get(S.job);
  $("#app").classList.toggle("with-job", !!j);
  el.hidden = !j;
  if (!j) return;
  const { info } = j;
  const running = info.code === undefined;
  const status = running
    ? `<span class="spin"></span> running`
    : info.code === null
      ? `<span class="dim">stopped</span>`
      : info.code === 0
        ? `<span style="color:var(--ok)">✓ done</span>`
        : `<span style="color:var(--bad)">✗ failed (exit ${info.code})</span>`;
  const others = [...S.jobs.values()].reverse();
  const stop = () => {
    const doStop = () => http(`/api/jobs/${info.id}/stop`, {}).catch((e) => toast(e.message));
    if (!info.undoable) return doStop();
    confirmDlg({ title: `Stop lf ${info.argv[0]}?`, text: "What it changed so far stays. Undo it from History.", ok: "Stop it", danger: true, onOk: doStop });
  };
  // The output element stays across renders: rebuilding it would lose the reader's scroll position.
  let out = $(".job-out", el);
  const fresh = !out || out.dataset.job !== info.id;
  if (fresh) {
    out = Object.assign(document.createElement("div"), { className: "job-out", tabIndex: 0 });
    out.dataset.job = info.id;
    out.setAttribute("role", "region");
    out.setAttribute("aria-label", "Output");
  }
  el.innerHTML = `
    <div class="job-head">
      <span class="title" title="${esc("lf " + info.argv.join(" "))}">$ lf ${esc(info.argv.join(" "))}</span>
      ${btn("✕", () => ((S.job = null), render()), "ghost sm", "Close (Esc)", "job-close", `aria-label="Close output"`)}
    </div>
    <div class="job-out-slot"></div>
    <div class="job-foot">
      <span class="status">${status}</span>
      ${running ? btn("Stop", stop, "danger", info.undoable ? "Changes made so far stay" : "", "job-stop") : ""}
      ${(running ? [] : j.actions).map((a, i) => btn(esc(a.label), a.run, a.cls ?? (i === 0 ? "primary" : ""), "", `job-act:${a.label}`)).join("")}
    </div>
    ${others.length > 1 ? `<div class="joblist">${others
      .map((o) => {
        const [cls, ico] = o.info.code === undefined ? ["", "…"] : o.info.code === 0 ? ["ok", "✓"] : o.info.code === null ? ["", "■"] : ["bad", "✗"];
        return `<button type="button" class="${o.info.id === S.job ? "on" : ""}" data-f="job:${o.info.id}" ${on(() => showJob(o.info.id))}>
        <span class="${cls}">${ico}</span><span>lf ${esc(o.info.argv.join(" "))}</span></button>`;
      })
      .join("")}</div>` : ""}`;
  $(".job-out-slot", el).replaceWith(out);
  appendOutput(j);
  if (fresh) out.scrollTop = out.scrollHeight;
}
