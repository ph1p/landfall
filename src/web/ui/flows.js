"use strict";
// ---- server flows ----------------------------------------------------------


function setupFlow(args, base = args) {
  run(["setup", ...args, "--check"], {
    server: args[0],
    after: (j) => {
      if (j.info.code !== 0) return;
      // Synology and other systems without a package manager: nothing for setup to apply.
      if (rep(j).refuse) return [{ label: "Back to the server", run: () => ((S.job = null), go(args[0], "sites")) }];
      if (rep(j).needsKey) {
        return [{ label: "Enter the password to install a key", run: () => passwordFor(args, base) }];
      }
      const todo = (rep(j).checks ?? []).filter((ch) => ch.status === "todo").length;
      return [
        { label: todo ? `Apply ${plural(todo, "change")}` : "Finish setup (nothing to install)", run: () => run(["setup", ...args, "-y"], { server: args[0], after: securityAfter(args[0]) }) },
        { label: "Change options", run: () => setupWizard(base) },
      ];
    },
  });
}

/** After a job that ends with security advice: a way to its fixes. */
const securityAfter = (n) => (j) =>
  j.info.code === 0 && rep(j).advice?.length ? [{ label: `Security: ${plural(rep(j).advice.length, "thing")} to look at`, run: () => go(n, "system") }] : undefined;

function setupWizard(base) {
  const saved = serverNamed(base[0])?.saved ?? {};
  dialog({
    title: `Set up ${base[0]}`,
    text: "landfall first shows what it finds and what it would change. Nothing is applied before you confirm.",
    ok: "Check",
    fields: [
      {
        legend: "Traefik (reverse proxy, automatic HTTPS)",
        fields: [
          {
            name: "traefik", label: "Mode", type: "select", value: saved.hostNetwork ? "host" : "docker",
            options: [
              { value: "docker", label: "Own Traefik, ports published by Docker" },
              { value: "host", label: "Own Traefik on the host network (real client IPs, ufw guards 80/443)" },
              { value: "none", label: "No Traefik (add later with traefik setup)" },
            ],
            hint: "If the server already runs a Traefik on 80/443, setup routes sites through it instead.",
          },
          { name: "email", label: "Let's Encrypt e-mail (optional)", value: saved.email ?? "", when: (v) => v.traefik !== "none", check: (x) => x && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x) && "An e-mail address" },
          { name: "dashboard", label: "Dashboard domain (optional)", value: "", placeholder: "traefik.example.com", mono: true, hint: "Behind basic auth; the password is shown after setup.", when: (v) => v.traefik !== "none", check: (x) => x && !domainOk(x) && "Not a domain" },
          { name: "http3", label: "HTTP/3 (QUIC on 443/udp)", type: "check", value: saved.http3 !== false, hint: "Browsers that can't use it fall back to HTTP/2.", when: (v) => v.traefik !== "none" },
          { name: "image", label: "Image", value: saved.traefikImage ?? S.state.defaultImage, mono: true, when: (v) => v.traefik !== "none" },
        ],
      },
      { name: "firewall", label: "Enable ufw: deny incoming except ssh, 80 and 443", type: "check", value: true, hint: "Skipped automatically if it would block ports in use." },
      { name: "harden", label: "Key login only (turn off ssh passwords)", type: "check", value: true, hint: "Skipped automatically if other users still log in with a password." },
      { name: "user", label: "Deploy user", value: "deploy", hint: "landfall deploys as this user (docker group, your key). Empty keeps the login user." },
    ],
    onOk: (v) => {
      const f = [];
      if (v.traefik === "none") f.push("--no-traefik");
      else {
        f.push(v.traefik === "host" ? "--host-network" : "--no-host-network");
        if (v.image.trim()) f.push(`--image=${v.image.trim()}`);
        if (v.email.trim()) f.push(`--email=${v.email.trim()}`);
        if (v.dashboard.trim()) f.push(`--dashboard=${v.dashboard.trim()}`);
        f.push(v.http3 ? "--http3" : "--no-http3");
      }
      if (!v.firewall) f.push("--no-firewall");
      if (!v.harden) f.push("--no-harden");
      f.push(`--deploy-user=${v.user.trim()}`);
      setupFlow([...base, ...f], base);
    },
  });
}

