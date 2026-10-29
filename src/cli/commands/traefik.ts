import { defineCommand, logOpts, serverOpt } from "../cmd";
import { checkEmail, checkInt, resolveServer } from "../../core/config";
import { assessTraefik, foreignProxy, probeServer } from "../../core/inventory";
import { dashboardHosts, dashboardRouters, dockerLogs, hasDashboardTunnel } from "../../core/remote";
import { DEFAULT_USER, installTraefik, removeTraefik, traefikSettings, traefikState, traefikStatus as traefikStatusOf, useProxy } from "../../core/traefik";
import { ctrAddress, findContainer, openTunnel, routerPort } from "../../core/tunnel";
import { runScript, shq, sshExec } from "../../core/ssh";
import { DEFAULT_TRAEFIK_IMAGE, NETWORK, PRELUDE, PROXY_CTR, PROXY_FILE, ROOT, TRAEFIK_DIR, TUNNEL_PORT, type Proxy } from "../../core/templates";
import { c, confirm, confirmRemoval, fail, info, ok } from "../../core/term";

export const traefikSetup = defineCommand({
  name: "traefik setup",
  summary: "Install or reconfigure Traefik (reverse proxy + automatic HTTPS) on a server. Safe to re-run; refuses if ports 80/443 belong to something else.",
  options: {
    server: serverOpt,
    email: { type: "string", desc: "contact e-mail for the Let's Encrypt account (optional)" },
    staging: { type: "boolean", desc: "Let's Encrypt staging CA, remembered (--no-staging to switch back)" },
    image: { type: "string", desc: `traefik image, remembered (default: ${DEFAULT_TRAEFIK_IMAGE})` },
    "host-network": { type: "boolean", desc: "run on the host network: real client IPs, ufw applies; remembered (--no-host-network)" },
    http3: { type: "boolean", desc: "HTTP/3 over QUIC on 443/udp, on by default; remembered (--no-http3 turns it off)" },
    dashboard: { type: "string", desc: "serve the traefik dashboard on this domain (basic auth), remembered; `traefik` = traefik.<main domain>, `off` removes it" },
    "dashboard-user": { type: "string", desc: "dashboard user", default: DEFAULT_USER },
    "dashboard-password": { type: "string", desc: "dashboard password (default: generated)" },
    force: { type: "boolean", desc: "overwrite a docker-compose.yml that was edited by hand" },
  },
  async run(_, o) {
    const { name, server } = resolveServer(o.server);
    const probe = await probeServer(server);
    const t = assessTraefik(probe);
    if (t.status === "conflict") fail(`not touching ${name}: ${t.detail}`);
    if (t.proxy) fail(`${name} already has its own traefik: ${t.detail}. landfall does not reconfigure it (lf traefik use)`);
    // On the host network traefik's tunnel entrypoint binds 127.0.0.1:${TUNNEL_PORT} itself: taken, it would not start.
    if (traefikSettings(server, { hostNetwork: o["host-network"] }).hostNetwork) {
      const taken = probe.listen.find((l) => l.port === TUNNEL_PORT && l.proc !== "traefik");
      if (taken) fail(`port ${TUNNEL_PORT} is in use by ${taken.proc}; traefik on the host network needs it for lf tunnel`);
    }
    await installTraefik(name, server, {
      email: o.email && checkEmail(o.email),
      staging: o.staging,
      image: o.image,
      hostNetwork: o["host-network"],
      http3: o.http3,
      dashboard: o.dashboard,
      dashboardUser: o["dashboard-user"],
      dashboardPassword: o["dashboard-password"],
      force: o.force,
    });
  },
});

