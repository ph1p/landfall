import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { basename, dirname, join, normalize, relative, resolve } from "node:path";
import { defineCommand, serverOpt } from "../cmd";
import { checkImage, checkInt, DEFAULT_KEEP, defaults, DOMAIN, expandDomain, isTunnelOnly, mainDomain, loadConfig, loadProject, PROJECT_FILE, resolveServer, saveProject, type ProjectConfig } from "../config";
import { analyze, generatedCompose, isOld, mainService, nginxConf, siteDomains, siteMain, type Release, type SiteKind, type SiteMeta } from "../compose";
import { applySite, discardRelease, mergeEnv, parseEnvPairs, prepareRelease, readEnvFile, readSite, siteDir, validName } from "../remote";
import { setUpState, upload } from "../ssh";
import { ask, c, confirm, fail, info, interactive, ok, report, step, warn } from "../ui";
import { pickIp, serverIps, sslipDomain } from "../facts";
import { appDockerfile, composeFile, detectApp, detectBuild, detectStaticDir, exposedPort, rememberProject, slug } from "../projects";
import { claimDomains } from "./access";
import { setupServer } from "./setup";
import { DEFAULT_USER, loginUser, newLogin } from "./traefik";


/** Per kind: where its files go in the release (none: nothing is uploaded), and whether it takes --port. */
const KINDS: Record<SiteKind, { files?: string; port?: boolean }> = {
  compose: { files: "" },
  dockerfile: { files: "", port: true },
  static: { files: "/public" },
  image: { port: true },
};

/** The site's htpasswd lines with `login` added, replacing that user's old one. */
function withLogin(auth: string[] | undefined, login?: string) {
  if (!login) return auth;
  const user = loginUser(login);
  return [...(auth ?? []).filter((l) => loginUser(l) !== user), login];
}

export const releaseId = (d = new Date()) => d.toISOString().replace(/[-:T]/g, "").slice(0, 14);

/** A release id not in `taken`: ids have one-second resolution, so a second deploy within it moves on a second. */
export function nextReleaseId(taken: string[], now = new Date()): string {
  let t = now.getTime();
  while (taken.includes(releaseId(new Date(t)))) t += 1000;
  return releaseId(new Date(t));
}

