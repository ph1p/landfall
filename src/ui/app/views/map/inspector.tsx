import type { ReactNode } from "react";
import { ExternalLink, X } from "lucide-react";
import type { Graph, GraphNode } from "../../../../core/views/infra-graph";
import { S, sv } from "../../lib/store";
import type { Overview } from "../../lib/types";
import { go } from "../../lib/api";
import { run } from "../../lib/jobs";
import { Btn, Dot, cx, MONO } from "../../ui/kit";
import { runCommand, siteSettings } from "../domains";
import { setupFlow, addServer } from "../flows/setup";
import { redeploy, deployFrom } from "../flows/deploy";
import { folderDialog } from "../flows/folder";
import { ICON, TINT } from "./layout";
import { registered, projects, siteOf, projectOf } from "./data";
import { IconBtn } from "./controls";

/** A ghost node: the lf command that adds it. */
export function addAction(x: GraphNode) {
  const n = x.server!;
  if (x.add === "server") return addServer();
  if (x.add === "setup") return setupFlow([n]);
  if (x.add === "site") return void folderDialog(S.state.cwd, undefined, n);
  const site = siteOf(n, x.site);
  if (x.add === "domain" && site) siteSettings(n, site);
}

/** Double click: the page that shows it. */
export function openNode(x: GraphNode) {
  if (x.kind === "add") return addAction(x);
  if (!x.server) return;
  if (x.kind === "proxy" || x.kind === "redirect") return go(x.server, "traefik");
  if (x.site) S.open.add(`${x.server}/${x.site}`);
  go(x.server, "sites");
}

