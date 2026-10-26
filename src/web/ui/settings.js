"use strict";
// ---- traefik & settings --------------------------------------------------------

/** Traefik on server n: its dashboard (domain and tunnel) and how landfall runs it. */
function traefikView(n) {
  const st = S.settings[n];
  const wait = pending(st, "reading the settings…");
  if (wait) return wait;
  const x = st.data;
  const reload = { server: n, after: ifOk(() => (load(n, "traefik", true), render())) };
  const rows = (pairs) => `<dl class="kv">${pairs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>`;
  const P = S.state.paths;
  const dashboard = () =>
    dialog({
      title: `Traefik dashboard on ${n}`,
      text: "Serves the dashboard on a domain behind a login. Without one it stays reachable through an SSH tunnel only (Open via tunnel).\nRuns lf traefik setup, which reconfigures landfall's Traefik.",
      fields: [
        {
          name: "domain", label: "Domain", value: x.traefik.dashboard ?? "", mono: true, placeholder: x.domains[0] ? `traefik.${x.domains[0]}` : "traefik.example.com",
          hint: x.traefik.dashboard ? "Empty: take the dashboard off its domain." : "Needs an A record pointing at the server.",
          required: !x.traefik.dashboard && "Give a domain, or use the tunnel", check: (d) => d && !domainOk(d) && "Not a domain",
        },
        {
          legend: "Login", when: (v) => v.domain.trim(),
          fields: [
            {
              row: [
                { name: "user", label: "User", value: "admin", placeholder: "admin", check: (u) => userError(u || "admin") },
                {
                  name: "password", label: `Password (${S.state.rules.minPassword}+ characters)`, type: "password", check: (pw) => pw && passwordError(pw),
                  hint: x.traefik.dashboard ? "Empty: keeps the current one." : "Empty: a generated one, shown in the output.",
                },
              ],
            },
          ],
        },
      ],
      ok: "Apply",
      onOk: (v) => {
        const d = v.domain.trim();
        const user = v.user.trim() || "admin";
        const argv = ["traefik", "setup", ...sv(n), "--dashboard", d || "off"];
        if (d) argv.push("--dashboard-user", user, ...(v.password ? ["--dashboard-password", v.password] : []));
        run(argv, reload);
      },
    });
  const traefikDialog = () =>
    dialog({
      title: `Traefik on ${n}`,
      text: "Runs lf traefik setup, which reconfigures landfall's Traefik and restarts it (a few seconds without traffic). The settings are remembered.",
      fields: [
        { name: "http3", label: "HTTP/3 (QUIC on 443/udp)", type: "check", value: x.traefik.http3, hint: "Faster on lossy and mobile connections; browsers that can't use it fall back to HTTP/2." },
        {
          name: "mode", label: "Ports", type: "select", value: x.traefik.hostNetwork ? "host" : "docker",
          options: [
            { value: "docker", label: "Published by Docker (default)" },
            { value: "host", label: "Host network: real client IPs, ufw guards 80/443" },
          ],
        },
        { name: "image", label: "Image", value: x.traefik.image, placeholder: S.state.defaultImage },
        { name: "email", label: "Let's Encrypt e-mail (optional)", value: x.traefik.email ?? "", hint: "Only the account contact; Let's Encrypt no longer mails expiry warnings." },
        { name: "staging", label: "Let's Encrypt staging CA (test certificates, browsers warn)", type: "check", value: x.traefik.staging },
      ],
      ok: "Apply",
      onOk: (v) => {
        const argv = ["traefik", "setup", ...sv(n), v.http3 ? "--http3" : "--no-http3", v.mode === "host" ? "--host-network" : "--no-host-network", v.staging ? "--staging" : "--no-staging"];
        if (v.image.trim()) argv.push("--image", v.image.trim());
        if (v.email.trim()) argv.push("--email", v.email.trim());
        run(argv, reload);
      },
    });
  // lf traefik setup refuses to touch a Traefik the server already had.
  const o = S.overview[n]?.data;
  const foreign = o?.adopted ? o.proxy : "";
  const dash = o?.dashboard ?? { hosts: x.traefik.dashboard ? [x.traefik.dashboard] : [], tunnel: false };
  const link = (h) => `<a href="https://${esc(h)}" target="_blank" rel="noopener">${esc(h)}</a>`;
  const dashArgv = ["traefik", "dashboard", ...sv(n)];
  return `
    <div class="card">
      <h2>Dashboard <span class="actions">${foreign ? "" : btn(dash.hosts.length ? "Domain & login…" : "Put on a domain…", dashboard, "sm")}</span></h2>
      <div class="body">${rows([
        ["domain", dash.hosts.length ? `${dash.hosts.map(link).join(", ")} <span class="dim">(with its login)</span>` : `<span class="dim">none${foreign ? "" : ": only through the tunnel"}</span>`],
        ["tunnel", dash.tunnel
          ? `${tunnelBtn(n, dashArgv, "Open via tunnel")} <span class="dim mono">lf traefik dashboard</span>`
          : foreign ? `<span class="dim">route its dashboard (api@internal) to a domain, or run <span class="mono">lf traefik dashboard --port &lt;its api port&gt;</span></span>`
          : `<span class="dim">set up by an older landfall</span> ${btn("Enable tunnel", () => run(["traefik", "setup", ...sv(n)], reload), "sm", "Re-runs lf traefik setup, which adds it")}`],
      ])}</div>
    </div>
    <div class="card">
      <h2>Traefik <span class="actions">${btn("Status", () => run(["traefik", "status", ...sv(n)]), "sm", "lf traefik status")}${foreign ? "" : btn("Settings…", traefikDialog, "sm")}</span></h2>
      <div class="body">${foreign ? `<div class="note">Sites go through <b class="mono">${esc(foreign)}</b>, a Traefik landfall did not install and never changes: it is configured in its own files.</div>` : ""}${rows([
        ["image", esc(x.traefik.summary)],
        ["e-mail", esc(x.traefik.email ?? "none")],
        ["HTTP/3", x.traefik.http3 ? `on <span class="dim">(443/udp)</span>` : `<span class="dim">off</span>`],
        ["files", `<span class="mono">${esc(P.traefik)}/docker-compose.yml</span>`],
        ["certificates", `<span class="mono">${esc(P.traefik)}/letsencrypt/</span> <span class="dim">(kept on reinstall)</span>`],
      ])}<p class="faint">Used when landfall installs or reconfigures its own Traefik. With a Traefik that was already there, landfall only writes <span class="mono">${esc(P.proxy)}</span>.</p></div>
    </div>`;
}