function passwordFor(args, base) {
  const host = args.includes("--host") ? `root@${args[args.indexOf("--host") + 1]}` : serverNamed(args[0])?.target ?? args[0];
  promptDlg(
    `Password for ${host}`,
    "Used once to install landfall's ssh key (ssh-copy-id). It is not stored; afterwards only the key is used.",
    { type: "password", label: "Password" },
    (pw) => {
      if (!pw) return;
      run(["setup", ...args, "--key-only", "-y"], {
        password: pw,
        server: args[0],
        after: (j) => {
          if (j.info.code === 0) return void setTimeout(() => setupFlow(args, base));
          return [{ label: "Try the password again", run: () => passwordFor(args, base) }];
        },
      });
    },
    "Install key",
  );
}

function addServer() {
  const known = (name) => !!serverNamed(name);
  dialog({
    title: "Add a server",
    text: "Use an alias from ~/.ssh/config (like vps), or pick a new name and give the machine's address, fresh or already in use. landfall writes the ssh config entry for it.",
    fields: [
      {
        row: [
          { name: "name", label: "Name", placeholder: "vps", required: "Give the server a name", preview: (v) => known(v.name.trim()) && "✓ in your ssh config" },
          {
            name: "host", label: "IP or hostname", placeholder: "203.0.113.7", mono: true, hint: "Not needed for an ssh alias.",
            check: (h, v) => !h && !known(v.name.trim()) && `${v.name.trim()} is not in your ssh config: give its IP or hostname`,
          },
        ],
      },
      {
        legend: "Login (for a new address)",
        fields: [
          { row: [{ name: "user", label: "User", placeholder: "root" }, { name: "port", label: "SSH port", type: "number", placeholder: "22", check: portError }] },
          { name: "key", label: "Private key file (optional)", placeholder: "~/.ssh/id_ed25519", mono: true, hint: "Without one, landfall creates ~/.ssh/landfall_<name> and installs it with the password." },
          { name: "password", label: "Password (optional)", type: "password", hint: "Used once to install the key, never stored. Leave empty if the key already works." },
        ],
      },
      { name: "setup", label: "Set it up now (shows what it would change first)", type: "check", value: true },
    ],
    ok: "Add",
    onOk: (v) => {
      const [name, host, user, port, key] = [v.name, v.host, v.user, v.port, v.key].map((x) => x.trim());
      const args = [name, ...(host ? ["--host", host] : []), ...(user ? ["-u", user] : []), ...(port ? ["-p", port] : []), ...(key ? ["-i", key] : [])];
      // With a password: install the key now, then the setup wizard needs nothing but the alias.
      const then = ifOk(() => (v.setup ? setupWizard([name]) : go(name)));
      if (v.password) run(["server", "add", ...args], { server: name, password: v.password, after: then });
      else if (v.setup) setupWizard(args);
      else run(["server", "add", ...args], { server: name, after: (j) => void go(name, rep(j).advice?.length ? "system" : S.tab) });
    },
  });
}

const defaultServer = () => S.sel ?? S.state.servers.find((s) => s.isDefault)?.name;
const mainDomain = (n) => serverNamed(n)?.saved?.domains?.[0];
/** The server deploys new sites with no domain unless one is given: its own setting, else landfall's default. */
const tunnelOnly = (n) => serverNamed(n)?.saved?.tunnelOnly ?? S.state.defaults.tunnelOnly;

