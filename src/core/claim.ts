import { siteHosts, siteMain } from "./compose";
import type { Server } from "./config";
import { checkDns, serverIps } from "./facts";
import { oneOrMany } from "./format";
import { updateProjectDomains } from "./projects";
import { changeSite, overview, type Overview } from "./remote";
import { dropRedirects } from "./server-redirects";
import type { Proxy } from "./templates";
import { c, confirmRemoval, fail, info, warn } from "./term";

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
      `${both.join(", ")} ${oneOrMany(both.length, "is", "are")} also routed to ${e.name}${e.dir ? ` (${e.dir})` : ""}, which landfall did not deploy: Traefik sends visitors to only one of them. Remove the labels there to hand ${oneOrMany(both.length, "it", "them")} over.`,
    );
  }

  // Other sites, each with the hosts it gives up.
  const others = all.sites.map(({ meta }) => ({ m: meta, taken: mine(siteHosts(meta)) })).filter(({ m, taken }) => m.name !== site && taken.length);
  for (const { m, taken } of others) {
    // Redirects and the main service's domains can move; what compose files route cannot.
    const fixed = taken.filter((d) => !m.redirects?.includes(d) && !(siteMain(m) && m.domains.includes(d)));
    if (fixed.length) {
      const where = m.adopted
        ? `its compose files in ${m.adopted} route ${oneOrMany(fixed.length, "it", "them")}`
        : `its compose.yaml routes ${oneOrMany(fixed.length, "it", "them")} (x-landfall.domains)`;
      fail(`${fixed.join(", ")} ${oneOrMany(fixed.length, "serves", "serve")} ${m.name} now and cannot move from there: ${where}`);
    }
    if (refuse) fail(`${taken.join(", ")} ${oneOrMany(taken.length, "serves", "serve")} ${m.name} now; ${refuse}`);
    const left = m.domains.length && m.domains.every((d) => taken.includes(d)) ? ` ${m.name} keeps running with no domain.` : "";
    await confirmRemoval(
      `${taken.join(", ")} ${oneOrMany(taken.length, "serves", "serve")} ${m.name} now. Move ${oneOrMany(taken.length, "it", "them")} to ${to}?${left}`,
    );
  }

  // A site takes a host over from the server's redirects; a redirect replaces its own entry.
  const redirected = site ? all.redirects.list.filter((r) => domains.includes(r.host)) : [];
  if (redirected.length) {
    const n = redirected.length;
    const now = `${redirected.map((r) => r.host).join(", ")} ${oneOrMany(n, "redirects", "redirect")} to ${redirected[0].to} now (lf redirects)`;
    if (refuse) fail(`${now}; ${refuse}`);
    await confirmRemoval(`${now}. Serve ${oneOrMany(n, "it", "them")} from ${site} instead?`);
  }

  const redirects = all.redirects;
  return async () => {
    // Each site is its own change: they run side by side, and report in order.
    const moved = await Promise.all(
      others.map(({ m, taken }) =>
        changeSite(server, m.name, proxy, `moved ${taken.join(", ")} from ${m.name} to ${to}`, (m) => {
          m.domains = m.domains.filter((d) => !domains.includes(d));
          if (m.redirects) m.redirects = m.redirects.filter((d) => !domains.includes(d));
        }),
      ),
    );
    for (const after of moved) {
      const left = after.domains;
      updateProjectDomains(serverName, after.name, left, after.redirects ?? []);
      info(c.dim(left.length ? `${after.name} keeps ${left.join(", ")}` : `${after.name} serves no domain now`));
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
        if (!d.ok)
          warn(
            `${d.domain} ${d.ips.length ? `points at ${d.ips.join(", ")}` : "has no DNS record"}: point an A record at ${ips.join(" or ")}; HTTPS waits for it`,
          );
    };
  });
}