export const traefikUse = defineCommand({
  name: "traefik use",
  args: "[container]",
  summary: `Deploy sites through a Traefik that already runs on the server (yours, not landfall's).

landfall reads network, entrypoint and cert resolver from the container's flags;
pass them when it is configured by a file. That Traefik is never changed.`,
  options: {
    server: serverOpt,
    network: { type: "string", desc: "docker network traefik watches (providers.docker.network)" },
    entrypoint: { type: "string", desc: "HTTPS entrypoint (the one on :443)" },
    resolver: { type: "string", desc: "certificate resolver" },
  },
  async run([ctr], o) {
    const { name, server } = resolveServer(o.server);
    const probe = await probeServer(server);
    const found = foreignProxy(probe.values.foreign_proxy);
    const container = ctr ?? found?.name;
    if (!container) fail(`no traefik container publishes port 443 on ${name}; name it: lf traefik use <container>`);
    const detected = found?.name === container ? found : undefined;
    const p = {
      container: container!,
      network: o.network ?? detected?.proxy?.network,
      entrypoint: o.entrypoint ?? detected?.proxy?.entrypoint,
      resolver: o.resolver ?? detected?.proxy?.resolver,
    };
    const missing = (["network", "entrypoint", "resolver"] as const).filter((k) => !p[k]);
    if (missing.length) fail(`could not read the ${missing.join(", ")} of ${container}; pass ${missing.map((m) => `--${m}`).join(" ")}`);
    await useProxy(server, p as Proxy);
  },
});

export const traefikRemove = defineCommand({
  name: "traefik rm",
  summary: `Stop landfall's Traefik and remove its config. Sites stay but are unreachable until \`lf traefik setup\`.

Certificates in letsencrypt/ stay for a later install unless --certs. Undo with \`lf undo\`.
With a Traefik of your own (lf traefik use), landfall only stops routing sites through it.`,
  options: { server: serverOpt, certs: { type: "boolean", desc: "also delete the Let's Encrypt certificates" } },
  async run(_, o) {
    const { name, server } = resolveServer(o.server);
    const st = await traefikState(server);
    if (st.proxy) {
      if (!(await confirm(`Stop routing sites on ${name} through your traefik ${st.proxy}? It keeps running.`, false))) fail("cancelled");
      await runScript(server, `${PRELUDE}\nu=$(saved ${PROXY_FILE})\n_as ${ROOT} rm -f ${PROXY_FILE}\nrecord ${shq(`sites stop using traefik ${st.proxy}`)} "$u"`);
      ok(`landfall no longer uses ${st.proxy}; it keeps running and keeps routing the sites until they are redeployed`);
      return info(c.dim("lf traefik setup installs landfall's own traefik"));
    }
    if (st.compose === "foreign") fail(`${TRAEFIK_DIR}/docker-compose.yml was not written by landfall; not touching it`);
    if (!st.compose) return ok(`no traefik of landfall's on ${name}`);
    const sites = st.sites.length ? ` ${st.sites.join(", ")} will be unreachable until \`lf traefik setup\`.` : "";
    await confirmRemoval(`Stop and remove traefik${o.certs ? " and its certificates" : ""} on ${name}?${sites}`);
    await removeTraefik(server, { certs: o.certs });
    ok(`traefik removed${o.certs ? "" : c.dim(" (certificates stay for a later install; --certs deletes them)")}`);
    info(c.dim("lf undo puts it back, lf traefik setup installs it again"));
  },
});

export const traefikStatus = defineCommand({
  name: "traefik status",
  summary: "Show traefik container state and the routes it serves.",
  options: { server: serverOpt, json: { type: "boolean", desc: "machine-readable output" } },
  async run(_, o) {
    const { server } = resolveServer(o.server);
    const st = await traefikStatusOf(server);
    if (o.json) return void console.log(JSON.stringify(st, null, 2));
    if (st.foreign) console.log(`${st.foreign} is a traefik landfall does not use: lf traefik use ${st.foreign} routes sites through it`);
    if (!st.container) return void console.log("traefik is not installed (lf traefik setup)");
    if (st.own) console.log(`your own traefik, landfall only routes sites through it (${PROXY_FILE})`);
    const x = st.container;
    console.log(`${x.name}  ${x.image}  ${x.status}  network ${x.networks.join(",")}\n\nroutes:`);
    for (const r of st.routes) console.log(`  ${r.container}  ${r.rule}  (${r.entrypoints.join(",")})`);
  },
});

