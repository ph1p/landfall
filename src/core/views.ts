/**
 * What `--json` prints and the web UI's read API returns: one function per view, so the
 * page never knows more about a server than the CLI can tell a script.
 */
import fs from "node:fs";
import { join } from "node:path";
import { firewallState } from "./firewall";
import { CONFIG_PATH, configDir, DEFAULT_KEEP, expandHome, isTunnelOnly, loadConfig, tildify, type Server } from "./config";
import { describeTraefik, traefikSettings } from "./traefik";
import { checkDns, domainDns, facts, suggestDomains, pickIp, serverCaps, serverIps, sslipDomain } from "./facts";
import { pending, readJournal } from "./journal";
import { prunePlan } from "./manage";
import { scanImages } from "./scan";
import { diskUsage, stats } from "./stats";
import { securityOf } from "./security";
import { certs, checkUrl, traffic } from "./traffic";
import { effectiveSsh, findHostBlock, SSH_CONFIG } from "./sshconfig";
import { DYNAMIC_DIR, JOURNAL, PROXY_FILE, ROOT, SITES, SSHD_CONF, TRAEFIK_DIR } from "./templates";
import { listUsers } from "./users";
import { engineNotes, engineStatus, imageStatus, pkgStatus } from "./updates";

/** `lf firewall --json`: rules numbered as `lf firewall remove <n>` takes them. */
export async function firewallView(server: Server) {
  const { login, probe, ...fw } = await firewallState(server);
  return { ...fw, rules: fw.rules.map((r, i) => ({ n: i + 1, ...r })), asRoot: effectiveSsh(login).user === "root" };
}

/** `lf server config --json`: the saved entry, ssh view, and DNS of each server domain. */
export async function configView(name: string, server: Server) {
  const settings = serverSettings(name);
  const [dns, suggest] = await Promise.all([Promise.all(settings.domains.map((d) => domainDns(server, d))), suggestDomains(server)]);
  return { ...settings, dns, suggest };
}

/** `lf server info --json`. */
export async function factsView(name: string, server: Server) {
  const f = await facts(server);
  const [ips, caps] = await Promise.all([serverIps(server, f), serverCaps(server, f)]);
  const ip = pickIp(ips);
  // What a site gets when deployed without a domain and no main domain is set: <site>.<this>.
  return { name, ...f, ...caps, ips, sslipIp: ip ?? null, sslipSuffix: ip ? sslipDomain("", ip).slice(1) : null };
}

/** `lf stats --json` and `lf disk --json`. */
export const statsView = (server: Server) => stats(server);
export const diskView = (server: Server) => diskUsage(server);
export const pruneView = (server: Server) => prunePlan(server);

/** `lf system --json`. */
export async function systemView(name: string, server: Server) {
  return securityOf(name, server);
}

/** `lf users --json`: fails (as the CLI does) where landfall may not manage users. */
export async function usersView(server: Server) {
  return listUsers(server);
}

/** `lf history --json`: newest first, with how many steps each run can still undo. */
export async function historyView(server: Server, n?: number) {
  const runs = (await readJournal(server)).reverse().slice(0, n);
  return runs.map((r) => ({ ...r, pending: pending(r).length }));
}

/** historyView for the browser: the newest runs, and whether a step has an undo, not the shell that does it. */
export async function historyBrief(server: Server, n = 200) {
  return (await historyView(server, n)).map((r) => ({ ...r, steps: r.steps.map(({ undo, ...x }) => ({ ...x, undo: !!undo })) }));
}

/** `lf update --json` (list only). */
/** lf scan --json [--others]: known vulnerabilities in the images it runs. */
export const scanView = (server: Server, others = false) => scanImages(server, [], others);

export async function updatesView(server: Server, refresh = false) {
  const [packages, engine, images] = await Promise.all([pkgStatus(server, refresh), engineStatus(server), imageStatus(server)]);
  return { packages, images, engine: { ...engine, ...engineNotes(engine) } };
}

/** `lf domains --json`: where each domain points and whether it answers on https. */
export async function dnsView(server: Server, domains: string[]) {
  const ips = await serverIps(server);
  const [dns, https] = await Promise.all([checkDns(domains, ips), Promise.all(domains.map((d) => checkUrl(d)))]);
  return { ips, domains: dns.map((d, i) => ({ ...d, https: https[i] })) };
}

