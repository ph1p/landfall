// No node: imports: the web page uses these too.
import type { Server } from "./config";

/** Whether a name or pattern covers a host: exact, or `*.x` for exactly one label below x. */
export const covers = (name: string, host: string) =>
  name === host || (name.startsWith("*.") && host.indexOf(".") > 0 && host.slice(host.indexOf(".") + 1) === name.slice(2));

/** Where a new site goes without a domain: under the main domain, else under a tenant's first wildcard (`*.x` gives x). */
export const autoBase = (s: Pick<Server, "domains">, mine?: string[]) => s.domains?.[0] ?? mine?.find((d) => d.startsWith("*."))?.slice(2);
