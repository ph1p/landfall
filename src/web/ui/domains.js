"use strict";
// ---- domains & login ---------------------------------------------------------

function copy(text) {
  navigator.clipboard?.writeText(text).then(() => toast(`Copied ${text}`), () => toast(text)) ?? toast(text);
}

const servedByOther = (n, site, d) => S.overview[n]?.data?.sites.find((s) => s.meta.name !== site && s.domains.includes(d))?.meta.name;

function domainsDialog(n, m) {
  const main = mainDomain(n);
  const free = autoDomain(n, m.name);
  const ips = S.dns[n]?.data?.ips ?? [];
  dialog({
    title: `Domains of ${m.name}`,
    text: `Each domain needs an A record pointing at ${ips.join(", ") || "the server"}. Traefik fetches the certificate once it resolves.`,
    fields: [
      {
        name: "domains", label: "Domains (space separated)", value: m.domains.join(" "), mono: true, off: (v) => v.noDomain,
        check: (x) => words(x).filter((d) => !domainOk(d)).map((d) => `Not a domain: ${d}`)[0],
      },
      { name: "noDomain", label: "No domain: reach it through a tunnel only", type: "check", value: !m.domains.length, hint: "Nothing is served on the internet; the site keeps running. Open via tunnel reaches it." },
      ...(main && !m.domains.includes(main) ? [{ name: "apex", label: `Also serve ${main}`, type: "check", value: false, when: (v) => !v.noDomain, hint: servedByOther(n, m.name, main) ? `${servedByOther(n, m.name, main)} serves it now and hands it over.` : "The main domain itself." }] : []),
      ...(free && !m.domains.includes(free) ? [{ name: "free", label: main ? `Also add ${free}` : `Also add the free address ${free}`, type: "check", value: false, when: (v) => !v.noDomain, hint: main ? `Under the main domain: works once *.${main} points at the server.` : "Works right away, no DNS setup." }] : []),
    ],
    ok: "Save",
    onOk: (v) => {
      const domains = v.noDomain ? [] : v.domains.split(/[\s,]+/).filter(Boolean);
      if (v.free && !v.noDomain) domains.push(free);
      if (v.apex && !v.noDomain) domains.push(main);
      // None left: the site keeps running, unrouted.
      const args = domains.length ? domains.flatMap((d) => ["--set", d]) : m.domains.flatMap((d) => ["--rm", d]);
      if (!args.length) return;
      run(["domains", m.name, ...sv(n), ...args, "-y"], { server: n });
    },
  });
}

function authDialog(n, m) {
  const users = (m.auth ?? []).map((a) => a.split(":")[0]);
  dialog({
    title: `Password for ${m.name}`,
    text: users.length
      ? `Visitors log in as ${users.join(", ")}. Saving an existing user changes their password.`
      : "Visitors have to log in (HTTP basic auth) before they see the site.",
    fields: [
      { name: "off", label: "Remove the login: the site is public again", type: "check", value: false, when: () => users.length },
      {
        row: [
          { name: "user", label: "User", value: users[0] ?? "admin", off: (v) => v.off, check: (x) => userError(x || "admin") },
          { name: "password", label: `Password (${S.state.rules.minPassword}+ characters)`, type: "password", off: (v) => v.off, required: "Pick a password", check: passwordError },
        ],
      },
    ],
    ok: "Save",
    onOk: (v) => {
      if (v.off) return void run(["auth", m.name, ...sv(n), "--off", "-y"], { server: n });
      run(["auth", m.name, ...sv(n), "-u", v.user.trim() || "admin", "--password", v.password], { server: n });
    },
  });
}

function ensureDns(n, o, force = false) {
  if ((S.dns[n] && !force) || S.dns[n]?.loading || !o?.sites.length) return;
  const domains = [...new Set(o.sites.flatMap((x) => x.domains))];
  fetchInto("dns", n, `/dns?domains=${encodeURIComponent(domains.join(","))}`);
}

function domainChip(n, d) {
  const c = S.dns[n]?.data?.domains.find((x) => x.domain === d);
  const url = `https://${d}`;
  let dot = "", title = "checking…";
  if (c) {
    const { status: st, ms, tls } = c.https;
    const cert = tls ? (tls.valid ? ` · certificate ${plural(tls.days, "day")} left` : ` · certificate: ${tls.error}`) : "";
    if (!c.ips.length) (dot = "down"), (title = "DNS: does not resolve");
    else if (!c.ok) (dot = "warn"), (title = `DNS points at ${c.ips.join(", ")}, not this server`);
    else if (st && st < 500 && tls && (!tls.valid || tls.days < 7)) (dot = "warn"), (title = `HTTPS ${st}${cert}`);
    else if (st && st < 500) (dot = "up"), (title = `HTTPS ${st}${st === 401 ? " (login required)" : ""} in ${ms} ms${cert}`);
    else (dot = "down"), (title = `HTTPS: ${st ?? c.https.error}`);
  }
  return `<span class="chip"><span class="dot ${dot}" title="${esc(title)}"></span><a href="${esc(url)}" target="_blank" rel="noopener" title="${esc(title)}" onclick="event.stopPropagation()">${esc(d)}</a>${btn("⧉", () => copy(url), "ghost", "Copy the address")}</span>`;
}

function runCommand(n) {
  promptDlg(`Run a command on ${n}`, "Runs through ssh as the server's login; output shows on the right.", { label: "Command", placeholder: "df -h", type: "text" }, (cmd) => {
    if (cmd) run(["ssh", n, "--", cmd], { server: n });
  }, "Run");
}

function forget(n) {
  confirmDlg({
    title: `Forget ${n}?`,
    text: "Removes it from landfall (and the Host block landfall wrote to ~/.ssh/config).\nNothing on the server is changed.",
    ok: `Forget ${n}`,
    danger: true,
    typeToConfirm: n,
    onOk: () => run(["server", "rm", n, "-y"], { server: n, after: ifOk(() => go(null)) }),
  });
}

function makeDefault(n) {
  run(["server", "use", n], { server: n, after: ifOk(() => refreshState()) });
}
