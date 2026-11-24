import { defineCommand, serverOpt } from "../cmd";
import { DOMAIN, editList, expandDomain, loadProject, saveProject, type Server } from "../../core/config";
import { checkDns, serverIps } from "../../core/facts";
import { updateProjectDomains, withRedirects } from "../../core/projects";
import { currentRelease, findRoute, siteDomains, siteMain, siteRedirects, subDomains, type SiteMeta } from "../../core/compose";
import { changeSite, overview, requireSite } from "../../core/remote";
import type { Proxy } from "../../core/templates";
import { c, confirmRemoval, fail, info, ok, openUrl, passwordOption, warn, printJson } from "../../core/term";
import { DEFAULT_USER, loginUser, newLogin } from "../../core/traefik";
import { target } from "./sites";
import { dnsView } from "../../core/views";
import { redirectHosts } from "../../core/redirects";

/**
 * Domains other sites serve that `site` is about to: asks to move them, and returns what
 * takes them away, to run right before `site` is applied (one host, one router).
 * With `refuse`, fails instead of asking, giving it as the way out.
 */
export async function claimDomains(
  server: Server,
  serverName: string,
  site: string,
  domains: string[],
  proxy: Proxy,
  refuse?: string,
): Promise<() => Promise<void>> {
  // No domain to claim (--no-domain, a worker): nothing to compare, no need to read every site.
  if (!domains.length) return async () => {};
  const all = await overview(server);
  for (const e of all.others) {
    const both = e.domains.filter((d) => domains.includes(d));
    if (both.length)
      warn(
        `${both.join(", ")} ${both.length > 1 ? "are" : "is"} also routed to ${e.name}${e.dir ? ` (${e.dir})` : ""}, which landfall did not deploy: Traefik sends visitors to only one of them. Remove the labels there to hand ${both.length > 1 ? "them" : "it"} over.`,
      );
  }
  const hosts = (m: SiteMeta) => [...siteDomains(m), ...(m.redirects ?? [])];
  const others = all.sites.map((s) => s.meta).filter((m) => m.name !== site && hosts(m).some((d) => domains.includes(d)));
  for (const m of others) {
    const taken = hosts(m).filter((d) => domains.includes(d));
    // Redirects and the main service's domains can move; what compose files route cannot.
    const fixed = taken.filter((d) => !m.redirects?.includes(d) && !(siteMain(m) && m.domains.includes(d)));
    if (fixed.length) {
      const where = m.adopted
        ? `its compose files in ${m.adopted} route ${fixed.length > 1 ? "them" : "it"}`
        : `its compose.yaml routes ${fixed.length > 1 ? "them" : "it"} (x-landfall.domains)`;
      fail(`${fixed.join(", ")} ${fixed.length > 1 ? "serve" : "serves"} ${m.name} now and cannot move from there: ${where}`);
    }
    if (refuse) fail(`${taken.join(", ")} ${taken.length > 1 ? "serve" : "serves"} ${m.name} now; ${refuse}`);
    const left = m.domains.length && m.domains.every((d) => taken.includes(d)) ? ` ${m.name} keeps running with no domain.` : "";
    await confirmRemoval(
      `${taken.join(", ")} ${taken.length > 1 ? "serve" : "serves"} ${m.name} now. Move ${taken.length > 1 ? "them" : "it"} to ${site}?${left}`,
    );
  }
  return async () => {
    for (const m of others) {
      const moved = hosts(m).filter((d) => domains.includes(d));
      const after = await changeSite(server, m.name, proxy, `moved ${moved.join(", ")} from ${m.name} to ${site}`, (m) => {
        m.domains = m.domains.filter((d) => !domains.includes(d));
        if (m.redirects) m.redirects = m.redirects.filter((d) => !domains.includes(d));
      });
      const left = after.domains;
      updateProjectDomains(serverName, m.name, left, after.redirects ?? []);
      info(c.dim(left.length ? `${m.name} keeps ${left.join(", ")}` : `${m.name} serves no domain now`));
    }
  };
}