export function Inspector({ x, g, close, folded, fold }: { x: GraphNode; g: Graph; close: () => void; folded: boolean; fold: (server: string) => void }) {
  const n = x.server;
  const ov: Overview | undefined = n ? S.overview[n]?.data : undefined;
  const site = siteOf(n, x.site);
  const proj = x.kind === "project" ? projects().find((p) => p.path === x.ref) : projectOf(n, x.site);
  const links = g.edges.filter((e) => e.from === x.id || e.to === x.id).length;
  const rows: [string, ReactNode][] = [];
  const acts: [string, () => void, string?][] = [];
  const open =
    (tab = "sites") =>
    () => (x.site && S.open.add(`${n}/${x.site}`), go(n!, tab));

  switch (x.kind) {
    case "machine":
      rows.push(["Servers", registered().length], ["Projects", projects().length], ["Folder", S.state.cwd]);
      acts.push(["Add a server", addServer, "lf server add"], ["Deploy a folder", () => void folderDialog(S.state.cwd)]);
      break;
    case "server": {
      const s = registered().find((y) => y.name === n);
      rows.push(["Address", s?.target], ["ssh login", S.reach[n!]?.state ?? "not checked"], ["Sites", ov?.sites.length ?? "…"]);
      if (ov) rows.push(["Traefik", ov.traefik || "not installed"]);
      if (S.overview[n!]?.error) rows.push(["Error", <span className="text-bad">{S.overview[n!]!.error}</span>]);
      acts.push(["Open", open()]);
      if (ov?.ready) acts.push(["Deploy here…", () => void folderDialog(S.state.cwd, undefined, n), "lf deploy -s " + n]);
      acts.push(["Set up / check", () => setupFlow([n!]), "lf setup --check"], ["Run a command…", () => runCommand(n!)]);
      if (ov) acts.push([folded ? "Unfold on the map" : "Fold on the map", () => fold(n!), "show only the server and its proxy"]);
      break;
    }
    case "proxy":
      rows.push(["Status", ov?.traefik], ["Container", ov?.proxy], ["Owner", ov?.adopted ? "yours (adopted)" : "landfall"]);
      if (ov?.dashboard.hosts.length) rows.push(["Dashboard", ov.dashboard.hosts.join(", ")]);
      acts.push(["Open Traefik", open("traefik")], ["Status", () => run(["traefik", "status", ...sv(n!)]), "lf traefik status"]);
      break;
    case "site":
      if (site) {
        rows.push(
          ["Kind", site.kind],
          ["Status", site.status || "not running"],
          ["Services", site.services.length],
          ["Domains", site.domains.join(", ") || "none: tunnel only"],
        );
        if (site.redirects.length) rows.push(["Redirects", site.redirects.join(", ")]);
        if (site.meta.adopted) rows.push(["Adopted from", <span className={MONO}>{site.meta.adopted}</span>]);
        if (proj) rows.push(["Project", <span className={MONO}>{proj.path}</span>]);
        acts.push(["Open", open()]);
        if (proj) acts.push(["Redeploy", () => redeploy(proj.path, n!, site.meta.name, site.kind, proj.environment), "lf deploy"]);
        acts.push(
          ["Domains and settings…", () => siteSettings(n!, site)],
          ["Logs", () => run(["logs", site.meta.name, ...sv(n!), "-f"]), "lf logs -f"],
          ["Restart", () => run(["restart", site.meta.name, ...sv(n!)]), "lf restart"],
        );
        if (site.domains[0]) acts.push([`Visit ${site.domains[0]}`, () => void window.open(`https://${site.domains[0]}`, "_blank", "noopener")]);
      }
      break;
    case "service":
      rows.push(["Site", x.site], ["Status", x.sub], ["Container", <span className={MONO}>{site?.services.find((s) => s.service === x.ref)?.container}</span>]);
      acts.push(
        ["Logs", () => run(["logs", x.site!, x.ref!, ...sv(n!), "-f"]), "lf logs -f"],
        ["Restart", () => run(["restart", x.site!, x.ref!, ...sv(n!)]), "lf restart"],
        ["Open site", open()],
      );
      break;
    case "volume":
      rows.push(["Site", x.site], ["Volume", <span className={MONO}>{x.ref}</span>]);
      acts.push(["Open site", open()], ["List volumes", () => run(["volume", "ls", x.site!, ...sv(n!)]), "lf volume ls"]);
      break;
    case "domain": {
      const d = S.dns[n!]?.data?.domains.find((y) => y.domain === x.ref);
      rows.push(
        ["Server", n],
        ["DNS", d ? (d.ok ? `points here (${d.ips.join(", ")})` : d.ips.length ? `points at ${d.ips.join(", ")}` : "no record") : "checking…"],
      );
      if (d) rows.push(["HTTPS", d.https.ok ? `${d.https.status} in ${d.https.ms} ms` : (d.https.error ?? `status ${d.https.status}`)]);
      if (d?.https.tls) rows.push(["Certificate", `${d.https.tls.valid ? "valid" : "not trusted"}, ${d.https.tls.days} days left`]);
      acts.push([`Visit ${x.ref}`, () => void window.open(`https://${x.ref}`, "_blank", "noopener")]);
      if (site) acts.push(["Domains and settings…", () => siteSettings(n!, site)]);
      break;
    }
    case "external": {
      const e = ov?.others.find((y) => y.name === x.ref);
      rows.push(["Status", e?.status], ["Containers", e?.containers.join(", ")], ["Domains", e?.domains.join(", ") || "none"]);
      acts.push(["Open", open()]);
      break;
    }
    case "container": {
      // One container, or every container of a Compose project.
      const list = ov?.unrouted.filter((y) => y.container === x.ref || y.project === x.ref) ?? [];
      const c = list.length === 1 ? list[0] : undefined;
      if (c) {
        rows.push(["Image", <span className={MONO}>{c.image}</span>], ["Status", c.status], ["Ports", c.ports.join(", ") || "none"]);
        if (c.project) rows.push(["Compose project", c.project]);
      } else
        for (const y of list)
          rows.push([
            y.container,
            <span>
              <span className={MONO}>{y.image}</span> · {y.status}
              {y.ports.length ? ` · :${y.ports.join(", :")}` : ""}
            </span>,
          ]);
      acts.push(["Open tunnels", open("tunnels")]);
      break;
    }
    case "redirect": {
      const r = ov?.redirects.list.find((y) => y.host === x.ref);
      rows.push(["From", r?.host], ["To", r?.to], ["Kind", r?.permanent ? "permanent (308)" : "temporary (307)"]);
      acts.push(["Open Traefik", open("traefik")]);
      break;
    }
    case "project":
      rows.push(["Folder", <span className={MONO}>{x.ref}</span>], ["Server", x.server], ["Site", x.site]);
      if (proj?.environment) rows.push(["Environment", proj.environment]);
      if (proj && site) acts.push(["Redeploy", () => redeploy(proj.path, proj.server, proj.name, proj.kind, proj.environment), "lf deploy"]);
      acts.push(["Deploy…", () => deployFrom(x.ref!), "review, then lf deploy"]);
      for (const s of registered())
        if (s.name !== x.server && S.overview[s.name]?.data?.ready) acts.push([`Deploy to ${s.name}…`, () => deployFrom(x.ref!, s.name)]);
      break;
  }
  const I = ICON[x.kind];
  return (
    <aside
      data-ui
      className="absolute right-3 top-14 bottom-3 w-[320px] max-w-[calc(100%-24px)] overflow-auto rounded-lg border border-line bg-panel shadow-lg"
    >
      <div className="flex items-start gap-2.5 px-4 pt-3.5 pb-3 border-b border-line">
        <span className={cx("grid place-items-center size-8 flex-none rounded-md bg-hover", TINT[x.kind] ?? "text-dim")}>
          <I className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-[15px] truncate flex items-center gap-1.5">
            {x.label}
            {x.kind !== "machine" && x.kind !== "project" && <Dot kind={x.health} className="m-0" />}
          </div>
          <div className="text-xs text-faint">
            {x.kind}
            {n && x.kind !== "server" ? ` on ${n}` : ""} · {links} {links === 1 ? "link" : "links"}
          </div>
        </div>
        <IconBtn icon={X} label="Close" on={close} />
      </div>
      <dl className="m-0 px-4 py-3 grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
        {rows
          .filter(([, v]) => v !== undefined && v !== "")
          .map(([k, v]) => [
            <dt key={`k${k}`} className="text-faint">
              {k}
            </dt>,
            <dd key={`v${k}`} className="m-0 wrap-anywhere">
              {v}
            </dd>,
          ])}
      </dl>
      {acts.length > 0 && (
        <div className="px-4 pb-4 grid gap-1.5">
          {acts.map(([label, on, hint], i) => (
            <Btn key={label} cls={cx(i === 0 ? "primary" : "", "justify-between w-full")} on={on} title={hint}>
              <span>{label}</span>
              {label.startsWith("Visit") && <ExternalLink className="inline-block size-3 ml-1 -mt-px align-middle" aria-hidden="true" />}
            </Btn>
          ))}
        </div>
      )}
      {x.kind === "project" && <div className="px-4 pb-4 text-xs text-faint">Or drag it onto a server's band to deploy it there.</div>}
    </aside>
  );
}
