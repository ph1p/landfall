import { siteHosts, siteMain } from "./compose";
import type { Server } from "./config";
import { checkDns, serverIps } from "./facts";
import { updateProjectDomains } from "./projects";
import { changeSite, overview, type Overview } from "./remote";
import { dropRedirects } from "./server-redirects";
import type { Proxy } from "./templates";
import { c, confirmRemoval, fail, info, warn } from "./term";

const are = (n: number, one: string, many: string) => (n > 1 ? many : one);

/**
 * Domains others answer that `by` is about to: asks to move them, and returns what takes them away,
 * to run right before `by` is applied (one host, one router).
 * `"redirect"`: they become a server redirect (`lf redirect add`).
 * `refuse`: fail instead of asking, giving it as the way out. `overview`: the server as already read.
 */
export async function claimDomains(
  server: Server,
  serverName: string,
  by: { site: string } | "redirect",
  domains: string[],
  proxy: Proxy,
  opts: { refuse?: string; overview?: Overview } = {},
): Promise<() => Promise<void>> {
  const { refuse } = opts;
  const site = by === "redirect" ? undefined : by.site;
  // No domain to claim (--no-domain, a worker): nothing to compare, no need to read every site.
  if (!domains.length) return async () => {};
  const all = opts.overview ?? (await overview(server));
  const to = site ?? "a server redirect";
  const mine = (hosts: string[]) => hosts.filter((d) => domains.includes(d));

  for (const e of all.others) {
    const both = mine(e.domains);
    if (!both.length) continue;
    warn(
      `${both.join(", ")} ${are(both.length, "is", "are")} also routed to ${e.name}${e.dir ? ` (${e.dir})` : ""}, which landfall did not deploy: Traefik sends visitors to only one of them. Remove the labels there to hand ${are(both.length, "it", "them")} over.`,
    );
  }

  // Other sites, each with the hosts it gives up.
  const others = all.sites.map(({ meta }) => ({ m: meta, taken: mine(siteHosts(meta)) })).filter(({ m, taken }) => m.name !== site && taken.length);
  for (const { m, taken } of others) {
    // Redirects and the main service's domains can move; what compose files route cannot.
    const fixed = taken.filter((d) => !m.redirects?.includes(d) && !(siteMain(m) && m.domains.includes(d)));
    if (fixed.length) {
      const where = m.adopted
        ? `its compose files in ${m.adopted} route ${are(fixed.length, "it", "them")}`
        : `its compose.yaml routes ${are(fixed.length, "it", "them")} (x-landfall.domains)`;
      fail(`${fixed.join(", ")} ${are(fixed.length, "serves", "serve")} ${m.name} now and cannot move from there: ${where}`);
    }
    if (refuse) fail(`${taken.join(", ")} ${are(taken.length, "serves", "serve")} ${m.name} now; ${refuse}`);
    const left = m.domains.length && m.domains.every((d) => taken.includes(d)) ? ` ${m.name} keeps running with no domain.` : "";
    await confirmRemoval(`${taken.join(", ")} ${are(taken.length, "serves", "serve")} ${m.name} now. Move ${are(taken.length, "it", "them")} to ${to}?${left}`);
  }

  // A site takes a host over from the server's redirects; a redirect replaces its own entry.
  const redirected = site ? all.redirects.list.filter((r) => domains.includes(r.host)) : [];
  if (redirected.length) {
    const n = redirected.length;
    const now = `${redirected.map((r) => r.host).join(", ")} ${are(n, "redirects", "redirect")} to ${redirected[0].to} now (lf redirects)`;
    if (refuse) fail(`${now}; ${refuse}`);
    await confirmRemoval(`${now}. Serve ${are(n, "it", "them")} from ${site} instead?`);
  }

  const redirects = all.redirects;
  return async () => {
    for (const { m, taken } of others) {
      const after = await changeSite(server, m.name, proxy, `moved ${taken.join(", ")} from ${m.name} to ${to}`, (m) => {
        m.domains = m.domains.filter((d) => !domains.includes(d));
        if (m.redirects) m.redirects = m.redirects.filter((d) => !domains.includes(d));
      });
      const left = after.domains;
      updateProjectDomains(serverName, m.name, left, after.redirects ?? []);
      info(c.dim(left.length ? `${m.name} keeps ${left.join(", ")}` : `${m.name} serves no domain now`));
    }
    if (redirected.length)
      await dropRedirects(
        server,
        redirects,
        redirected.map((r) => r.host),
        `${site} serves it now`,
      );
  };
}

/**
 * Looks up where `hosts` point; await the result to print a warning for each that is not the server yet.
 * Start it before a change and print after: the lookup runs meanwhile, and it never fails.
 */
export function lookupDns(server: Server, hosts: string[]): Promise<() => void> {
  return serverIps(server).then(async (ips) => {
    const checks = await checkDns(hosts, ips);
    return () => {
      for (const d of checks)
        if (!d.ok) warn(`${d.domain} ${d.ips.length ? `points at ${d.ips.join(", ")}` : "has no DNS record"}, not ${ips.join(" or ")}: HTTPS waits for it`);
    };
  });
}
