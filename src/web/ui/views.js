"use strict";
// ---- views ---------------------------------------------------------------

function renderNav() {
  const st = S.state;
  // Reachable first, then refused, then down; unchecked last. sort() is stable, so ties keep config order.
  const list = st.servers.slice().sort((a, b) => reachRank(a.name) - reachRank(b.name));
  // Down servers sit in their own group, closed until opened, so the rest stay in view.
  const isDown = (s) => S.reach[s.name]?.state === "down";
  const own = list.filter((s) => s.registered && !isDown(s));
  const aliases = list.filter((s) => !s.registered && !isDown(s));
  const down = list.filter(isDown);
  const q = S.filter.toLowerCase();
  const hit = (s) => !q || s.name.toLowerCase().includes(q) || s.target.toLowerCase().includes(q) || s.name === S.sel;
  const item = (s) => {
    const tunnels = openTunnels(s.name).length;
    const r = S.reach[s.name];
    const why = r?.state === "login" ? `<span class="x"> · <span class="refused">login refused</span></span>` : "";
    const head = `<button type="button" class="srv ${s.name === S.sel ? "on" : ""} ${r?.state === "down" ? "off" : ""}" data-f="srv:${esc(s.name)}" ${on(() => go(s.name, S.sel === s.name ? S.tab : "sites"))}>
      ${reachDot(s.name)}<div class="n">${esc(s.name)}${s.isDefault ? `<span class="star" title="default server">★</span>` : ""}</div>
      <div class="t"><span class="h">${esc(s.target)}</span>${why}${tunnels ? `<span class="x"> · <span class="live">${plural(tunnels, "tunnel")}</span></span>` : ""}</div></button>`;
    return s.name === S.sel ? `${head}<div class="sections" role="list" aria-label="${esc(s.name)}">${sectionButtons(s.name, "sec")}</div>` : head;
  };
  const group = (key, title, l) => {
    if (!l.length) return "";
    const shown = l.filter(hit);
    // A closed group still shows the open server; a filter opens every group.
    const closed = navClosed.has(key) && !q;
    const rows = closed ? shown.filter((s) => s.name === S.sel) : shown;
    return `<h3><button type="button" class="grp" aria-expanded="${!closed}" ${on(() => toggleGroup(key))}><span class="caret" aria-hidden="true"></span>${title}</button><span>${q ? `${shown.length}/` : ""}${l.length}</span></h3>
      ${rows.map(item).join("") || (closed ? "" : `<div class="nav-none">no match</div>`)}`;
  };
  $("#filter").hidden = list.length < 8;
  $("#add-server").textContent = list.length < 8 ? "+ Add server" : "+";
  $("#navlist").innerHTML = `<button type="button" class="srv nav-home ${S.sel ? "" : "on"}"${S.sel ? "" : ` aria-current="page"`} data-f="home" ${on(() => go(null))}><svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 2.5h4.5v4.5h-4.5zM9 2.5h4.5v4.5h-4.5zM2.5 9h4.5v4.5h-4.5zM9 9h4.5v4.5h-4.5z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg><div class="n">Overview</div></button>${group("own", "Servers", own)}${group("ssh", "From ~/.ssh/config", aliases)}${group("down", "Unreachable", down)}
    ${list.length ? "" : `<div class="nav-none">No servers yet.</div>`}`;
  $("#navfoot").hidden = !list.length;
  $("#navfoot").innerHTML = reachSummary(list);
  $("#pick").innerHTML = `<select aria-label="Server" onchange="go(this.value || null)">
    <option value="">Pick a server…</option>${list.map((s) => `<option value="${esc(s.name)}" ${s.name === S.sel ? "selected" : ""}>${esc(s.name)} · ${esc(s.target)}${S.reach[s.name] && S.reach[s.name].state !== "ok" ? ` · ${REACH_DOT[S.reach[s.name].state][1]}` : ""}</option>`).join("")}
  </select>`;
}

const reachRank = (n) => ({ ok: 0, login: 1, down: 2 })[S.reach[n]?.state] ?? 3;

