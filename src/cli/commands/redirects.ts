import { defineCommand, serverOpt } from "../cmd";
import { serverTarget } from "../target";
import { DOMAIN, expandDomain } from "../../core/lib/config";
import { redirectTarget, type ServerRedirect } from "../../core/traefik/redirects";
import { dropRedirects, editableRedirects, readRedirects, writeRedirects } from "../../core/traefik/server-redirects";
import { OWN_PROXY } from "../../core/ssh/templates";
import { c, confirmRemoval, dnsHint, dnsLabel, fail, httpsLabel, info, ok, printJson, warn } from "../../core/lib/term";
import { redirectsView } from "../../core/views/views";
import { oneOrMany } from "../../core/lib/format";
import { claimDomains, lookupDns } from "../../core/site/claim";
import { overview } from "../../core/server/overview";

const describe = (r: ServerRedirect) =>
  `${c.cyan(`https://${r.host}`)} ${c.dim("→")} ${r.to}${r.path ? "" : c.dim(" (path dropped)")}${r.permanent ? "" : c.dim(" (temporary)")}`;

export const redirectsList = defineCommand({
  name: "redirects",
  summary: `List the server's redirects with their DNS and HTTPS state.

A server redirect sends every request for a host elsewhere, with no site behind it
(lf redirect add). Redirects of a site to its own domain are in lf domains.`,
  options: { server: serverOpt, json: { type: "boolean", desc: "machine-readable output" } },
  async run(_, o) {
    const { name, server } = serverTarget(o);
    const v = await redirectsView(server);
    if (v.error) warn(v.error);
    if (o.json) return void printJson({ server: name, ...v });
    if (!v.redirects.length) return info(`no redirects on ${name} ${c.dim("(lf redirect add old.example.com https://example.com)")}`);
    for (const x of v.redirects) console.log(`${describe(x)}  ${dnsLabel(x)}  ${httpsLabel(x.https)}`);
    dnsHint(v.redirects, v.ips, "host");
  },
});

export const redirectAdd = defineCommand({
  name: "redirect add",
  args: "<host> <url>",
  summary: `Redirect a host to a URL, with no site behind it (undoable).

The request's path and query are appended: old.example.com/a?b=1 → <url>/a?b=1.
A bare host name is a subdomain of the main domain. Adding a host again changes it.`,
  options: {
    server: serverOpt,
    temporary: { type: "boolean", desc: "302/307 instead of a permanent 301/308" },
    path: { type: "boolean", desc: "append the request's path and query, on by default (--no-path: always the URL as given)" },
  },
  async run([h, url], o) {
    if (!h || !url) fail("usage: lf redirect add <host> <url>");
    const { name, server } = serverTarget(o);
    const host = expandDomain(h.trim(), server);
    if (!DOMAIN.test(host)) fail(`not a domain: ${host}`);
    const path = o.path !== false;
    const next: ServerRedirect = { host, to: redirectTarget(host, url.trim(), path), permanent: !o.temporary, path };
    const all = await overview(server);
    const was = editableRedirects(all.redirects, name);
    const same = was.list.find((r) => r.host === host);
    if (same && JSON.stringify(same) === JSON.stringify(next)) return ok(`nothing to change: ${describe(same)}`);
    const move = await claimDomains(server, name, "redirect", [host], OWN_PROXY, { overview: all });
    const dns = lookupDns(server, [host]);
    await move();
    const list = [...was.list.filter((r) => r.host !== host), next];
    await writeRedirects(server, was, list, `${same ? "changed" : "added"} redirect ${host} → ${next.to}${next.permanent ? "" : " (temporary)"}`);
    ok(describe(next));
    (await dns)();
  },
});

export const redirectRemove = defineCommand({
  name: "redirect rm",
  args: "<host...>",
  summary: "Remove server redirects (undoable). A bare host name is a subdomain of the main domain.",
  options: { server: serverOpt },
  async run(hosts, o) {
    if (!hosts.length) fail("usage: lf redirect rm <host...>");
    const { name, server } = serverTarget(o);
    const was = editableRedirects(await readRedirects(server), name);
    const want = hosts.map((h) => expandDomain(h.trim(), server));
    const gone = was.list.filter((r) => want.includes(r.host));
    const missing = want.filter((h) => !gone.some((r) => r.host === h));
    if (!gone.length) fail(`${missing.join(", ")} ${oneOrMany(missing.length, "is not a redirect", "are not redirects")} on ${name} (lf redirects)`);
    if (missing.length) warn(`${missing.join(", ")} not a redirect on ${name}`);
    await confirmRemoval(`Remove ${gone.map((r) => `${r.host} → ${r.to}`).join(", ")}? ${oneOrMany(gone.length, "It stops", "They stop")} answering.`);
    const names = gone.map((r) => r.host).join(", ");
    await dropRedirects(
      server,
      was,
      gone.map((r) => r.host),
    );
    ok(`removed ${names}`);
  },
});
