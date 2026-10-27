import { defineCommand, serverOpt } from "../cmd";
import { DOMAIN, editList, expandDomain, loadProject, saveProject, type Server } from "../config";
import { checkDns, serverIps } from "../facts";
import { updateProjectDomains } from "../projects";
import { isOld, siteDomains, siteMain } from "../compose";
import { changeSite, overview, requireSite } from "../remote";
import type { Proxy } from "../templates";
import { c, confirmRemoval, fail, info, ok, openUrl, passwordOption, warn } from "../ui";
import { DEFAULT_USER, loginUser, newLogin } from "../traefik";
import { target } from "./sites";
import { dnsView } from "../views";


/**
 * Domains other sites serve that `site` is about to: asks to move them, and returns what
 * takes them away, to run right before `site` is applied (one host, one router).
 * With `refuse`, fails instead of asking, giving it as the way out.
 */
export async function claimDomains(server: Server, serverName: string, site: string, domains: string[], proxy: Proxy, refuse?: string): Promise<() => Promise<void>> {
  const all = await overview(server);
  for (const e of all.others) {
    const both = e.domains.filter((d) => domains.includes(d));
    if (both.length) warn(`${both.join(", ")} ${both.length > 1 ? "are" : "is"} also routed to ${e.name}${e.dir ? ` (${e.dir})` : ""}, which landfall did not deploy: Traefik sends visitors to only one of them. Remove the labels there to hand ${both.length > 1 ? "them" : "it"} over.`);
  }
  const others = all.sites.map((s) => s.meta).filter((m) => m.name !== site && siteDomains(m).some((d) => domains.includes(d)));
  for (const m of others) {
    const taken = siteDomains(m).filter((d) => domains.includes(d));
    const fixed = !siteMain(m) ? taken : taken.filter((d) => !m.domains.includes(d));
    if (fixed.length) {
      const where = isOld(m) ? "redeploy it first (lf deploy) so it can hand them over" : m.adopted ? `its compose files in ${m.adopted} route ${fixed.length > 1 ? "them" : "it"}` : `its compose.yaml routes ${fixed.length > 1 ? "them" : "it"} (x-landfall.domains)`;
      fail(`${fixed.join(", ")} ${fixed.length > 1 ? "serve" : "serves"} ${m.name} now and cannot move from there: ${where}`);
    }
    if (refuse) fail(`${taken.join(", ")} ${taken.length > 1 ? "serve" : "serves"} ${m.name} now; ${refuse}`);
    const left = taken.length === m.domains.length ? ` ${m.name} keeps running with no domain.` : "";
    await confirmRemoval(`${taken.join(", ")} ${taken.length > 1 ? "serve" : "serves"} ${m.name} now. Move ${taken.length > 1 ? "them" : "it"} to ${site}?${left}`);
  }
  return async () => {
    for (const m of others) {
      const moved = m.domains.filter((d) => domains.includes(d));
      await changeSite(server, m, proxy, `moved ${moved.join(", ")} from ${m.name} to ${site}`, (m) => void (m.domains = m.domains.filter((d) => !domains.includes(d))));
      updateProjectDomains(serverName, m.name, m.domains);
      info(c.dim(m.domains.length ? `${m.name} keeps ${m.domains.join(", ")}` : `${m.name} serves no domain now`));
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
    const changing = !!(o.add || o.rm || o.set);
    const { meta, proxy } = await requireSite(server, site, changing ? { deployed: "change the domains of" } : {});
    if (!changing) {
      const { ips, domains: rows } = await dnsView(server, siteDomains(meta));
      if (o.json) return void console.log(JSON.stringify({ site, ips, domains: rows }, null, 2));
      for (const r of rows) {
        const dnsState = r.ok ? c.green("dns ok") : r.ips.length ? c.yellow(`dns → ${r.ips.join(", ")}`) : c.red("no dns");
        const { status, error, tls } = r.https;
        const h = !status ? c.red(`https ${error}`) : tls && !tls.valid ? c.red(`https ${status}, certificate: ${tls.error}`) : (status < 400 ? c.green : status === 401 ? c.cyan : c.yellow)(`https ${status}`);
        console.log(`${c.cyan(`https://${r.domain}`)}  ${dnsState}  ${h}`);
      }
      if (rows.some((r) => !r.ok)) console.log(c.dim(`\npoint an A record at ${ips.join(" or ")} for each domain`));
      return;
    }
    const main = siteMain(meta);
    if (!main) fail(`no service of ${site} serves the site's domains: its compose.yaml sets them (x-landfall.domains)`);
    const lower = (l?: string[]) => (l ?? []).map((d) => expandDomain(d.trim(), server)).filter(Boolean);
    const next = editList(o.set ? lower(o.set) : meta.domains, lower(o.add), lower(o.rm));
    const bad = next.filter((d) => !DOMAIN.test(d));
    if (bad.length) fail(`not a domain: ${bad.join(", ")}`);
    const missing = lower(o.rm).filter((d) => !meta.domains.includes(d));
    if (missing.length) warn(`${missing.join(", ")} not on ${site}`);
    if (next.join() === meta.domains.join()) return ok("nothing to change");
    const dropped = meta.domains.filter((d) => !next.includes(d));
    if (dropped.length) {
      const left = next.length ? "" : ` ${site} keeps running, unreachable until it gets a domain again.`;
      await confirmRemoval(`Remove ${dropped.join(", ")} from ${site}? ${dropped.length > 1 ? "They stop" : "It stops"} serving it.${left}`);
    }
    const added = next.filter((d) => !meta.domains.includes(d));
    const move = await claimDomains(server, serverName, site, added, proxy);
    await move();
    await changeSite(server, meta, proxy, `domains of ${site}: ${next.join(", ")}`, (m) => void (m.domains = next));
    updateProjectDomains(serverName, site, next);
    const here = loadProject(process.cwd());
    if (here?.name === site) saveProject(process.cwd(), { ...here, domains: next });
    if (!next.length) ok(`${site} serves no domain now ${c.dim(`(lf domains ${site} --add <domain> routes it again)`)}`);
    else ok(`${site} serves ${next.map((d) => c.cyan(`https://${d}`)).join(", ")}`);
    const ips = await serverIps(server);
    for (const d of await checkDns(added, ips)) {
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
    user: { type: "string", short: "u", desc: "login to add or change (default with --password: admin)" },
    password: { type: "string", short: "p", desc: "its password (asked when missing; visible in ps, prefer --password-stdin)" },
    "password-stdin": { type: "boolean", desc: "read the password from stdin" },
    "rm-user": { type: "string", multiple: true, desc: "remove a login" },
    off: { type: "boolean", desc: "remove every login" },
  },
  async run([n], o) {
    const { site, server } = target(n, o.server);
    const { meta, proxy } = await requireSite(server, site, { deployed: "set logins for" });
    const users = (meta.auth ?? []).map(loginUser);
    const password = await passwordOption(o);
    const user = o.user ?? (password ? DEFAULT_USER : undefined);
    if (!user && !o["rm-user"] && !o.off) {
      if (!users.length) return void console.log(`${site} is public ${c.dim("(add a login with --user)")}`);
      return void console.log(`${site} asks for a login: ${users.map((u) => c.bold(u)).join(", ")}`);
    }
    let lines = o.off ? [] : [...(meta.auth ?? [])];
    const drop = new Set<string>(o["rm-user"] ?? []);
    for (const u of drop) if (!users.includes(u)) warn(`no login ${u} on ${site}`);
    if (user) drop.add(user);
    lines = lines.filter((l) => !drop.has(loginUser(l)));
    if (user) lines.push(await newLogin(user, password));
    if (lines.join("\n") === (meta.auth ?? []).join("\n")) return ok("nothing to change");
    const now = lines.map(loginUser);
    const gone = users.filter((u) => !now.includes(u));
    if (!now.length) await confirmRemoval(`Remove every login from ${site}? Anyone can open it then.`);
    else if (gone.length) await confirmRemoval(`Remove the login${gone.length > 1 ? "s" : ""} ${gone.join(", ")} from ${site}?`);

    await changeSite(server, meta, proxy, now.length ? `login for ${site}: ${now.join(", ")}` : `removed the login of ${site}`, (m) => void (m.auth = lines.length ? lines : undefined));
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
    const domain = siteDomains(meta)[0];
    if (!domain) fail(`${site} serves no domain`);
    const url = `https://${domain}`;
    console.log(c.cyan(url));
    openUrl(url);
  },
});