/** The sidebar's foot: what the login check is doing, or what it found and when. */
function reachSummary(list) {
  const btnHtml = `<button type="button" class="sm ghost recheck" ${S.reaching ? "disabled" : ""} title="Try landfall's ssh login on every server again (lf server list --check)" ${on(() => loadReach(true))}><span class="${S.reaching ? "spin" : "ico"}" aria-hidden="true">${S.reaching ? "" : "↻"}</span>${S.reaching ? "Checking" : "Check"}</button>`;
  if (S.reaching) return `<div class="what" role="status">Trying ssh login on ${plural(list.length, "server")}…</div>${btnHtml}`;
  if (!S.reachedAt) return `<div class="what">Not checked yet</div>${btnHtml}`;
  const count = { ok: 0, login: 0, down: 0 };
  for (const s of list) if (S.reach[s.name]) count[S.reach[s.name].state]++;
  const part = (k, word) => (count[k] ? `<span title="${esc(word)}"><span class="dot ${REACH_DOT[k][0]}"></span>${count[k]} ${word}</span>` : "");
  const at = S.reachedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `<div class="what" role="status"><div class="counts">${part("ok", "reachable")}${part("login", "refused")}${part("down", "down")}</div>
    <div class="when">checked ${at} · again every minute</div></div>${btnHtml}`;
}

// Unreachable starts folded on every load; only the other groups remember their state.
const navClosed = new Set([...(() => {
  try {
    return JSON.parse(localStorage.getItem("lf.navClosed") ?? "[]");
  } catch {
    return [];
  }
})(), "down"]);
function toggleGroup(key) {
  navClosed.has(key) ? navClosed.delete(key) : navClosed.add(key);
  try {
    localStorage.setItem("lf.navClosed", JSON.stringify([...navClosed].filter((k) => k !== "down")));
  } catch {}
  renderNav();
}

/** The open server's sections as buttons, each with its count. */
/** What the server can do (`lf server info --json` can); null until its facts are in, then everything shows. */
const can = (n) => S.facts[n]?.data?.can ?? null;
/** When each section is worth a tab: the same conditions the CLI checks before doing it. */
const SECTION_IF = {
  sites: (k) => k.docker || k.setup,
  tunnels: (k) => k.docker,
  traffic: (k) => k.docker,
  traefik: (k) => k.docker,
  updates: (k) => k.packages || k.docker,
  firewall: (k) => k.firewall,
};
const sections = (n) => SECTIONS.filter(([t]) => !can(n) || (SECTION_IF[t]?.(can(n)) ?? true));

function sectionButtons(n, f) {
  const o = S.overview[n]?.data;
  const tunnels = openTunnels(n).length;
  const badge = {
    sites: o ? ` <span class="badge">${o.sites.length}</span>` : "",
    tunnels: tunnels ? ` <span class="badge ok">${tunnels} open</span>` : "",
    updates: updatesBadge(n),
  };
  return sections(n).map(([t, label], i) => `<button type="button" class="${S.tab === t ? "on" : ""}"${S.tab === t ? ` aria-current="page"` : ""} data-f="${f}:${t}" title="${label} (${i + 1})" ${on(() => go(n, t))}>${label}${badge[t] ?? ""}</button>`).join("");
}

function renderHeader() {
  const st = S.state;
  $("#version").textContent = st.version;
  const p = st.project;
  const running = runningJobs().length;
  const jobsBtn = S.jobs.size && !S.job
    ? btn(`${running ? `<span class="spin" aria-hidden="true"></span>` : ""}Jobs${running ? ` · ${running} running` : ""}`, () => showJob([...S.jobs.keys()].pop()), "jobs-btn", "Show command output", "jobs")
    : "";
  $("#project").innerHTML = `${jobsBtn}
    <span class="path" title="${esc(st.cwd)}">${p ? `<b>${esc(p.name)}</b> · ${esc(p.domains.join(", "))}` : esc(st.cwd.replace(/^\/(Users|home)\/[^/]+/, "~"))}</span>
    ${btn("Deploy folder…", () => folderDialog(st.cwd), "", "Pick a folder, a recent project, or drop one here")}
    ${btn(p ? "Deploy" : "Deploy this folder", deployHere, "primary", p ? `lf deploy (.landfall.json in ${st.cwd})` : `lf deploy from ${st.cwd}`)}`;
}

function errorHint(error) {
  if (/permission denied/i.test(error)) return "No key login yet. Use Set up: landfall asks for the password once and installs a key.";
  if (/resolve|not known|nodename/i.test(error)) return "Host name not found. Check the entry in ~/.ssh/config.";
  if (/timed out|refused|no route|unreachable/i.test(error)) return "Server not reachable. Is it running, and is the ssh port right?";
  return "";
}

