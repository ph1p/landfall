import fs from "node:fs";
import { defineCommand, logOpts, paintStatus, serverOpt } from "../cmd";
import { checkInt, loadProject, projectServer, resolveServer, type Server } from "../config";
import { COMPOSE_FILES, currentRelease, isOld, OVERRIDE_FILES, projectName, routed, SECRET_NAME, SECRETS_DIR, secretUsers, SERVICE_PORT, siteDomains, siteMain, type SiteMeta } from "../compose";
import { bytes } from "../facts";
import { adoptSite, changeSite, composeCmd, envEntries, envView, liveConfig, maskedEnv, overview, mergeEnv, newestFirst, parseEnvPairs, readEnvFile, readSecrets, readSite, removeSite, requireSite, siteDir, siteLogs, validName } from "../remote";
import { shq, writeFileCmd } from "../ssh";
import { ago, c, confirm, confirmRemoval, fail, info, ok, table } from "../ui";
import { slug } from "../projects";
import { ctrAddress, type Ctr, findContainer, openTunnel, portScheme } from "../tunnel";

/** Site + server from args, falling back to ./.landfall.json. */
export function target(name: string | undefined, server: string | undefined) {
  const project = loadProject(process.cwd());
  const site = name ?? project?.name;
  if (!site) fail("which site? pass a name or run inside a folder with .landfall.json");
  return { site: site!, ...projectServer(server) };
}