export const traefikLogs = defineCommand({
  name: "traefik logs",
  summary: "Show traefik logs (certificate errors show up here).\nRequests are left out unless --access: lf traffic sums them up.",
  options: { server: serverOpt, ...logOpts, access: { type: "boolean", desc: "include the access log (a JSON line per request)" } },
  async run(_, o) {
    const { server } = resolveServer(o.server);
    if (o.access) return dockerLogs(server, PROXY_CTR, o);
    // Requests outnumber everything else: take the last lines from a larger window once they are dropped.
    const n = checkInt(o.tail, "--tail", 1);
    const drop = `awk '!/^\\{.*"DownstreamStatus":/ { print; fflush() }'`;
    return sshExec(server, [o.follow ? `docker logs --tail ${n} -f ${PROXY_CTR} 2>&1 | ${drop}` : `docker logs --tail ${Math.max(n * 50, 5000)} ${PROXY_CTR} 2>&1 | ${drop} | tail -n ${n}`]);
  },
});

export const traefikRestart = defineCommand({
  name: "traefik restart",
  summary: "Restart traefik.",
  options: { server: serverOpt },
  async run(_, o) {
    const { server } = resolveServer(o.server);
    await runScript(server, `${PRELUDE}\ndocker restart ${PROXY_CTR} >/dev/null\nrecord "restarted traefik"`);
    ok("traefik restarted");
  },
});

export const traefikDashboard = defineCommand({
  name: "traefik dashboard",
  summary: `Open Traefik's dashboard on localhost through an SSH tunnel.

No domain or password needed: landfall's Traefik serves the dashboard to the server
itself, and only there. To also serve it on a domain behind a password:
lf traefik setup --dashboard traefik (traefik.<main domain>).

A Traefik of your own works too when it routes the dashboard to a domain: the tunnel
goes to that entrypoint and sends the domain along (log in with its password).`,
  options: {
    server: serverOpt,
    local: { type: "string", short: "l", desc: "local port (default: 8080, else a free one)" },
    lan: { type: "boolean", desc: "listen on this machine's network too: open it from a phone on the same Wi-Fi" },
    port: { type: "string", desc: "with a Traefik of your own: the port of its API (api.insecure: 8080)" },
  },
  async run(_, o) {
    const { name, server } = resolveServer(o.server);
    const st = await traefikState(server);
    const ctr = await findContainer(server, [`name=^${st.proxy ?? "traefik"}$`]);
    if (!ctr) fail(`traefik is not running on ${name}${st.proxy ? "" : " (lf traefik setup)"}`);
    const hosts = dashboardHosts(ctr!.labels);
    const also = hosts.length ? `also at ${hosts.map((h) => `https://${h}`).join(", ")} (with its password)` : undefined;
    const port = o.port ? checkInt(o.port, "--port", 1, 65535) : !st.proxy && hasDashboardTunnel(ctr!.labels) ? TUNNEL_PORT : undefined;
    const what = `traefik dashboard of ${name}`;
    if (port) return openTunnel(server, ctrAddress(ctr!, NETWORK), port, { local: o.local, lan: o.lan, path: "/dashboard/", what, note: also });
    // No API port: go through the router that serves it on a domain, as that domain.
    const routed = dashboardRouters(ctr!.labels)
      .flatMap((r) => (r.hosts[0] ? [{ host: r.hosts[0], at: routerPort(ctr!, r.router) }] : []))
      .find((r) => r.at);
    if (!routed)
      fail(
        st.proxy
          ? `${st.proxy} is your own traefik and serves no dashboard on a domain; if it serves its API (api.insecure), pass its port: --port 8080`
          : `traefik on ${name} was set up by an older landfall: \`lf traefik setup -s ${name}\` adds the dashboard tunnel`,
      );
    const { host, at } = routed!;
    await openTunnel(server, ctrAddress(ctr!, NETWORK), at!.port, {
      local: o.local,
      lan: o.lan,
      path: "/dashboard/",
      what,
      note: `through ${host}'s router (it asks for its login)`,
      as: { name: host, tls: at!.tls },
    });
  },
});