const isUp = (status) => /^up/i.test(status);
// A one-off service that finished (Exited (0)) is not down: grey, not red.
const statusDot = (status) => {
  const [cls, word] = isUp(status) ? (/unhealthy|restarting/i.test(status) ? ["warn", "unhealthy"] : ["up", "running"]) : /^exited \(0\)/i.test(status) ? ["", "finished"] : ["down", "down"];
  return `<span class="dot ${cls}" role="img" aria-label="${word}" title="${esc(status)}"></span>`;
};

const size = (b) => {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) (b /= 1024), i++;
  return `${b < 10 && i ? b.toFixed(1) : Math.round(b)} ${u[i]}`;
};
const uptime = (s) => {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
  return d ? `${d}d ${h}h` : h ? `${h}h` : `${Math.floor(s / 60)}m`;
};

function factsLine(n) {
  const f = S.facts[n]?.data;
  if (!f) return "";
  const pct = (used, total) => (total ? Math.round((used / total) * 100) : 0);
  const disk = pct(f.disk.used, f.disk.total);
  const items = [
    `<b>${esc(f.os)}</b> ${esc(f.arch)}`,
    `<span title="kernel ${esc(f.kernel)}">up ${uptime(f.uptime)}</span>`,
    f.cpus ? `${f.cpus} CPU · load ${esc(f.load.split(" ")[0])}` : "",
    f.mem.total ? `RAM ${size(f.mem.total - f.mem.available)} / ${size(f.mem.total)}` : "",
    f.disk.total ? `<span ${disk > 85 ? `style="color:var(--warn)"` : ""}>disk ${disk}% of ${size(f.disk.total)}</span>` : "",
    f.docker ? `docker ${esc(f.docker)}` : `<span class="faint">no docker</span>`,
    f.reboot ? `<span class="badge warn">reboot required</span>` : "",
  ];
  return `<div class="facts">${items.filter(Boolean).map((x) => `<span>${x}</span>`).join("")}</div>`;
}

function factsNote(n) {
  const f = S.facts[n]?.data;
  const sup = f?.support;
  // A system that installs its own way (DSM, SteamOS) is not a problem, just a different kind of server.
  if (!sup?.note) return "";
  return `<div class="note ${sup.level === "eol" || sup.level === "unsupported" ? "bad" : ""}">${esc(sup.note)}${f.can && !f.can.docker ? `. Docker: ${esc(f.why.docker)}` : ""}</div>`;
}