function settingsView(n) {
  const st = S.settings[n];
  const wait = pending(st, "reading the settings…");
  if (wait) return wait;
  const x = st.data;
  const reload = { server: n, after: ifOk(() => (load(n, "settings", true), render())) };
  const rows = (pairs) => `<dl class="kv">${pairs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>`;
  const dnsRow = (d) => `${esc(d.domain)} ${d.ok ? `<span class="badge ok">dns ok</span>` : d.ips.length ? `<span class="badge warn">dns → ${esc(d.ips.join(", "))}</span>` : `<span class="badge bad">no dns</span>`}`;
  const addDomain = () =>
    promptDlg(`Add a main domain to ${n}`, `${x.domains.length ? "The first main domain stays the primary." : "The first main domain is the primary: new sites get <site>.<domain>, and a bare name like blog means blog.<domain>."}\nPoint <domain> and *.<domain> (A records) at the server once.`, { label: "Domain", placeholder: "example.com", type: "text", value: "" }, (d) => {
      if (d) run(["server", "domain", n, "--add", d], reload);
    }, "Add");
  const sites = S.overview[n]?.data?.sites ?? [];
  const external = (d) => S.overview[n]?.data?.others?.find((e) => e.domains.includes(d))?.name;
  const servedBy = (d) => sites.find((s) => s.domains.includes(d))?.meta.name;
  const serve = (d) => {
    const cur = servedBy(d);
    // Only sites whose domains landfall sets; the others name theirs in compose.yaml.
    const pick = sites.filter((s) => s.main && s.meta.name !== cur);
    if (!pick.length) return void toast(cur ? `${cur} is the only site on ${n}` : `No sites on ${n} yet: deploy one with @ as its domain`);
    dialog({
      title: `Serve a site on ${d}`,
      text: cur ? `${cur} serves ${d} now; it moves to the site you pick, which keeps its other domains.` : `The site keeps its other domains. ${d} needs an A record pointing at the server.`,
      fields: [{ name: "site", label: "Site", type: "select", options: pick.map((s) => ({ value: s.meta.name, label: `${s.meta.name} (${s.domains.join(", ")})` })), value: pick[0].meta.name }],
      ok: "Serve it",
      onOk: (v) => run(["domains", v.site, ...sv(n), "--add", d, "-y"], { server: n, after: ifOk(() => (load(n, "settings", true), load(n, "sites", true), render())) }),
    });
  };
  const P = S.state.paths;
  const ip = x.dns[0]?.ips[0] ?? "<server ip>";
  const records = x.dns.flatMap((r) => [r.apex, r.wildcard]).filter((d) => !d.ok).map((d) => `${esc(d.domain)}  A  ${esc(ip)}`);
  const tunnel = x.tunnelOnly;
  const setTunnel = () =>
    run(["server", "domain", n, tunnel ? "--no-tunnel-only" : "--tunnel-only"], { server: n, after: ifOk(() => (load(n, "settings", true), refreshState())) });
  const saved = x.saved ? Object.entries(x.saved).filter(([k, v]) => v !== undefined && k !== "dashboard").map(([k, v]) => [k, `<span class="mono">${esc(String(v))}</span>`]) : [];
  return `
    <div class="card">
      <h2>Main domains <span class="actions">${btn("Add domain…", addDomain, "sm")}</span></h2>
      <div class="body">${x.domains.length
        ? `${x.domains.map((d, i) => `<div class="drow">
             <div>${dnsRow(x.dns[i].apex)}${i === 0 ? ` <span class="badge accent">primary</span>` : ""}<div class="dim">sites: ${dnsRow(x.dns[i].wildcard)}</div><div class="faint">${servedBy(d) ? `served by <b>${esc(servedBy(d))}</b>` : external(d) ? `served by <b>${esc(external(d))}</b> (not landfall)` : "no site serves it"}</div></div>
             <div class="actions">${btn(servedBy(d) ? "Serve another site…" : "Serve a site…", () => serve(d), "sm")}${menuBtn([
               i ? { label: "Make primary", hint: "--primary", run: () => run(["server", "domain", n, "--primary", d], reload) } : null,
               { label: `Remove ${d}…`, cls: "danger", hint: "--rm", run: () => confirmDlg({ title: `Remove ${d} from ${n}?`, text: "New sites stop getting names under it. Sites keep their domains.", ok: "Remove it", danger: true, onOk: () => run(["server", "domain", n, "--rm", d, "-y"], reload) }) },
             ], `More for ${d}`)}</div>
           </div>`).join("")}
           <p class="faint">New sites get <span class="mono">&lt;site&gt;.${esc(x.domains[0])}</span>; a bare name like <span class="mono">blog</span> means <span class="mono">blog.${esc(x.domains[0])}</span>, and <span class="mono">@</span> means <span class="mono">${esc(x.domains[0])}</span> itself.</p>
           ${records.length ? `<div class="note">Add at your DNS provider:<div class="mono">${records.join("<br>")}</div></div>` : ""}`
        : `<p class="dim">No main domain set in landfall. New sites get a free <span class="mono">&lt;site&gt;.&lt;ip&gt;.sslip.io</span> address until you set one.</p>`}
        <div class="drow">
          <div>New sites: ${tunnel ? `<b>no domain</b> <span class="dim">· tunnel only until you give one (Domains… on the site, or deploy with a domain)</span>` : `<b>get a domain</b> <span class="dim">· unless you tick “No domain” when deploying</span>`}${x.tunnelOnlyOwn ? "" : ` <span class="faint">(landfall default)</span>`}</div>
          <div class="actions">${btn(tunnel ? "Give them a domain" : "Make them tunnel only", setTunnel, "sm", tunnel ? "lf server domain --no-tunnel-only" : "lf server domain --tunnel-only")}</div>
        </div>
        ${x.suggest.length ? `<div class="note">${x.domains.length ? "Other domains" : "Domains"} your sites on this server already use: ${x.suggest.map((g) => `<b>${esc(g.domain)}</b> <span class="faint">(${g.hosts})</span> ${btn("Add", () => run(["server", "domain", n, "--add", g.domain], reload), "sm")}`).join(" ")}</div>` : ""}</div>
    </div>
    <div class="card">
      <h2>On the server <span class="dim mono" style="font-weight:400">${esc(P.root)}</span></h2>
      <div class="body">${rows([
        ["sites", `<span class="mono">${esc(P.sites)}/&lt;site&gt;/</span> <span class="dim">one folder per site: releases, compose file, .env</span>`],
        ["traefik", `<span class="mono">${esc(P.traefik)}/</span>`],
        ["history", `<span class="mono">${esc(P.journal)}</span> <span class="dim">every change with its undo</span>`],
      ])}</div>
    </div>
    <div class="card">
      <h2>landfall config <span class="dim mono" style="font-weight:400">${esc(x.configFile)}</span></h2>
      <div class="body">${saved.length ? rows(saved) : `<p class="dim">Not registered — an ssh alias landfall reads from ~/.ssh/config.</p>`}</div>
    </div>
    <div class="card">
      <h2>SSH <span class="dim mono" style="font-weight:400">ssh -G ${esc(x.saved?.host ?? n)}</span></h2>
      <div class="body">${rows([
        ["login", `<span class="mono">${esc(`${x.ssh.user}@${x.ssh.hostname}:${x.ssh.port}`)}</span>`],
        ...x.ssh.keys.map((k) => ["key", `<span class="mono">${esc(k.file)}</span>${k.exists ? "" : ` <span class="badge bad">missing</span>`}`]),
      ])}
      ${x.ssh.block
        ? `<p class="dim">${esc(x.ssh.block.file)}:${x.ssh.block.line} · ${x.ssh.block.managed ? "written by landfall" : "your own"}</p><pre class="mono block">${esc(x.ssh.block.text)}</pre>`
        : `<p class="dim">No Host block; ssh uses its defaults.</p>`}</div>
    </div>`;
}
