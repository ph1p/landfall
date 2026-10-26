"use strict";
// ---- firewall --------------------------------------------------------------

const REACH = { open: "ok", limited: "accent", blocked: "bad", local: "" };

function firewallView(n) {
  const st = S.firewall[n];
  const wait = pending(st, "reading the firewall…");
  if (wait) return wait;
  const fw = st.data;
  const s = sv(n);
  const fwRun = (argv) => run(argv, { server: n });
  const active = fw.ufw === "active";
  const toggle =
    fw.ufw === "missing"
      ? btn("Install & enable ufw", () => fwRun(["firewall", "enable", ...s]), "primary")
      : active
        ? btn("Turn off", () => confirmDlg({ title: `Turn the firewall on ${n} off?`, text: "Every listening port becomes reachable from anywhere.", ok: "Turn it off", danger: true, onOk: () => fwRun(["firewall", "disable", ...s, "-y"]) }), "danger")
        : btn("Turn on", () => fwRun(["firewall", "enable", ...s]), "primary");
  const badge = active ? `<span class="badge ok">on</span>` : fw.ufw === "missing" ? `<span class="badge warn">ufw not installed</span>` : `<span class="badge bad">off</span>`;
  const blocked = !active && fw.blocked.length
    ? `<div class="note">Turning it on would cut off ${esc(fw.blocked.join(", "))}: add rules for them first, or landfall refuses (with a way to do it anyway).</div>`
    : "";
  const ruleRows = fw.rules
    .map((r, i) => {
      const num = String(i + 1);
      const flip = r.action === "deny" || r.action === "reject" ? "allow" : "deny";
      const cls = r.action === "allow" ? "ok" : r.action === "limit" ? "accent" : "bad";
      const port = r.port ? `${r.port}${r.proto ? `/${r.proto}` : ""}` : "";
      return `<tr>
        <td class="faint">${num}</td>
        <td>${btn(`<span class="badge ${cls}">${esc(r.action)}${r.out ? " out" : ""}</span>`, () => confirmDlg({ title: `Switch rule ${num} to ${flip}?`, text: `${r.spec}${r.from ? ` from ${r.from}` : ""}`, ok: `Switch to ${flip}`, danger: flip === "deny", onOk: () => fwRun(["firewall", "update", r.spec, "--action", flip, ...s]) }), "ghost sm", `Switch to ${flip}`)}</td>
        <td class="mono">${esc(port || r.spec)}</td>
        <td>${r.from ? `<span class="mono">${esc(r.from)}</span>` : `<span class="dim">anywhere</span>`}</td>
        <td class="dim hide-sm">${esc(r.comment ?? "")}</td>
        <td class="acts">${btn("Edit", () => editRule(n, num, r), "sm")}${btn("Remove", () => confirmDlg({ title: `Remove rule ${num}?`, text: r.spec, ok: "Remove it", danger: true, onOk: () => fwRun(["firewall", "rm", r.spec, ...s, "-y"]) }), "sm danger")}</td>
      </tr>`;
    })
    .join("");
  const portRows = fw.ports
    .map((p) => `<tr><td class="mono">${esc(p.port)}</td><td>${esc(p.proc)}</td><td><span class="badge ${REACH[p.state] ?? ""}">${esc(p.state)}</span></td><td class="dim">${esc(p.why)}</td></tr>`)
    .join("");
  return `
    ${blocked}
    <div class="card">
      <h2>ufw ${badge} <span class="dim" style="font-weight:400">incoming default: ${esc(fw.policy.toLowerCase())} · ssh on ${esc(fw.sshPort)}${fw.asRoot ? " · as root" : ""}</span>
        <span class="actions">${toggle}</span></h2>
      <div class="scroll"><table>
        <thead><tr><th>#</th><th>Action</th><th>Port</th><th>From</th><th class="hide-sm">Comment</th><th><span class="sr">Actions</span></th></tr></thead>
        <tbody>${ruleRows || `<tr><td colspan="6" class="dim">no rules</td></tr>`}</tbody>
      </table></div>
      <div class="body" style="border-top:1px solid var(--line)">
        <form class="form-row" id="addrule">
          <label>Port <input name="port" placeholder="5432, 51820/udp, 6000:6007/tcp" required></label>
          <label>From <input name="from" placeholder="anywhere, or 10.0.0.0/8"></label>
          <label style="flex:0 0 110px">Action <select name="action"><option value="allow">allow</option><option value="deny">deny</option></select></label>
          <button type="submit" class="primary">Add rule</button>
        </form>
      </div>
    </div>
    <div class="card">
      <h2>Listening ports <span class="dim" style="font-weight:400">and whether the internet reaches them</span></h2>
      <div class="scroll"><table>
        <thead><tr><th>Port</th><th>Process</th><th>Reach</th><th>Why</th></tr></thead>
        <tbody>${portRows || `<tr><td colspan="4" class="dim">nothing listening</td></tr>`}</tbody>
      </table></div>
    </div>`;
}

document.addEventListener("submit", (e) => {
  if (e.target.id !== "addrule") return;
  e.preventDefault();
  const f = e.target.elements;
  const port = f.port.value.trim();
  if (!port) return;
  const from = f.from.value.trim();
  const action = f.action.value;
  e.target.reset();
  run(["firewall", action, port, ...sv(S.sel), ...(from && from !== "anywhere" ? ["--from", from] : [])], { server: S.sel });
});

function editRule(n, num, r) {
  const port = r.port ? `${r.port}${r.proto ? `/${r.proto}` : ""}` : "";
  dialog({
    title: `Edit rule ${num}`,
    text: r.spec,
    fields: [
      { name: "port", label: "Port", value: port, placeholder: "port[/proto]" },
      { name: "from", label: "From", value: r.from ?? "", placeholder: "anywhere", hint: "An address or network like 10.0.0.0/8. Empty = anyone." },
      { name: "action", label: "Action", type: "select", value: r.action, options: ["allow", "deny", "reject", "limit"].map((a) => ({ value: a, label: a })) },
    ],
    ok: "Save",
    onOk: (v) => {
      // By its text, not its number: numbers shift when another firewall command lands first.
      const argv = ["firewall", "update", r.spec, ...sv(n)];
      if (v.port.trim() && v.port.trim() !== port) argv.push("--port", v.port.trim());
      argv.push("--from", v.from.trim() || "any");
      if (v.action !== r.action) argv.push("--action", v.action);
      run(argv, { server: n });
    },
  });
}
