import { defineCommand, serverOpt } from "../cmd";
import { loadProject, resolveServer } from "../config";
import { COMPOSE_FILES, isDone, isOld, isUp, kindOf, OVERRIDE_FILES, projectName, siteDomains, type SiteMeta } from "../compose";
import { adoptSite, applySite, composeCmd, overview, mergeEnv, newestFirst, parseEnvPairs, readSite, removeSite, requireSite, siteDir, siteLogs, validName } from "../remote";
import { shq, writeFileCmd } from "../ssh";
import { ago, c, confirmRemoval, fail, ok, table } from "../ui";
import { slug } from "../projects";
import { logOpts } from "./traefik";

/** Site + server from args, falling back to ./.landfall.json. */
export function target(name: string | undefined, server: string | undefined) {
  const project = loadProject(process.cwd());
  const site = name ?? project?.name;
  if (!site) fail("which site? pass a name or run inside a folder with .landfall.json");
  return { site: site!, ...resolveServer(server ?? project?.server) };
}

const paint = (status: string) => (isUp(status) ? c.green(status) : isDone(status) ? c.dim(status) : c.red(status));

export const sitesList = defineCommand({
  name: "sites list",
  summary: "List deployed sites on a server.",
  options: {
    server: serverOpt,
    json: { type: "boolean", desc: "machine-readable output" },
    others: { type: "boolean", desc: "with --json: {sites, others}, others = containers Traefik routes that landfall did not deploy" },
  },
  async run(_, o) {
    const { name, server } = resolveServer(o.server ?? loadProject(process.cwd())?.server);
    const { sites, others } = await overview(server);
    if (o.json) return console.log(JSON.stringify(o.others ? { sites, others } : sites, null, 2));
    if (others.length) {
      console.log(c.dim(`not deployed by landfall, routed by Traefik (\`lf adopt <name>\` manages a Compose project):`));
      table([
        [c.dim("NAME"), c.dim("DOMAINS"), c.dim("FOLDER"), c.dim("STATUS")],
        ...others.map((e) => [e.name, e.domains.join(", "), e.dir ?? c.dim(e.containers.join(", ")), paint(e.status)]),
      ]);
      if (sites.length) console.log();
    }
    if (!sites.length) return console.log(`no landfall sites on ${name} yet — ${c.bold("lf deploy --domain example.com")}`);
    table([
      [c.dim("NAME"), c.dim("KIND"), c.dim("DOMAINS"), c.dim("SERVICES"), c.dim("RELEASE"), c.dim("UPDATED"), c.dim("STATUS")],
      ...sites.map(({ meta, status, services }) => [
        c.bold(meta.name),
        kindOf(meta),
        siteDomains(meta).join(", "),
        services.map((x) => x.service).join(", ") || c.dim("-"),
        meta.current || c.dim("-"),
        ago(meta.updatedAt),
        paint(status),
      ]),
    ]);
  },
});

export const sitesInfo = defineCommand({
  name: "sites info",
  args: "[name]",
  summary: "Show a site's services, domains and release history.",
  options: { server: serverOpt },
  async run([n], o) {
    const { site, server } = target(n, o.server);
    // One round trip: the overview has the site's meta and its containers.
    const st = (await overview(server)).sites.find((x) => x.meta.name === site);
    if (!st) fail(`no site "${site}" on ${server.host}. See \`lf sites list\``);
    const meta = st!.meta;
    console.log(`${c.bold(meta.name)}  ${kindOf(meta)}  ${paint(st?.status ?? "not running")}`);
    for (const d of siteDomains(meta)) console.log(`  ${c.cyan("https://" + d)}`);
    console.log(c.dim(`  ${meta.adopted ?? siteDir(site) + "/current"}  (docker compose works there)`));
    if (st?.services.length) {
      console.log(`\n${c.bold("Services")}`);
      table(st.services.map((x) => [`  ${x.service}`, c.dim(x.container), paint(x.status)]));
    }
    // Sites of the old layout list no services per release.
    if (!meta.releases.length || isOld(meta)) return;
    console.log(`\n${c.bold("Releases")}`);
    for (const r of newestFirst(meta)) {
      const mark = r.id === meta.current ? c.green("● ") : "  ";
      const routes = r.services.filter((x) => x.port || x.own).map((x) => `${x.name}${x.port ? ":" + x.port : ""}`);
      console.log(`${mark}${r.id}  ${c.dim(ago(r.at))}  ${c.dim(r.services.map((x) => x.name).join(", "))}${routes.length ? c.dim(`  → ${routes.join(", ")}`) : ""}`);
    }
  },
});

