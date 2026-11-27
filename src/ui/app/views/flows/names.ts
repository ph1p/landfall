import { S, serverNamed } from "../../lib/store";
import { slug } from "../../../../core/lib/slug";
import { autoBase, covers } from "../../../../core/lib/domain-match";

/** What `lf deploy` picks without a domain: <site>.<main domain>, a tenant's <site>.<wildcard domain>, else the free sslip.io address. */
export function autoDomain(n: string, name: string) {
  const saved = serverNamed(n)?.saved;
  const base = saved && autoBase(saved);
  if (base) return `${name}.${base}`;
  if (saved?.tenant) return "";
  const suffix = S.facts[n]?.data?.sslipSuffix;
  return suffix ? `${name}.${suffix}` : "";
}

/** Why this login may not route a host: a tenant's domain for the admin, outside its own list for a tenant. */
export function domainTaken(n: string, host: string): string | undefined {
  const own = serverNamed(n)?.saved?.tenant?.domains;
  if (own) return own.some((d) => covers(d, host)) ? undefined : `${host} is not one of your domains: ${own.join(", ")}`;
  const t = S.overview[n]?.data?.tenants?.find((x) => x.domains.some((d) => covers(d, host)));
  return t && `${host} belongs to tenant ${t.user}`;
}

export const slugify = (s: string) => slug(s.toLowerCase().replace(/\.(zip|tgz|tar(\.gz)?)$/, ""));

/** ghcr.io/me/blog:1.2 → blog. */
export const imageName = (ref: string) =>
  slugify(
    ref
      .trim()
      .replace(/@.*$/, "")
      .replace(/:[\w.-]*$/, "")
      .split("/")
      .pop() ?? "",
  );
