import { defineCommand, logOpts, serverOpt } from "../cmd";
import { serverTarget } from "../target";
import { accessLogStatus, clearProxyLog, composeTarget, planAccessLog, readProxyCompose, writeAccessLog } from "../../core/traefik/accesslog";
import {
  DEFAULT_CERT_HINT,
  fileProvider,
  planStrictTls,
  readDynamicDir,
  unknownHostsOf,
  writeStrictTls,
  type UnknownHostsCheck,
} from "../../core/traefik/stricttls";
import { bytes } from "../../core/lib/format";
import { adminLogin } from "../../core/ssh/privilege";
import { ACCESS_LOG_HINT, logLimitText, type AccessLog } from "../../core/traefik/traffic-merge";
import { checkEmail, checkInt, type Server } from "../../core/lib/config";
import { assessTraefik, foreignProxy, probeServer } from "../../core/server/inventory";
import { dashboardHosts, dashboardRouters, hasDashboardTunnel } from "../../core/server/overview";
import { dockerLogs } from "../../core/ssh/ssh";
import {
  DEFAULT_USER,
  installTraefik,
  removeTraefik,
  traefikSettings,
  traefikState,
  traefikStatus as traefikStatusOf,
  useProxy,
} from "../../core/traefik/traefik";
import { ctrAddress, findContainer, openTunnel, routerPort } from "../../core/ssh/tunnel";
import { runScript, shq, sshExec } from "../../core/ssh/ssh";
import { DEFAULT_TRAEFIK_IMAGE, NETWORK, PRELUDE, PROXY_CTR, PROXY_FILE, ROOT, TRAEFIK_DIR, TUNNEL_PORT, type Proxy } from "../../core/ssh/templates";
import { c, confirm, confirmRemoval, fail, info, ok, printJson, showDiff, step, table, warn } from "../../core/lib/term";