/** landfall's defaults for every server (lf config); a server's own setting wins. */
function defaultsDialog() {
  const d = S.state.defaults;
  dialog({
    title: "landfall defaults",
    text: `For every server, unless it sets its own. Saved in ${d.configFile}.`,
    fields: [
      { name: "default", label: "Default server", type: "select", value: d.default ?? "", options: [{ value: "", label: "none" }, ...S.state.servers.map((s) => ({ value: s.name, label: s.name }))], hint: "Commands in a terminal use it without --server." },
      { name: "tunnelOnly", label: "New sites get no domain: tunnel only", type: "check", value: d.tunnelOnly, hint: "Nothing is served on the internet until a site gets a domain. A server's Settings can override it." },
      { name: "email", label: "Let's Encrypt e-mail (optional)", value: d.email ?? "", hint: "For servers that set none, when landfall installs Traefik." },
      { name: "keep", label: "Releases to keep for rollback", type: "number", value: String(d.keep), placeholder: "5", check: (k) => k && (!/^\d+$/.test(k) || !Number(k)) && "A whole number from 1 up" },
    ],
    after: whereList(d.locations),
    ok: "Save",
    onOk: (v) => {
      const argv = ["config"];
      if (v.default !== (d.default ?? "")) argv.push(...(v.default ? ["--default", v.default] : ["--unset", "default"]));
      if (v.tunnelOnly !== d.tunnelOnly) argv.push(v.tunnelOnly ? "--tunnel-only" : "--no-tunnel-only");
      const email = v.email.trim();
      if (email !== (d.email ?? "")) argv.push(...(email ? ["--email", email] : ["--unset", "email"]));
      const keep = v.keep.trim();
      if (keep !== String(d.keep)) argv.push(...(keep ? ["--keep", keep] : ["--unset", "keep"]));
      if (argv.length === 1) return;
      run(argv, { after: ifOk(() => (S.sel && load(S.sel, "settings", true), refreshState())) });
    },
  });
}
/** Every place landfall writes to, from `lf config`: nothing it installs is hidden. */
const whereList = (loc) => {
  const kv = (list) => `<dl>${list.map((l) => `<dt class="mono">${esc(l.path)}</dt><dd class="dim">${esc(l.what)}</dd>`).join("")}</dl>`;
  return `<details class="where"><summary>Where landfall puts things</summary>
    <h3>On this machine</h3>${kv(loc.local)}<h3>On each server</h3>${kv(loc.server)}</details>`;
};
/** What `lf deploy` picks without a domain: <site>.<main domain>, else the free sslip.io address. */
function autoDomain(n, name) {
  const main = mainDomain(n);
  if (main) return `${name}.${main}`;
  const suffix = S.facts[n]?.data?.sslipSuffix;
  return suffix ? `${name}.${suffix}` : "";
}
const slugify = (s) => s.toLowerCase().replace(/\.(zip|tgz|tar(\.gz)?)$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "site";

function describe(d, before = true) {
  const built = d.build ? ` · builds with <code>${esc(d.build)}</code> first` : "";
  const what =
    d.kind === "compose" ? `Compose project <code>${esc(d.compose ?? "compose.yaml")}</code>: built and started on the server; x-landfall picks the routed service`
    : d.kind === "image" ? `Docker image <code>${esc(d.project?.image ?? "")}</code> (from .landfall.json)`
    : d.kind === "dockerfile" && d.start ? `${esc(d.runtime)} app${d.tool ? ` (${esc(d.tool)})` : ""}: built on the server${d.build ? ` with <code>${esc(d.build)}</code>` : ""}, started with <code>${esc(d.start)}</code> on port ${esc(d.port)}${d.note ? `<br><span style="color:var(--warn)">${esc(d.note)}</span>` : ""}`
    : d.kind === "dockerfile" ? `Dockerfile: built on the server, served on port ${esc(d.port)}`
    : d.dir ? `Static files from <code>${esc(d.dir === "." ? "./" : d.dir + "/")}</code>${d.tool ? ` (where ${esc(d.tool)} builds the site)` : ""}${d.spa ? " (single-page app)" : ""}${built}`
    : d.build ? `Static site, built with <code>${esc(d.build)}</code> first`
    : `<span style="color:var(--warn)">No compose.yaml, Dockerfile, index.html or build script here.</span>`;
  return what + (before && d.project?.server ? ` <span class="dim">· deployed before to ${esc(d.project.server)}</span>` : "");
}

/**
 * Deploy a local folder (det from /api/fs or an upload). upload: a temporary folder, so no .landfall.json.
 * site: an existing site ({ server, name, domains, old }) this folder redeploys.
 */
function deployDialog(det, o = {}) {
  const p = det.project;
  const re = o.site;
  const servers = S.state.servers.map((s) => ({ value: s.name, label: s.name }));
  const target = re?.server ?? p?.server ?? defaultServer();
  const name = re?.name ?? o.name ?? det.name;
  // A redeploy keeps the site's domains unless .landfall.json or the field names others.
  const keeps = re && !p?.domains ? re.domains : null;
  const keeping = (v) => keeps && v.name.trim() === re.name && v.server === re.server;
  // Static files or an app without a Dockerfile: what to build and run is landfall's to decide, and editable here.
  const runtime = det.runtime ?? "Node.js";
  const modal = det.kind === "static" || !!det.start;
  const runs = det.kind === "dockerfile" || det.kind === "image";
  const isApp = (v) => (modal ? (v.mode ?? (det.start ? "node" : "static")) === "node" : runs);
  const served = (v) => !(isApp(v) && v.worker);
  const volumes = det.volumes ?? [];
  /** What the domains field deploys to, as the CLI expands it: [domains] or an error. */
  const addresses = (v) => {
    const main = mainDomain(v.server);
    const given = words(v.domains);
    if (!given.length) return [keeping(v) ? keeps : [autoDomain(v.server, v.name.trim())].filter(Boolean)];
    const out = given.map((d) => (d === "@" ? main : !d.includes(".") && main ? `${d}.${main}` : d)?.toLowerCase());
    if (out.includes(undefined)) return [[], `@ means the main domain, and ${v.server} has none`];
    const bad = out.find((d) => !domainOk(d));
    return [out, bad && `Not a domain: ${bad}`];
  };
  const app = [
    { name: "worker", label: "Background worker: no port, no domain", type: "check", value: !!det.worker, hint: "A bot, a queue consumer, a scheduler: it runs, nothing routes to it." },
    { name: "port", label: "Port it listens on", type: "number", value: String(det.port ?? 3000), hint: modal ? "The app gets it as PORT." : "", when: (v) => !v.worker, required: "Which port does it listen on?", check: portError },
    {
      name: "volumes", label: "Folders to keep", value: volumes.join(" "), placeholder: "/app/data", mono: true,
      hint: "In the container, space separated: their files outlive deploys and rollbacks (a Docker volume each). Empty: none.",
      check: (x) => words(x).filter((d) => !/^\/[\w./-]*\w$/.test(d)).map((d) => `${d} is not a folder like /app/data`)[0],
    },
  ];
  dialog({
    title: re ? `Redeploy ${name}` : `Deploy ${name}`,
    text: (o.upload ? `Uploaded ${plural(o.files ?? 0, "file")}. Not remembered: drop it again to redeploy.` : `From ${tilde(det.path)}${p ? " (settings from .landfall.json)" : ""}`)
      + (re ? `\nGoes live as a new release of ${name} on ${re.server}: volumes keep their data${re.old ? "." : ", and Roll back… returns to the current one."}` : ""),
    extra: `<div class="detected">${describe(det)}</div>`,
    fields: [
      {
        row: [
          {
            name: "name", label: "Site name", value: name, required: "Give the site a name",
            check: siteNameError,
            hint: re ? "Another name deploys a new site." : "",
          },
          { name: "server", label: "Server", type: "select", options: servers, value: target, required: "Pick a server" },
        ],
      },
      ...(modal && (det.node || det.start)
        ? [{ name: "mode", label: "Deploy as", type: "select", value: det.start ? "node" : "static", options: [{ value: "node", label: `${runtime} app (runs on the server)` }, { value: "static", label: "Static files" }] }]
        : []),
      {
        legend: "Address", when: served,
        fields: [
          {
            name: "domains", label: "Domains", value: (p?.domains ?? []).join(" "), off: (v) => v.noDomain,
            placeholder: keeps ? keeps.join(" ") || "none" : "empty: the address below",
            hint: mainDomain(target) ? "A bare name like blog is under the main domain, @ is the main domain itself. Others need an A record pointing at the server." : "Own domains need an A record pointing at the server.",
            check: (_, v) => addresses(v)[1],
            preview: (v) => {
              const [out, bad] = addresses(v);
              return bad ? "" : out.length ? `→ ${out.map((d) => `https://${d}`).join("  ")}` : "→ no domain: tunnel only";
            },
          },
          { name: "noDomain", label: "No domain: reach it through a tunnel only", type: "check", value: p?.domains ? !p.domains.length : re ? false : !!tunnelOnly(target), hint: "Nothing is served on the internet. Give it a domain later with Domains… on the site." },
        ],
      },
      ...(modal
        ? [
            { name: "build", label: "Build command", value: det.build ?? "", placeholder: "none", mono: true, hint: `Static files: runs here, before the upload. The ${runtime} app: runs on the server, in its image.` },
            {
              legend: "Static files", id: "static", when: (v) => !isApp(v),
              fields: [
                {
                  name: "dir", label: "Folder to publish", value: det.dir ?? ".", placeholder: ".", mono: true,
                  hint: det.tool && !det.start ? `Detected: ${det.tool} writes the site to ${det.dir}/ (it need not exist before the build).` : "Relative to the project; it needs an index.html after the build.",
                  check: (x) => (/^[/-]/.test(x) || x.split("/").includes("..")) && "A folder inside the project",
                },
                { name: "spa", label: "Single-page app (unknown paths serve index.html)", type: "check", value: !!p?.spa },
              ],
            },
            {
              legend: `${runtime} app`, id: "node", when: isApp,
              fields: [
                {
                  name: "start", label: "Start command", value: det.start ?? "", placeholder: "node server.js", mono: true, required: "How does the app start? For example: node server.js",
                  hint: `${det.start && det.tool ? `Detected: ${det.tool}. ` : ""}landfall writes the Dockerfile (install, build, start); lf init puts it into the project to change it.`,
                },
                ...app,
              ],
            },
          ]
        : runs
        ? [{ legend: det.kind === "image" ? "Container" : "Dockerfile app", fields: app }]
        : []),
      {
        legend: "Visitor login", collapsed: true, note: "optional: HTTP basic auth, set or remove it later with Password… on the site", when: served,
        fields: [
          {
            row: [
              { name: "authUser", label: "User", value: "admin", placeholder: "admin", check: (x, v) => v.authPassword && userError(x || "admin") },
              { name: "authPassword", label: `Password (${S.state.rules.minPassword}+ characters)`, type: "password", check: (x) => x && passwordError(x) },
            ],
          },
        ],
      },
    ],
    ok: re ? "Redeploy" : "Deploy",
    onOk: (v) => {
      const n = v.name.trim();
      const asNode = isApp(v);
      const worker = asNode && v.worker;
      const argv = ["deploy", "-y", ...sv(v.server), "-n", n];
      if (!worker) {
        const domains = words(v.domains);
        // The server's default would leave it unrouted though the box is unticked.
        if (!v.noDomain && !domains.length && !p?.domains?.length && !keeping(v) && tunnelOnly(v.server)) return invalid("domains", `${v.server} gives new sites no domain: name one, or tick No domain`);
        argv.push(...(v.noDomain ? ["--no-domain"] : domains.flatMap((d) => ["-d", d])));
      }
      const build = v.build?.trim() ?? "";
      if (modal && asNode) {
        const start = v.start.trim();
        if (start !== det.start) argv.push("--start", start);
        if (build !== (det.build ?? "")) argv.push("--build", build);
      } else if (modal) {
        if (det.start) argv.push("--static");
        if (build && build !== p?.build) argv.push("--build", build);
        if (v.spa && !p?.spa) argv.push("--spa");
        const dir = v.dir.trim().replace(/\/+$/, "") || ".";
        if (dir !== (det.dir ?? ".")) argv.push(dir);
      }
      if (asNode) {
        if (worker !== !!det.worker) argv.push(worker ? "--worker" : "--no-worker");
        const port = Number(v.port.trim());
        if (!worker && port !== (det.port ?? 3000)) argv.push("--port", String(port));
        const vols = words(v.volumes);
        if (vols.join(" ") !== volumes.join(" ")) argv.push(...(vols.length ? vols.flatMap((x) => ["--volume", x]) : ["--volume", ""]));
      }
      // The login counts once there is a password; the user defaults to admin.
      if (!worker && v.authPassword) argv.push("--auth-user", v.authUser.trim() || "admin", "--auth-password", v.authPassword);
      if (o.upload) argv.push("--no-save");
      run(argv, { server: v.server, cwd: det.path, after: openAfter });
    },
  });
}

/** After a deploy: offer the address it printed. */
function openAfter(j) {
  if (j.info.code !== 0) return;
  const url = rep(j).url;
  if (url) return [{ label: `Open ${url.replace("https://", "")}`, run: () => window.open(url, "_blank", "noopener") }];
}

async function browse(path) {
  return http(`/api/fs${path ? `?path=${encodeURIComponent(path)}` : ""}`);
}

/** What a site's folder holds and how it builds: detected once per folder, for the site details. */
const detected = (path) => {
  if (!(path in S.det)) (S.det[path] = null), browse(path).then((x) => ((S.det[path] = x.detected), render()), () => (S.det[path] = false));
  return S.det[path];
};
/** Edit how a site builds and starts (build, start, port, static or Node.js), then redeploy. */
const buildSettings = (path, site) => {
  delete S.det[path];
  browse(path).then((x) => deployDialog(x.detected, { site }), (e) => toast(e.message));
};

function deployHere() {
  browse(S.state.cwd).then((b) => deployDialog(b.detected), (e) => toast(e.message));
}

/**
 * Pick a folder on this machine: recent projects, a folder browser, or drop/choose files to upload.
 * site: an existing site the folder redeploys (one this machine does not remember a folder for).
 */
async function folderDialog(path, site) {
  let b;
  try {
    b = await browse(path);
  } catch (e) {
    return toast(e.message);
  }
  const dlg = openDlg("wide");
  // Files dropped while it is open redeploy the site too.
  dlg.site = site;
  const recent = site ? [] : (S.state.projects ?? []).slice(0, 8);
  const parts = b.path.split("/").filter(Boolean);
  const crumbs = `<button type="button" class="ghost sm" data-path="/">/</button>` + parts.map((x, i) =>
    `<button type="button" class="ghost sm" data-path="${esc("/" + parts.slice(0, i + 1).join("/"))}">${esc(x)}</button>`).join(`<span class="faint">/</span>`);
  dlg.innerHTML = `<form method="dialog">
    <h2>${site ? `Redeploy ${esc(site.name)}` : "Deploy a folder"}</h2>
    ${site ? `<div class="text">This machine does not know which folder ${esc(site.name)} on ${esc(site.server)} was deployed from. Pick it: this machine remembers it, so the next redeploy is one click. Dropped files are not remembered.</div>` : ""}
    ${recent.length ? `<fieldset><legend>Recent</legend><div class="list">${recent
      .map((r, i) => `<button type="button" class="row" data-recent="${i}" title="Deploy again"><b>${esc(r.name)}</b><span class="dim">→ ${esc(r.server)}${r.domains[0] ? ` · ${esc(r.domains[0])}` : ""}</span><span class="faint mono">${esc(tilde(r.path))}</span></button>`)
      .join("")}</div></fieldset>` : ""}
    <div class="crumbs mono">${crumbs} <button type="button" class="ghost sm" data-path="${esc(b.home)}" title="Home">~</button></div>
    <div class="list">${b.parent ? `<button type="button" class="row" data-path="${esc(b.parent)}">↑ ..</button>` : ""}${b.dirs
      .map((d) => `<button type="button" class="row" data-path="${esc(b.path.replace(/\/$/, "") + "/" + d)}">📁 ${esc(d)}</button>`)
      .join("") || `<div class="row faint">no subfolders</div>`}</div>
    <div class="detected"><b>${esc(b.detected.name)}</b>: ${describe(b.detected)}</div>
    <div class="drop">Or drop a folder or .zip anywhere ·
      <label>choose a folder<input type="file" id="pick-dir" webkitdirectory multiple hidden></label> ·
      <label>choose a .zip<input type="file" id="pick-zip" accept=".zip,.tar,.tgz,.gz" hidden></label></div>
    <div class="btns">
      <button type="button" class="ghost" id="dlg-cancel">Cancel</button>
      <button type="submit" class="primary">${site ? "Redeploy from this folder…" : "Deploy this folder…"}</button>
    </div>
  </form>`;
  $("#dlg-cancel", dlg).onclick = () => dlg.close();
  $("form", dlg).onsubmit = (e) => (e.preventDefault(), deployDialog(b.detected, { site }));
  $("form", dlg).onclick = (e) => {
    const el = e.target.closest("[data-path],[data-recent]");
    if (!el) return;
    if (el.dataset.path) return void folderDialog(el.dataset.path, site);
    browse(recent[el.dataset.recent].path).then((x) => deployDialog(x.detected), (err) => toast(err.message));
  };
  $("#pick-dir", dlg).onchange = (e) => {
    const files = [...e.target.files];
    upload(files.filter((f) => !skipped(f.webkitRelativePath)).map((f) => [f, f.webkitRelativePath || f.name]), files[0]?.webkitRelativePath.split("/")[0], site);
  };
  $("#pick-zip", dlg).onchange = (e) => {
    const f = e.target.files[0];
    if (f) upload([[f, f.name]], f.name, site);
  };
  if (!dlg.open) dlg.showModal();
}

// Dropped folders: walk the entries (skipping dependencies and VCS data), then upload with relative paths.
const SKIP = new Set(["node_modules", ".git", ".DS_Store", "__MACOSX"]);
const skipped = (rel) => rel.split("/").some((x) => SKIP.has(x));
async function droppedFiles(roots) {
  const out = [];
  const walk = async (entry, prefix) => {
    if (SKIP.has(entry.name)) return;
    if (entry.isFile) out.push([await new Promise((res, rej) => entry.file(res, rej)), prefix + entry.name]);
    else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (let batch; (batch = await new Promise((res, rej) => reader.readEntries(res, rej))).length; ) {
        for (const e of batch) await walk(e, `${prefix}${entry.name}/`);
      }
    }
  };
  for (const r of roots) await walk(r, "");
  return out;
}

