import { defineCommand, serverOpt } from "../cmd";
import { DOMAIN, expandDomain, loadProject, saveProject, type Server } from "../config";
import { checkDns, serverIps } from "../facts";
import { updateProjectDomains } from "../projects";
import { applySite, listSites, requireSite } from "../remote";
import type { Proxy } from "../templates";
import { askSecret, c, confirmRemoval, fail, info, ok, openUrl, warn } from "../ui";
import { htpasswd } from "./traefik";
import { target } from "./sites";

export { DOMAIN } from "../config";

/** HTTPS status of a URL: the code, or why there is none. */
export async function httpsStatus(domain: string): Promise<{ status?: number; error?: string }> {
  try {
    const res = await fetch(`https://${domain}`, { method: "HEAD", signal: AbortSignal.timeout(8000), redirect: "manual" });
    return { status: res.status };
  } catch (e: any) {
    return { error: e?.cause?.code ?? e?.code ?? e?.message ?? String(e) };
  }
}

/**
 * Domains other sites serve that `site` is about to: asks to move them, and returns what
 * takes them away, to run right before `site` is applied (one host, one router).
 * With `refuse`, fails instead of asking, giving it as the way out.
 */
export async function claimDomains(server: Server, serverName: string, site: string, domains: string[], proxy: Proxy, refuse?: string): Promise<() => Promise<void>> {
  const others = (await listSites(server)).map((s) => s.meta).filter((m) => m.name !== site && m.domains.some((d) => domains.includes(d)));
  for (const m of others) {
    const taken = m.domains.filter((d) => domains.includes(d));
    if (refuse) fail(`${taken.join(", ")} ${taken.length > 1 ? "serve" : "serves"} ${m.name} now; ${refuse}`);
    if (taken.length === m.domains.length) {
      fail(`${taken.join(", ")} ${taken.length > 1 ? "are" : "is"} all ${m.name} serves: give it another domain first (lf domains ${m.name} --add <domain>) or remove it (lf sites rm ${m.name})`);
    }
    await confirmRemoval(`${taken.join(", ")} ${taken.length > 1 ? "serve" : "serves"} ${m.name} now. Move ${taken.length > 1 ? "them" : "it"} to ${site}?`);
  }
  return async () => {
    for (const m of others) {
      const prev = structuredClone(m);
      m.domains = m.domains.filter((d) => !domains.includes(d));
      m.updatedAt = new Date().toISOString();
      await applySite(server, m, proxy, { keep: m.releases.length, prev, what: `moved ${prev.domains.filter((d) => domains.includes(d)).join(", ")} from ${m.name} to ${site}` });
      updateProjectDomains(serverName, m.name, m.domains);
      info(c.dim(`${m.name} keeps ${m.domains.join(", ")}`));
    }
  };
}

