"use strict";
// ---- traffic ---------------------------------------------------------------

const TRAFFIC_SPANS = [["1h", "Last hour"], ["24h", "24 hours"], ["7d", "7 days"]];
const CLASS_COLORS = { "2xx": "var(--accent)", "3xx": "var(--faint)", "4xx": "var(--warn)", "5xx": "var(--bad)" };
const ms = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`);
const count = (v) => v.toLocaleString();
const sv2 = (n) => (S.state.defaults.default === n ? "" : ` -s ${n}`);

/** One lazily fetched view per server, outside the tab stores: the sites' error card and certificates. */
function ensure(store, n, url) {
  if (!S[store][n]) fetchInto(store, n, url);
}

/** Requests per minute or hour, stacked by status class; hover a bar for its numbers. */
function trafficChart(series, bucket) {
  const W = 600, H = 120;
  const tot = series.map((x) => x["2xx"] + x["3xx"] + x["4xx"] + x["5xx"]);
  const max = Math.max(1, ...tot);
  const bw = W / series.length;
  const gap = bw > 4 ? 1 : 0;
  const when = (at) => (bucket === "hour" ? new Date(`${at}:00:00Z`) : new Date(`${at}:00Z`));
  const label = (at) => (bucket === "hour" ? when(at).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" }) : when(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
  const bars = series
    .map((x, i) => {
      let y = H;
      const segs = ["2xx", "3xx", "4xx", "5xx"]
        .filter((k) => x[k])
        .map((k) => {
          const h = Math.max(1, (x[k] / max) * (H - 4));
          y -= h;
          return `<rect x="${i * bw + gap / 2}" y="${y}" width="${Math.max(0.5, bw - gap)}" height="${h}" fill="${CLASS_COLORS[k]}"/>`;
        })
        .join("");
      const tip = `${label(x.at)}: ${count(tot[i])} requests${["4xx", "5xx"].filter((k) => x[k]).map((k) => `, ${count(x[k])} ${k}`).join("")}`;
      return `<g><title>${esc(tip)}</title><rect x="${i * bw}" y="0" width="${bw}" height="${H}" fill="transparent"/>${segs}</g>`;
    })
    .join("");
  const ticks = [0, Math.floor(series.length / 2), series.length - 1].map((i, j) => `<span style="text-align:${["left", "center", "right"][j]}">${esc(label(series[i].at))}</span>`).join("");
  return `<div class="tchart"><div class="tmax faint">${count(max)}</div><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Requests per ${bucket}">${bars}</svg>
    <div class="tticks faint">${ticks}</div>
    <div class="tlegend">${Object.entries(CLASS_COLORS).map(([k, col]) => `<span><i style="background:${col}"></i>${k}</span>`).join("")}</div></div>`;
}

const errorCell = (status) => `<span class="badge ${status >= 500 ? "bad" : "warn"}">${status}</span>`;

function trafficView(n) {
  ensure("certs", n, "/certs");
  const st = S.traffic[n];
  const spans = `<div class="actions" style="margin:0 0 14px">${TRAFFIC_SPANS.map(([v, l]) => btn(l, () => ((S.since = v), load(n, "traffic", true), render()), `sm${S.since === v ? " primary" : ""}`, `lf traffic --since ${v}`)).join("")}</div>`;
  const wait = pending(st, "reading Traefik's access log…");
  if (wait) return spans + wait;
  const t = st.data;
  if (!t.proxy) return `<div class="note">No Traefik on ${esc(n)}: nothing to count. Set up the server to install it.</div>`;
  if (t.format === "common") {
    return `<div class="note warn">Traefik writes its access log as plain text. ${t.own
      ? `Add <span class="mono">--accesslog.format=json</span> to its command to see traffic here.`
      : `${btn("Switch to JSON", () => run(["traefik", "setup", ...sv(n), "-y"], { server: n, after: () => (load(n, "traffic", true), []) }), "sm", "lf traefik setup: restarts Traefik for a moment")}`}</div>${certsCard(n)}`;
  }
  if (t.format === "none") return `${spans}<div class="card"><div class="body empty"><h2>No requests in this span</h2><p class="dim">Traefik's access log has nothing from the last ${esc(S.since)}.</p></div></div>${certsCard(n)}`;
  const T = t.total;
  const errs = T.classes["4xx"] + T.classes["5xx"];
  const pct = (v) => (T.requests ? Math.round((v / T.requests) * 1000) / 10 : 0);
  const meters = [
    meter("Requests", null, count(T.requests), `${plural(t.sites.length, "site")} · ${size(T.bytes)} sent`),
    meter("Server errors", null, `${count(T.classes["5xx"])}`, `${pct(T.classes["5xx"])}% · 5xx: the site failed`),
    meter("Client errors", null, `${count(T.classes["4xx"])}`, `${pct(T.classes["4xx"])}% · 4xx: not found, denied`),
    meter("Response time", null, ms(T.p50), `median · 95% within ${ms(T.p95)}`, "", "From Traefik receiving the request to the last byte sent"),
  ].join("");
  const other = t.hosts.filter((h) => !h.site);
  const rowsOf = (label, x) => `<tr><td>${label}</td><td class="num">${count(x.requests)}</td><td class="num">${x.classes["4xx"] ? `<span class="badge warn">${count(x.classes["4xx"])}</span>` : `<span class="faint">0</span>`}</td><td class="num">${x.classes["5xx"] ? `<span class="badge bad">${count(x.classes["5xx"])}</span>` : `<span class="faint">0</span>`}</td><td class="num hide-sm">${ms(x.p50)}</td><td class="num hide-sm">${ms(x.p95)}</td><td class="num hide-sm">${size(x.bytes)}</td></tr>`;
  const siteCard = `<div class="card"><h2>By site</h2><div class="scroll"><table>
    <thead><tr><th>Site</th><th class="num">Requests</th><th class="num">4xx</th><th class="num">5xx</th><th class="num hide-sm">Median</th><th class="num hide-sm">95%</th><th class="num hide-sm">Sent</th></tr></thead>
    <tbody>${t.sites.map((x) => rowsOf(`<b>${esc(x.site)}</b><div class="faint">${esc(x.hosts.join(" "))}</div>`, x)).join("")}${other.slice(0, 10).map((h) => rowsOf(`<span class="mono dim">${esc(h.host)}</span>`, h)).join("")}</tbody></table></div>
    ${other.length ? `<div class="body faint" style="padding-top:0">Hosts without a site: bots asking for the server's IP or old domains${other.length > 10 ? `, ${other.length - 10} more` : ""}.</div>` : ""}</div>`;
  const list = (title, rows, cols) => (rows.length ? `<div class="card"><h2>${title}</h2><div class="scroll"><table><thead><tr>${cols.map(([c, cls = ""]) => `<th class="${cls}">${c}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div></div>` : "");
  const paths = list("Busiest paths", T.paths.map((p) => `<tr><td class="mono">${esc(p.path)}</td><td class="num">${count(p.count)}</td><td class="num">${p.errors ? `<span class="badge warn">${count(p.errors)}</span>` : ""}</td></tr>`), [["Path"], ["Requests", "num"], ["Failed", "num"]]);
  const errors = list("Failing requests", T.errors.map((e) => `<tr><td>${errorCell(e.status)}</td><td class="mono">${esc(e.path)}</td><td class="num">${count(e.count)}</td></tr>`), [["Status"], ["Path"], ["Requests", "num"]]);
  const ips = list("Clients", T.ips.map((i) => `<tr><td class="mono">${esc(i.ip)}</td><td class="num">${count(i.count)}</td></tr>`), [["IP"], ["Requests", "num"]]);
  const reach = t.from && new Date(t.from) - (Date.now() - t.since * 1000) > (t.bucket === "hour" ? 2 * 3_600_000 : 120_000) ? ` · the log reaches back to ${new Date(t.from).toLocaleString()}` : "";
  return `${spans}<div class="meters">${meters}</div>
    <div class="card"><h2>Requests per ${t.bucket} ${errs ? `<span class="sub">${count(errs)} failed</span>` : ""}</h2><div class="body">${trafficChart(T.series, t.bucket)}</div></div>
    ${siteCard}<div class="cols">${errors}${paths}</div>${ips}${certsCard(n)}
    <p class="faint" style="margin-top:14px">${st.loading ? `<span class="spin"></span> ` : ""}from Traefik's access log, read ${new Date(t.at).toLocaleTimeString()}${reach} · <span class="mono">lf traffic --since ${esc(S.since)}${esc(sv2(n))}</span></p>`;
}