async function upload(pairs, label = "site", site) {
  if (!pairs.length) return toast("Nothing to upload");
  const fd = new FormData();
  for (const [f, path] of pairs) fd.append("file", f), fd.append("path", path);
  toast(`Uploading ${plural(pairs.length, "file")}…`);
  try {
    const r = await fetch("/api/upload", { method: "POST", body: fd });
    const data = await r.json().catch(() => ({ error: `${r.status} ${r.statusText}` }));
    if (!r.ok) throw new Error(data.error);
    toast(`Uploaded ${plural(data.files, "file")}`);
    deployDialog(data.detected, { upload: true, files: data.files, name: slugify(label), site });
  } catch (e) {
    toast(`Upload failed: ${e.message}`);
  }
}

const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes("Files");
window.addEventListener("dragover", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  document.body.classList.add("dragging");
});
window.addEventListener("dragleave", (e) => {
  if (!e.relatedTarget) document.body.classList.remove("dragging");
});
window.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  document.body.classList.remove("dragging");
  // Entries must be taken while the event is live.
  const roots = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  const label = roots[0]?.name ?? e.dataTransfer.files[0]?.name;
  const files = roots.length ? droppedFiles(roots) : Promise.resolve([...e.dataTransfer.files].map((f) => [f, f.name]));
  const dlg = $("#dlg");
  const site = dlg.open ? dlg.site : undefined;
  files.then((pairs) => upload(pairs, label, site), (err) => toast(err.message));
});
