"use strict";
// ---- system ----------------------------------------------------------------

const SVC_FAILED = (s) => s.active === "failed" || s.active === "crashed";
const SVC_UP = (s) => s.active === "active" || s.active === "started";
// What keeps the server and its sites running: shown first, the rest behind "all".
const KEY_SVCS = ["docker", "containerd", "ssh", "sshd", "fail2ban", "ufw", "unattended-upgrades", "cron", "crond", "systemd-timesyncd", "chronyd", "chrony"];
const svcName = (u) => u.replace(/\.service$/, "");

function systemView(n) {
  const st = S.system[n];
  const wait = pending(st, `reading ${esc(n)}…`);
  if (wait) return wait;
  const i = st.data;
  const s = sv(n);
  const go_ = (argv) => run([...argv, ...s], { server: n });

  const swapTotal = i.swap.reduce((t, x) => t + x.size, 0);
  const d = i.docker;
  // Change buttons only where the CLI would do it: as admin, and not on a system that keeps it itself.
  const adm = i.root, set = adm && !i.managed;
  const may = (ok, html) => (ok ? html : "");
  const basics = `<div class="card"><h2>Basics</h2><div class="body">${kv([
    ["Host name", `<span class="mono">${esc(i.hostname)}</span> ${may(set, btn("Change", () => renameHost(n, i.hostname), "ghost sm"))}`],
    ["Time zone", `${esc(i.timezone)} <span class="faint">· ${esc(i.time)}</span> ${may(set, btn("Change", () => changeTz(n, i.timezone), "ghost sm"))}`],
    ["Clock", i.ntp === true ? `<span class="badge ok">synced</span>` : i.ntp === false ? `<span class="badge warn">not synced</span>` : `<span class="faint">unknown</span>`],
    ["Swap", `${swapTotal ? `${size(swapTotal)} <span class="faint">${esc(i.swap.map((x) => `${x.file} · ${size(x.used)} used`).join(", "))}</span>` : `<span class="badge${i.mem < 4 * 1024 ** 3 ? " warn" : ""}">none</span> <span class="faint">${size(i.mem)} memory</span>`}
      ${!set ? "" : i.swap.some((x) => x.file === "/swapfile")
        ? btn("Remove", () => confirmDlg({ title: `Remove the swap file on ${n}?`, text: "What is swapped out moves back to memory first.", ok: "Remove it", danger: true, onOk: () => go_(["swap", "off", "-y"]) }), "ghost sm danger")
        : swapTotal ? "" : btn("Add…", () => addSwapDlg(n, i), "ghost sm")}`],
    ["Docker logs", !d ? `<span class="faint">no docker</span>`
      : `${d.maxSize ? `${esc(d.maxSize)} × ${d.maxFile ?? 1} per container` : d.driver === "json-file" ? `<span class="badge warn">unlimited</span>` : ""} <span class="faint">${esc(d.driver)}</span> ${d.daemonError || !set ? "" : btn(d.maxSize ? "Change" : "Limit…", () => logLimitDlg(n, d), "ghost sm")}`],
  ])}${d?.daemonError ? `<div class="note bad" style="margin:12px 0 0">${esc(d.daemonError)}</div>` : ""}
  ${i.managed ? `<p class="faint" style="margin:12px 0 0">${esc(i.managed)}.</p>` : ""}
  ${i.root ? "" : `<p class="faint" style="margin:12px 0 0">${esc(i.user)} has no passwordless sudo and root's key does not work: other users' keys, bans and Docker's settings may be missing.</p>`}</div></div>`;

  let services = "";
  if (i.init !== "other") {
    const all = S.allSvcs?.[n];
    const shown = i.services
      .filter((x) => all || SVC_FAILED(x) || KEY_SVCS.includes(svcName(x.unit)) || (i.init === "openrc" && SVC_UP(x)))
      .sort((a, b) => (SVC_FAILED(b) - SVC_FAILED(a)) || (KEY_SVCS.includes(svcName(b.unit)) - KEY_SVCS.includes(svcName(a.unit))) || a.unit.localeCompare(b.unit));
    const nFailed = i.services.filter(SVC_FAILED).length;
    const row = (x) => {
      const u = svcName(x.unit);
      const ssh = /^sshd?$/.test(u), core = /^(docker|containerd)$/.test(u);
      const stop = () => confirmDlg({
        title: `Stop ${u} on ${n}?`,
        text: ssh ? "New ssh logins fail until it is started again (from the provider's console)." : core ? "Every site goes down until it is started again." : "It stays stopped until started again, or until the next boot if it is enabled.",
        ok: "Stop it", danger: true, onOk: () => go_(["services", "stop", u, "-y", ...(ssh ? ["--force"] : [])]),
      });
      const restart = () => core
        ? confirmDlg({ title: `Restart ${u} on ${n}?`, text: "Every site goes down for a moment.", ok: "Restart", danger: true, onOk: () => go_(["services", "restart", u, "-y"]) })
        : go_(["services", "restart", u]);
      const cls = SVC_FAILED(x) ? "bad" : SVC_UP(x) ? "ok" : "";
      return `<tr><td class="mono">${esc(u)}</td><td><span class="badge ${cls}">${esc(x.sub || x.active)}</span></td>
        ${i.init === "systemd" ? `<td class="faint hide-sm">${esc(x.enabled ?? "")}</td>` : ""}<td class="dim hide-sm">${esc(x.description)}</td>
        <td class="acts">${btn("Logs", () => run(["services", "logs", u, "-n", "200", ...s], { server: n }), "sm")}${may(adm, menuBtn([
          { label: "Restart", run: restart },
          SVC_UP(x) ? { label: "Stop…", cls: "danger", run: stop } : { label: "Start", run: () => go_(["services", "start", u]) },
        ], `Actions for ${u}`))}</td></tr>`;
    };
    services = `<div class="card"><h2>Services ${nFailed ? `<span class="badge bad">${nFailed} failed</span>` : ""} <span class="sub">${i.init}</span>
      <span class="actions">${btn(all ? "Fewer" : `All ${i.services.length}`, () => ((S.allSvcs = { ...S.allSvcs, [n]: !all }), render()), "sm")}</span></h2>
      <div class="scroll"><table><thead><tr><th>Service</th><th>State</th>${i.init === "systemd" ? `<th class="hide-sm">Boot</th>` : ""}<th class="hide-sm">Description</th><th><span class="sr">Actions</span></th></tr></thead>
      <tbody>${shown.map(row).join("") || `<tr><td colspan="5" class="dim">none</td></tr>`}</tbody></table></div></div>`;
  }

  const keyRows = i.keys.map((k) => {
    const label = k.comment || k.fingerprint.slice(7, 19);
    const rm = () => confirmDlg({
      title: `Remove ${label} from ${k.user}?`,
      text: k.mine ? "This is the key this machine logs in with: removing it can lock you out." : `${k.type} ${k.fingerprint}`,
      ok: "Remove it", danger: true,
      onOk: () => go_(["keys", "rm", k.fingerprint, "--user", k.user, "-y", ...(k.mine ? ["--force"] : [])]),
    });
    return `<tr><td>${esc(k.user)}</td><td>${k.mine ? `<span class="badge ok" title="This machine logs in with it">this machine</span> ` : ""}${esc(k.comment || "")}${k.options ? `<div class="faint mono">${esc(k.options)}</div>` : ""}</td>
      <td class="mono faint hide-sm">${esc(k.type.replace(/^ssh-/, ""))} ${esc(k.fingerprint.slice(7, 23))}…</td><td class="acts">${may(adm || k.user === i.user, btn("Remove", rm, "sm danger"))}</td></tr>`;
  }).join("");
  const keys = `<div class="card"><h2>SSH keys <span class="badge">${i.keys.length}</span> <span class="sub">who may log in</span><span class="actions">${btn("Add key…", () => addKeyDlg(n), "sm")}</span></h2>
    <div class="scroll"><table><thead><tr><th>User</th><th>Comment</th><th class="hide-sm">Key</th><th><span class="sr">Actions</span></th></tr></thead>
    <tbody>${keyRows || `<tr><td colspan="4" class="dim">no keys found</td></tr>`}</tbody></table></div></div>`;

  const banned = i.jails.flatMap((j) => j.ips.map((ip) => ({ ip, jail: j.name })));
  const bans = i.fail2ban === "running"
    ? `<div class="card"><h2>Bans <span class="badge${banned.length ? " warn" : ""}">${banned.length}</span> <span class="sub">fail2ban · ${esc(i.jails.map((j) => `${j.name}: ${j.total} in total`).join(", "))}</span></h2>
      <div class="scroll"><table><thead><tr><th>IP</th><th>Jail</th><th><span class="sr">Actions</span></th></tr></thead>
      <tbody>${banned.map((b) => `<tr><td class="mono">${esc(b.ip)}</td><td>${esc(b.jail)}</td><td class="acts">${may(adm, btn("Unban", () => go_(["unban", b.ip]), "sm"))}</td></tr>`).join("") || `<tr><td colspan="3" class="dim">nobody banned right now</td></tr>`}</tbody></table></div></div>`
    : `<div class="card"><h2>Bans</h2><div class="body dim">${i.fail2ban === "missing" ? "fail2ban is not installed." : "fail2ban is not running."}</div></div>`;

  return securityCard(n, i) + basics + services + keys + bans;
}