/** Each site domain's certificate: days left, who issued it, why getting one failed. */
function certsCard(n) {
  const st = S.certs[n];
  const head = `<h2>Certificates <span class="sub">lf certs</span></h2>`;
  const wait = pending(st, "reading certificates…");
  if (wait) return `<div class="card">${head}${st?.error ? `<div class="body">${wait}</div>` : wait}</div>`;
  const r = st.data;
  if (!r.domains.length) return "";
  const days = (c) => !c ? `<span class="badge bad">none</span>` : c.days < 7 ? `<span class="badge bad">${c.days < 0 ? "expired" : plural(c.days, "day")}</span>` : c.staging ? `<span class="badge warn">staging</span>` : `<span class="badge ${c.days < 30 ? "warn" : "ok"}">${plural(c.days, "day")}</span>`;
  const rows = r.domains.map((d) => `<tr><td>${esc(d.domain)}${d.error && (!d.cert || d.cert.days < 30) ? `<div class="faint" style="color:var(--bad)">${esc(d.error.error)}</div>` : ""}</td><td class="hide-sm dim">${esc(d.site)}</td><td>${days(d.cert)}</td><td class="hide-sm dim">${d.cert ? esc(new Date(d.cert.expires).toLocaleDateString()) : ""}</td><td class="hide-sm faint">${esc(d.cert?.issuer ?? "")}</td></tr>`).join("");
  return `<div class="card">${head}${r.denied.length ? `<div class="body"><div class="note warn" style="margin:0">${esc(r.denied.join(", "))} needs root to read: this login has no passwordless sudo.</div></div>` : ""}<div class="scroll"><table>
    <thead><tr><th>Domain</th><th class="hide-sm">Site</th><th>Left</th><th class="hide-sm">Expires</th><th class="hide-sm">Issuer</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
}

/** The sites tab: what failed in the last 24 hours, only when something did. */
function errorsCard(n) {
  if (!can(n)?.docker) return "";
  ensure("errs", n, "/traffic?since=24h");
  const t = S.errs[n]?.data;
  if (!t || t.format !== "json") return "";
  const rows = t.hosts.flatMap((h) => h.errors.map((e) => ({ ...e, where: h.site ?? h.host, site: !!h.site }))).filter((e) => e.site || e.status >= 500).sort((a, b) => (b.status >= 500) - (a.status >= 500) || b.count - a.count).slice(0, 6);
  if (!rows.length) return "";
  const fives = t.total.classes["5xx"];
  return `<div class="card"><h2>Errors in the last 24h <span class="sub">${fives ? `${count(fives)} server errors · ` : ""}${count(t.total.classes["4xx"])} client errors</span><span class="actions">${btn("Traffic", () => (location.hash = `#/${encodeURIComponent(n)}/traffic`), "sm")}</span></h2><div class="scroll"><table>
    <thead><tr><th>Status</th><th>Site</th><th>Path</th><th class="num">Requests</th></tr></thead>
    <tbody>${rows.map((e) => `<tr><td>${errorCell(e.status)}</td><td>${e.site ? `<b>${esc(e.where)}</b>` : `<span class="mono dim">${esc(e.where)}</span>`}</td><td class="mono">${esc(e.path)}</td><td class="num">${count(e.count)}</td></tr>`).join("")}</tbody></table></div></div>`;
}
