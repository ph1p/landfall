"use strict";
// ---- tunnels -------------------------------------------------------------------

/** Everything an SSH tunnel reaches on server n, and the tunnels open now. */
function tunnelsView(n, o) {
  if (!o.ready && !o.others.length && !o.unrouted?.length) return `<div class="card"><div class="body empty"><h2>Nothing to tunnel to yet</h2><p>Set up the server and deploy a site first.</p></div></div>`;
  const open = openTunnels(n);
  const chips = (l) => `<div class="chips">${l.map((d) => `<span class="chip">${esc(d)}</span>`).join("")}</div>`;
  const targets = [];
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
  const loose = (o.unrouted ?? []).map((x) => ({ name: x.container, status: x.status, image: x.image, ports: x.ports ?? [], serves: [], argv: ["tunnel", ...(x.project ? [x.project, x.service] : [x.container]), ...sv(n)] }));
  const row = (t) => `<tr><td><div class="site-name">${t.status ? statusDot(t.status) : ""}<b>${esc(t.name)}</b>${t.other ? `&nbsp;<span class="faint">not landfall's</span>` : ""}</div><div class="show-sm">${chips(t.serves)}</div></td>
      <td class="hide-sm">${chips(t.serves)}</td>
      <td class="acts">${t.argv ? tunnelBtn(n, t.argv) : `<span class="dim">${esc(t.why)}</span> ${btn("Traefik", () => go(n, "traefik"), "sm")}`}</td></tr>`;
  return `${open.length ? `<div class="card scroll"><h2>Open <span class="badge ok">${open.length}</span></h2><table><tbody>${open
      .map((j) => `<tr><td><b class="mono">lf ${esc(j.info.argv.filter((a, i, l) => a !== "-s" && l[i - 1] !== "-s").join(" "))}</b></td><td class="acts">${tunnelBtn(n, j.info.argv)}</td></tr>`)
      .join("")}</tbody></table></div>` : ""}
    <div class="card scroll"><h2>Tunnel to</h2>
      <div class="lede">An SSH tunnel forwards a port on this machine to a container on ${esc(n)}: test a site on localhost with no domain, HTTPS or login. Nothing changes on the server, and closing the tunnel ends it.</div>
      <table><thead><tr><th>Container</th><th class="hide-sm">Domains</th><th><span class="sr">Tunnel</span></th></tr></thead><tbody>${targets.map(row).join("")}</tbody></table></div>
    ${loose.length ? `<div class="card scroll"><h2>Other containers <span class="badge">${loose.length}</span></h2>
      <div class="lede">Running, but no domain routes to them: databases, caches, workers. The tunnel goes to the port their image exposes.</div>
      <table><thead><tr><th>Container</th><th class="hide-sm">Image</th><th><span class="sr">Tunnel</span></th></tr></thead><tbody>${loose
        .map((t) => `<tr><td><div class="site-name">${statusDot(t.status)}<b>${esc(t.name)}</b></div><div class="show-sm faint mono">${esc(t.image)}</div></td><td class="hide-sm faint mono">${esc(t.image)}</td><td class="acts">${tunnelBtn(n, t.argv, undefined, t.ports)}</td></tr>`)
        .join("")}</tbody></table></div>` : ""}`;
}