export const domains = defineCommand({
  name: "domains",
  args: "[site]",
  summary: `Show a site's domains with their DNS and HTTPS state, or change them.

Without flags it lists and checks; --add/--rm/--set/--redirect change the site (undoable)
and update .landfall.json of remembered projects. A redirect host answers with a
permanent redirect to the site's first domain, path and query kept.`,
  options: {
    server: serverOpt,
    add: { type: "string", short: "a", multiple: true, desc: "add a domain (`blog` = blog.<main domain>, `@` = the main domain); another site's moves here" },
    rm: { type: "string", multiple: true, desc: "remove a domain or a redirect" },
    set: { type: "string", multiple: true, desc: "replace all domains" },
    redirect: {
      type: "string",
      multiple: true,
      desc: "redirect a host permanently to the site's first domain (`www` = www.<first domain>); one of its domains turns into a redirect",
    },
    json: { type: "boolean", desc: "machine-readable output (listing)" },
  },
  async run([n], o) {
    const { site, name: serverName, server } = target(n, o.server);
    const changing = !!(o.add || o.rm || o.set || o.redirect);
    const { meta, proxy } = await requireSite(server, site, changing ? { deployed: "change the domains of" } : {});
    if (!changing) {
      const { hosts, to } = siteRedirects(meta);
      const served = siteDomains(meta);
      const { ips, domains: all } = await dnsView(server, [...served, ...hosts]);
      const rows = all.slice(0, served.length);
      const redirects = all.slice(served.length).map((r) => ({ ...r, to: to! }));
      if (o.json) return void printJson({ site, ips, domains: rows, redirects });
      for (const r of [...rows, ...redirects]) {
        const dnsState = r.ok ? c.green("dns ok") : r.ips.length ? c.yellow(`dns → ${r.ips.join(", ")}`) : c.red("no dns");
        const { status, error, tls } = r.https;
        const h = !status
          ? c.red(`https ${error}`)
          : tls && !tls.valid
            ? c.red(`https ${status}, certificate: ${tls.error}`)
            : (status < 400 ? c.green : status === 401 ? c.cyan : c.yellow)(`https ${status}`);
        const to = "to" in r ? ` ${c.dim("→")} ${r.to}` : "";
        console.log(`${c.cyan(`https://${r.domain}`)}${to}  ${dnsState}  ${h}`);
      }
      if (meta.redirects?.length && !to) console.log(c.dim(`redirects of ${site} wait for a domain: ${meta.redirects.join(", ")}`));
      if ([...rows, ...redirects].some((r) => !r.ok)) console.log(c.dim(`\npoint an A record at ${ips.join(" or ")} for each domain`));
      return;
    }
    const main = siteMain(meta);
    if (!main) fail(`no service of ${site} serves the site's domains: its compose.yaml sets them (x-landfall.domains)`);
    const lower = (l?: string[]) => (l ?? []).map((d) => expandDomain(d.trim(), server)).filter(Boolean);
    const was = meta.redirects ?? [];
    // A bare name redirects to a subdomain of the site's own first domain: www → www.example.com.
    const served = editList(o.set ? lower(o.set) : meta.domains, lower(o.add), lower(o.rm));
    const asked = redirectHosts(o.redirect ?? []);
    const first = served.find((d) => !asked.includes(d));
    const redirect = redirectHosts(asked, first);
    const bare = redirect.find((d) => !d.includes("."));
    if (bare) fail(`\`${bare}\` means ${bare}.<first domain>, but ${site} serves no domain: give the whole host`);
    const next = served.filter((d) => !redirect.includes(d));
    // Hosts served again leave the redirects; removed ones leave either list. `--rm www` takes www.<first domain> too.
    const rm = [...lower(o.rm), ...redirectHosts(o.rm ?? [], meta.domains[0])];
    const nextRedirects = editList(was, redirect, [...rm, ...next]);
    const bad = [...next, ...nextRedirects].filter((d) => !DOMAIN.test(d));
    if (bad.length) fail(`not a domain: ${bad.join(", ")}`);
    const on = (h: string) => meta.domains.includes(h) || was.includes(h);
    const missing = (o.rm ?? []).filter((d: string) => ![expandDomain(d.trim(), server), ...redirectHosts([d], meta.domains[0])].some(on));
    if (missing.length) warn(`${missing.join(", ")} not on ${site}`);
    if (next.join() === meta.domains.join() && nextRedirects.join() === was.join()) return ok("nothing to change");
    // Redirects kept from before wait for a domain; new ones need one now.
    if (redirect.length && !next.length) fail(`${redirect.join(", ")} would redirect to nothing: ${site} needs a domain to redirect to`);
    const dropped = meta.domains.filter((d) => !next.includes(d) && !nextRedirects.includes(d));
    if (dropped.length) {
      const left = next.length ? "" : ` ${site} keeps running, unreachable until it gets a domain again.`;
      await confirmRemoval(`Remove ${dropped.join(", ")} from ${site}? ${dropped.length > 1 ? "They stop" : "It stops"} serving it.${left}`);
    }
    const added = next.filter((d) => !meta.domains.includes(d));
    const addedRedirects = nextRedirects.filter((d) => !was.includes(d) && !meta.domains.includes(d));
    const services = currentRelease(meta)?.services ?? [];
    const claim = [...added, ...subDomains(services, added), ...addedRedirects];
    const move = await claimDomains(server, serverName, site, claim, proxy);
    await move();
    const what = `domains of ${site}: ${next.join(", ")}${nextRedirects.length ? `; redirects to ${next[0]}: ${nextRedirects.join(", ")}` : ""}`;
    await changeSite(server, site, proxy, what, (m) => {
      m.domains = next;
      if (nextRedirects.length) m.redirects = nextRedirects;
      else delete m.redirects;
    });
    updateProjectDomains(serverName, site, next, nextRedirects);
    const here = loadProject(process.cwd());
    if (here?.name === site) saveProject(process.cwd(), withRedirects({ ...here, domains: next }, nextRedirects));
    if (!next.length) ok(`${site} serves no domain now ${c.dim(`(lf domains ${site} --add <domain> routes it again)`)}`);
    if (!next.length && nextRedirects.length) info(c.dim(`${nextRedirects.join(", ")} redirect again once ${site} has a domain`));
    else ok(`${site} serves ${next.map((d) => c.cyan(`https://${d}`)).join(", ")}`);
    if (next.length && nextRedirects.length) ok(`${nextRedirects.map((d) => c.cyan(`https://${d}`)).join(", ")} ${c.dim("→")} https://${next[0]}`);
    const ips = await serverIps(server);
    for (const d of await checkDns(claim, ips)) {
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
  lf auth my-site                         show who can log in
  lf auth my-site -r admin --user bob     a login of its own on one route (admin.<domain>), in place of the site's
  lf auth my-site -r hooks --public       no login on one route, though the site asks for one
  lf auth my-site -r admin --off          the route asks for the site's login again`,
  options: {
    server: serverOpt,
    user: { type: "string", short: "u", desc: "login to add or change (default with --password: admin)" },
    password: { type: "string", short: "p", desc: "its password (asked when missing; visible in ps, prefer --password-stdin)" },
    "password-stdin": { type: "boolean", desc: "read the password from stdin" },
    "rm-user": { type: "string", multiple: true, desc: "remove a login" },
    off: { type: "boolean", desc: "remove every login (with --route: its own, so it asks for the site's again)" },
    route: { type: "string", short: "r", desc: "one route instead of the site: its subdomain, a domain, service:port or service" },
    public: { type: "boolean", desc: "with --route: no login on it at all" },
  },
  async run([n], o) {
    const { site, server } = target(n, o.server);
    const { meta, proxy } = await requireSite(server, site, { deployed: "set logins for" });
    if (o.public && !o.route) fail("--public goes with --route; lf auth --off makes the whole site public");
    let key: string | undefined;
    if (o.route) {
      const r = findRoute(meta, o.route);
      if ("routes" in r) return fail(`${site} has no route ${o.route}${r.routes.length ? `; its routes: ${r.routes.join(", ")}` : ""}`);
      key = r.key;
    }
    const own = key ? meta.routeAuth?.[key] : meta.auth;
    const users = (own ?? []).map(loginUser);
    const password = await passwordOption(o);
    const user = o.user ?? (password ? DEFAULT_USER : undefined);
    if (o.public && (user || o["rm-user"] || o.off)) fail("--public takes no logins: use it alone, or --off to drop the route's own ones");
    if (!user && !o["rm-user"] && !o.off && !o.public) return void showLogins(site, meta, key);

    const where = key ? `${key} of ${site}` : site;
    let lines: string[] | undefined;
    if (o.public) lines = [];
    else if (!o.off) {
      const drop = new Set<string>(o["rm-user"] ?? []);
      for (const u of drop) if (!users.includes(u)) warn(`no login ${u} on ${where}`);
      if (user) drop.add(user);
      lines = (own ?? []).filter((l) => !drop.has(loginUser(l)));
      if (user) lines.push(await newLogin(user, password));
      // No logins left: the site is public, a route asks for the site's again; only --public keeps [].
      if (!lines.length) lines = undefined;
    }
    if (lines?.join("\n") === own?.join("\n")) return ok("nothing to change");
    const now = (lines ?? []).map(loginUser);
    const gone = users.filter((u) => !now.includes(u));
    if (!key && !now.length) await confirmRemoval(`Remove every login from ${site}? Anyone can open it then.`);
    else if (key && lines?.length === 0 && meta.auth?.length) await confirmRemoval(`Open ${where} without a login? Anyone can use it then.`);
    else if (gone.length) await confirmRemoval(`Remove the login${gone.length > 1 ? "s" : ""} ${gone.join(", ")} from ${where}?`);

    const said = lines?.length
      ? `login for ${where}: ${now.join(", ")}`
      : lines
        ? `${where} is public`
        : key
          ? `${where} asks for the site's login again`
          : `${site} is public again`;
    await changeSite(server, site, proxy, said, (m) => {
      if (!key) return void (m.auth = lines);
      const all = { ...m.routeAuth };
      if (lines === undefined) delete all[key];
      else all[key] = lines;
      m.routeAuth = Object.keys(all).length ? all : undefined;
    });
    ok(said);
  },
});

/** Who can log in to a site, and to the routes that have logins of their own; or to one route (`key`). */
function showLogins(site: string, meta: SiteMeta, key?: string) {
  const names = (lines: string[]) => lines.map((l) => c.bold(loginUser(l))).join(", ");
  const siteSays = meta.auth?.length ? `asks for a login: ${names(meta.auth)}` : "is public";
  if (key) {
    const own = meta.routeAuth?.[key];
    if (!own) return void console.log(`${key} of ${site} has no logins of its own: like the site, it ${siteSays}`);
    return void console.log(
      own.length
        ? `${key} of ${site} asks for its own login: ${names(own)}`
        : `${key} of ${site} is public ${c.dim("(lf auth -r " + key + " --off asks for the site's login again)")}`,
    );
  }
  console.log(`${site} ${siteSays}${meta.auth?.length ? "" : ` ${c.dim("(add a login with --user)")}`}`);
  for (const [k, own] of Object.entries(meta.routeAuth ?? {})) console.log(`  ${k.padEnd(16)} ${own.length ? `its own login: ${names(own)}` : "public"}`);
}

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