export const domains = defineCommand({
  name: "domains",
  args: "[site]",
  summary: `Show a site's domains with their DNS and HTTPS state, or change them.

Without flags it lists and checks; --add/--rm/--set change the site (undoable)
and update .landfall.json of remembered projects.`,
  options: {
    server: serverOpt,
    add: { type: "string", short: "a", multiple: true, desc: "add a domain (`blog` = blog.<main domain>, `@` = the main domain); another site's moves here" },
    rm: { type: "string", multiple: true, desc: "remove a domain" },
    set: { type: "string", multiple: true, desc: "replace all domains" },
    json: { type: "boolean", desc: "machine-readable output (listing)" },
  },
  async run([n], o) {
    const { site, name: serverName, server } = target(n, o.server);
    const { meta, proxy } = await requireSite(server, site);
    if (!o.add && !o.rm && !o.set) {
      const ips = await serverIps(server);
      const [dns, https] = await Promise.all([checkDns(meta.domains, ips), Promise.all(meta.domains.map(httpsStatus))]);
      const rows = dns.map((d, i) => ({ ...d, https: https[i] }));
      if (o.json) return void console.log(JSON.stringify({ site, serverIps: ips, domains: rows }, null, 2));
      for (const r of rows) {
        const dnsState = r.ok ? c.green("dns ok") : r.ips.length ? c.yellow(`dns → ${r.ips.join(", ")}`) : c.red("no dns");
        const h = r.https.status ? (r.https.status < 400 ? c.green : r.https.status === 401 ? c.cyan : c.yellow)(`https ${r.https.status}`) : c.red(`https ${r.https.error}`);
        console.log(`${c.cyan(`https://${r.domain}`)}  ${dnsState}  ${h}`);
      }
      if (rows.some((r) => !r.ok)) console.log(c.dim(`\npoint an A record at ${ips.join(" or ")} for each domain`));
      return;
    }
    const lower = (l?: string[]) => (l ?? []).map((d) => expandDomain(d.trim(), server)).filter(Boolean);
    let next = o.set ? lower(o.set) : [...meta.domains];
    next = [...new Set([...next, ...lower(o.add)])].filter((d) => !lower(o.rm).includes(d));
    const bad = next.filter((d) => !DOMAIN.test(d));
    if (bad.length) fail(`not a domain: ${bad.join(", ")}`);
    if (!next.length) fail("a site needs at least one domain");
    const missing = lower(o.rm).filter((d) => !meta.domains.includes(d));
    if (missing.length) warn(`${missing.join(", ")} not on ${site}`);
    if (next.join() === meta.domains.join()) return ok("nothing to change");
    const dropped = meta.domains.filter((d) => !next.includes(d));
    if (dropped.length) await confirmRemoval(`Remove ${dropped.join(", ")} from ${site}? ${dropped.length > 1 ? "They stop" : "It stops"} serving it.`);
    const move = await claimDomains(server, serverName, site, next.filter((d) => !meta.domains.includes(d)), proxy);

    const prev = structuredClone(meta);
    meta.domains = next;
    meta.updatedAt = new Date().toISOString();
    await move();
    await applySite(server, meta, proxy, { keep: meta.releases.length, prev, what: `domains of ${site}: ${next.join(", ")}` });
    updateProjectDomains(serverName, site, next);
    const here = loadProject(process.cwd());
    if (here?.name === site) saveProject(process.cwd(), { ...here, domains: next });
    ok(`${site} serves ${next.map((d) => c.cyan(`https://${d}`)).join(", ")}`);
    const ips = await serverIps(server);
    for (const d of await checkDns(next.filter((d) => !prev.domains.includes(d)), ips)) {
      if (!d.ok) warn(`${d.domain} ${d.ips.length ? `points at ${d.ips.join(", ")}` : "has no DNS record"}, not ${ips.join(" or ")}: HTTPS waits for it`);
    }
  },
});

export const auth = defineCommand({
  name: "auth",
  args: "[site]",
  summary: `Protect a site with a password (HTTP basic auth in Traefik).

  lf auth my-site --user anna             add or change a login (asks the password)
  lf auth my-site --rm-user anna          remove a login
  lf auth my-site --off                   remove all logins: the site is public again
  lf auth my-site                         show who can log in`,
  options: {
    server: serverOpt,
    user: { type: "string", short: "u", desc: "login to add or change" },
    password: { type: "string", short: "p", desc: "its password (asked when missing)" },
    "rm-user": { type: "string", multiple: true, desc: "remove a login" },
    off: { type: "boolean", desc: "remove every login" },
  },
  async run([n], o) {
    const { site, server } = target(n, o.server);
    const { meta, proxy } = await requireSite(server, site);
    const users = (meta.auth ?? []).map((l) => l.slice(0, l.indexOf(":")));
    if (!o.user && !o["rm-user"] && !o.off) {
      if (!users.length) return void console.log(`${site} is public ${c.dim("(add a login with --user)")}`);
      return void console.log(`${site} asks for a login: ${users.map((u) => c.bold(u)).join(", ")}`);
    }
    let lines = o.off ? [] : [...(meta.auth ?? [])];
    const drop = new Set<string>(o["rm-user"] ?? []);
    for (const u of drop) if (!users.includes(u)) warn(`no login ${u} on ${site}`);
    if (o.user) {
      if (!/^[A-Za-z0-9._@-]{1,64}$/.test(o.user)) fail("user may only have letters, digits and . _ @ -");
      const pw: string = o.password ?? (await askSecret(`Password for ${o.user}:`));
      if (pw.length < 8) fail("use a password of at least 8 characters");
      drop.add(o.user);
      lines = lines.filter((l) => !drop.has(l.slice(0, l.indexOf(":"))));
      lines.push(await htpasswd(o.user, pw));
    } else lines = lines.filter((l) => !drop.has(l.slice(0, l.indexOf(":"))));
    if (lines.join("\n") === (meta.auth ?? []).join("\n")) return ok("nothing to change");
    const now = lines.map((l) => l.slice(0, l.indexOf(":")));
    const gone = users.filter((u) => !now.includes(u));
    if (!now.length) await confirmRemoval(`Remove every login from ${site}? Anyone can open it then.`);
    else if (gone.length) await confirmRemoval(`Remove the login${gone.length > 1 ? "s" : ""} ${gone.join(", ")} from ${site}?`);

    const prev = structuredClone(meta);
    meta.auth = lines.length ? lines : undefined;
    meta.updatedAt = new Date().toISOString();
    await applySite(server, meta, proxy, {
      keep: meta.releases.length,
      prev,
      what: now.length ? `login for ${site}: ${now.join(", ")}` : `removed the login of ${site}`,
    });
    ok(now.length ? `${site} asks for a login (${now.join(", ")})` : `${site} is public again`);
  },
});

export const open = defineCommand({
  name: "open",
  args: "[site]",
  summary: "Open a site in the browser.",
  options: { server: serverOpt },
  async run([n], o) {
    const { site, server } = target(n, o.server);
    const { meta } = await requireSite(server, site);
    const url = `https://${meta.domains[0]}`;
    console.log(c.cyan(url));
    openUrl(url);
  },
});
