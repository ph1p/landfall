"use strict";
// ---- stats ---------------------------------------------------------------------

// The last samples per server, for the sparklines: 5 minutes at one per 5s.
const STATS_LOG = 60;
function logStats(n, s) {
  const log = (S.statsLog[n] ??= []);
  log.push({ cpu: s.cpu, mem: s.mem.total ? ((s.mem.total - s.mem.available) / s.mem.total) * 100 : 0 });
  if (log.length > STATS_LOG) log.shift();
}
const pctOf = (used, total) => (total ? Math.round((used / total) * 100) : 0);
/** A sparkline of 0-100 values, oldest left. */
function spark(values) {
  if (values.length < 2) return "";
  const pts = values.map((v, i) => `${((STATS_LOG - values.length + i) / (STATS_LOG - 1)) * 100},${24 - (Math.min(100, v) / 100) * 22}`).join(" ");
  return `<svg viewBox="0 0 100 26" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>`;
}
function meter(label, p, value, sub, line = "", hint = "") {
  const cls = p >= 90 ? "bad" : p >= 70 ? "warn" : "";
  return `<div class="meter ${cls}" title="${esc(hint)}"><div class="k"><span>${esc(label)}</span></div>
    <div class="v">${value}${line}</div>
    ${p === null ? "" : `<div class="bar" role="meter" aria-label="${esc(label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p}"><i style="width:${Math.min(100, p)}%"></i></div>`}
    <div class="t">${sub}</div></div>`;
}
/** Live usage of one server: meters, the busiest processes and containers, disk usage on request. */
function statsView(n) {
  const st = S.stats[n];
  const wait = pending(st, `measuring ${esc(n)} for a second…`);
  if (wait) return st?.error ? `${wait}<div class="actions" style="margin:0">${btn("Retry", () => (load(n, "stats", true), render()))}</div>` : wait;
  const s = st.data;
  const log = S.statsLog[n] ?? [];
  const memUsed = s.mem.total - s.mem.available;
  const swapUsed = s.mem.swapTotal - s.mem.swapFree;
  const meters = [
    meter("CPU", s.cpu, `${s.cpu}%`, `${plural(s.cpus, "core")} · load ${s.load.join(" ")}`, spark(log.map((x) => x.cpu)), "Busy share of all cores over one second; load is the 1, 5 and 15 minute average"),
    meter("Memory", pctOf(memUsed, s.mem.total), `${pctOf(memUsed, s.mem.total)}%`, `${size(memUsed)} of ${size(s.mem.total)}`, spark(log.map((x) => x.mem)), "Used, without caches the kernel gives back when needed"),
    s.mem.swapTotal ? meter("Swap", pctOf(swapUsed, s.mem.swapTotal), `${pctOf(swapUsed, s.mem.swapTotal)}%`, `${size(swapUsed)} of ${size(s.mem.swapTotal)}`) : "",
    ...s.disks.map((d) => meter(`Disk ${d.mount}`, pctOf(d.used, d.total), `${pctOf(d.used, d.total)}%`, `${size(d.used)} of ${size(d.total)} · ${size(d.available)} free`)),
    ...s.net.map((x) => meter(`Network ${x.iface}`, null, `↓ ${size(x.rx)}/s`, `↑ ${size(x.tx)}/s`)),
  ].join("");
  const procs = s.procs.slice(0, 8);
  const procCard = procs.length
    ? `<div class="card"><h2>Processes <span class="sub">busiest and largest · cpu 100% = one core</span></h2><div class="scroll"><table>
        <thead><tr><th>Name</th><th class="num">CPU</th><th class="num">Memory</th><th class="num hide-sm">PID</th></tr></thead>
        <tbody>${procs.map((p) => `<tr><td class="mono">${esc(p.name)}</td><td class="num">${p.cpu}%</td><td class="num">${size(p.rss)}</td><td class="num faint hide-sm">${p.pid}</td></tr>`).join("")}</tbody></table></div></div>`
    : "";
  const up = (x) => isUp(x.status);
  const ctrCard = !s.docker
    ? `<div class="note">No access to Docker on ${esc(n)}: containers are not shown. Set up the server to fix that.</div>`
    : s.containers.length
      ? `<div class="card"><h2>Containers <span class="badge">${s.containers.length}</span></h2><div class="scroll"><table>
          <thead><tr><th>Container</th><th class="hide-sm">Site</th><th class="num">CPU</th><th class="num">Memory</th><th class="num hide-sm" title="Received and sent since the container started">Network in / out</th><th class="num hide-sm">Restarts</th></tr></thead>
          <tbody>${s.containers
            .map((x) => `<tr><td>${statusDot(x.status)}<span class="mono">${esc(x.name)}</span><div class="faint">${esc(x.image)}</div></td>
              <td class="hide-sm">${x.site ? `<b>${esc(x.site)}</b>` : `<span class="faint">${esc(x.project || "-")}</span>`}</td>
              <td class="num">${up(x) ? `${Math.round(x.cpu * 10) / 10}%` : ""}</td>
              <td class="num">${up(x) ? `${size(x.mem)}${x.memLimit && x.memLimit < s.mem.total ? `<div class="faint" title="Set by mem_limit or deploy.resources in its compose file">limit ${size(x.memLimit)}</div>` : ""}` : `<span class="faint">${esc(x.status)}</span>`}</td>
              <td class="num hide-sm" title="since the container started">${up(x) ? `↓ ${size(x.net.rx)} <span class="faint">·</span> ↑ ${size(x.net.tx)}` : ""}</td>
              <td class="num hide-sm">${x.restarts ? `<span class="badge warn">${x.restarts}</span>` : `<span class="faint">0</span>`}</td></tr>`)
            .join("")}</tbody></table></div></div>`
      : "";
  const live = `<p class="faint" style="margin-top:14px">${st.loading ? `<span class="spin"></span> ` : ""}${st.error ? `<span style="color:var(--bad)">last sample failed: ${esc(st.error)}</span> · ` : ""}measured ${new Date(s.at).toLocaleTimeString()} · new sample every 5s while this tab is open · <span class="mono">lf stats -w${S.state.defaults.default === n ? "" : ` -s ${esc(n)}`}</span></p>`;
  return `<div class="meters">${meters}</div>${ctrCard}${procCard}${diskCard(n)}${live}`;
}


