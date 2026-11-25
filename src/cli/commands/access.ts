import { defineCommand, serverOpt } from "../cmd";
import { expandDomain, loadProject, saveProject } from "../../core/lib/config";
import { updateProjectDomains, withRedirects } from "../../core/deploy/remembered";
import { currentRelease, type SiteMeta } from "../../core/site/meta";
import { findRoute, siteDomains, siteMain, siteRedirects, subDomains } from "../../core/site/routing";
import { changeSite } from "../../core/site/apply";
import { requireSite } from "../../core/site/site";
import { c, confirmRemoval, dnsHint, dnsLabel, fail, httpsLabel, info, ok, openUrl, passwordOption, warn, printJson } from "../../core/lib/term";
import { DEFAULT_USER, loginUser, newLogin } from "../../core/traefik/traefik";
import { siteTarget } from "../target";
import { dnsView } from "../../core/views/views";
import { claimDomains, lookupDns } from "../../core/site/claim";
import { planDomains } from "../../core/site/domain-plan";
import { oneOrMany } from "../../core/lib/format";
import { overview } from "../../core/server/overview";

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
    const { site, name: serverName, server } = siteTarget(n, o.server);
    const changing = !!(o.add || o.rm || o.set || o.redirect);
    // What may claim hosts from other sites needs the whole server: read it alongside the site.
    const all = o.add || o.set || o.redirect ? overview(server) : undefined;
    all?.catch(() => {});
    const { meta, proxy } = await requireSite(server, site, changing ? { deployed: "change the domains of" } : {});
    if (!changing) {
      const { hosts, to } = siteRedirects(meta);
      const served = siteDomains(meta);
      const { ips, domains: all } = await dnsView(server, [...served, ...hosts]);
      const rows = all.slice(0, served.length);
      const redirects = all.slice(served.length).map((r) => ({ ...r, to: to! }));
      if (o.json) return void printJson({ site, ips, domains: rows, redirects });
      for (const r of [...rows, ...redirects]) {
        const to = "to" in r ? ` ${c.dim("→")} ${r.to}` : "";
        console.log(`${c.cyan(`https://${r.domain}`)}${to}  ${dnsLabel(r)}  ${httpsLabel(r.https)}`);
      }
      if (meta.redirects?.length && !to) console.log(c.dim(`redirects of ${site} wait for a domain: ${meta.redirects.join(", ")}`));
      dnsHint([...rows, ...redirects], ips, "domain");
      return;
    }
    const main = siteMain(meta);
    if (!main) fail(`no service of ${site} serves the site's domains: its compose.yaml sets them (x-landfall.domains)`);
    const plan = planDomains(meta, o, (d) => expandDomain(d, server));
    const { domains: next, redirects: nextRedirects, dropped, added, addedRedirects } = plan;
    if (plan.missing.length) warn(`${plan.missing.join(", ")} not on ${site}`);
    if (!plan.changed) return ok("nothing to change");
    if (dropped.length) {
      const left = next.length ? "" : ` ${site} keeps running, unreachable until it gets a domain again.`;
      await confirmRemoval(`Remove ${dropped.join(", ")} from ${site}? ${oneOrMany(dropped.length, "It stops", "They stop")} serving it.${left}`);
    }
    const services = currentRelease(meta)?.services ?? [];
    const claim = [...added, ...subDomains(services, added), ...addedRedirects];
    const move = await claimDomains(server, serverName, { site }, claim, proxy, { overview: await all });
    const dns = lookupDns(server, claim);
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
    (await dns)();
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
    const { site, server } = siteTarget(n, o.server);
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
    const { site, server } = siteTarget(n, o.server);
    const { meta } = await requireSite(server, site);
    const domain = siteDomains(meta)[0];
    if (!domain) fail(`${site} serves no domain`);
    const url = `https://${domain}`;
    console.log(c.cyan(url));
    openUrl(url);
  },
});
