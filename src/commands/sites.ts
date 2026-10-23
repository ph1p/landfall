import { defineCommand, serverOpt } from "../cmd";
import { loadProject, resolveServer } from "../config";
import {
  applySite,
  composeCmd,
  dockerLogs,
  listSites,
  mergeEnv,
  newestFirst,
  parseEnvPairs,
  removeSite,
  requireSite,
  siteDir,
} from "../remote";
import { runScript, shq, writeFileCmd } from "../ssh";
import { container } from "../templates";
import { ago, c, confirm, confirmRemoval, fail, ok, table } from "../ui";
import { logOpts } from "./traefik";

/** Site + server from args, falling back to ./srv.json. */
export function target(name: string | undefined, server: string | undefined) {
  const project = loadProject(process.cwd());
  const site = name ?? project?.name;
  if (!site) fail("which site? pass a name or run inside a folder with srv.json");
  return { site: site!, ...resolveServer(server ?? project?.server) };
}

const paint = (status: string) => (status.startsWith("Up") ? c.green(status) : c.red(status));

export const sitesList = defineCommand({
  name: "sites list",
  summary: "List deployed sites on a server.",
  options: { server: serverOpt, json: { type: "boolean", desc: "machine-readable output" } },
  async run(_, o) {
    const { name, server } = resolveServer(o.server ?? loadProject(process.cwd())?.server);
    const sites = await listSites(server);
    if (o.json) return console.log(JSON.stringify(sites, null, 2));
    if (!sites.length) return console.log(`no sites on ${name} yet — ${c.bold("lf deploy --domain example.com")}`);
    table([
      [c.dim("NAME"), c.dim("KIND"), c.dim("DOMAINS"), c.dim("RELEASE"), c.dim("UPDATED"), c.dim("STATUS")],
      ...sites.map(({ meta, status }) => [
        c.bold(meta.name),
        meta.kind,
        meta.domains.join(", "),
        meta.current,
        ago(meta.updatedAt),
        paint(status),
      ]),
    ]);
  },
});

export const sitesInfo = defineCommand({
  name: "sites info",
  args: "[name]",
  summary: "Show a site's details and release history.",
  options: { server: serverOpt },
  async run([n], o) {
    const { site, server } = target(n, o.server);
    const { meta } = await requireSite(server, site);
    const { stdout } = await runScript(server, `docker ps -a --filter name=^${container(site)}$ --format '{{.Status}}'`, {
      capture: true,
    });
    console.log(`${c.bold(meta.name)}  ${meta.kind}  ${paint(stdout.trim() || "not running")}`);
    for (const d of meta.domains) console.log(`  ${c.cyan("https://" + d)}`);
    console.log(c.dim(`  dir ${siteDir(site)}  port ${meta.port}${meta.spa ? "  spa" : ""}`));
    console.log(`\n${c.bold("Releases")}`);
    for (const r of newestFirst(meta)) {
      const mark = r.id === meta.current ? c.green("● ") : "  ";
      console.log(`${mark}${r.id}  ${c.dim(ago(r.at))}${r.image ? "  " + r.image : ""}`);
    }
  },
});

export const sitesLogs = defineCommand({
  name: "logs",
  args: "[name]",
  summary: "Show a site's container logs.",
  options: { server: serverOpt, ...logOpts },
  async run([n], o) {
    const { site, server } = target(n, o.server);
    return dockerLogs(server, container(site), o);
  },
});

/**
 * `undo`: the compose command that reverts it, journaled only when the container was `undoWhen`
 * (running or not) before; otherwise nothing changed and undoing it would flip a live site.
 */
const lifecycle = (verb: "restart" | "stop" | "start", compose: string, done: string, undo?: string, undoWhen?: boolean) =>
  defineCommand({
    name: verb,
    args: "[name]",
    summary: `${verb[0].toUpperCase() + verb.slice(1)} a site's container.`,
    options: { server: serverOpt },
    async run([n], o) {
      const { site, server } = target(n, o.server);
      await requireSite(server, site);
      const what = `record ${shq(`${verb} ${site}`)}`;
      const running = `[ "$(docker inspect -f '{{.State.Running}}' ${container(site)} 2>/dev/null)" = true ]`;
      const before = undo
        ? `if ${undoWhen ? "" : "! "}${running}; then ${what} ${shq(`cd ${siteDir(site)} && dc ${undo}`)}; else ${what}; fi`
        : what;
      await composeCmd(server, site, compose, before);
      ok(`${site} ${done}`);
    },
  });

export const sitesRestart = lifecycle("restart", "restart", "restarted");
export const sitesStop = lifecycle("stop", "stop", "stopped", "up -d", true);
export const sitesStart = lifecycle("start", "up -d", "started", "stop", false);

export const sitesRollback = defineCommand({
  name: "rollback",
  args: "[name]",
  summary: "Switch a site back to the previous release (or --to <release>).",
  options: { server: serverOpt, to: { type: "string", desc: "release id (see `lf sites info`)" } },
  async run([n], o) {
    const { site, server } = target(n, o.server);
    const { meta, proxy } = await requireSite(server, site);
    const sorted = newestFirst(meta);
    const idx = sorted.findIndex((r) => r.id === meta.current);
    const to = o.to ? sorted.find((r) => r.id === o.to) : sorted[idx + 1];
    if (!to) fail(o.to ? `no release ${o.to}` : `no release older than ${meta.current}`);
    const prev = structuredClone(meta);
    meta.current = to!.id;
    meta.updatedAt = new Date().toISOString();
    await applySite(server, meta, proxy, { keep: meta.releases.length, prev, what: `rollback ${site} from ${prev.current} to ${to!.id}` });
    ok(`${site} rolled back to ${c.bold(to!.id)}`);
  },
});

export const sitesRemove = defineCommand({
  name: "sites rm",
  args: "<name>",
  summary: "Stop a site and delete all its files and releases from the server.",
  options: { server: serverOpt },
  async run([n], o) {
    if (!n) fail("usage: lf sites rm <name>");
    const { site, server, name } = target(n, o.server);
    const { meta } = await requireSite(server, site);
    await confirmRemoval(`Delete ${site} (${meta.domains.join(", ")}) from ${name}? This cannot be undone.`, site);
    await removeSite(server, meta);
    ok(`removed ${site}`);
  },
});

export const sitesEnv = defineCommand({
  name: "env",
  args: "[name] [KEY=VALUE...]",
  summary: "Show or change environment variables of an image/dockerfile site; the container is recreated.",
  options: { server: serverOpt, unset: { type: "string", short: "u", multiple: true, desc: "remove KEY" } },
  async run(pos, o) {
    const pairs = pos.filter((p) => p.includes("="));
    const [n] = pos.filter((p) => !p.includes("="));
    const { site, server } = target(n, o.server);
    const { env } = await requireSite(server, site);
    if (!pairs.length && !o.unset?.length) return void process.stdout.write(env || c.dim("(empty)\n"));
    const next = mergeEnv(env, parseEnvPairs(pairs), o.unset ?? []);
    const keys = [...pairs.map((p) => p.slice(0, p.indexOf("="))), ...(o.unset ?? []).map((k: string) => `-${k}`)];
    await composeCmd(
      server,
      site,
      "up -d --force-recreate --quiet-pull",
      `u=$(saved .env)
record ${shq(`env ${site} ${keys.join(" ")}`)} "cd ${siteDir(site)} && $u && dc up -d --force-recreate"
${writeFileCmd(".env", next, "600")}`,
    );
    ok(`updated env of ${site}`);
  },
});