export const sitesList = defineCommand({
  name: "sites list",
  summary: "List deployed sites on a server.",
  options: {
    server: serverOpt,
    json: { type: "boolean", desc: "machine-readable output" },
    others: { type: "boolean", desc: "with --json: {sites, others}, others = containers Traefik routes that landfall did not deploy" },
  },
  async run(_, o) {
    const { name, server } = projectServer(o.server);
    const view = await overview(server);
    const { sites, others } = view;
    // --others: the whole overview the web UI reads (proxy, dashboard, unrouted containers too).
    if (o.json) return console.log(JSON.stringify(o.others ? view : sites, null, 2));
    if (others.length) {
      console.log(c.dim(`not deployed by landfall, routed by Traefik (\`lf adopt <name>\` manages a Compose project):`));
      table([
        [c.dim("NAME"), c.dim("DOMAINS"), c.dim("FOLDER"), c.dim("STATUS")],
        ...others.map((e) => [e.name, e.domains.join(", "), e.dir ?? c.dim(e.containers.join(", ")), paintStatus(e.status)]),
      ]);
      if (sites.length) console.log();
    }
    if (!sites.length) return console.log(`no landfall sites on ${name} yet — ${c.bold("lf deploy --domain example.com")}`);
    table([
      [c.dim("NAME"), c.dim("KIND"), c.dim("DOMAINS"), c.dim("SERVICES"), c.dim("RELEASE"), c.dim("UPDATED"), c.dim("STATUS")],
      ...sites.map(({ meta, status, services, kind, domains }) => [
        c.bold(meta.name),
        kind,
        domains.join(", "),
        services.map((x) => x.service).join(", ") || c.dim("-"),
        meta.current || c.dim("-"),
        ago(meta.updatedAt),
        paintStatus(status),
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
    console.log(`${c.bold(meta.name)}  ${st!.kind}  ${paintStatus(st!.status)}`);
    for (const d of st!.domains) console.log(`  ${c.cyan("https://" + d)}`);
    console.log(c.dim(`  ${meta.adopted ?? siteDir(site) + "/current"}  (docker compose works there)`));
    if (st!.services.length) {
      console.log(`\n${c.bold("Services")}`);
      table(st!.services.map((x) => [`  ${x.service}`, c.dim(x.container), paintStatus(x.status)]));
    }
    // Sites of the old layout list no services per release.
    if (!meta.releases.length || st!.state === "old") return;
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
    await changeSite(server, meta, proxy, `rollback ${site} from ${meta.current} to ${to!.id}`, (m) => void (m.current = to!.id));
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

Named volumes (databases, uploads) and their backups stay, so deploying the site again finds its
data; --volumes deletes them too. An adopted site is stopped and forgotten; its folder stays.`,
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
  options: {
    server: serverOpt,
    unset: { type: "string", short: "u", multiple: true, desc: "remove KEY" },
    "env-file": { type: "string", desc: "also set the KEY=VALUE lines of this file; - reads stdin (keeps values out of ps)" },
    reveal: { type: "boolean", desc: "show the values (hidden by default)" },
    keys: { type: "boolean", desc: "list the variable names only" },
    json: { type: "boolean", desc: "machine-readable output (values only with --reveal)" },
    pull: { type: "string", desc: "write the site's .env to this local file (mode 600; - prints it)" },
  },
  async run(pos, o) {
    const [n] = pos.filter((p) => !p.includes("="));
    const set = { ...(o["env-file"] ? await readEnvFile(o["env-file"]) : {}), ...parseEnvPairs(pos.filter((p) => p.includes("="))) };
    const { site, server } = target(n, o.server);
    const { env } = await requireSite(server, site, { deployed: "manage the .env of" });
    if (!Object.keys(set).length && !o.unset?.length) {
      if (o.pull === "-") return void process.stdout.write(env);
      if (o.pull) {
        if (fs.existsSync(o.pull) && !(await confirm(`${o.pull} exists. Overwrite it?`, false))) fail(`${o.pull} exists: pick another file`);
        fs.writeFileSync(o.pull, env, { mode: 0o600 });
        fs.chmodSync(o.pull, 0o600);
        return ok(`wrote ${envEntries(env).length} variables of ${site} to ${o.pull}`);
      }
      if (o.json) return console.log(JSON.stringify(envView(env, o.reveal), null, 2));
      if (o.keys) return void process.stdout.write(envEntries(env).map((e) => e.key + "\n").join(""));
      if (!envEntries(env).length) return void process.stdout.write(c.dim("(empty)\n"));
      if (o.reveal) return void process.stdout.write(env);
      process.stdout.write(maskedEnv(env));
      return void process.stderr.write(c.dim("values hidden: --reveal shows them\n"));
    }
    const next = mergeEnv(env, set, o.unset ?? []);
    const keys = [...Object.keys(set), ...(o.unset ?? []).map((k: string) => `-${k}`)];
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

export const sitesSecret = defineCommand({
  name: "secret",
  args: "[name] [NAME=VALUE...]",
  summary: "List or change a site's secret files; services read them at /run/secrets/<NAME>.",
  options: {
    server: serverOpt,
    unset: { type: "string", short: "u", multiple: true, desc: "remove NAME" },
    file: { type: "string", multiple: true, desc: "NAME=path: the content of a local file (keys, certificates)" },
    "env-file": { type: "string", desc: "also set the NAME=VALUE lines of this file; - reads stdin (keeps values out of ps)" },
    json: { type: "boolean", desc: "machine-readable list (names and sizes, never values)" },
    force: { type: "boolean", desc: "remove a secret its compose.yaml still uses" },
  },
  async run(pos, o) {
    const [n] = pos.filter((p) => !p.includes("="));
    const set = {
      ...(o["env-file"] ? await readEnvFile(o["env-file"]) : {}),
      ...parseEnvPairs(pos.filter((p) => p.includes("="))),
      ...Object.fromEntries(
        Object.entries(parseEnvPairs(o.file ?? [])).map(([k, f]) => {
          if (!fs.existsSync(f)) fail(`--file ${k}=${f}: no such file`);
          return [k, fs.readFileSync(f, "utf8")];
        }),
      ),
    };
    const unset: string[] = o.unset ?? [];
    for (const k of [...Object.keys(set), ...unset]) if (!SECRET_NAME.test(k)) fail(`"${k}" cannot name a secret: use letters, digits, _ . -`);
    const { site, server } = target(n, o.server);
    const { meta, proxy } = await requireSite(server, site, { deployed: "manage the secrets of" });
    if (meta.kind === "static") fail(`${site} serves static files: it has no service to give a secret to`);
    const have = await readSecrets(server, site);

    if (!Object.keys(set).length && !unset.length) {
      if (o.json) return console.log(JSON.stringify({ secrets: have }, null, 2));
      if (!have.length) return void process.stdout.write(c.dim(`(none) set one with: lf secret ${site} NAME=value\n`));
      return table(have.map((h) => [h.key, c.dim(bytes(h.size)), c.dim(`/run/secrets/${h.key}`)]));
    }

    const missing = unset.filter((k) => !have.some((h) => h.key === k));
    if (missing.length) fail(`${site} has no secret ${missing.join(", ")}`);
    const config = await liveConfig(server, site);
    const generated = meta.kind === "dockerfile" || meta.kind === "image";
    const used = secretUsers(config, unset);
    if (!generated && used.length && !o.force) fail(`${used.join(", ")} still use ${unset.join(", ")}: take it out of compose.yaml first, or pass --force`);
    // Same file, new content: compose sees no change, so whoever mounts it starts again to read it.
    const recreate = secretUsers(config, Object.keys(set));
    const files = {
      ...Object.fromEntries(Object.entries(set).map(([k, v]) => [`${SECRETS_DIR}/${k}`, v])),
      ...Object.fromEntries(unset.map((k) => [`${SECRETS_DIR}/${k}`, null])),
    };
    const keys = [...Object.keys(set), ...unset.map((k) => `-${k}`)];
    await changeSite(
      server,
      meta,
      proxy,
      `secret ${site} ${keys.join(" ")}`,
      (m) => {
        if (!generated) return;
        const names = new Set([...(m.secrets ?? []), ...Object.keys(set)]);
        for (const k of unset) names.delete(k);
        m.secrets = [...names].sort();
        if (!m.secrets.length) delete m.secrets;
      },
      { files, recreate },
    );
    ok(`updated secrets of ${site}${recreate.length ? `, restarted ${recreate.join(", ")}` : ""}`);
    const unused = generated ? [] : Object.keys(set).filter((k) => !secretUsers(config, [k]).length);
    if (unused.length) {
      info("compose.yaml uses a secret once it names it, e.g.:");
      console.log(
        c.dim(
          [
            "services:",
            "  app:",
            `    secrets: [${unused.join(", ")}]`,
            "secrets:",
            ...unused.flatMap((k) => [`  ${k}:`, `    file: ./${SECRETS_DIR}/${k}`]),
          ].join("\n"),
        ),
      );
    }
  },
});

export const sitesTunnel = defineCommand({
  name: "tunnel",
  args: "[name] [service|private]",
  summary: `Open a site on localhost through an SSH tunnel, straight to its container.
A name from x-landfall.private (lf tunnel blog admin) opens that port.

Nothing changes on the server: no port is published and its domains stay as they are,
so it also works for a site with no domain. Traefik is bypassed: no HTTPS and no login.
Works for any Compose project or container on the server too, not only landfall's sites.
The tunnel stays open until Ctrl-C.`,
  options: {
    server: serverOpt,
    port: { type: "string", desc: "container port (default: the one Traefik routes to)" },
    local: { type: "string", short: "l", desc: "local port (default: the container port, else a free one)" },
    lan: { type: "boolean", desc: "listen on this machine's network too: open it from a phone on the same Wi-Fi" },
  },
  async run([n, svc], o) {
    const { site, server } = target(n, o.server);
    const { meta, proxy } = await readSite(server, site);
    if (!meta) return foreignTunnel(server, site, svc, proxy.network, o);
    if (isOld(meta)) fail(`${site} was deployed by an older landfall: run \`lf deploy\` in its project once to move it to a Compose project`);
    const release = currentRelease(meta);
    // A service by name, else a port named in x-landfall.private: lf tunnel blog admin.
    const named = svc ? release?.services.find((x) => x.name === svc) : undefined;
    const hidden = svc && !named ? release?.services.find((x) => x.private?.[svc] !== undefined) : undefined;
    const service = named ?? hidden ?? (svc ? undefined : (siteMain(meta) ?? release?.services.find(routed)));
    if (svc && release && !service) {
      const names = release.services.flatMap((x) => [x.name, ...Object.keys(x.private ?? {})]);
      fail(`${site} has no service or private port ${svc} (${names.join(", ")})`);
    }
    const name = service?.name ?? svc;
    if (!name) fail(`which service of ${site}? lf tunnel ${site} <service>`);
    const ctr = await findContainer(server, [`label=com.docker.compose.project=${projectName(meta)}`, `label=com.docker.compose.service=${name}`]);
    if (!ctr) fail(`${name} of ${site} is not running (lf start ${site})`);
    await tunnelTo(server, ctr!, proxy.network, o.port ?? (hidden ? hidden.private![svc!] : service?.port), { local: o.local, lan: o.lan, what: `${site}${svc ? ` (${svc})` : ""}` });
  },
});

/** A tunnel to a Compose project (or container) landfall did not deploy: a routed container of it, else any. */
async function foreignTunnel(server: Server, name: string, svc: string | undefined, network: string, o: { port?: string; local?: string; lan?: boolean }) {
  const project = [`label=com.docker.compose.project=${name}`, ...(svc ? [`label=com.docker.compose.service=${svc}`] : [])];
  const ctr =
    (await findContainer(server, [...project, "label=traefik.enable=true"])) ??
    (await findContainer(server, project)) ??
    (svc ? undefined : await findContainer(server, [`name=^/?${name}$`]));
  if (!ctr) fail(`no site, Compose project or container "${name}"${svc ? ` with a service ${svc}` : ""} running on ${server.host}. See \`lf sites list\``);
  const service = ctr!.labels["com.docker.compose.service"];
  await tunnelTo(server, ctr!, network, o.port, { local: o.local, lan: o.lan, what: `${name}${service && service !== name ? ` (${service})` : ""}` });
}

/** Tunnel to the container's port: the given one, else the one Traefik routes to. */
async function tunnelTo(server: Server, ctr: Ctr, network: string, port: string | number | undefined, o: { local?: string; lan?: boolean; what: string }) {
  // Else the port Traefik routes to, else the one its image exposes (a database's, say).
  const routedTo = Object.entries(ctr.labels).find(([k]) => SERVICE_PORT.test(k))?.[1];
  const found = port ?? routedTo ?? ctr.ports[0];
  if (found === undefined) fail(`which port of ${ctr.name}? pass --port`);
  const to = checkInt(String(found), "--port", 1, 65535);
  if (port === undefined && routedTo === undefined && ctr.ports.length > 1) info(c.dim(`${ctr.name} also exposes ${ctr.ports.slice(1).join(", ")}: pick one with --port`));
  const scheme = portScheme(to);
  await openTunnel(server, ctrAddress(ctr, network), to, {
    ...o,
    scheme,
    note: scheme === "http" ? `straight to the container: no HTTPS, no login, and the app sees Host: ${o.lan ? "localhost or this machine's address" : "localhost"}` : `straight to the container: point a ${scheme} client at it, with the container's own credentials`,
  });
}
