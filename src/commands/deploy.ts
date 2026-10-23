import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { defineCommand, serverOpt } from "../cmd";
import { checkImage, checkInt, DOMAIN, expandDomain, mainDomain, loadProject, PROJECT_FILE, resolveServer, saveProject, type ProjectConfig } from "../config";
import { applySite, mergeEnv, parseEnvPairs, readSite, siteDir, validName } from "../remote";
import { upload } from "../ssh";
import { container, type Release, type SiteKind, type SiteMeta } from "../templates";
import { ask, c, fail, info, ok, step, warn } from "../ui";
import { pickIp, serverIps, sslipDomain } from "../facts";
import { detectStaticDir, exposedPort, rememberProject, slug } from "../projects";

export { detectStaticDir, exposedPort, slug } from "../projects";

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
  summary: `Deploy a static folder, Dockerfile or image with HTTPS.

Kinds:
  static      a folder of files (default; auto-detects dist/, build/, out/, public/)
  dockerfile  the folder has a Dockerfile: uploaded and built on the server
  image       --image: run a prebuilt image (e.g. ghcr.io/me/app:1.2)

Settings are saved to ./.landfall.json, so later deploys are just \`lf deploy\`.`,
  options: {
    server: serverOpt,
    name: { type: "string", short: "n", desc: "site name (default: folder name)" },
    domain: { type: "string", short: "d", multiple: true, desc: "domain to serve (`blog` = blog.<main domain>)" },
    spa: { type: "boolean", desc: "single-page app: unknown paths serve index.html" },
    image: { type: "string", desc: "deploy a docker image instead of files" },
    port: { type: "string", desc: "container port (image/dockerfile; default: EXPOSE or 3000)" },
    static: { type: "boolean", desc: "force static even if a Dockerfile exists" },
    env: { type: "string", short: "e", multiple: true, desc: "set KEY=VALUE in the site's .env" },
    "env-file": { type: "string", desc: "merge a local .env file into the site's .env" },
    build: { type: "string", short: "b", desc: "run this command locally first (e.g. 'npm run build')" },
    keep: { type: "string", desc: "releases to keep for rollback", default: "5" },
    save: { type: "boolean", desc: "write .landfall.json (--no-save to skip)", default: true },
  },
  async run([dirArg], o) {
    const cwd = process.cwd();
    const project: Partial<ProjectConfig> = loadProject(cwd) ?? {};
    if (project.name) info(c.dim(`using ${PROJECT_FILE}`));

    const { name: serverName, server } = resolveServer(o.server ?? project.server);
    const name = validName(o.name ?? project.name ?? slug(basename(cwd)));
    let domains: string[] = o.domain?.length ? o.domain : project.domains ?? [];
    if (!domains.length) {
      // <name>.<main domain>, or with no DNS needed: <name>.<ip>.sslip.io resolves to the server.
      const main = mainDomain(server);
      const ip = main ? undefined : pickIp(await serverIps(server));
      const auto = main ? `${name}.${main}` : ip ? sslipDomain(name, ip) : undefined;
      domains = (await ask("Domain(s) to serve (comma separated):", auto)).split(/[\s,]+/).filter(Boolean);
    }
    domains = domains.map((d) => expandDomain(d, server));
    if (!domains.length) fail("at least one --domain is required");
    const bad = domains.filter((d) => !DOMAIN.test(d));
    if (bad.length) fail(`not a domain: ${bad.join(", ")}`);
    const keep = checkInt(o.keep, "--keep", 1);

    const buildCmd: string | undefined = o.build ?? project.build;
    if (buildCmd) {
      step(`building locally: ${buildCmd}`);
      const r = spawnSync(buildCmd, { shell: true, stdio: "inherit" });
      if (r.status !== 0) fail(`build failed (exit ${r.status})`);
    }

    const forceStatic = o.static ?? project.static;
    const imageArg: string | undefined = o.image ?? (forceStatic ? undefined : project.image);
    const image = imageArg && checkImage(imageArg);
    const dir = resolve(cwd, dirArg ?? project.dir ?? (image ? "." : detectStaticDir(cwd)));
    const kind: SiteKind = image ? "image" : !forceStatic && fs.existsSync(join(dir, "Dockerfile")) ? "dockerfile" : "static";
    if (kind === "static" && !fs.existsSync(join(dir, "index.html"))) warn(`no index.html in ${relative(cwd, dir) || "."}`);
    const port =
      kind === "static"
        ? 80
        : checkInt(o.port ?? project.port ?? (kind === "dockerfile" ? exposedPort(join(dir, "Dockerfile")) : undefined) ?? 3000, "--port", 1, 65535);

    step(`deploying ${c.bold(name)} (${kind}) to ${c.bold(serverName)}`);
    const { meta: prev, env: prevEnv, proxy, exists } = await readSite(server, name);
    if (prev && prev.kind !== kind) info(c.dim(`site was ${prev.kind}, now ${kind}`));

    const id = nextReleaseId((prev?.releases ?? []).map((r) => r.id));
    const release: Release = { id, at: new Date().toISOString() };
    if (kind === "image") release.image = image;
    if (kind === "dockerfile") release.image = `${container(name)}:${id}`;

    if (kind !== "image") {
      step(`uploading ${relative(cwd, dir) || "."}`);
      await upload(server, dir, `${siteDir(name)}/releases/${id}`);
    }

    let env: string | undefined;
    if (o.env?.length || o["env-file"]) {
      env = prevEnv;
      if (o["env-file"]) env = mergeEnv(env, parseEnvPairs(dotenvLines(fs.readFileSync(o["env-file"], "utf8"))));
      if (o.env?.length) env = mergeEnv(env, parseEnvPairs(o.env));
    }

    const now = new Date().toISOString();
    const meta: SiteMeta = {
      name,
      kind,
      domains,
      port,
      spa: kind === "static" ? !!(o.spa ?? project.spa) : undefined,
      auth: prev?.auth,
      current: id,
      releases: [...(prev?.releases ?? []), release],
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    };
    await applySite(server, meta, proxy, {
      env,
      build: kind === "dockerfile",
      pull: kind === "image",
      keep,
      prev,
      existed: !prev && exists,
      what: `deploy ${name} release ${id}${prev ? "" : ` (new site, ${domains.join(", ")})`}`,
    });

    if (o.save) {
      const saved: ProjectConfig = { name, server: serverName, domains };
      if (kind === "image") Object.assign(saved, { image, port });
      else {
        const rel = relative(cwd, dir) || ".";
        if (rel !== detectStaticDir(cwd)) saved.dir = rel;
        if (kind === "dockerfile") saved.port = port;
        if (meta.spa) saved.spa = true;
        if (forceStatic && kind === "static") saved.static = true;
      }
      if (buildCmd) saved.build = buildCmd;
      saveProject(cwd, saved);
      rememberProject({ path: cwd, name, server: serverName, domains, kind });
    }

    ok(`release ${c.bold(id)} live`);
    for (const d of domains) console.log(`  ${c.cyan(`https://${d}`)}`);
    await checkLive(domains[0]);
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