export const sitesLogs = defineCommand({
  name: "logs",
  args: "[name] [service]",
  summary: "Show a site's logs: all its services, or one.",
  options: { server: serverOpt, ...logOpts },
  async run([n, service], o) {
    const { site, server } = target(n, o.server);
    return siteLogs(server, site, { ...o, service });
  },
});

/**
 * `undo`: the compose command that reverts it, journaled only when the service was `undoWhen`
 * (running or not) before; otherwise nothing changed and undoing it would flip a live site.
 */
const lifecycle = (verb: "restart" | "stop" | "start", compose: string, done: string, undo?: string, undoWhen?: boolean) =>
  defineCommand({
    name: verb,
    args: "[name] [service]",
    summary: `${verb[0].toUpperCase() + verb.slice(1)} a site's services, or one of them.`,
    options: { server: serverOpt },
    async run([n, service], o) {
      const { site, server } = target(n, o.server);
      await requireSite(server, site);
      const svc = service ? ` ${shq(service)}` : "";
      const what = `record ${shq(`${verb} ${site}${service ? " " + service : ""}`)}`;
      const running = `[ -n "$(cd -P current && dc ps -q --status running${svc} 2>/dev/null)" ]`;
      const before = undo
        ? `if ${undoWhen ? "" : "! "}${running}; then ${what} ${shq(`cd -P ${siteDir(site)}/current && dc ${undo}${svc}`)}; else ${what}; fi`
        : what;
      await composeCmd(server, site, compose + svc, before);
      ok(`${service ? `${site} ${service}` : site} ${done}`);
    },
  });

export const sitesRestart = lifecycle("restart", "restart", "restarted");
export const sitesStop = lifecycle("stop", "stop", "stopped", "start", true);
export const sitesStart = lifecycle("start", "up -d --wait", "started", "stop", false);

export const sitesRollback = defineCommand({
  name: "rollback",
  args: "[name]",
  summary: "Switch a site back to the previous release (or --to <release>).",
  options: { server: serverOpt, to: { type: "string", desc: "release id (see `lf sites info`)" } },
  async run([n], o) {
    const { site, server } = target(n, o.server);
    const { meta, proxy } = await requireSite(server, site, { deployed: "roll back" });
    const sorted = newestFirst(meta);
    const idx = sorted.findIndex((r) => r.id === meta.current);
    if (idx < 0 && !o.to) fail(`current release ${meta.current} is not in the release list; pick one with --to (see \`lf sites info\`)`);
    const to = o.to ? sorted.find((r) => r.id === o.to) : sorted[idx + 1];
    if (!to) fail(o.to ? `no release ${o.to}` : `no release older than ${meta.current}`);
    const prev = structuredClone(meta);
    meta.current = to!.id;
    meta.updatedAt = new Date().toISOString();
    await applySite(server, meta, proxy, { keep: meta.releases.length, prev, what: `rollback ${site} from ${prev.current} to ${to!.id}` });
    ok(`${site} rolled back to ${c.bold(to!.id)}`);
  },
});