function renderMain() {
  const main = $("#main");
  if (!S.sel) return void (main.innerHTML = homeView());
  const n = S.sel;
  const s = server();
  if (!s) {
    return void (main.innerHTML = `<div class="card"><div class="body empty"><h2>No server named ${esc(n)}</h2>
      <p>It is not in landfall's list or in ~/.ssh/config (anymore).</p>
      <p>${btn("All servers", () => go(null), "primary")} ${btn("Add a server…", addServer)}</p></div></div>`);
  }
  // A section this server has no use for (no docker, no ufw…): open the first one it has.
  const shown = sections(n);
  if (!shown.some(([t]) => t === S.tab)) return void location.replace(`#/${encodeURIComponent(n)}/${shown[0][0]}`);
  const k = can(n);
  const ov = S.overview[n] ?? { loading: true };
  const o = ov.data;
  const traefik = o
    ? o.traefik
      ? `${statusDot(o.traefik)}${esc(o.proxy)} ${esc(o.traefik.toLowerCase())}`
      : o.ready ? `<span class="dot down"></span>no traefik` : ""
    : "";
  const sub = [esc(s?.target ?? ""), s && !s.registered ? "from ~/.ssh/config" : "", traefik].filter(Boolean).join(" · ");
  // Reloading with something already on screen: keep it, show a small spinner.
  // Stats reload every few seconds and say so themselves.
  const reloading = needs(S.tab).some((t) => t !== "stats" && S[STORE[t]][n]?.loading && S[STORE[t]][n]?.data);
  main.innerHTML = `
    <div class="head">
      <div><h1>${esc(n)}${s?.isDefault ? ` <span class="star" title="default server">★</span>` : ""} <span class="crumb">/ ${SECTIONS.find(([t]) => t === S.tab)[1]}</span>${reloading ? ` <span class="spin" role="img" aria-label="reloading"></span>` : ""}</h1><div class="sub">${sub}</div>${factsLine(n)}</div>
      <div class="actions">
        ${!k || k.setup ? btn("Set up / check", () => setupFlow([n]), "", "Shows what is installed and what setup would change; asks before applying") : ""}
        ${btn("Run…", () => runCommand(n), "", "Run a shell command over ssh")}
        ${btn("↻", () => (load(n, S.tab, true), render()), "", "Reload", "reload", `aria-label="Reload"`)}
        ${menuBtn([
          { label: "Server info", hint: "lf server info", run: () => run(["server", "info", n]) },
          !k || k.docker ? { label: "Traefik status", hint: "lf traefik status", run: () => run(["traefik", "status", ...sv(n)]) } : null,
          !k || k.admin ? "-" : null,
          !k || k.admin ? { label: "Reboot…", cls: "danger", hint: "lf reboot", run: () => rebootDlg(n) } : null,
          s?.isDefault ? null : { label: "Make default", title: "Commands without -s use it", run: () => makeDefault(n) },
          s?.registered ? "-" : null,
          s?.registered ? { label: `Forget ${n}…`, cls: "danger", hint: "lf server rm", run: () => forget(n) } : null,
        ], "More", "")}
      </div>
    </div>
    ${factsNote(n)}
    <div class="tabs">${sectionButtons(n, "tab")}</div>
    <div id="view"></div>`;
  const view = $("#view");
  if (ov.loading && !o) view.innerHTML = `<div class="loading"><span class="spin"></span> connecting to ${esc(n)}…</div>`;
  else if (ov.error) {
    const hint = errorHint(ov.error);
    view.innerHTML = `<div class="note bad"><b>Cannot reach ${esc(n)}.</b> ${esc(hint)}<div class="mono" style="margin-top:6px">${esc(ov.error)}</div></div>
      <div class="actions" style="margin:0">${btn("Set up", () => setupFlow([n]), "primary")} ${btn("Retry", () => (load(n, S.tab, true), render()))}</div>`;
  } else if (!o) view.innerHTML = "";
  else if (S.tab === "sites") view.innerHTML = sitesView(n, o);
  else if (S.tab === "tunnels") view.innerHTML = tunnelsView(n, o);
  else if (S.tab === "stats") view.innerHTML = statsView(n);
  else if (S.tab === "traffic") view.innerHTML = trafficView(n);
  else if (S.tab === "traefik") view.innerHTML = traefikView(n);
  else if (S.tab === "updates") view.innerHTML = updatesView(n);
  else if (S.tab === "firewall") view.innerHTML = firewallView(n);
  else if (S.tab === "system") view.innerHTML = systemView(n);
  else if (S.tab === "settings") view.innerHTML = settingsView(n);
  else view.innerHTML = historyView(n);
}

