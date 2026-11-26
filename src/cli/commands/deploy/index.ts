import fs from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { defineCommand, serverOpt } from "../../cmd";
import { deploySource, pickEnvironmentForRef, type Connect } from "../../../core/deploy/source";
import {
  activeEnvironment,
  checkInt,
  DEFAULT_KEEP,
  defaults,
  DOMAIN,
  envSiteName,
  expandDomain,
  isTunnelOnly,
  mainDomain,
  loadConfig,
  loadProject,
  PROJECT_FILE,
  projectSources,
  resolveServer,
  saveProject,
  type ProjectConfig,
} from "../../../core/lib/config";
import { analyze, WEB_PORTS } from "../../../core/site/analyze";
import { builtImage, currentRelease, type Release, type SiteMeta } from "../../../core/site/meta";
import { askable, missingVars, wantedVars } from "../../../core/site/env-vars";
import { folderVolumes } from "../../../core/site/compose-config";
import { fixedDomains, subDomains, routed, mainService, siteDomains, siteMain } from "../../../core/site/routing";
import { besideCompose, besideName, generatedCompose, nginxConf } from "../../../core/site/generate";
import { applySite } from "../../../core/site/apply";
import { builtImages, discardRelease, prepareRelease, imagePorts } from "../../../core/site/releases";
import { lockSite, readSite, siteDir, validName } from "../../../core/site/site";
import { dotenvLines, localEnv, mergeEnv, parseEnvPairs, readEnvFile } from "../../../core/site/dotenv";
import { buildLocally, buildTmp, localBuilds, localImage, localImages, sendImage } from "../../../core/deploy/buildlocal";
import { uploadList, uploadSize } from "../../../core/deploy/ignore";
import { journal, setUpState } from "../../../core/ssh/ssh";
import { ask, askSecret, c, confirm, fail, info, interactive, ok, report, step, warn } from "../../../core/lib/term";
import { pickIp, serverIps, sslipDomain } from "../../../core/server/facts";
import { bytes, plural } from "../../../core/lib/format";
import { detectStaticDir } from "../../../core/deploy/projects";
import { rememberProject, withRedirects } from "../../../core/deploy/remembered";
import { slug } from "../../../core/lib/slug";
import { deployRedirects } from "../../../core/site/domain-plan";
import { claimDomains } from "../../../core/site/claim";
import { setupServer } from "../setup";
import { onStop } from "../../../core/lib/job";
import { VERSION } from "../../../core/lib/version";
import { offerSeed } from "../volume";
import { DEFAULT_USER, loginUser, newLogin } from "../../../core/traefik/traefik";
import {
  failedHook,
  hookVars,
  readHooks,
  refuseStaticServerHooks,
  releaseHooks,
  runLocalHook,
  serverCall,
  SKIP_OPTIONS,
  skipper,
} from "../../../core/site/hooks";
import { KINDS, planDeploy } from "./plan";
import { checkLive, showRoutes } from "./output";
import { nextReleaseId } from "./release";

/** The first upload of a site above this size asks first. */
const BIG_UPLOAD = 100 * 1024 * 1024;

/** The site's htpasswd lines with `login` added, replacing that user's old one. */
function withLogin(auth: string[] | undefined, login?: string) {
  if (!login) return auth;
  const user = loginUser(login);
  return [...(auth ?? []).filter((l) => loginUser(l) !== user), login];
}

