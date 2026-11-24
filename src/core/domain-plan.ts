import { DOMAIN, editList, PROJECT_FILE } from "./config";
import type { SiteMeta } from "./compose";
import { redirectHosts } from "./redirects";
import { fail } from "./term";

export interface DomainPlan {
  /** What the site serves and redirects afterwards. */
  domains: string[];
  redirects: string[];
  changed: boolean;
  /** Domains it stops serving, neither served nor redirected any more. */
  dropped: string[];
  added: string[];
  addedRedirects: string[];
  /** --rm names that are on the site neither as a domain nor as a redirect. */
  missing: string[];
}

/**
 * What `lf domains --add/--rm/--set/--redirect` makes of a site's domains and redirects.
 * `expand` turns `blog` into blog.<main domain>; a bare redirect name is a subdomain of the site's first domain.
 */
export function planDomains(
  meta: SiteMeta,
  o: { add?: string[]; rm?: string[]; set?: string[]; redirect?: string[] },
  expand: (d: string) => string,
): DomainPlan {
  const lower = (l?: string[]) => (l ?? []).map((d) => expand(d.trim())).filter(Boolean);
  const was = meta.redirects ?? [];
  // `--rm www`: the redirect www.<first domain> if the site has it, else www.<main domain> like --add.
  const rmHost = (d: string) => redirectHosts([d], meta.domains[0]).find((r) => was.includes(r)) ?? expand(d.trim());
  const rm = (o.rm ?? []).filter((d) => d.trim()).map(rmHost);
  const served = editList(o.set ? lower(o.set) : meta.domains, lower(o.add), rm);
  const asked = redirectHosts(o.redirect ?? []);
  // A bare name redirects to a subdomain of the site's own first domain: www → www.example.com.
  const redirect = redirectHosts(
    asked,
    served.find((d) => !asked.includes(d)),
  );
  const bare = redirect.find((d) => !d.includes("."));
  if (bare) fail(`\`${bare}\` means ${bare}.<first domain>, but ${meta.name} serves no domain: give the whole host`);
  const domains = served.filter((d) => !redirect.includes(d));
  // Hosts served again leave the redirects; removed ones leave either list.
  const redirects = editList(was, redirect, [...rm, ...domains]);
  const bad = [...domains, ...redirects].filter((d) => !DOMAIN.test(d));
  if (bad.length) fail(`not a domain: ${bad.join(", ")}`);
  const on = (h: string) => meta.domains.includes(h) || was.includes(h);
  const missing = rm.filter((h) => !on(h));
  const changed = domains.join() !== meta.domains.join() || redirects.join() !== was.join();
  // Redirects kept from before wait for a domain; new ones need one now.
  if (changed && redirect.length && !domains.length) fail(`${redirect.join(", ")} would redirect to nothing: ${meta.name} needs a domain to redirect to`);
  return {
    domains,
    redirects,
    changed,
    dropped: meta.domains.filter((d) => !domains.includes(d) && !redirects.includes(d)),
    added: domains.filter((d) => !meta.domains.includes(d)),
    addedRedirects: redirects.filter((d) => !was.includes(d) && !meta.domains.includes(d)),
    missing,
  };
}

/**
 * The site's redirect hosts: --redirect, else .landfall.json's when it lists them, else what lf domains --redirect set.
 * `www` = www.<first domain>. A site that serves no domain keeps its previous ones until it serves one again.
 */
export function deployRedirects(o: { none: boolean; args?: string[]; saved?: string[]; prev?: string[]; domains: string[]; name: string }): string[] {
  if (o.none) return [];
  if (!o.domains.length) {
    if (o.args?.length) fail(`${o.args.join(", ")} would redirect to nothing: ${o.name} serves no domain`);
    return o.prev ?? [];
  }
  const hosts = redirectHosts(o.args?.length ? o.args : (o.saved ?? o.prev ?? []), o.domains[0]).filter((d) => !o.domains.includes(d));
  const bad = hosts.filter((d) => !DOMAIN.test(d));
  if (bad.length) fail(`not a domain: ${bad.join(", ")}${o.args?.length ? "" : ` (redirects in ${PROJECT_FILE})`}`);
  return hosts;
}