function loadDisk(n) {
  fetchInto("disk", n, "/disk");
  render();
}
function pruneFlow(n) {
  http(`/api/servers/${encodeURIComponent(n)}/prune`).then((p) => {
    const imgs = p.images.filter((i) => !i.keep);
    const kept = (w) => p.images.filter((i) => i.keep === w).length;
    const most = imgs.reduce((t, i) => t + i.size, 0) + p.buildCache;
    const keep = [[kept("release"), "for rollback"], [kept("undo"), "for undo"], [kept("used"), "in use"]].filter(([k]) => k).map(([k, w]) => `${k} ${w}`).join(", ");
    dialog({
      title: `Clean up ${n}?`,
      text: `${plural(imgs.length, "unused image")} and ${size(p.buildCache)} of build cache: up to ${size(most)}.${keep ? ` Kept: ${keep}.` : ""} Volumes and containers stay.`,
      fields: kept("tagged") ? [{ name: "all", type: "check", label: `Also ${plural(kept("tagged"), "unused tagged image")}`, hint: "Pulled again when a site needs them" }] : [],
      ok: "Clean up",
      danger: true,
      onOk: (v) => run(["prune", ...sv(n), "-y", ...(v.all ? ["--all"] : [])], { server: n, after: () => (loadDisk(n), []) }),
    });
  }, (e) => toast(e.message));
}
function diskCard(n) {
  const st = S.disk[n];
  const head = (acts) => `<h2>Disk usage <span class="sub">images, volumes, build cache, sites and logs</span><span class="actions">${acts}</span></h2>`;
  if (!st) return `<div class="card">${head(btn("Analyze", () => loadDisk(n), "sm", "lf disk: sums up folders, takes a few seconds"))}<div class="body dim">Where the space goes. Sums up folders on the server, so only on request.</div></div>`;
  if (!st.data) {
    const body = st.loading ? `<div class="loading"><span class="spin"></span> adding up folders…</div>` : `<div class="body"><div class="note bad" style="margin:0">${esc(st.error)}</div></div>`;
    return `<div class="card">${head(st.loading ? "" : btn("Retry", () => loadDisk(n), "sm"))}${body}</div>`;
  }
  const d = st.data;
  const tbl = (cols, rows) => `<div class="scroll"><table><thead><tr>${cols.map(([c, cls = ""]) => `<th class="${cls}">${c}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>`;
  const sub = (t) => `<h3 style="margin:16px 18px 6px;font-size:var(--fs-sm);color:var(--dim);font-weight:600">${t}</h3>`;
  const docker = d.dockerDf.length
    ? sub("Docker") + tbl([["Kind"], ["Count", "num"], ["In use", "num"], ["Size", "num"], ["Reclaimable", "num"]],
        d.dockerDf.map((x) => `<tr><td>${esc(x.type)}</td><td class="num">${x.count}</td><td class="num">${x.active}</td><td class="num">${size(x.size)}</td><td class="num">${x.reclaimable ? `<span class="badge warn">${size(x.reclaimable)}</span>` : `<span class="faint">0</span>`}</td></tr>`).join(""))
    : "";
  const sites = d.sites.length
    ? sub(`Sites <span class="faint mono">${esc(S.state.paths.sites)}</span>`) + tbl([["Site"], ["Files", "num"], ["Releases", "num"]],
        d.sites.map((x) => `<tr><td>${esc(x.name)}</td><td class="num">${size(x.size)}</td><td class="num">${x.releases} · ${size(x.releasesSize)}</td></tr>`).join(""))
    : "";
  const vols = d.volumes.filter((x) => x.size > 0).slice(0, 10);
  const volumes = vols.length
    ? sub("Largest volumes") + tbl([["Volume"], ["Size", "num"], ["Used by", "num"]],
        vols.map((x) => `<tr><td class="mono">${esc(x.name)}</td><td class="num">${size(x.size)}</td><td class="num">${x.links ? plural(x.links, "container") : `<span class="badge warn">nothing</span>`}</td></tr>`).join(""))
    : "";
  const lg = d.logs.filter((x) => x.size > 0).slice(0, 10);
  const logs = lg.length ? sub("Largest container logs") + tbl([["Container"], ["Size", "num"]], lg.map((x) => `<tr><td class="mono">${esc(x.container)}</td><td class="num">${size(x.size)}</td></tr>`).join("")) : "";
  const notes = [
    d.journald ? `systemd journal: ${size(d.journald)}` : "",
    d.docker ? "" : "No access to Docker: images, volumes and logs are not shown.",
    d.root ? "" : "Without root or passwordless sudo, root-owned folders and container logs may be missing.",
  ].filter(Boolean);
  return `<div class="card">${head((d.docker ? btn("Clean up…", () => pruneFlow(n), "sm", "lf prune: remove unused images and the build cache") : "") + btn("↻", () => loadDisk(n), "sm", "Analyze again", "", `aria-label="Analyze again"`))}${docker}${sites}${volumes}${logs}
    ${notes.length ? `<div class="body faint">${notes.map(esc).join("<br>")}</div>` : `<div style="height:8px"></div>`}</div>`;
}