/** One of this machine's Docker images, picked in a terminal. */
async function pickLocalImage(): Promise<string> {
  const list = localImages();
  if (!list.length) fail("this machine's Docker has no tagged image to send (docker build -t <name> . makes one)");
  if (!interactive()) fail("--send-image needs --image <name:tag> without a terminal (docker image ls lists them)");
  list.slice(0, 30).forEach((i, n) => process.stderr.write(`  ${c.dim(String(n + 1).padStart(2))} ${i.ref} ${c.dim(`${i.size}, ${i.created}`)}\n`));
  const answer = await ask("Image to send (number or name:tag):", "1");
  return list[+answer - 1]?.ref ?? answer;
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
              Node.js or Bun: a server-rendering framework (Next.js, also standalone,
                Nuxt, TanStack Start, SvelteKit adapter-node/-bun, Astro Node,
                React Router, Remix, SolidStart, Analog, Qwik City, AdonisJS)
                or a server (Express, Fastify, NestJS, ws, Socket.IO, any start script)
              Python (Django, FastAPI, Flask, …), Go, Java/Kotlin (Maven, Gradle:
              Spring Boot, Quarkus, …), Ruby (Rails, Rack), PHP (Laravel, Symfony),
              Rust, .NET, Elixir (Phoenix), Deno (Fresh, Hono, Oak);
              --start overrides the command
              (a Procfile's web: process counts too)
              --volume keeps a folder across deploys, --worker runs it without a domain
  static      a folder of files (auto-detects dist/, build/, out/, public/ and the
              output of Vite, Astro, Next export, Nuxt generate, SvelteKit, VitePress,
              Docusaurus, Hugo, Zola, MkDocs, mdBook, Pelican, Jekyll, Lume, …)
  image       --image: run a prebuilt image (e.g. ghcr.io/me/app:1.2)

Every site is a Compose project on the server (/opt/landfall/sites/<name>/current),
so \`docker compose\` works there without landfall. Settings are saved to
./.landfall.json, so later deploys are just \`lf deploy\`.

-E staging deploys the project's staging environment as its own site (<name>-staging);
a compose.staging.yaml next to compose.yaml is merged in for it.

A server landfall has not set up yet is set up first (\`lf setup\`), asking
before and logging in with the password once: \`lf deploy -s vps --host 1.2.3.4\`.

package.json's landfall.hooks runs npm scripts along the way: prebuild, postbuild and
predeploy here, release (once, in a one-off container of the new release), verify and
postdeploy on the server; onfailure here when anything fails. --skip-hook <name> skips one.`,
  options: {
    server: serverOpt,
    name: { type: "string", short: "n", desc: "site name (default: folder name)" },
    domain: {
      type: "string",
      short: "d",
      multiple: true,
      desc: "domain to serve (`blog` = blog.<main domain>, `@` = the main domain); another site's moves here",
      no: "serve no domain: reach it with lf tunnel until lf domains --add gives it one",
    },
    redirect: {
      type: "string",
      multiple: true,
      desc: "redirect a host to the site's first domain (`www` = www.<first domain>); replaces the saved redirects",
      no: "drop the site's redirects",
    },
    file: { type: "string", short: "f", desc: "compose file to deploy (default: compose.yaml)" },
    spa: { type: "boolean", desc: "single-page app: unknown paths serve index.html" },
    image: { type: "string", desc: "deploy a docker image instead of files" },
    "send-image": {
      type: "boolean",
      desc: "--image: send it from this machine's Docker, no registry (saved; --no-send-image pulls it again). Alone: pick one of the local images",
    },
    port: { type: "string", desc: "container port (image/dockerfile; default: EXPOSE or 3000)" },
    static: { type: "boolean", desc: "force static even if a Dockerfile or compose file exists" },
    env: { type: "string", short: "e", multiple: true, desc: "set KEY=VALUE in the site's .env" },
    dotenv: { type: "string", desc: "merge a local .env file into the site's .env (- reads stdin)" },
    "fill-volumes": { type: "boolean", desc: "fill each empty volume from the project's folder named like it that the upload leaves out" },
    "local-env": { type: "boolean", desc: "what the project asks for and the site's .env lacks: take it from the project's local .env" },
    build: { type: "string", short: "b", desc: "build command: static sites run it locally first, apps in their image ('' for none)" },
    "build-local": {
      type: "boolean",
      desc: "build the images on this machine (with Docker) and send them, not on the server (saved; --no-build-local builds there again)",
    },
    start: { type: "string", desc: "run as an app with this start command (e.g. 'node server.js'); landfall writes its Dockerfile" },
    volume: {
      type: "string",
      multiple: true,
      desc: "app/dockerfile/image: a folder in the container that outlives deploys, e.g. /app/data (a named volume; '' for none)",
    },
    worker: { type: "boolean", desc: "app/dockerfile/image: run without a port or a domain (a bot, a queue consumer; --no-worker serves one again)" },
    gitignore: {
      type: "boolean",
      desc: "also leave out what .gitignore ignores (saved; --no-gitignore uploads it again). exclude and include in .landfall.json always apply",
    },
    keep: { type: "string", desc: `releases to keep for rollback (default: ${DEFAULT_KEEP}, lf config --keep)` },
    save: { type: "boolean", desc: "write .landfall.json (--no-save to skip)", default: true },
    host: { type: "string", desc: "IP or hostname of a new server: set it up as --server first" },
    user: { type: "string", short: "u", desc: "with --host: initial login user (default: root)" },
    "ssh-port": { type: "string", desc: "with --host: ssh port" },
    "password-stdin": { type: "boolean", desc: "setting up first: read the login password from stdin (also: $LANDFALL_PASSWORD)" },
    "auth-user": { type: "string", desc: "protect the site with this login (HTTP basic auth, as lf auth; default with --auth-password: admin)" },
    "auth-password": { type: "string", desc: "password of the login (asked when only --auth-user is given)" },
    ref: { type: "string", desc: "deploy a branch, tag or commit: a clean export of it, without uncommitted or ignored files" },
    tag: { type: "string", desc: "deploy a tag; latest = the newest one the environment's git rule allows" },
    git: { type: "string", desc: "deploy <url>[#ref]: the server fetches the repository (lf git key gives it a deploy key)" },
    "for-ref": { type: "string", desc: "CI: deploy this ref (refs/heads/main, refs/tags/v1.2.0) to the environment whose git rule matches it" },
    force: { type: "boolean", desc: "deploy what the environment's git rule (lf git track) does not allow" },
    ...SKIP_OPTIONS,
  },
  async run([dirArg], o) {
    const cwd = process.cwd();
    // Read before any ssh: one with the inherited stdin would swallow `--dotenv -`.
    const dotenv = o.dotenv ? await readEnvFile(o.dotenv) : undefined;
    if (o["for-ref"]) pickEnvironmentForRef(cwd, o["for-ref"]);
    let project: Partial<ProjectConfig> = loadProject(cwd) ?? {};
    const environment = activeEnvironment();
    // A typo in package.json's hooks or --skip-hook fails before anything runs.
    const skip = skipper(o);
    // The server, connected (and set up) once: --git fetches there before anything is planned.
    let conn: Awaited<ReturnType<Connect>> | undefined;
    const connect: Connect = async () => {
      if (conn) return conn;
      let { name: serverName, server } = resolveServer(o.server ?? project.server);
      // A cloned repo's .landfall.json could name any host: never send it the source unasked.
      if (
        !o.server &&
        !o.host &&
        project.server &&
        !loadConfig().servers[project.server] &&
        !(await confirm(`${PROJECT_FILE} deploys to ${project.server}, which is not one of your servers (lf server ls). Send the project there?`, false))
      )
        fail("cancelled");
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
      return (conn = { server, serverName });
    };
    // The working tree, a clean export of a commit (--ref, --tag, --for-ref), or a commit the server fetches (--git).
    const source = await deploySource(cwd, project, environment, o, connect);
    // --git with no .landfall.json here: the commit's settings.
    if (source.project) project = source.project;
    const src = source.dir;
    const hooks = readHooks([resolve(src, dirArg ?? project.dir ?? "."), src], { ...project, dir: src });
    if (hooks && (["prebuild", "postbuild", "predeploy"] as const).some((h) => hooks.run[h])) source.prepare();
    if (project.name && !source.project) info(c.dim(`using ${projectSources(cwd).join(" and ")}${environment ? `, environment ${environment}` : ""}`));

    const { server, serverName } = await connect();
    const name = validName(o.name ?? project.name ?? envSiteName(slug(source.name ?? basename(cwd))));
    const keep = checkInt(o.keep ?? defaults().keep ?? DEFAULT_KEEP, "--keep", 1);
    const domainArgs: string[] | undefined = o.domain;
    const redirectArgs: string[] | undefined = o.redirect;
    const noDomain = !!o["no-domain"];
    const noRedirect = !!o["no-redirect"];
    // Domains given up front fail on a typo before the build and the upload.
    const typos = (domainArgs?.length ? domainArgs : (project.domains ?? [])).map((d) => expandDomain(d, server)).filter((d) => !DOMAIN.test(d));
    if (typos.length) fail(`not a domain: ${typos.join(", ")}`);
    const authUser = o["auth-user"] ?? (o["auth-password"] ? DEFAULT_USER : undefined);
    const login = authUser ? await newLogin(authUser, o["auth-password"], "--auth-user") : undefined;

    const git = source.git;
    // The app's version is its commit, as on the server; its tag is LANDFALL_TAG (landfall's own version is Release.landfall).
    const vars = { ...hookVars(name), LANDFALL_SERVER: serverName, LANDFALL_VERSION: git?.commit, LANDFALL_TAG: git?.tag };
    // Where it got to: what onfailure is told failed, unless a hook did.
    let stage = "prebuild";
    try {
      runLocalHook(hooks, "prebuild", vars, skip);
      stage = "build";

      // --send-image without an image: pick one of this machine's.
      if (o["send-image"] && !o.image && !project.image) o.image = await pickLocalImage();
      let { buildCmd, forceStatic, image, compose, beside, layered, app, detected, dir, kind, worker, volumes, port, appBuild, spa, root } = planDeploy(
        src,
        dirArg,
        o,
        project,
        environment,
        source.prepare,
      );
      // A static site runs in nginx, without package.json: its server hooks are refused before anything is sent.
      refuseStaticServerHooks(hooks, kind);
      stage = "postbuild";
      runLocalHook(hooks, "postbuild", vars, skip);
      stage = "predeploy";
      runLocalHook(hooks, "predeploy", vars, skip);
      stage = "deploy";

      // An image only this machine's Docker has (built here, never pushed) is sent, not pulled.
      const here = kind === "image" ? localImage(image!) : undefined;
      const send = kind === "image" && !!(o["send-image"] ?? project.sendImage ?? (here && !here.pushed));
      if (send && !here) fail(`${image} is not in this machine's Docker (docker image ls lists what is; --no-send-image pulls it on the server)`);
      if (send && o["send-image"] === undefined && project.sendImage === undefined)
        info(c.dim(`${image} is only in this machine's Docker: sending it to ${serverName} (--no-send-image pulls it there instead)`));
      // Read from the image on every deploy, never saved: a new tag may expose another port.
      const fromImage = kind === "image" && port === undefined && !worker;
      if (fromImage) {
        step(`reading the ports ${image} exposes`);
        const exposed = send ? here!.ports : await imagePorts(server, image!);
        port = exposed.find((p) => WEB_PORTS.has(p)) ?? exposed[0];
        if (port === undefined) {
          worker = true;
          warn(`${image} exposes no port: it runs as a worker, without a domain (--port <port> routes it)`);
        } else info(c.dim(`routing to port ${port}${exposed.length > 1 ? ` of ${exposed.join(", ")}` : ""} (EXPOSE in the image; --port picks another)`));
      }
      step(`deploying ${c.bold(name)} (${app ? app.name : kind}) to ${c.bold(serverName)}`);
      // One deploy of a site at a time; its release id from the server's clock.
      const lock = await lockSite(server, name);
      try {
        const site = await readSite(server, name);
        const { meta: prev, env: prevEnv, proxy, exists } = site;
        if (prev?.adopted) fail(`${name} is adopted (${prev.adopted}): deploy it there with docker compose, or pick another --name`);
        if (prev && prev.kind !== kind) info(c.dim(`site was ${prev.kind}, now ${kind}`));

        let env: string | undefined;
        if (o.env?.length || dotenv) {
          env = prevEnv;
          if (dotenv) env = mergeEnv(env, dotenv);
          if (o.env?.length) env = mergeEnv(env, parseEnvPairs(o.env, true));
        }
        // What the project wants in its .env (compose's ${NAME:?}, an example .env's keys): asked for here,
        // or said before the upload rather than by compose or the app after it. A static site has no .env.
        if (kind !== "static") {
          let missing = missingVars(
            wantedVars(
              root,
              [compose, beside?.file, layered].filter((f): f is string => !!f),
              { app: !!beside },
            ),
            parseEnvPairs(dotenvLines(env ?? prevEnv ?? "")),
          );
          // The local .env is never sent as a whole: only what the project asks for and the server lacks, and only when told.
          const local = localEnv(root);
          if (o["local-env"]) {
            const from = missing.filter((v) => local[v.name]);
            if (from.length) {
              env = mergeEnv(env ?? prevEnv ?? "", Object.fromEntries(from.map((v) => [v.name, local[v.name]])));
              info(c.dim(`from your local .env: ${from.map((v) => v.name).join(", ")}`));
              missing = missing.filter((v) => !from.includes(v));
            }
          }
          const fix = (vars: typeof missing) =>
            `deploy with ${vars.map((v) => `-e ${v.name}=…`).join(" ")} (or --dotenv${vars.some((v) => local[v.name]) ? ", --local-env" : ""})${exists ? `, or set it first: lf env -s ${serverName} ${name} ${vars[0].name}=…` : ""}`;
          const named = (vars: typeof missing) =>
            [...Map.groupBy(vars, (v) => v.from)].map(([f, vs]) => `${vs.map((v) => v.name).join(", ")} (${f})`).join(", ");
          const needed = missing.filter((v) => !v.optional);
          if (needed.length && !interactive()) fail(`${name}'s .env on ${serverName} needs ${named(needed)}: ${fix(needed)}`);
          // An example's empty keys are asked for once (an empty answer keeps them asked no more); with -y only said.
          const asked = missing.filter((v) => askable(v) && (!v.optional || interactive()));
          const set: Record<string, string> = {};
          for (const v of asked) {
            const hint = local[v.name] ? " (empty: your local .env's)" : v.optional ? " (empty: none)" : "";
            set[v.name] = (await askSecret(`${v.name} for ${name}'s .env${v.message ? ` (${v.message})` : ""}${hint && c.dim(hint)}:`)) || local[v.name] || "";
            if (v.strict && !set[v.name]) fail(`${v.from} needs a value for ${v.name}`);
          }
          if (asked.length) env = mergeEnv(env ?? prevEnv ?? "", set);
          const unset = missing.filter((v) => !asked.includes(v));
          if (unset.length) info(c.dim(`not in ${name}'s .env: ${named(unset)}; ${fix(unset)}`));
        }
        // What the app needs from its .env: said until the .env has it (or, without a variable, on the first deploy).
        if (app?.note && (app.secret ? !parseEnvPairs(dotenvLines(env ?? prevEnv ?? ""))[app.secret] : !prev)) warn(app.note);

        const id = nextReleaseId(
          (prev?.releases ?? []).map((r) => r.id),
          lock.now,
        );
        const releaseDir = `${siteDir(name)}/releases/${id}`;
        // A sent image runs under a tag of this release: a redeploy of the same local tag replaces it, old releases' go with them.
        const appService = beside ? besideName(beside.services) : "app";
        const sentImage = builtImage(name, appService, id);
        const withBeside = (text: string) => (beside ? besideCompose(fs.readFileSync(join(root, beside.file), "utf8"), beside.file, text) : text);
        const generated: Record<string, string> =
          kind === "compose"
            ? {}
            : {
                "compose.yaml": withBeside(
                  generatedCompose(kind, { port: worker ? undefined : port, image: send ? sentImage : image, sent: send, app: app?.name, volumes }),
                ),
                ...(kind === "static" && { "nginx.conf": nginxConf(spa) }),
              };
        if (app) {
          generated.Dockerfile = app.dockerfile({ build: appBuild, start: app.start, port: port! });
          if (!fs.existsSync(join(root, ".dockerignore"))) generated[".dockerignore"] = app.ignore.join("\n") + "\n";
        }

        const files = KINDS[kind].files;
        const gitignore = !!(o.gitignore ?? project.gitignore);
        const buildLocal = !!(o["build-local"] ?? project.buildLocal);
        const list = files === undefined ? [] : uploadList(dir, { exclude: app?.ignore, project: src, gitignore, rules: project });
        // The first upload of a site says what it sends: a folder of data or a build cache is easy to miss.
        if (files !== undefined && !prev) {
          const { total, files: n, largest } = uploadSize(list);
          info(c.dim(`upload: ${n} files, ${bytes(total)}${largest.length ? ` (largest: ${largest.map(([p, b]) => `${p} ${bytes(b)}`).join(", ")})` : ""}`));
          const hint = `exclude in .landfall.json leaves files out${gitignore ? "" : ", --gitignore what .gitignore ignores"}`;
          if (total > BIG_UPLOAD && !(await confirm(`That is a big upload: ${hint}. Upload it?`, false))) fail("not deployed");
        }

        // Anything that fails from the upload until the site switches takes the half-made release away again.
        let release: Release,
          domains: string[],
          redirects: string[] = [],
          move: () => Promise<void>;
        // Images built here and (maybe partly) sent: a failed deploy takes them off the server again.
        let sent: string[] = [];
        let vols: string[] = [];
        // Stopped midway: the half-made release goes like a failed one.
        const offDiscard = onStop(() => discardRelease(server, name, id, [...sent, ...(release ? builtImages(name, release) : [])]));
        try {
          if (files !== undefined) {
            const size = uploadSize(list);
            const what = `${relative(src, dir) || "."} (${plural(size.files, "file")}, ${bytes(size.total)})`;
            step(source.fromServer() ? `unpacking ${what} from ${serverName}'s copy of ${git!.commit}` : `uploading ${what}`);
            // A redeploy starts from the live release's files and sends only what changed.
            const seedRelease = prev?.kind === kind ? prev.current : undefined;
            const uploaded = await source.send(server, dir, releaseDir + files, list, seedRelease && `${siteDir(name)}/current${files}`);
            if (uploaded === "rsync") info(c.dim(`uploaded only what changed since release ${seedRelease}`));
            else if (uploaded === "tar:no-local-rsync") info(c.dim("uploaded every file: install rsync on this machine to send only what changed"));
            else if (uploaded === "tar:no-server-rsync")
              info(c.dim(`uploaded every file: ${serverName} has no rsync, \`lf setup ${serverName}\` installs it to send only what changed`));
          }
          const prepared = await prepareRelease(server, name, id, { file: compose, generated, env, layer: layered });
          vols = folderVolumes(prepared.config, prev?.volumes);
          const a = analyze(prepared.config, prepared.dir, (d) => expandDomain(d, server), { auto: kind === "compose" });
          for (const w of a.warnings) warn(w);
          if (a.auto && a.services.some(routed))
            info(c.dim(`no x-landfall in ${compose ?? "compose.yaml"}: routing the HTTP ports it publishes or exposes (\`lf init\` writes them down)`));
          for (const n of a.notes) info(c.dim(n));
          if (a.errors.length) fail(`${compose ?? "compose.yaml"} cannot be deployed:\n${a.errors.map((e) => `  - ${e}`).join("\n")}`);
          const rh = releaseHooks(hooks, a.services, kind);
          release = {
            id,
            at: new Date().toISOString(),
            services: a.services,
            ...(git && { git }),
            by: journal.actor,
            landfall: VERSION,
            ...(rh && { hooks: rh }),
          };
          const fixed = fixedDomains(a.services);

          // Domains of the service that serves the site's own: -d, .landfall.json, the server's, or asked.
          // Those from .landfall.json never move from another site: that takes a -d.
          domains = [];
          let fromFile = false;
          if (mainService(release)) {
            fromFile = !domainArgs?.length && !!project.domains?.length;
            domains = noDomain ? [] : ([domainArgs, project.domains, prev?.domains].find((l) => l?.length) ?? []);
            // Unrouted until -d: deployed with --no-domain, or a site whose domains were all taken off (lf domains --rm).
            let unrouted = noDomain || (!domains.length && ((!!prev && !!siteMain(prev) && !prev.domains.length) || project.domains?.length === 0));
            // The server's default: new sites stay off the internet until -d.
            if (!domains.length && !unrouted && isTunnelOnly(server)) unrouted = true;
            // No Traefik on the server (lf setup --minimal, --no-traefik): nothing would answer on a domain.
            if (!domains.length && !unrouted && !site.routed) unrouted = true;
            if (domains.length && !site.routed)
              warn(
                `${serverName} has no Traefik: ${domains.join(", ")} answers nothing until \`lf traefik setup -s ${serverName}\` (reach ${name} with lf tunnel ${name})`,
              );
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
            const subClash = subDomains(a.services, domains).filter((d) => domains.includes(d) || fixed.includes(d));
            if (subClash.length) fail(`${subClash.join(", ")} would be routed twice: by a subdomain route and as a domain`);
          } else if (domainArgs?.length)
            warn(
              `-d ignored: ${release.services.some(routed) ? `every routed service of ${name} names its own x-landfall.domains` : `${name} serves no domain`}`,
            );

          redirects = deployRedirects({
            none: noRedirect,
            args: redirectArgs,
            saved: project.redirects,
            prev: prev?.redirects,
            domains: mainService(release) ? domains : [],
            name,
          });
          if (redirects.length && domains.length) info(c.dim(`redirects to ${domains[0]}: ${redirects.join(", ")}`));
          showRoutes(a.services, domains, prev && currentRelease(prev));
          move = await claimDomains(
            server,
            serverName,
            { site: name },
            [...domains, ...fixed, ...subDomains(a.services, domains), ...redirects.filter((d) => !prev?.redirects?.includes(d))],
            proxy,
            { refuse: fromFile ? `${PROJECT_FILE} lists it; deploy with -d to move it` : undefined },
          );
          if (buildLocal) {
            const tmp = buildTmp();
            const offTmp = onStop(async () => fs.rmSync(tmp, { recursive: true, force: true }));
            try {
              const builds = localBuilds(prepared.config, { site: name, id, serverDir: prepared.dir + files, localDir: dir, generated, tmp });
              sent = builds.map((b) => b.tag);
              await buildLocally(server, builds);
            } finally {
              offTmp();
              fs.rmSync(tmp, { recursive: true, force: true });
            }
          }
          if (send) {
            // Counted as built here: the release's images, and with them this tag, go when the release does.
            for (const s of release.services) if (s.name === appService) s.build = true;
            sent = [sentImage];
            await sendImage(server, image!, here!, sentImage);
          }
        } catch (e) {
          await discardRelease(server, name, id, sent).catch((e) => warn(`could not remove the failed release ${id} of ${name}: ${e?.message ?? e}`));
          throw e;
        }

        const now = new Date().toISOString();
        // What lf auth, lf secret and the rest set on the site stays; the release decides the rest.
        const meta: SiteMeta = {
          ...prev,
          name,
          kind,
          domains,
          redirects: redirects.length ? redirects : undefined,
          auth: withLogin(prev?.auth, login),
          volumes: vols.length ? vols : undefined,
          current: id,
          releases: [...(prev?.releases ?? []), release],
          createdAt: prev?.createdAt ?? now,
          updatedAt: now,
        };
        const serverVars = hookVars(name, { release, prev: prev && currentRelease(prev) });
        const call = (h: "release" | "verify" | "postdeploy") => serverCall(release.hooks, h, skip, serverVars);
        try {
          await applySite(server, meta, proxy, {
            env,
            // Built here: the server runs the images it was sent.
            build: !buildLocal && !send,
            pull: true,
            keep,
            prev,
            existed: !prev && exists,
            hooks: { release: call("release"), verify: call("verify"), post: call("postdeploy") },
            what: `deploy ${name} release ${id}${prev ? "" : ` (new site, ${siteDomains(meta).join(", ")})`}${skip.note()}`,
          });
          offDiscard();
        } catch (e) {
          // A failed build or pull, or a start that went back to the previous release: its folder and images go.
          await discardRelease(server, name, id, builtImages(name, release)).catch((e) =>
            warn(`could not remove the failed release ${id} of ${name}: ${e?.message ?? e}`),
          );
          throw e;
        }
        // Domains leave their old site only once this one runs: a failed deploy takes nobody's away.
        await move().catch((e) => warn(`${name} is live, but moving its domains failed: ${e?.message ?? e}`));

        const all = siteDomains(meta);
        // --git: the settings belong in the repository, not in the folder it was deployed from.
        if (o.save && o.git) info(c.dim(`not saved to ${PROJECT_FILE}: a --git deploy takes its settings from the commit`));
        else if (o.save) {
          const saved = withRedirects({ name, server: serverName, domains }, redirects);
          if (kind === "image") Object.assign(saved, { image, ...(!fromImage && { port }), ...(send && { sendImage: true }) });
          else {
            const rel = relative(src, dir) || ".";
            if (kind !== "static") {
              if (rel !== ".") saved.dir = rel;
              if (kind === "compose" && (o.file || project.compose)) saved.compose = compose;
            } else if (rel !== detectStaticDir(src, detected)) saved.dir = rel;
            if (kind === "dockerfile") saved.port = port;
            if (app && (o.start || project.start)) saved.start = app.start;
            if (spa) saved.spa = true;
            if (forceStatic && kind === "static") saved.static = true;
          }
          // Saved even when empty: --volume '' turns off the volumes an app would get by default.
          if (o.volume?.length || project.volumes) saved.volumes = volumes;
          if (worker && !fromImage) saved.worker = true;
          if (gitignore) saved.gitignore = true;
          // Written by hand: kept as they are.
          if (project.exclude) saved.exclude = project.exclude;
          if (project.include) saved.include = project.include;
          if (project.hooks) saved.hooks = project.hooks;
          if (project.service) saved.service = project.service;
          if (buildLocal) saved.buildLocal = true;
          if (buildCmd !== undefined) saved.build = buildCmd;
          saveProject(cwd, saved);
          rememberProject({ path: cwd, name, server: serverName, domains: all, kind, ...(environment ? { environment } : {}) });
        }

        ok(`release ${c.bold(id)} live`);
        for (const d of all) console.log(`  ${c.cyan(`https://${d}`)}`);
        if (all[0]) report({ url: `https://${all[0]}` });
        if (all[0]) await checkLive(all[0]);
        if (files !== undefined) await offerSeed(server, name, dir, list, !!o["fill-volumes"]).catch((e) => warn(`volumes of ${name}: ${e?.message ?? e}`));
      } finally {
        await lock.unlock().catch((e) => warn(`could not unlock ${name}: ${e?.message ?? e}`));
      }
    } catch (e: any) {
      // Report only, here: the server may be what failed. A failing onfailure only warns, and never runs itself again.
      const hook = failedHook(String(e?.message ?? e));
      runLocalHook(
        hooks,
        "onfailure",
        { ...vars, LANDFALL_FAILED_STEP: hook ?? stage, LANDFALL_FAILED_HOOK: hook, LANDFALL_ERROR: String(e?.message ?? e) },
        skip,
      );
      throw e;
    }
  },
});

export { planDeploy } from "./plan";
export { nextReleaseId, releaseId } from "./release";
