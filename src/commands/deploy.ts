import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { defineCommand, serverOpt } from "../cmd";
import { checkImage, checkInt, DOMAIN, expandDomain, mainDomain, loadConfig, loadProject, PROJECT_FILE, resolveServer, saveProject, type ProjectConfig } from "../config";
import { analyze, generatedCompose, isOld, mainService, nginxConf, siteDomains, siteMain, type Release, type SiteKind, type SiteMeta } from "../compose";
import { applySite, discardRelease, mergeEnv, parseEnvPairs, prepareRelease, readSite, siteDir, validName } from "../remote";
import { setUpState, upload } from "../ssh";
import { ask, askSecret, c, confirm, fail, info, interactive, ok, step, warn } from "../ui";
import { pickIp, serverIps, sslipDomain } from "../facts";
import { composeFile, detectStaticDir, exposedPort, rememberProject, slug } from "../projects";
import { claimDomains } from "./access";
import { setupServer } from "./setup";
import { htpasswd } from "./traefik";

export { detectStaticDir, exposedPort, slug } from "../projects";

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
  const user = login.slice(0, login.indexOf(":"));
  return [...(auth ?? []).filter((l) => l.slice(0, l.indexOf(":")) !== user), login];
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
  summary: `Deploy a Compose project, static folder, Dockerfile or image with HTTPS.

Kinds:
  compose     the folder has a compose.yaml: its services run on the server as one
              project; x-landfall: { port: 3000 } on a service routes it through Traefik
  dockerfile  the folder has a Dockerfile: uploaded and built on the server
  static      a folder of files (auto-detects dist/, build/, out/, public/)
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
    file: { type: "string", short: "f", desc: "compose file to deploy (default: compose.yaml)" },
    spa: { type: "boolean", desc: "single-page app: unknown paths serve index.html" },
    image: { type: "string", desc: "deploy a docker image instead of files" },
    port: { type: "string", desc: "container port (image/dockerfile; default: EXPOSE or 3000)" },
    static: { type: "boolean", desc: "force static even if a Dockerfile or compose file exists" },
    env: { type: "string", short: "e", multiple: true, desc: "set KEY=VALUE in the site's .env" },
    "env-file": { type: "string", desc: "merge a local .env file into the site's .env" },
    build: { type: "string", short: "b", desc: "run this command locally first (e.g. 'npm run build')" },
    keep: { type: "string", desc: "releases to keep for rollback", default: "5" },
    save: { type: "boolean", desc: "write .landfall.json (--no-save to skip)", default: true },
    host: { type: "string", desc: "IP or hostname of a new server: set it up as --server first" },
    user: { type: "string", short: "u", desc: "with --host: initial login user (default: root)" },
    "ssh-port": { type: "string", desc: "with --host: ssh port" },
    "password-stdin": { type: "boolean", desc: "setting up first: read the login password from stdin (also: $LANDFALL_PASSWORD)" },
    "auth-user": { type: "string", desc: "protect the site with this login (HTTP basic auth, as lf auth)" },
    "auth-password": { type: "string", desc: "with --auth-user: its password (asked when missing)" },
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
    const keep = checkInt(o.keep, "--keep", 1);
    // Domains given up front fail on a typo before the build and the upload.
    const typos = (o.domain?.length ? o.domain : (project.domains ?? [])).map((d: string) => expandDomain(d, server)).filter((d: string) => !DOMAIN.test(d));
    if (typos.length) fail(`not a domain: ${typos.join(", ")}`);
    let login: string | undefined;
    if (o["auth-user"]) {
      const user: string = o["auth-user"];
      if (!/^[A-Za-z0-9._@-]{1,64}$/.test(user)) fail("--auth-user may only have letters, digits and . _ @ -");
      const pw: string = o["auth-password"] ?? (await askSecret(`Password for ${user}:`));
      if (pw.length < 8) fail("use a password of at least 8 characters");
      login = await htpasswd(user, pw);
    } else if (o["auth-password"]) fail("--auth-password needs --auth-user");

    const buildCmd: string | undefined = o.build ?? project.build;
    if (buildCmd) {
      step(`building locally: ${buildCmd}`);
      const r = spawnSync(buildCmd, { shell: true, stdio: "inherit" });
      if (r.status !== 0) fail(`build failed (exit ${r.status})`);
    }

    const forceStatic = o.static ?? project.static;
    const imageArg: string | undefined = o.image ?? (forceStatic ? undefined : project.image);
    const image = imageArg && checkImage(imageArg);
    const root = resolve(cwd, dirArg ?? project.dir ?? ".");
    const compose = image || forceStatic ? undefined : (o.file ?? composeFile(root, project));
    if (compose && !fs.existsSync(join(root, compose))) fail(`no ${compose} in ${relative(cwd, root) || "."}`);
    const dir = compose || image ? root : resolve(cwd, dirArg ?? project.dir ?? detectStaticDir(cwd));
    const kind: SiteKind = compose ? "compose" : image ? "image" : !forceStatic && fs.existsSync(join(dir, "Dockerfile")) ? "dockerfile" : "static";
    if (kind === "static" && !fs.existsSync(join(dir, "index.html"))) warn(`no index.html in ${relative(cwd, dir) || "."}`);
    const port = KINDS[kind].port
      ? checkInt(o.port ?? project.port ?? (kind === "dockerfile" ? exposedPort(join(dir, "Dockerfile")) : undefined) ?? 3000, "--port", 1, 65535)
      : undefined;
    const spa = kind === "static" && !!(o.spa ?? project.spa);

    step(`deploying ${c.bold(name)} (${kind}) to ${c.bold(serverName)}`);
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
      if (o["env-file"]) env = mergeEnv(env, parseEnvPairs(dotenvLines(fs.readFileSync(o["env-file"], "utf8"))));
      if (o.env?.length) env = mergeEnv(env, parseEnvPairs(o.env));
    }

    const id = nextReleaseId((prev?.releases ?? []).map((r) => r.id));
    const releaseDir = `${siteDir(name)}/releases/${id}`;
    const generated: Record<string, string> =
      kind === "compose" ? {} : { "compose.yaml": generatedCompose(kind, { port, image }), ...(kind === "static" && { "nginx.conf": nginxConf(spa) }) };

    // Anything that fails from the upload until the site switches takes the half-made release away again.
    let release: Release, domains: string[], move: () => Promise<void>;
    try {
      const files = KINDS[kind].files;
      if (files !== undefined) {
        step(`uploading ${relative(cwd, dir) || "."}`);
        await upload(server, dir, releaseDir + files);
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
        fromFile = !o.domain?.length && !!project.domains?.length;
        domains = [o.domain, project.domains, prev?.domains, old?.domains].find((l) => l?.length) ?? [];
        // A site whose domains were all taken off (lf domains --rm) stays unrouted until -d.
        const unrouted = !domains.length && !!prev && !!siteMain(prev) && !prev.domains.length;
        if (!domains.length && !unrouted) {
          // <name>.<main domain>, or with no DNS needed: <name>.<ip>.sslip.io resolves to the server.
          const main = mainDomain(server);
          const ip = main ? undefined : pickIp(await serverIps(server));
          const auto = main ? `${name}.${main}` : ip ? sslipDomain(name, ip) : undefined;
          domains = (await ask("Domain(s) to serve (comma separated):", auto)).split(/[\s,]+/).filter(Boolean);
        }
        domains = [...new Set(domains.map((d) => expandDomain(d, server)))];
        const bad = domains.filter((d) => !DOMAIN.test(d));
        const clash = domains.filter((d) => fixed.includes(d));
        if (!domains.length && !unrouted) fail("at least one --domain is required");
        if (unrouted) info(c.dim(`${name} serves no domain (lf domains ${name} --add <domain>, or deploy with -d)`));
        if (bad.length) fail(`not a domain: ${bad.join(", ")}`);
        if (clash.length) fail(`${clash.join(", ")} is already routed by x-landfall.domains`);
      } else if (o.domain?.length) warn(`-d ignored: every routed service of ${name} names its own x-landfall.domains`);

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
        if (kind === "compose") {
          if (rel !== ".") saved.dir = rel;
          if (o.file || project.compose) saved.compose = compose;
        } else if (rel !== detectStaticDir(cwd)) saved.dir = rel;
        if (kind === "dockerfile") saved.port = port;
        if (spa) saved.spa = true;
        if (forceStatic && kind === "static") saved.static = true;
      }
      if (buildCmd) saved.build = buildCmd;
      saveProject(cwd, saved);
      rememberProject({ path: cwd, name, server: serverName, domains: all, kind });
    }

    ok(`release ${c.bold(id)} live`);
    for (const d of all) console.log(`  ${c.cyan(`https://${d}`)}`);
    if (all[0]) await checkLive(all[0]);
  },
});

/** Turn dotenv text into KEY=VALUE pairs, dropping comments and blanks. */
function dotenvLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim().replace(/^export\s+/, ""))
    .filter((l) => l && !l.startsWith("#") && l.includes("="));
}

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
