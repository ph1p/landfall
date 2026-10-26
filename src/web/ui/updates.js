"use strict";
// ---- updates ---------------------------------------------------------------

const IMG = { current: ["ok", "up to date"], update: ["warn", "newer image"], unknown: ["", "unknown"], pinned: ["", "pinned"], rebuild: ["", "rebuild"], foreign: ["", "not landfall's"], missing: ["bad", "missing"] };

function updatesBadge(n) {
  const d = S.updates[n]?.data;
  if (!d) return "";
  const k = d.packages.updates.length + d.images.filter((i) => i.state === "update").length;
  const sec = d.packages.updates.some((u) => u.security);
  return k ? ` <span class="badge ${sec ? "warn" : ""}">${k}</span>` : "";
}

function refreshUpdates(n) {
  // Drops what is shown, for the refreshing spinner.
  S.updates[n] = { refreshing: true };
  fetchInto("updates", n, "/updates?refresh=1");
  render();
}

/** "24.0.2 → 29.9.2 · how to get it", or "· newest" when it is (and the newest is known). */
const engineLine = (have, latest, old, how) =>
  `<span class="mono">${esc(have)}</span>${old ? ` <span class="dim">→</span> <span class="mono">${esc(latest)}</span>${how ? ` <span class="faint">· ${esc(how)}</span>` : ""}` : latest ? ` <span class="faint">· newest</span>` : ""}`;

function updatesView(n) {
  const st = S.updates[n];
  const wait = pending(st, st?.refreshing ? "refreshing package lists…" : "checking packages and images…");
  if (wait) return st?.error ? `${wait}<div class="actions" style="margin:0">${btn("Retry", () => (load(n, "updates", true), render()))}</div>` : wait;
  const { packages: p, images, engine: e } = st.data;
  const s = sv(n);
  const sec = p.updates.filter((u) => u.security);
  const upgrade = (flags, what, k) =>
    confirmDlg({
      title: `Upgrade ${what} on ${n}?`,
      text: `${plural(k, "package")} through ${p.mgr}, as root. Package upgrades cannot be undone.${flags.includes("--reboot") ? "\nReboots afterwards if the upgrade needs it: sites are offline for a minute or two." : ""}`,
      ok: "Upgrade",
      danger: flags.includes("--reboot"),
      onOk: () => run(["update", "--packages", ...flags, ...s, "-y"], { server: n }),
    });
  // Package upgrades need a package manager and root (the CLI's can.packages).
  const pkgOk = p.mgr !== "none" && (can(n)?.packages ?? true);
  const pkgActs = !pkgOk ? "" : [
    btn("Refresh lists", () => refreshUpdates(n), "sm", "Fetch the newest package lists first (apt update)"),
    sec.length && p.mgr !== "apk" ? btn(`Security only (${sec.length})`, () => upgrade(["--security"], "security updates", sec.length), "sm") : "",
    p.updates.length ? btn("Upgrade all", () => upgrade([], "all packages", p.updates.length), "sm primary") : "",
    p.updates.length ? btn("Upgrade + reboot", () => upgrade(["--reboot"], "all packages", p.updates.length), "sm danger") : "",
  ].join("");
  const shown = p.updates.slice(0, 200);
  const pkgRows = shown
    .map((u) => `<tr><td class="mono">${esc(u.name)}</td><td class="mono dim hide-sm">${esc(u.from ?? "")}</td><td class="mono">${esc(u.to)}</td><td>${u.security ? `<span class="badge warn">security</span>` : ""}</td></tr>`)
    .join("");
  const imgUpdates = images.filter((i) => i.state === "update");
  const updImg = (names) =>
    confirmDlg({
      title: `Update ${names.join(", ")}?`,
      text: "Pulls the newer image and recreates the container (a few seconds offline). Undo puts the old image back.",
      ok: "Update",
      onOk: () => run(["update", ...names, "--images", ...s, "-y"], { server: n }),
    });
  const imgRows = images
    .map((i) => {
      const [cls, label] = IMG[i.state] ?? ["", i.state];
      const can = i.state === "update" || i.state === "unknown";
      return `<tr><td><b>${esc(i.name)}</b> <span class="faint">${esc(i.kind)}</span></td><td class="mono dim hide-sm">${esc(i.ref || "-")}</td>
        <td><span class="badge ${cls}">${esc(label)}</span></td><td class="dim hide-sm">${esc(i.note ?? "")}</td>
        <td class="acts">${can ? btn(i.state === "update" ? "Update" : "Pull anyway", () => updImg([i.name]), i.state === "update" ? "sm primary" : "sm") : ""}</td></tr>`;
    })
    .join("");
  const head = p.mgr === "none"
    ? `<span class="dim" style="font-weight:400">no supported package manager</span>`
    : p.updates.length
      ? `<span class="badge">${p.updates.length}</span>${sec.length ? ` <span class="badge warn">${sec.length} security</span>` : ""}`
      : `<span class="badge ok">up to date</span>`;
  return `
    ${p.mgr === "none" ? "" : `<div class="card">
      <h2>Packages ${head}${p.reboot ? ` <span class="badge warn">reboot required</span>` : ""}
        <span class="dim hide-sm" style="font-weight:400">${esc(p.mgr)}${p.refreshed ? "" : " · lists not refreshed"}</span>
        <span class="actions">${pkgActs}</span></h2>
      ${pkgRows ? `<div class="scroll"><table>
        <thead><tr><th>Package</th><th class="hide-sm">Installed</th><th>New</th><th></th></tr></thead>
        <tbody>${pkgRows}${p.updates.length > shown.length ? `<tr><td colspan="4" class="dim">… ${p.updates.length - shown.length} more</td></tr>` : ""}</tbody>
      </table></div>` : ""}
      ${pkgOk ? "" : `<p class="dim">${esc(S.facts[n]?.data?.why?.packages ?? "")}</p>`}
    </div>`}
    ${!e.docker && can(n) && !can(n).docker ? "" : `<div class="card">
      <h2>Docker <span class="badge ${!e.docker || e.dockerNote || e.composeNote ? "warn" : "ok"}">${!e.docker ? "not installed" : e.dockerNote || e.composeNote ? "update available" : "up to date"}</span>
        <span class="actions">${e.composeUpdate ? btn("Update compose", () => run(["update", "--compose", ...s, "-y"], { server: n }), "sm primary") : ""}</span></h2>
      ${e.docker ? `<div class="body"><dl class="kv">
        <dt>Docker</dt><dd>${engineLine(e.docker, e.latestDocker, e.dockerNote, e.dockerHow)}</dd>
        <dt>Compose</dt><dd>${e.compose ? engineLine(e.compose, e.latestCompose, e.composeNote, e.composeHow) : `<span class="badge warn">missing</span> <span class="faint">lf setup installs it</span>`}</dd>
      </dl></div>` : ""}
    </div>
    <div class="card">
      <h2>Images <span class="dim" style="font-weight:400">Traefik and sites</span>
        <span class="actions">${imgUpdates.length ? btn(`Update all (${imgUpdates.length})`, () => updImg(imgUpdates.map((i) => i.name)), "sm primary") : ""}</span></h2>
      <div class="scroll"><table>
        <thead><tr><th>Name</th><th class="hide-sm">Image</th><th>State</th><th class="hide-sm">Note</th><th></th></tr></thead>
        <tbody>${imgRows || `<tr><td colspan="5" class="dim">no containers</td></tr>`}</tbody>
      </table></div>
    </div>`}`;
}