export const sitesAdopt = defineCommand({
  name: "adopt",
  args: "<project>",
  summary: `Make a Compose project landfall did not deploy a site: \`lf sites\`, logs, restart,
stop and start then work for it. It keeps running from its folder, with its own files and
Traefik labels; landfall does not deploy, roll back or change its domains. \`lf sites rm\`
stops it and forgets it again. The projects you can adopt are listed under \`lf sites\`.`,
  options: { server: serverOpt, name: { type: "string", desc: "site name (default: the project name)" } },
  async run([project], o) {
    if (!project) fail("usage: lf adopt <project>   (see the projects not deployed by landfall in `lf sites`)");
    const { server, name } = resolveServer(o.server);
    const ov = await overview(server);
    const ext = ov.others.find((e) => e.name === project);
    if (!ext) {
      const known = ov.sites.find((x) => projectName(x.meta) === project);
      fail(known ? `${project} is already the site ${known.meta.name}` : `no Compose project "${project}" with Traefik routes on ${name}. See \`lf sites\``);
    }
    const e = ext!;
    if (!e.dir) fail(`${project} is a single container, not a Compose project: only Compose projects can be adopted`);
    const site = validName(o.name ?? slug(project));
    if (ov.sites.some((x) => x.meta.name === site)) fail(`there is a site "${site}" already: pick another name with --name`);
    // Commands run `docker compose` in its folder, which finds only the standard file names.
    const defaults = new Set([...COMPOSE_FILES, ...OVERRIDE_FILES].map((f) => `${e.dir}/${f}`));
    const odd = (e.files ?? "").split(",").filter((f) => f && !defaults.has(f));
    if (odd.length) fail(`${project} was started with ${odd.join(", ")}; rename it to compose.yaml in ${e.dir} (or adopt it after moving it there)`);
    const now = new Date().toISOString();
    const meta: SiteMeta = { v: 2, name: site, kind: "compose", domains: e.domains, current: "", releases: [], adopted: e.dir, project, createdAt: now, updatedAt: now };
    await adoptSite(server, meta);
    ok(`adopted ${project} as ${site} (${e.domains.join(", ")})`);
    console.log(c.dim(`it runs from ${e.dir} as before; lf logs ${site}, lf restart ${site} and lf sites rm ${site} now work`));
  },
});

export const sitesRemove = defineCommand({
  name: "sites rm",
  args: "<name>",
  summary: `Stop a site and delete its files and releases from the server.

Named volumes (databases, uploads) stay, so deploying the site again finds its data;
--volumes deletes them too. An adopted site is stopped and forgotten; its folder stays.`,
  options: { server: serverOpt, volumes: { type: "boolean", desc: "also delete the site's named volumes (its data)" } },
  async run([n], o) {
    if (!n) fail("usage: lf sites rm <name>");
    const { site, server, name } = target(n, o.server);
    // Not requireSite: sites of an older landfall can go too.
    const { meta } = await readSite(server, site);
    if (!meta) fail(`no site "${site}" on ${name}. See \`lf sites list\``);
    const m = meta!;
    const domains = siteDomains(m).join(", ") || "no domains";
    const data = o.volumes ? " and its volumes (all its data)" : "";
    await confirmRemoval(
      m.adopted ? `Stop ${site} (${domains}) on ${name} and forget it${data}? ${m.adopted} stays.` : `Delete ${site} (${domains})${data} from ${name}? This cannot be undone.`,
      site,
    );
    await removeSite(server, m, { volumes: o.volumes });
    ok(`removed ${site}${o.volumes ? " and its volumes" : c.dim(" (its volumes stay; --volumes deletes them)")}`);
  },
});

export const sitesEnv = defineCommand({
  name: "env",
  args: "[name] [KEY=VALUE...]",
  summary: "Show or change a site's .env; services whose environment changed are recreated.",
  options: { server: serverOpt, unset: { type: "string", short: "u", multiple: true, desc: "remove KEY" } },
  async run(pos, o) {
    const pairs = pos.filter((p) => p.includes("="));
    const [n] = pos.filter((p) => !p.includes("="));
    const { site, server } = target(n, o.server);
    const { env } = await requireSite(server, site, { deployed: "manage the .env of" });
    if (!pairs.length && !o.unset?.length) return void process.stdout.write(env || c.dim("(empty)\n"));
    const next = mergeEnv(env, parseEnvPairs(pairs), o.unset ?? []);
    const keys = [...pairs.map((p) => p.slice(0, p.indexOf("="))), ...(o.unset ?? []).map((k: string) => `-${k}`)];
    await composeCmd(
      server,
      site,
      "up -d --wait --quiet-pull",
      `u=$(saved .env)
record ${shq(`env ${site} ${keys.join(" ")}`)} "cd ${siteDir(site)} && $u && cd -P current && dc up -d"
${writeFileCmd(".env", next, "600")}`,
    );
    ok(`updated env of ${site}`);
  },
});
