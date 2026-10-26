/**
 * What `--json` prints and the web UI's read API returns: one function per view, so the
 * page never knows more about a server than the CLI can tell a script.
 */
import { firewallState } from "./commands/firewall";
import { domainDns, serverSettings, suggestDomains } from "./commands/server";
import type { Server } from "./config";
import { checkDns, facts, pickIp, serverCaps, serverIps, sslipDomain } from "./facts";
import { pending, readJournal } from "./journal";
import { prunePlan } from "./manage";
import { diskUsage, stats } from "./stats";
import { securityOf } from "./security";
import { certs, checkUrl, traffic } from "./traffic";
import { effectiveSsh } from "./sshconfig";
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

/** `lf history --json`: newest first, with how many steps each run can still undo. */
export async function historyView(server: Server, n?: number) {
  const runs = (await readJournal(server)).reverse().slice(0, n);
  return runs.map((r) => ({ ...r, pending: pending(r).length }));
}

/** `lf update --json` (list only). */
export async function updatesView(server: Server, refresh = false) {
  const packages = await pkgStatus(server, refresh);
  const engine = await engineStatus(server);
  return { packages, images: await imageStatus(server), engine: { ...engine, ...engineNotes(engine) } };
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