/** `lf traffic --json`: Traefik's access log, aggregated per host and site on the server. */
export const trafficView = (server: Server, secs: number) => traffic(server, secs);

/** `lf certs --json`: each site domain's certificate and the last error getting one. */
export const certsView = (server: Server) => certs(server);

/** A saved server entry as views show it: without the dashboard's password hash. */
export const savedView = (s: Server | undefined) => (s ? { ...s, dashboard: s.dashboard && { host: s.dashboard.host, user: s.dashboard.user } } : null);

/** Everything landfall and ssh know about a server, without connecting to it. */
export function serverSettings(name: string) {
  const cfg = loadConfig();
  const saved = cfg.servers[name];
  const server: Server = saved ?? { host: name };
  const eff = effectiveSsh(server);
  const block = findHostBlock(server.host);
  const t = traefikSettings(server, {});
  return {
    name,
    isDefault: cfg.default === name,
    configFile: tildify(CONFIG_PATH),
    saved: savedView(saved),
    domains: server.domains ?? [],
    tunnelOnly: isTunnelOnly(server),
    /** Set on the server itself, not inherited from `lf config`. */
    tunnelOnlyOwn: server.tunnelOnly !== undefined,
    traefik: { ...t, summary: describeTraefik(t), dashboard: server.dashboard?.host ?? null },
    ssh: {
      hostname: eff.hostname,
      user: eff.user,
      port: eff.port,
      keys: (server.key ? [server.key] : eff.identityFiles).map((f) => ({ file: tildify(f), exists: fs.existsSync(expandHome(f)) })),
      block: block ? { file: tildify(block.file), line: block.start + 1, managed: block.managed, text: block.lines.join("\n") } : null,
    },
  };
}

/** Every place landfall writes to, here and on servers: nothing it installs is hidden. */
function locations() {
  return {
    local: [
      { path: tildify(CONFIG_PATH), what: "servers and these defaults" },
      { path: tildify(join(configDir, "projects.json")), what: "folders deployed from here (web UI Recent)" },
      { path: tildify(join(configDir, "ui-token")), what: "web UI login token" },
      { path: tildify(join(configDir, "uploads")), what: "folders dropped into the web UI, removed after a day" },
      { path: tildify(SSH_CONFIG), what: "Host <name> blocks between # >>> landfall:<name> markers" },
      { path: "~/.ssh/landfall_<name>", what: "ssh key per server (lf keygen, lf setup)" },
      { path: "./.landfall.json", what: "a project's deploy settings, saved by lf deploy" },
    ],
    server: [
      { path: `${ROOT}/README`, what: "how to run it all by hand, without landfall" },
      { path: `${SITES}/<site>`, what: "a site: .env, site.json, current -> releases/<id>" },
      { path: TRAEFIK_DIR, what: "landfall's Traefik: docker-compose.yml, letsencrypt/" },
      { path: DYNAMIC_DIR, what: "Traefik file provider; files you add here are kept" },
      { path: PROXY_FILE, what: "only when sites use a Traefik the server already had" },
      { path: JOURNAL, what: "every change with its undo (lf log, lf undo)" },
      { path: SSHD_CONF, what: "ssh hardening from lf setup" },
      { path: "user deploy", what: "lf setup's deploy user (--deploy-user), in group docker" },
      { path: "packages", what: "Docker + compose plugin, ufw, fail2ban, unattended-upgrades" },
      { path: ".<file>.landfall-*", what: "backups next to each file landfall changed" },
    ],
  };
}

/** landfall's defaults with what applies when one is unset; also the web UI's view. */
export function defaultsView() {
  const cfg = loadConfig();
  const d = cfg.defaults ?? {};
  return {
    configFile: tildify(CONFIG_PATH),
    default: cfg.default ?? null,
    defaults: d,
    tunnelOnly: d.tunnelOnly ?? false,
    email: d.email ?? null,
    keep: d.keep ?? DEFAULT_KEEP,
    locations: locations(),
  };
}