/** What `lf security` says, with its fixes as buttons. */
function rebootDlg(n) {
  confirmDlg({ title: `Reboot ${n}?`, text: "Its sites are offline for a minute or two. Waits until it is back and checks its containers run again.", ok: "Reboot", danger: true, onOk: () => run(["reboot", ...sv(n), "-y"], { server: n }) });
}

function securityCard(n, i) {
  const adv = i.advice ?? [];
  const cls = { risk: "bad", warn: "warn", info: "" };
  const fix = (a) => {
    const f = a.fix;
    if (!f) return "";
    // A key pair for someone else: say where it goes before making it.
    if (f.user) return btn(`${f.label}…`, () => addKeyDlg(n, f.user, true), "sm");
    if (f.argv[0] === "reboot") return btn(`${f.label}…`, () => rebootDlg(n), "sm");
    return btn(f.confirm ? `${f.label}…` : f.label, () => f.confirm
      ? confirmDlg({ title: `${a.title}: ${f.label.toLowerCase()} on ${n}?`, text: f.confirm, ok: f.label, onOk: () => run([...f.argv, "-y"], { server: n }) })
      : run(f.argv, { server: n }), "sm");
  };
  const risks = adv.filter((a) => a.level === "risk").length;
  return `<div class="card"><h2>Security ${adv.length ? `<span class="badge ${risks ? "bad" : "warn"}">${plural(adv.length, "thing")} to look at</span>` : `<span class="badge ok">nothing to fix</span>`} <span class="sub">lf security</span></h2>
    ${adv.length ? `<div class="scroll"><table><tbody>${adv.map((a) => `<tr><td><span class="badge ${cls[a.level]}">${a.level}</span></td>
      <td><b>${esc(a.title)}</b><div class="dim">${esc(a.why)}</div></td><td class="acts">${fix(a)}</td></tr>`).join("")}</tbody></table></div>`
    : `<div class="body dim">SSH takes keys only${i.security.firewall === "active" ? ", the firewall is on" : ""}${i.fail2ban === "running" ? ", fail2ban runs" : ""}${i.security.autoUpdates ? " and security updates install themselves" : ""}.</div>`}</div>`;
}