export const deploy = defineCommand({
  name: "deploy",
  args: "[dir]",
  summary: `Deploy a Compose project, app, static folder, Dockerfile or image with HTTPS.

Kinds:
  compose     the folder has a compose.yaml: its services run on the server as one
              project; x-landfall: { port: 3000 } on a service routes it through Traefik
  dockerfile  the folder has a Dockerfile: uploaded and built on the server
  app         landfall writes the Dockerfile, built on the server, for
              Node.js: a server-rendering framework (Next.js, Nuxt, TanStack Start,
                SvelteKit adapter-node, Astro Node, React Router, Remix, SolidStart)
                or a server (Express, Fastify, NestJS, ws, Socket.IO, any start script)
              Python (Django, FastAPI, Flask, …), Go, Java/Kotlin (Maven, Gradle:
              Spring Boot, Quarkus, …), Ruby (Rails, Rack), PHP (Laravel, Symfony),
              Rust, .NET, Elixir (Phoenix), Deno; --start overrides the command
              (a Procfile's web: process counts too)
  static      a folder of files (auto-detects dist/, build/, out/, public/ and the
              output of Vite, Astro, Next export, Nuxt generate, SvelteKit, Hugo, …)
  image       --image: run a prebuilt image (e.g. ghcr.io/me/app:1.2)

Every site is a Compose project on the server (/opt/landfall/sites/<name>/current),
so \`docker compose\` works there without landfall. Settings are saved to
./.landfall.json, so later deploys are just \`lf deploy\`.

A server landfall has not set up yet is set up first (\`lf setup\`), asking
before and logging in with the password once: \`lf deploy -s vps --host 1.2.3.4\`.`,
  options: {
    server: serverOpt,
    name: { type: "string", short: "n", desc: "site name (default: folder name)" },
    domain: { type: "string", short: "d", multiple: true, desc: "domain to serve (`blog` = blog.<main domain>, `@` = the main domain); another site's moves here" },
    "no-domain": { type: "boolean", desc: "serve no domain: reach it with lf tunnel until lf domains --add gives it one" },
    file: { type: "string", short: "f", desc: "compose file to deploy (default: compose.yaml)" },
    spa: { type: "boolean", desc: "single-page app: unknown paths serve index.html" },
    image: { type: "string", desc: "deploy a docker image instead of files" },
    port: { type: "string", desc: "container port (image/dockerfile; default: EXPOSE or 3000)" },
    static: { type: "boolean", desc: "force static even if a Dockerfile or compose file exists" },
    env: { type: "string", short: "e", multiple: true, desc: "set KEY=VALUE in the site's .env" },
    "env-file": { type: "string", desc: "merge a local .env file into the site's .env (- reads stdin)" },
    build: { type: "string", short: "b", desc: "build command: static sites run it locally first, apps in their image ('' for none)" },
    start: { type: "string", desc: "run as an app with this start command (e.g. 'node server.js'); landfall writes its Dockerfile" },
    keep: { type: "string", desc: `releases to keep for rollback (default: ${DEFAULT_KEEP}, lf config --keep)` },
    save: { type: "boolean", desc: "write .landfall.json (--no-save to skip)", default: true },
    host: { type: "string", desc: "IP or hostname of a new server: set it up as --server first" },
    user: { type: "string", short: "u", desc: "with --host: initial login user (default: root)" },
    "ssh-port": { type: "string", desc: "with --host: ssh port" },
    "password-stdin": { type: "boolean", desc: "setting up first: read the login password from stdin (also: $LANDFALL_PASSWORD)" },
    "auth-user": { type: "string", desc: "protect the site with this login (HTTP basic auth, as lf auth; default with --auth-password: admin)" },
    "auth-password": { type: "string", desc: "password of the login (asked when only --auth-user is given)" },
  },
  async run([dirArg], o) {
    const cwd = process.cwd();
    const project: Partial<ProjectConfig> = loadProject(cwd) ?? {};
    if (project.name) info(c.dim(`using ${PROJECT_FILE}`));

    let { name: serverName, server } = resolveServer(o.server ?? project.server);
    if (o.host && !o.server && !project.server && !loadConfig().default) fail("--host needs --server <name> for the new server");
    const state = o.host ? "bare" : await setUpState(server);
    if (state !== "ready") {
      const why = state === "bare" ? "is not set up by landfall yet" : "does not let landfall log in with a key";
      if (!o.host && !(interactive() && (await confirm(`${serverName} ${why}. Set it up now (lf setup)?`))))
        fail(`${serverName} ${why}: run \`lf setup ${serverName}\`${state === "no-login" ? " (--host <ip> for a new server)" : ""}, or deploy with --host`);
      await setupServer(serverName, { host: o.host, user: o.user, port: o["ssh-port"], "password-stdin": o["password-stdin"] });
      ({ server } = resolveServer(serverName));
      if ((await setUpState(server)) !== "ready") fail(`${serverName} is still not set up`);
    }
    const name = validName(o.name ?? project.name ?? slug(basename(cwd)));
    const keep = checkInt(o.keep ?? defaults().keep ?? DEFAULT_KEEP, "--keep", 1);
    // parseArgs reads --no-domain as the negation of --domain: a false among its values.
    const noDomain = !!o["no-domain"] || ((o.domain as unknown[] | undefined)?.includes(false) ?? false);
    const domainArgs: string[] | undefined = o.domain?.filter((d: unknown) => typeof d === "string");
    if (noDomain && domainArgs?.length) fail("--no-domain and --domain exclude each other");
    // Domains given up front fail on a typo before the build and the upload.
    const typos = (domainArgs?.length ? domainArgs : (project.domains ?? [])).map((d: string) => expandDomain(d, server)).filter((d: string) => !DOMAIN.test(d));
    if (typos.length) fail(`not a domain: ${typos.join(", ")}`);
    const authUser = o["auth-user"] ?? (o["auth-password"] ? DEFAULT_USER : undefined);
    const login = authUser ? await newLogin(authUser, o["auth-password"], "--auth-user") : undefined;

    if (o.start && o.static) fail("--start and --static exclude each other");
    const buildCmd: string | undefined = o.build ?? project.build;
    // --start turns a site saved as static into an app.
    const forceStatic = o.static ?? (o.start ? false : project.static);
    const imageArg: string | undefined = o.image ?? (forceStatic ? undefined : project.image);
    const image = imageArg && checkImage(imageArg);
    const root = resolve(cwd, dirArg ?? project.dir ?? ".");
    const named = image || forceStatic ? undefined : (o.file ?? composeFile(root, project));
    const compose = named && normalize(named);
    // The file becomes the release's compose.yaml, at the root of the upload: from a subfolder its relative
    // paths (build: ., ./data:/data) would point elsewhere.
    if (compose?.includes("/")) fail(`${named} is not in the folder deployed; deploy its folder instead: lf deploy ${dirname(join(relative(cwd, root) || ".", compose))} -f ${basename(compose)}`);
    if (compose && !fs.existsSync(join(root, compose))) fail(`no ${compose} in ${relative(cwd, root) || "."}`);
    const ownDockerfile = !compose && !image && !forceStatic && fs.existsSync(join(root, "Dockerfile"));
    if (ownDockerfile && o.start) warn("--start ignored: the Dockerfile says how the app starts");
    // Without a Dockerfile of its own: an app landfall writes one for.
    const app = compose || image || forceStatic || ownDockerfile ? undefined : detectApp(root, o.start ?? project.start);
    if (buildCmd && !app) {
      step(`building locally: ${buildCmd}`);
      const r = spawnSync(buildCmd, { shell: true, stdio: "inherit" });
      if (r.status !== 0) fail(`build failed (exit ${r.status})`);
    }
    const detected = detectBuild(cwd);
    const dir = compose || image || ownDockerfile || app ? root : resolve(cwd, dirArg ?? project.dir ?? detectStaticDir(cwd, detected));
    const kind: SiteKind = compose ? "compose" : image ? "image" : ownDockerfile || app ? "dockerfile" : "static";
    const tool = kind === "static" && !dirArg && !project.dir ? detected.tool : undefined;
    if (tool) info(c.dim(`publishing ${relative(cwd, dir)}: where ${tool} builds the site (another folder: lf deploy <dir>)`));
    if (kind === "static" && !fs.existsSync(join(dir, "index.html"))) {
      warn(`no index.html in ${relative(cwd, dir) || "."}${tool && !buildCmd ? `: build first, or let deploy do it (--build "${detected.build}")` : ""}`);
    }
    const port = KINDS[kind].port
      ? checkInt(o.port ?? project.port ?? (ownDockerfile ? exposedPort(join(dir, "Dockerfile")) : app?.port) ?? 3000, "--port", 1, 65535)
      : undefined;
    const appBuild = app && (buildCmd ?? app.build);
    if (app) info(c.dim(`${app.runtime} app${app.tool && app.tool !== app.runtime ? ` (${app.tool})` : ""}: built on the server${appBuild ? ` with ${appBuild}` : ""}, started with ${app.start} on port ${port}`));
    const spa = kind === "static" && !!(o.spa ?? project.spa);

    step(`deploying ${c.bold(name)} (${app ? app.runtime : kind}) to ${c.bold(serverName)}`);
    const site = await readSite(server, name);
    const { env: prevEnv, proxy, exists } = site;
    const old = site.meta && isOld(site.meta) ? site.meta : undefined;
    const prev = old ? undefined : site.meta;
    if (prev?.adopted) fail(`${name} is adopted (${prev.adopted}): deploy it there with docker compose, or pick another --name`);
    if (old) warn(`${name} was deployed by an older landfall: this moves it to a Compose project (its old releases go, so it cannot be undone)`);
    else if (prev && prev.kind !== kind) info(c.dim(`site was ${prev.kind}, now ${kind}`));

    let env: string | undefined;
    if (o.env?.length || o["env-file"]) {
      env = prevEnv;
      if (o["env-file"]) env = mergeEnv(env, await readEnvFile(o["env-file"]));
      if (o.env?.length) env = mergeEnv(env, parseEnvPairs(o.env));
    }
    // What the app needs from its .env: said until the .env has it (or, without a variable, on the first deploy).
    if (app?.note && (app.secret ? !new RegExp(`^${app.secret}=.`, "m").test(env ?? prevEnv ?? "") : !prev)) warn(app.note);

    // A takeover removes the old layout's release folders: the new id must not be one of them.
    const id = nextReleaseId((site.meta?.releases ?? []).map((r) => r.id));
    const releaseDir = `${siteDir(name)}/releases/${id}`;
    const generated: Record<string, string> =
      kind === "compose" ? {} : { "compose.yaml": generatedCompose(kind, { port, image, app: app?.runtime }), ...(kind === "static" && { "nginx.conf": nginxConf(spa) }) };
    if (app) {
      generated.Dockerfile = appDockerfile(root, app, { build: appBuild, start: app.start, port: port! });
      if (!fs.existsSync(join(root, ".dockerignore"))) generated[".dockerignore"] = app.ignore.join("\n") + "\n";
    }

    // Anything that fails from the upload until the site switches takes the half-made release away again.
    let release: Release, domains: string[], move: () => Promise<void>;
    try {
      const files = KINDS[kind].files;
      if (files !== undefined) {
        step(`uploading ${relative(cwd, dir) || "."}`);
        // A redeploy starts from the live release's files and sends only what changed.
        const seedRelease = prev?.kind === kind ? prev.current : undefined;
        const sent = await upload(server, dir, releaseDir + files, seedRelease && `${siteDir(name)}/current${files}`, app ? app.ignore : []);
        if (sent === "rsync") info(c.dim(`sent only what changed since release ${seedRelease}`));
        else if (sent === "tar:no-local-rsync") info(c.dim("sent every file: install rsync on this machine to send only what changed"));
        else if (sent === "tar:no-server-rsync") info(c.dim(`sent every file: ${serverName} has no rsync, \`lf setup ${serverName}\` installs it to send only what changed`));
      }
      const prepared = await prepareRelease(server, name, id, { file: compose, generated, env });
      const a = analyze(prepared.config, prepared.dir, (d) => expandDomain(d, server));
      for (const w of a.warnings) warn(w);
      if (a.errors.length) fail(`${compose ?? "compose.yaml"} cannot be deployed:\n${a.errors.map((e) => `  - ${e}`).join("\n")}`);
      release = { id, at: new Date().toISOString(), services: a.services };
      const fixed = a.services.flatMap((s) => s.domains ?? []);

      // Domains of the service that serves the site's own: -d, .landfall.json, the server's, or asked.
      // Those from .landfall.json never move from another site: that takes a -d.
      domains = [];
      let fromFile = false;
      if (mainService(release)) {
        fromFile = !domainArgs?.length && !!project.domains?.length;
        domains = noDomain ? [] : ([domainArgs, project.domains, prev?.domains, old?.domains].find((l) => l?.length) ?? []);
        // Unrouted until -d: deployed with --no-domain, or a site whose domains were all taken off (lf domains --rm).
        let unrouted = noDomain || (!domains.length && ((!!prev && !!siteMain(prev) && !prev.domains.length) || project.domains?.length === 0));
        // The server's default: new sites stay off the internet until -d.
        if (!domains.length && !unrouted && isTunnelOnly(server)) unrouted = true;
        if (!domains.length && !unrouted) {
          // <name>.<main domain>, or with no DNS needed: <name>.<ip>.sslip.io resolves to the server.
          const main = mainDomain(server);
          const ip = main ? undefined : pickIp(await serverIps(server));
          const auto = main ? `${name}.${main}` : ip ? sslipDomain(name, ip) : undefined;
          const answer = await ask("Domain(s) to serve (comma separated; none: reach it by tunnel only):", auto);
          unrouted = answer === "none";
          if (!unrouted) domains = answer.split(/[\s,]+/).filter(Boolean);
        }
        domains = [...new Set(domains.map((d) => expandDomain(d, server)))];
        const bad = domains.filter((d) => !DOMAIN.test(d));
        const clash = domains.filter((d) => fixed.includes(d));
        if (!domains.length && !unrouted) fail("at least one --domain is required");
        if (unrouted) info(c.dim(`${name} serves no domain: reach it with lf tunnel ${name}, give it one with lf domains ${name} --add <domain>`));
        if (bad.length) fail(`not a domain: ${bad.join(", ")}`);
        if (clash.length) fail(`${clash.join(", ")} is already routed by x-landfall.domains`);
      } else if (domainArgs?.length) warn(`-d ignored: every routed service of ${name} names its own x-landfall.domains`);

      move = await claimDomains(server, serverName, name, [...domains, ...fixed], proxy, fromFile ? `${PROJECT_FILE} lists it; deploy with -d to move it` : undefined);
    } catch (e) {
      await discardRelease(server, name, id).catch(() => {});
      throw e;
    }

    const now = new Date().toISOString();
    const meta: SiteMeta = {
      v: 2,
      name,
      kind,
      domains,
      auth: withLogin(prev?.auth ?? old?.auth, login),
      current: id,
      releases: [...(prev?.releases ?? []), release],
      createdAt: prev?.createdAt ?? old?.createdAt ?? now,
      updatedAt: now,
    };
    await move();
    await applySite(server, meta, proxy, {
      env,
      build: true,
      pull: true,
      keep,
      prev,
      takeover: old,
      existed: !prev && !old && exists,
      what: `deploy ${name} release ${id}${prev ? "" : ` (new site, ${siteDomains(meta).join(", ")})`}`,
    });

    const all = siteDomains(meta);
    if (o.save) {
      const saved: ProjectConfig = { name, server: serverName, domains };
      if (kind === "image") Object.assign(saved, { image, port });
      else {
        const rel = relative(cwd, dir) || ".";
        if (kind !== "static") {
          if (rel !== ".") saved.dir = rel;
          if (kind === "compose" && (o.file || project.compose)) saved.compose = compose;
        } else if (rel !== detectStaticDir(cwd, detected)) saved.dir = rel;
        if (kind === "dockerfile") saved.port = port;
        if (app && (o.start || project.start)) saved.start = app.start;
        if (spa) saved.spa = true;
        if (forceStatic && kind === "static") saved.static = true;
      }
      if (buildCmd || (app && buildCmd === "")) saved.build = buildCmd;
      saveProject(cwd, saved);
      rememberProject({ path: cwd, name, server: serverName, domains: all, kind });
    }

    ok(`release ${c.bold(id)} live`);
    for (const d of all) console.log(`  ${c.cyan(`https://${d}`)}`);
    if (all[0]) report({ url: `https://${all[0]}` });
    if (all[0]) await checkLive(all[0]);
  },
});

/** Turn dotenv text into KEY=VALUE pairs, dropping comments and blanks. */


async function checkLive(domain: string) {
  try {
    const res = await fetch(`https://${domain}`, { signal: AbortSignal.timeout(15000), redirect: "manual" });
    if (res.status < 400) ok(`https://${domain} responded ${res.status}`);
    else warn(`https://${domain} responded ${res.status}`);
  } catch (e: any) {
    const msg = e?.cause?.code ?? e?.code ?? e?.message ?? String(e);
    warn(`could not reach https://${domain} yet (${msg}). DNS or the first certificate may still be pending.`);
  }
}