/** No server open: the servers, recent deploys, landfall's defaults and every place it writes to. */
function homeView() {
  const st = S.state;
  const list = st.servers;
  const own = list.filter((s) => s.registered).sort((a, b) => reachRank(a.name) - reachRank(b.name));
  const why = (n) => {
    const r = S.reach[n];
    return r && r.state !== "ok" ? `<div class="w ${r.state}">${REACH_DOT[r.state][1]}</div>` : "";
  };
  const tile = (s) => `<button type="button" class="tile" ${on(() => go(s.name, "sites"))}>
      <div class="n">${reachDot(s.name)}${esc(s.name)}${s.isDefault ? `<span class="star" title="default server">★</span>` : ""}</div>
      <div class="t">${esc(s.target)}</div>${why(s.name)}</button>`;
  const d = st.defaults;
  const def = d.default;
  const count = { ok: 0, login: 0, down: 0 };
  for (const s of list) if (S.reach[s.name]) count[S.reach[s.name].state]++;
  const stat = (k, word) => (count[k] ? `<span><span class="dot ${REACH_DOT[k][0]}"></span>${count[k]} ${word}</span>` : "");
  const status = S.reaching ? `<span><span class="spin"></span> checking ssh login…</span>` : S.reachedAt ? `${stat("ok", "reachable")}${stat("login", "login refused")}${stat("down", "unreachable")}` : "";
  const recent = (st.projects ?? []).slice(0, 6);
  const recentCard = `<div class="card"><h2>Recent deploys ${recent.length ? `<span class="badge">${(st.projects ?? []).length}</span>` : ""}
      <span class="actions">${btn("Deploy folder…", () => folderDialog(st.cwd), "sm", "Pick a folder, a recent project, or drop one here")}</span></h2>
    ${recent.length
      ? `<ul class="recent">${recent
          .map((r) => `<li><div><b>${esc(r.name)}</b> <span class="dim">→ ${esc(r.server)}${r.domains[0] ? ` · ${esc(r.domains[0])}` : " · tunnel only"}</span>
              <div class="faint mono" title="${esc(r.path)}">${esc(tilde(r.path))} · ${ago(r.at)}</div></div>
              ${btn("Deploy again", () => browse(r.path).then((x) => deployDialog(x.detected), (err) => toast(err.message)), "sm", `lf deploy from ${r.path}`)}</li>`)
          .join("")}</ul>`
      : `<div class="body dim">Nothing deployed from this machine yet. Folders you deploy show up here to deploy again.</div>`}</div>`;
  const row = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`;
  const defaultsCard = `<div class="card"><h2>Defaults <span class="sub">for every server, unless it sets its own</span>
      <span class="actions">${btn("Edit…", defaultsDialog, "sm", "lf config")}</span></h2>
    <div class="body"><dl class="kv">
      ${row("Default server", def ? `<a href="#/${encodeURIComponent(def)}">${esc(def)}</a>` : `<span class="dim">none: commands need -s</span>`)}
      ${row("New sites", d.tunnelOnly ? "no domain, tunnel only" : "get a domain")}
      ${row("Let's Encrypt e-mail", d.email ? `<span class="mono">${esc(d.email)}</span>` : `<span class="dim">none</span>`)}
      ${row("Releases kept", esc(String(d.keep)))}
      ${row("Saved in", `<span class="mono">${esc(d.configFile)}</span>`)}
    </dl></div></div>`;
  const paths = (l) => `<dl class="paths">${l.map((x) => `<dt class="mono">${esc(x.path)}</dt><dd>${esc(x.what)}</dd>`).join("")}</dl>`;
  const whereCard = `<div class="card"><h2>Where landfall puts things <span class="sub">nothing it installs is hidden</span></h2>
    <div class="where-cols"><div><h3>On this machine</h3>${paths(d.locations.local)}</div><div><h3>On each server</h3>${paths(d.locations.server)}</div></div></div>`;
  return `<div class="home">
    <h1>Overview</h1>
    <div class="home-sub">${plural(own.length, "server")}${own.length < list.length ? ` <span class="faint">+ ${list.length - own.length} from ~/.ssh/config</span>` : ""}${status ? `<span class="sep"></span>${status}` : ""}</div>
    <div class="grid">${own.map(tile).join("")}<button type="button" class="tile add" ${on(addServer)}>+ Add server</button></div>
    <p class="faint home-note">The dot shows whether landfall's ssh login works (hover for why not); nothing else connects until you open a server. Any ~/.ssh/config alias works as a server.</p>
    <div class="cols">${recentCard}${defaultsCard}</div>
    ${whereCard}
    <div class="cli">Everything here runs an <span class="mono">lf</span> command, shown above its output, so you can do the same in a terminal:
      <pre>lf deploy ./dist -d blog <span># a folder, Dockerfile project or image, with HTTPS</span>
lf ls${def ? "" : " -s <server>"}               <span># sites, and what else Traefik routes</span>
lf logs blog -f          <span># follow a site's logs</span>
lf undo                  <span># revert the last change</span>
lf config                <span># these defaults, and where landfall puts things</span>
lf help                  <span># every command</span></pre></div>
  </div>`;
}

/** Containers Traefik routes that landfall did not deploy: shown; Compose projects can be adopted. */
function othersCard(n, o) {
  if (!o.others?.length) return "";
  const links = (e) => e.domains.map((d) => `<span class="chip"><a href="https://${esc(d)}" target="_blank" rel="noopener">${esc(d)}</a></span>`).join("");
  return `<div class="card scroll"><h2>Not deployed by landfall <span class="badge">${o.others.length}</span></h2>
    <div class="lede">Containers your Traefik routes, e.g. your own compose projects. Adopting one lists it as a site with logs, restart and stop; it keeps running from its folder.</div>
    <table><thead><tr><th>Name</th><th class="hide-sm">Domains</th><th class="hide-sm">Folder</th><th><span class="sr">Actions</span></th></tr></thead><tbody>${o.others
      .map((e) => `<tr><td><div class="site-name">${statusDot(e.status)}<b>${esc(e.name)}</b>&nbsp;<span class="faint">${esc(e.status.toLowerCase())}</span></div>
          <div class="chips show-sm">${links(e)}</div></td>
        <td class="hide-sm"><div class="chips">${links(e)}</div></td>
        <td class="hide-sm mono dim">${esc(e.dir ?? e.containers.join(", "))}</td>
        <td class="acts">${btn("Tunnel", () => run(["tunnel", e.name, ...sv(n)], { server: n }), "sm", "lf tunnel: an SSH tunnel straight to the container, until you stop it")}${e.dir ? btn("Adopt…", () => adoptDialog(n, e), "sm", "lf adopt") : ""}</td></tr>`)
      .join("")}</tbody></table></div>`;
}

function sitesView(n, o) {
  ensureDns(n, o);
  if (!o.ready && can(n) && !can(n).setup) {
    return `<div class="card"><div class="body empty"><h2>Not ready for sites</h2>
      <p>${esc(S.facts[n]?.data?.why?.setup ?? "")}, so landfall cannot set it up: sites need ${esc("/opt/landfall")} and Traefik, which setup creates.</p></div></div>`;
  }
  if (!o.ready) {
    return `<div class="card"><div class="body empty"><h2>Not set up for landfall yet</h2>
      <p>Setup installs Docker and Traefik, a deploy user and (if you want) a firewall. It shows what it would change first.</p>
      <p>${btn("Check & set up", () => setupFlow([n]), "primary")}</p></div></div>`;
  }
  if (!o.sites.length) {
    return `<div class="card"><div class="body empty"><h2>No sites yet</h2>
      <p>Deploy a folder with a compose.yaml, a Dockerfile, static files, or an image. It gets HTTPS automatically.</p>
      <p>${btn("Deploy a folder…", () => folderDialog(S.state.cwd), "primary")} <span class="dim">or drop one here</span></p>
      <p class="faint mono">lf deploy ./dist -d example.com -s ${esc(n)}</p></div></div>${othersCard(n, o)}`;
  }
  const rows = o.sites
    .map(({ meta: m, status, services, domains, main, state, kind }) => {
      const cur = m.releases.find((r) => r.id === m.current);
      const name = m.name;
      const open = S.open.has(`${n}/${name}`);
      const up = isUp(status);
      const old = state === "old";
      // Adopted and pre-Compose sites: landfall runs them, it does not deploy them.
      const managed = state === "managed";
      const older = [...m.releases].sort((a, b) => (a.at < b.at ? 1 : -1)).filter((r) => r.at < (cur?.at ?? ""));
      const proj = (S.state.projects ?? []).find((p) => p.server === n && p.name === name);
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
      const svcMenu = (x) =>
        menuBtn([
          { label: "Logs", hint: `lf logs ${name} ${x.service}`, run: () => run(["logs", name, x.service, ...sv(n), "-f"]) },
          { label: "Restart", hint: "lf restart", run: () => run(["restart", name, x.service, ...sv(n)]) },
          isUp(x.status)
            ? { label: "Stop…", hint: "lf stop", run: () => confirmDlg({ title: `Stop ${x.service} of ${name}?`, text: "It stays stopped until you start it again.", ok: "Stop it", danger: true, onOk: () => run(["stop", name, x.service, ...sv(n)]) }) }
            : { label: "Start", hint: "lf start", run: () => run(["start", name, x.service, ...sv(n)]) },
        ], `${x.service} of ${name}`, "sm ghost");
      const editBuild = () => buildSettings(proj.path, { server: n, name, domains: m.domains ?? [], old });
      const acts = [
        proj && !m.adopted
          ? btn("Redeploy", () => confirmDlg({ title: `Redeploy ${name}?`, text: `From ${tilde(proj.path)}${proj.kind === "static" ? " (runs its build first, if it has one)" : ""}.`, ok: "Deploy", onOk: () => run(["deploy", "-y", ...sv(n)], { server: n, cwd: proj.path, after: openAfter }) }), "sm primary", `lf deploy in ${proj.path}`)
          : m.adopted || m.kind === "image" ? ""
          : btn("Redeploy…", () => folderDialog(S.state.cwd, { server: n, name, domains: m.domains ?? [], old }), "sm", "Pick the folder it was deployed from"),
        old ? "" : btn("Logs", () => run(["logs", name, ...sv(n), "-f"]), "sm", "Follow the logs of all its services"),
        menuBtn([
          old ? null : { label: "Restart", hint: "lf restart", run: () => run(["restart", name, ...sv(n)]) },
          old ? null
          : up ? { label: "Stop…", hint: "lf stop", run: () => confirmDlg({ title: `Stop ${name}?`, text: `${domains.join(", ") || "The site"} stops answering until you start it again.`, ok: "Stop it", danger: true, onOk: () => run(["stop", name, ...sv(n)]) }) }
          : { label: "Start", hint: "lf start", run: () => run(["start", name, ...sv(n)]) },
          managed && older.length
            ? { label: "Roll back…", hint: "lf rollback", title: `To ${older[0].id} (${ago(older[0].at)})`, run: () => confirmDlg({ title: `Roll back ${name}?`, text: `From ${m.current} to ${older[0].id} (${ago(older[0].at)}). Volumes keep their data.`, ok: "Roll back", onOk: () => run(["rollback", name, ...sv(n), "-y"]) }) }
            : null,
          "-",
          old ? null : { label: "Open via tunnel", hint: "lf tunnel", title: "An SSH tunnel straight to the container: test it on localhost, no domain needed", run: () => run(["tunnel", name, ...sv(n)], { server: n }) },
          main ? { label: "Domains…", hint: "lf domains", run: () => domainsDialog(n, m) } : null,
          managed ? { label: m.auth?.length ? "Login…" : "Password…", hint: "lf auth", title: "Protect the site with a user and password", run: () => authDialog(n, m) } : null,
          managed ? { label: "Environment…", hint: "lf env", run: () => envDialog(n, name) } : null,
          proj && !m.adopted ? { label: "Build settings…", hint: "lf deploy --build --start", title: "What it builds and starts with, its port, static or Node.js", run: editBuild } : null,
          "-",
          { label: m.adopted ? `Forget ${name}…` : `Delete ${name}…`, cls: "danger", hint: "lf sites rm", run: deleteSite },
        ], `More for ${name}`),
      ].join("");
      const toggle = () => (open ? S.open.delete(`${n}/${name}`) : S.open.add(`${n}/${name}`), render());
      const live = m.releases?.find((r) => r.id === m.current);
      const svcDomains = (svc) => (svc === main ? m.domains : (live?.services?.find((x) => x.name === svc)?.domains ?? []));
      const det = open && proj && !m.adopted ? detected(proj.path) : undefined;
      const detail = open
        ? `<tr class="detail"><td colspan="5"><dl class="kv">
            ${old ? `<dt>Old site</dt><dd class="dim">Deployed before sites were Compose projects: ${proj ? "redeploy it" : `run <span class="mono">lf deploy</span> for it`} once to manage it again.</dd>` : ""}
            <dt>Services</dt><dd>${services.length
              ? `<ul class="services">${services.map((x) => `<li>${statusDot(x.status)}<b>${esc(x.service)}</b>${svcDomains(x.service).length ? ` <span class="badge">${esc(svcDomains(x.service).join(" "))}</span>` : ""} <span class="faint">${esc(x.status.toLowerCase())}</span>${old ? "" : svcMenu(x)}</li>`).join("")}</ul>`
              : `<span class="dim">none running</span>`}</dd>
            <dt>On ${esc(n)}</dt><dd>${siteFiles(m, state)}</dd>
            ${m.adopted ? "" : `<dt>Source</dt><dd>${proj
              ? `<span class="mono">${esc(tilde(proj.path))}</span> <span class="dim">· redeploy runs there</span>`
              : `<span class="dim">not deployed from this machine${m.kind === "image" ? "" : " (or the folder moved): Redeploy… picks the folder"}</span>`}</dd>`}
            ${det !== undefined ? `<dt>Build</dt><dd>${det ? `${describe(det, false)} ${btn("Edit…", editBuild, "sm ghost", "Build settings: lf deploy --build --start")}` : `<span class="faint">${det === false ? "cannot read its folder" : "reading its folder…"}</span>`}</dd>` : ""}
            <dt>Kind</dt><dd>${esc(kind)}${main || !managed ? "" : ` <span class="dim">· domains set in compose.yaml</span>`}</dd>
            ${managed ? `<dt>Login</dt><dd>${m.auth?.length ? `${esc(m.auth.map((a) => a.split(":")[0]).join(", "))} (basic auth)` : `<span class="dim">public</span>`}</dd>` : ""}
            <dt>Created</dt><dd>${esc(ago(m.createdAt))} · updated ${esc(ago(m.updatedAt))}</dd>
            ${m.releases.length ? `<dt>Releases</dt><dd><ul class="releases">${[...m.releases]
              .sort((a, b) => (a.at < b.at ? 1 : -1))
              .map((r) => `<li><span class="mono">${esc(r.id)}</span><span class="dim">${esc(ago(r.at))}</span>${r.services ? `<span class="faint">${esc(r.services.map((x) => x.name).join(", "))}</span>` : ""}
                ${r.id === m.current ? `<span class="badge ok">live</span>` : managed ? btn("Switch to this", () => confirmDlg({ title: `Switch ${name} to ${r.id}?`, text: `Release from ${ago(r.at)} goes live instead of ${m.current}. Volumes keep their data.`, ok: "Switch", onOk: () => run(["rollback", name, ...sv(n), "--to", r.id, "-y"]) }), "sm") : ""}</li>`)
              .join("")}</ul></dd>` : ""}
          </dl></td></tr>`
        : "";
      // A site deployed with no domain is reached by its tunnel.
      const where = domains.length ? domains.map((d) => domainChip(n, d)).join("") : main && !old ? `<span class="faint">no domain</span> ${tunnelBtn(n, ["tunnel", name, ...sv(n)])}` : "";
      return `<tr class="click" ${on(toggle)}>
        <td><div class="site-name">${statusDot(status)}<button type="button" class="row-toggle" aria-expanded="${open}" data-f="row:${esc(name)}" ${on(toggle)}><b>${esc(name)}</b> <span class="faint" aria-hidden="true">${open ? "▾" : "▸"}</span></button>${m.auth?.length ? `<span class="lock" title="password protected" role="img" aria-label="password protected">🔒</span>` : ""}</div>
          <div class="chips show-sm">${where}</div></td>
        <td class="hide-sm"><div class="chips">${where}</div></td>
        <td class="hide-sm"><span class="badge" title="${esc(services.map((x) => x.service).join(", "))}">${esc(kind)}</span>${services.length > 1 ? ` <span class="faint">${services.length} services</span>` : ""}</td>
        <td class="hide-sm dim">${cur ? esc(ago(cur.at)) : ""}</td>
        <td class="acts">${acts}</td></tr>${detail}`;
    })
    .join("");
  return `<div class="card scroll"><table>
    <thead><tr><th>Site</th><th class="hide-sm">Domains</th><th class="hide-sm">Kind</th><th class="hide-sm">Deployed</th><th><span class="sr">Actions</span></th></tr></thead>
    <tbody>${rows}</tbody></table></div>${errorsCard(n)}${othersCard(n, o)}`;
}

/** Where a site lives on the server: docker compose works in its current folder. */
function siteFiles(m, state) {
  const dir = `${S.state.paths.sites}/${m.name}`;
  if (m.adopted) return `<span class="mono">${esc(m.adopted)}</span><div class="dim">its own folder; project <span class="mono">${esc(m.project ?? m.name)}</span></div>`;
  if (state === "old") return `<span class="mono">${esc(dir)}</span>`;
  return `<span class="mono">${esc(dir)}/current</span> <span class="dim">→ releases/${esc(m.current)}</span>
    <div class="faint mono">compose.yaml · compose.override.yaml (landfall's) · .env (mode 600)</div>
    <div class="faint">run it by hand: <span class="mono">cd ${esc(dir)}/current && docker compose ps</span></div>`;
}

function adoptDialog(n, e) {
  dialog({
    title: `Adopt ${e.name}?`,
    text: `${e.name} keeps running from ${e.dir} with its own files and Traefik labels. landfall lists it as a site with logs, restart, stop and start; it does not deploy it or change its domains.`,
    fields: [{ name: "name", label: "Site name", value: e.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+/, ""), required: true, check: siteNameError }],
    ok: "Adopt",
    onOk: (v) => run(["adopt", e.name, ...sv(n), "--name", v.name.trim()], { server: n }),
  });
}

function envDialog(n, name) {
  dialog({
    title: `Environment of ${name}`,
    text: "Changes recreate the container. Leave both empty to only show the current values.",
    fields: [
      {
        name: "set", label: "Set (KEY=VALUE, one per line)", type: "textarea", value: "", placeholder: "DATABASE_URL=postgres://…\nLOG_LEVEL=info",
        check: (x) => x.split("\n").map((l) => l.trim()).filter((l) => l && !/^[^=]+=/.test(l)).map((l) => `Not KEY=VALUE: ${l.slice(0, 40)}`)[0],
      },
      { name: "unset", label: "Remove (names, space separated)", value: "", placeholder: "OLD_KEY" },
    ],
    ok: "Apply",
    onOk: (v) => {
      const pairs = v.set.split("\n").map((l) => l.trim()).filter((l) => l && l.includes("="));
      const unset = v.unset.split(/[\s,]+/).filter(Boolean).flatMap((k) => ["-u", k]);
      run(["env", name, ...sv(n), ...pairs, ...unset]);
    },
  });
}