/** lf traefik setup: install or reconfigure landfall's Traefik, after the checks that keep it from breaking the server. */
async function setupTraefik(name: string, server: Server, opts: Parameters<typeof installTraefik>[2]) {
  const probe = await probeServer(server);
  const t = assessTraefik(probe);
  if (t.status === "conflict") fail(`not touching ${name}: ${t.detail}`);
  if (t.proxy) fail(`${name} already has its own traefik: ${t.detail}. landfall does not reconfigure it (lf traefik use)`);
  // On the host network traefik's tunnel entrypoint binds 127.0.0.1:${TUNNEL_PORT} itself: taken, it would not start.
  if (traefikSettings(server, { hostNetwork: opts.hostNetwork }).hostNetwork) {
    const taken = probe.listen.find((l) => l.port === TUNNEL_PORT && l.proc !== "traefik");
    if (taken) fail(`port ${TUNNEL_PORT} is in use by ${taken.proc}; traefik on the host network needs it for lf tunnel`);
  }
  await installTraefik(name, server, opts);
}

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
    "access-log": { type: "boolean", desc: "the JSON access log lf traffic reads, on by default; remembered (--no-access-log turns it off)" },
    dashboard: {
      type: "string",
      desc: "serve the traefik dashboard on this domain (basic auth), remembered; `traefik` = traefik.<main domain>, `off` removes it",
    },
    "dashboard-user": { type: "string", desc: "dashboard user", default: DEFAULT_USER },
    "dashboard-password": { type: "string", desc: "dashboard password (default: generated)" },
    force: { type: "boolean", desc: "overwrite a docker-compose.yml that was edited by hand" },
  },
  async run(_, o) {
    const { name, server } = serverTarget(o);
    await setupTraefik(name, server, {
      email: o.email && checkEmail(o.email),
      staging: o.staging,
      image: o.image,
      hostNetwork: o["host-network"],
      http3: o.http3,
      accessLog: o["access-log"],
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
pass them when it is configured by a file. landfall does not change that Traefik,
except for lf traefik access-log when you run it.`,
  options: {
    server: serverOpt,
    network: { type: "string", desc: "docker network traefik watches (providers.docker.network)" },
    entrypoint: { type: "string", desc: "HTTPS entrypoint (the one on :443)" },
    resolver: { type: "string", desc: "certificate resolver" },
  },
  async run([ctr], o) {
    const { name, server } = serverTarget(o);
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
    if ((await unknownHostsOf(server)).state === "default-cert") warnDefaultCert(o.server ? ` -s ${name}` : "");
  },
});

export const traefikRemove = defineCommand({
  name: "traefik rm",
  summary: `Stop landfall's Traefik and remove its config. Sites stay but are unreachable until \`lf traefik setup\`.

Certificates in letsencrypt/ stay for a later install unless --certs. Undo with \`lf undo\`.
With a Traefik of your own (lf traefik use), landfall only stops routing sites through it.`,
  options: { server: serverOpt, certs: { type: "boolean", desc: "also delete the Let's Encrypt certificates" } },
  async run(_, o) {
    const { name, server } = serverTarget(o);
    const st = await traefikState(server);
    if (st.proxy) {
      if (!(await confirm(`Stop routing sites on ${name} through your traefik ${st.proxy}? It keeps running.`, false))) fail("cancelled");
      await runScript(
        server,
        `${PRELUDE}\nu=$(saved ${PROXY_FILE})\n_as ${ROOT} rm -f ${PROXY_FILE}\nrecord ${shq(`sites stop using traefik ${st.proxy}`)} "$u"`,
      );
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
    const { name, server } = serverTarget(o);
    const st = await traefikStatusOf(server);
    const unknownHosts = st.container ? await unknownHostsOf(server) : undefined;
    if (o.json) return void printJson({ ...st, unknownHosts });
    if (st.foreign) console.log(`${st.foreign} is a traefik landfall does not use: lf traefik use ${st.foreign} routes sites through it`);
    if (!st.container) return void console.log("traefik is not installed (lf traefik setup)");
    if (st.own) console.log(`your own traefik, landfall only routes sites through it (${PROXY_FILE})`);
    const x = st.container;
    console.log(`${x.name}  ${x.image}  ${x.status}  network ${x.networks.join(",")}\n\nroutes:`);
    for (const r of st.routes) console.log(`  ${r.container}  ${r.rule}  (${r.entrypoints.join(",")})`);
    if (unknownHosts?.state === "default-cert") warnDefaultCert(o.server ? ` -s ${name}` : "");
  },
});

export const traefikLogs = defineCommand({
  name: "traefik logs",
  summary: "Show traefik logs (certificate errors show up here).\nRequests are left out unless --access: lf traffic sums them up.",
  options: { server: serverOpt, ...logOpts, access: { type: "boolean", desc: "include the access log (a JSON line per request)" } },
  async run(_, o) {
    const { server } = serverTarget(o);
    if (o.access) return dockerLogs(server, PROXY_CTR, o);
    // Requests outnumber everything else: take the last lines from a larger window once they are dropped.
    const n = checkInt(o.tail, "--tail", 1);
    const drop = `awk '!/^\\{.*"DownstreamStatus":/ { print; fflush() }'`;
    return sshExec(server, [
      o.follow
        ? `docker logs --tail ${n} -f ${PROXY_CTR} 2>&1 | ${drop}`
        : `docker logs --tail ${Math.max(n * 50, 5000)} ${PROXY_CTR} 2>&1 | ${drop} | tail -n ${n}`,
    ]);
  },
});

export const traefikAccessLog = defineCommand({
  name: "traefik access-log",
  args: "[on|off|clear]",
  summary: `Show, turn on, turn off or empty Traefik's JSON access log, which lf traffic reads.

Without an argument it shows whether the log is on, Docker's size limit for it and its size.
on and off change the command of your own Traefik (lf traefik use) in its compose file and recreate
the container; on landfall's Traefik they run lf traefik setup and are remembered. lf undo reverts both.
clear empties the container's log file: the requests lf traffic counts start again. It cannot be undone.`,
  options: { server: serverOpt, json: { type: "boolean", desc: "machine-readable output (status)" } },
  async run([action], o) {
    if (action && !["on", "off", "clear"].includes(action)) fail(`unknown action ${action}: on, off or clear`);
    const { name, server: login } = serverTarget(o);
    let server = login;
    let p = await readProxyCompose(server);
    if (!p) return fail(`no traefik on ${name} (lf traefik setup)`);
    const via = o.server ? ` -s ${name}` : "";
    if (!action) {
      const v = accessLogStatus(p);
      if (o.json) return void printJson(v);
      const l = p.log;
      table([
        ["traefik", `${p.container} (${p.own ? "yours" : "landfall's"})`],
        ["access log", ACCESS_LOG_TEXT[p.accessLog]],
        ...(l ? [["log", [l.driver, logLimitText(l), l.bytes === undefined ? "" : bytes(l.bytes)].filter(Boolean).join(", ")]] : []),
      ]);
      if (l && !logLimitText(l).startsWith("capped")) info(c.dim(`lf log-limit${via} caps the logs of every container, traefik's included`));
      return;
    }
    if (action === "clear") {
      const log = p.log;
      if (log?.driver !== "json-file") return fail(`${p.container} keeps no log file landfall can empty (log driver ${log?.driver ?? "unknown"})`);
      const size = log.bytes === undefined ? "" : ` (${bytes(log.bytes)})`;
      await confirmRemoval(`Empty the log of ${p.container}${size}? lf traffic and lf traefik logs lose what it holds; this cannot be undone.`);
      if (!p.root) server = await adminLogin(server, "lf traefik access-log clear");
      await clearProxyLog(server, p.container);
      return ok(`emptied the log of ${p.container}: lf traffic${via} counts requests from now on`);
    }
    const on = action === "on";
    const want = on ? "json" : "off";
    if (p.accessLog === want) return ok(`the access log of ${p.container} is already ${on ? "on, as JSON" : "off"}`);
    if (!p.own) {
      // landfall's own Traefik: writing its compose file again adds or drops the flags, and the server remembers it.
      if (!(await confirm(`Rewrite and restart landfall's traefik on ${name}? Requests through it fail for a moment.`))) return;
      return setupTraefik(name, server, { dashboardUser: DEFAULT_USER, accessLog: on });
    }
    if (on && p.accessLog === "file")
      fail(`${p.container} writes its access log to a file; lf traffic reads stdout: remove --accesslog.filepath from its command`);
    if (p.accessLog === "unknown")
      fail(`landfall cannot read how ${p.container} is configured; ${on ? ACCESS_LOG_HINT : "remove accessLog from its config by hand"}, then recreate it`);
    // A compose file under /root: read and write it as root (a root key login, or the sudo password).
    if (p.text === undefined && p.files.length === 1 && !p.root) {
      server = await adminLogin(server, "lf traefik access-log");
      p = (await readProxyCompose(server)) ?? p;
    }
    const plan = planAccessLog(p, on);
    if ("error" in plan)
      return fail(`cannot change ${p.container} for you: ${plan.error}; ${on ? ACCESS_LOG_HINT : "remove its --accesslog flags"}, then recreate it`);
    step(`${on ? "adding the access log flags to" : "removing the access log flags from"} the command of ${c.bold(plan.service)}:`);
    showDiff(plan.file, p.text!, plan.text, console.error);
    if (!(await confirm(`Recreate ${p.container}? Requests through it fail for a moment.`))) return;
    await writeAccessLog(server, plan);
    ok(
      on
        ? `${p.container} writes its access log as JSON: lf traffic${via} shows requests from now on`
        : `${p.container} writes no access log: lf traffic${via} has nothing new to count`,
    );
    info(c.dim("lf undo puts the compose file back"));
  },
});

/** How `lf traefik access-log` names each state of the log. */
const ACCESS_LOG_TEXT: Record<AccessLog, string> = {
  json: "on, JSON (what lf traffic reads)",
  common: "on, plain text (lf traffic needs JSON: lf traefik access-log on)",
  off: "off",
  file: "on, written to a file in the container (lf traffic reads stdout)",
  unknown: "set by a config file landfall does not read",
};

/** Unknown hostnames get Traefik's default certificate: say so and how to refuse them. */
function warnDefaultCert(via: string) {
  warn(DEFAULT_CERT_HINT);
  info(c.dim(`lf traefik strict-tls${via} on refuses them: browsers say the site cannot be reached`));
}

/** How `lf traefik strict-tls` names what the probe found. */
const UNKNOWN_HOSTS_TEXT: Record<UnknownHostsCheck["state"], string> = {
  refused: "refused (sniStrict): browsers say the site cannot be reached",
  "default-cert": "answered with traefik's default certificate: browsers show a certificate warning",
  cert: "answered with a certificate",
  unreachable: "could not connect to port 443 from here",
};

export const traefikStrictTls = defineCommand({
  name: "traefik strict-tls",
  args: "[on|off]",
  summary: `Show, turn on or turn off refusing HTTPS for hostnames no site serves (Traefik's sniStrict).

Without it, Traefik answers such a hostname with its self-signed default certificate and browsers warn.
Without an argument it connects to port 443 with a made-up hostname and shows what Traefik answers.
landfall's own Traefik always refuses. on and off are for your own Traefik (lf traefik use): they write
or remove landfall-tls.yml in its file provider folder, adding the folder to its compose file and
recreating the container when it has none. lf undo reverts both.`,
  options: { server: serverOpt, json: { type: "boolean", desc: "machine-readable output (status)" } },
  async run([action], o) {
    if (action && !["on", "off"].includes(action)) fail(`unknown action ${action}: on or off`);
    const { name, server: login } = serverTarget(o);
    let server = login;
    let p = await readProxyCompose(server);
    if (!p) return fail(`no traefik on ${name} (lf traefik setup)`);
    if (!action) {
      const check = await unknownHostsOf(server);
      if (o.json) return void printJson({ container: p.container, own: p.own, unknownHosts: check });
      table([
        ["traefik", `${p.container} (${p.own ? "yours" : "landfall's"})`],
        ["unknown hosts", `${UNKNOWN_HOSTS_TEXT[check.state]}${check.subject && check.state === "cert" ? ` (${check.subject})` : ""}`],
      ]);
      if (check.state === "default-cert" && p.own) info(c.dim(`lf traefik strict-tls${o.server ? ` -s ${name}` : ""} on refuses them`));
      if (check.error) info(c.dim(check.error));
      return;
    }
    const on = action === "on";
    if (!p.own) {
      if (on) return ok(`landfall's traefik on ${name} already refuses hostnames no site serves`);
      return fail(`landfall's traefik always refuses hostnames no site serves; there is nothing to turn off`);
    }
    // A compose file under /root: read and write it as root (a root key login, or the sudo password).
    if (p.text === undefined && p.files.length === 1 && !p.root) {
      server = await adminLogin(server, "lf traefik strict-tls");
      p = (await readProxyCompose(server)) ?? p;
    }
    const t = composeTarget(p);
    if ("error" in t) return fail(`cannot change ${p.container} for you: ${t.error}; ${STRICT_TLS_HINT}`);
    const prov = fileProvider(t.text, t.service, t.dir);
    if ("error" in prov) return fail(`cannot change ${p.container} for you: ${prov.error}; ${STRICT_TLS_HINT}`);
    const plan = planStrictTls(p, prov, await readDynamicDir(server, prov.hostDir), on);
    if ("already" in plan) return ok(plan.already);
    if ("error" in plan) return fail(`cannot change ${p.container} for you: ${plan.error}`);
    if (plan.compose !== undefined) {
      step(`adding a file provider folder (${plan.provider.hostDir}) to ${c.bold(plan.service)}:`);
      showDiff(plan.file, t.text, plan.compose, console.error);
    }
    step(`${on ? "writing" : "removing"} ${plan.path}${plan.reload === "none" ? c.dim(" (traefik reloads it by itself)") : ""}`);
    const reload = { recreate: "Recreate", restart: "Restart", none: "" }[plan.reload];
    const q = reload ? `${reload} ${p.container}? Requests through it fail for a moment.` : `${on ? "Write" : "Remove"} ${plan.path}?`;
    if (!(await confirm(q))) return;
    await writeStrictTls(server, plan);
    ok(
      on
        ? `${p.container} refuses hostnames no site serves: browsers say the site cannot be reached`
        : `${p.container} answers hostnames no site serves with its default certificate again`,
    );
    info(c.dim(`lf undo puts ${plan.compose === undefined ? "it" : "the compose file and it"} back`));
  },
});

/** What to do by hand when landfall cannot turn sniStrict on. */
const STRICT_TLS_HINT = "set tls.options.default.sniStrict: true in its dynamic config, then reload it";

export const traefikRestart = defineCommand({
  name: "traefik restart",
  summary: "Restart traefik.",
  options: { server: serverOpt },
  async run(_, o) {
    const { server } = serverTarget(o);
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
    const { name, server } = serverTarget(o);
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
          : `traefik on ${name} serves no dashboard tunnel: \`lf traefik setup -s ${name}\` adds it`,
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