function renameHost(n, old) {
  dialog({
    title: `Rename ${n}`,
    text: "The server's own host name: what its shell prompt and logs show. Your ssh alias stays as it is.",
    fields: [{ name: "name", label: "Host name", value: old, placeholder: "web-1", mono: true, required: true, check: (x) => !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i.test(x) && "Letters, digits and -, up to 63, no dots" }],
    ok: "Rename",
    onOk: (v) => {
      const name = v.name.trim();
      if (name !== old) run(["hostname", name, ...sv(n)], { server: n });
    },
  });
}
function changeTz(n, old) {
  dialog({
    title: `Time zone of ${n}`,
    text: "Cron jobs, logs and the clock in containers that read it follow it.",
    fields: [{
      name: "tz", label: "Time zone", value: old, placeholder: "Europe/Berlin, UTC", hint: `Yours is ${Intl.DateTimeFormat().resolvedOptions().timeZone}.`, required: true,
      check: (x) => !/^[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+)*$/.test(x) && "A name like Europe/Berlin or UTC",
    }],
    ok: "Change",
    onOk: (v) => {
      const tz = v.tz.trim();
      if (tz !== old) run(["timezone", tz, ...sv(n)], { server: n });
    },
  });
}
function addSwapDlg(n, i) {
  const gb = 1024 ** 3;
  // Rule of thumb: as much as memory up to 2 GB, never more than a tenth of the free disk.
  const pick = Math.max(0.5, Math.min(i.mem > 2 * gb ? 2 : 1, Math.floor((i.diskFree / gb / 10) * 2) / 2));
  dialog({
    title: `Add swap to ${n}`,
    text: `A swap file at /swapfile, on at boot. It keeps the server alive when memory runs out (slowly instead of killing processes). ${size(i.diskFree)} free on the disk.`,
    fields: [{ name: "size", label: "Size", value: `${pick >= 1 ? pick + "G" : "512M"}`, placeholder: "1G, 512M", required: true, check: (x) => !/^\d+(\.\d+)?\s*[mg]$/i.test(x) && "A size like 1G or 512M" }],
    ok: "Add swap",
    onOk: (v) => {
      run(["swap", v.size.trim(), ...sv(n)], { server: n });
    },
  });
}
function logLimitDlg(n, d) {
  dialog({
    title: `Docker log limit on ${n}`,
    text: "Caps the log Docker keeps per container. It applies to containers created afterwards: redeploy or restart sites to apply it to them.",
    fields: [
      {
        row: [
          { name: "size", label: "Per file", value: d.maxSize ?? "10m", placeholder: "10m", hint: "k, m or g. Empty: no limit.", check: (x) => x && !/^\d+[kmg]$/i.test(x) && "A size like 10m" },
          { name: "files", label: "Files kept", type: "number", value: String(d.maxFile ?? 3), placeholder: "3", required: true, check: (x) => !/^\d+$/.test(x) && "A number" },
        ],
      },
      { name: "restart", type: "check", label: "Restart Docker now", hint: "Sites go down for a moment. Otherwise it applies on Docker's next start." },
    ],
    ok: "Save",
    onOk: (v) => {
      const sz = v.size.trim().toLowerCase();
      run(["log-limit", sz || "off", "--files", v.files.trim(), ...(v.restart ? ["--restart", "-y"] : []), ...sv(n)], { server: n });
    },
  });
}
function addKeyDlg(n, user = "", generate = false) {
  dialog({
    title: `Add an SSH key to ${n}`,
    text: "Paste a public key (the .pub file, one line), or make a new pair on this computer. Whoever holds the private key can log in.",
    fields: [
      { name: "generate", label: "Make a new key pair", type: "check", value: generate, hint: `Saved as ~/.ssh/${n}_<user>, without a passphrase (add one with ssh-keygen -p). Hand it to whoever logs in as that user.` },
      {
        name: "key", label: "Public key", type: "textarea", value: "", placeholder: "ssh-ed25519 AAAA… name@laptop", when: (v) => !v.generate, required: "Paste the public key",
        check: (k) => !/^(\S+\s+)?(ssh-|ecdsa-|sk-)\S+ AAAA/.test(k.split("\n")[0]) && "That does not look like a public key (the .pub file)",
      },
      { name: "user", label: "User", value: user, placeholder: "the login user", hint: "Whose account it logs in to. Empty: the user landfall logs in as." },
    ],
    ok: "Add key",
    onOk: (v) => {
      const u = v.user.trim() ? ["--user", v.user.trim()] : [];
      if (v.generate) return void run(["keys", "add", "--generate", ...u, ...sv(n)], { server: n });
      const key = v.key.trim().split("\n")[0];
      run(["keys", "add", key, ...u, ...sv(n)], { server: n });
    },
  });
}
