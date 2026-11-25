import { S } from "../../lib/store";
import { slug } from "../../../../core/lib/slug";
import { mainDomain } from "./server-dialogs";

/** What `lf deploy` picks without a domain: <site>.<main domain>, else the free sslip.io address. */
export function autoDomain(n: string, name: string) {
  const main = mainDomain(n);
  if (main) return `${name}.${main}`;
  const suffix = S.facts[n]?.data?.sslipSuffix;
  return suffix ? `${name}.${suffix}` : "";
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
