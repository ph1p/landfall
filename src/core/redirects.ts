// No node: imports: the web page uses this too.

/**
 * Redirect hosts as written in `lf domains --redirect`, `.landfall.json` or the web page: lowercase, each once,
 * and a bare name is a subdomain of the site's first domain (`www` = www.example.com). Without one it stays bare.
 */
export function redirectHosts(list: string[], first?: string): string[] {
  const hosts = list.map((d) => d.trim().toLowerCase()).filter(Boolean);
  return [...new Set(hosts.map((d) => (d.includes(".") || !first ? d : `${d}.${first}`)))];
}
