import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { basename, dirname, join, normalize, relative, resolve } from "node:path";
import { checkImage, checkInt, type ProjectConfig } from "../../../core/lib/config";
import { type SiteKind } from "../../../core/site/meta";
import { CONTAINER_PATH } from "../../../core/site/compose-edit";
import { envComposeFile } from "../../../core/site/compose-config";
import { c, showStack, fail, info, step, warn } from "../../../core/lib/term";
import { detectBuild } from "../../../core/deploy/frameworks";
import { besideApp, composeFile, detectApp, detectStack, detectStaticDir, exposedPort } from "../../../core/deploy/projects";

/** Per kind: where its files go in the release (none: nothing is uploaded), and whether it takes --port. */
export const KINDS: Record<SiteKind, { files?: string; port?: boolean }> = {
  compose: { files: "" },
  dockerfile: { files: "", port: true },
  static: { files: "/public" },
  image: { port: true },
};

/** What deploy's options and the project folder say is deployed from here, and how; the local build command runs. */
export function planDeploy(
  cwd: string,
  dirArg: string | undefined,
  o: { start?: string; static?: boolean; build?: string; image?: string; file?: string; volume?: string[]; worker?: boolean; port?: string; spa?: boolean },
  project: Partial<ProjectConfig>,
  environment?: string,
  /** Installs a clean export's dependencies before the local build. */
  install?: () => void,
) {
  if (o.start && o.static) fail("--start and --static exclude each other");
  let buildCmd: string | undefined = o.build ?? project.build;
  // --start turns a site saved as static into an app.
  const forceStatic = o.static ?? (o.start ? false : project.static);
  const imageArg: string | undefined = o.image ?? (forceStatic ? undefined : project.image);
  const image = imageArg && checkImage(imageArg);
  const root = resolve(cwd, dirArg ?? project.dir ?? ".");
  const named = image || forceStatic ? undefined : (o.file ?? composeFile(root, project));
  let compose = named && normalize(named);
  // The file becomes the release's compose.yaml, at the root of the upload: from a subfolder its relative
  // paths (build: ., ./data:/data) would point elsewhere.
  if (compose?.includes("/"))
    fail(
      `${named} is not in the folder deployed; deploy its folder instead: lf deploy ${dirname(join(relative(cwd, root) || ".", compose))} -f ${basename(compose)}`,
    );
  if (compose && !fs.existsSync(join(root, compose))) fail(`no ${compose} in ${relative(cwd, root) || "."}`);
  // compose.staging.yaml next to compose.yaml: what -E staging changes, merged in on the server.
  const layer = compose && environment ? envComposeFile(compose, environment) : undefined;
  const layered = layer && fs.existsSync(join(root, layer)) ? layer : undefined;
  if (layered) info(c.dim(`layering ${layered} over ${compose}`));
  // A compose file of databases and caches next to an app (a Next.js app with Redis): the app is what deploys,
  // with them beside it. Named with -f or in .landfall.json, the file deploys as it is.
  const beside = compose && !o.file && !project.compose ? besideApp(root, compose, o.start ?? project.start, forceStatic) : undefined;
  if (beside) {
    compose = undefined;
    info(
      c.dim(
        `${beside.file} runs no app of its own (${beside.services.join(", ")}): deploying the app with them beside it (-f ${beside.file} deploys only the file)`,
      ),
    );
  }
  const ownDockerfile = !compose && !image && !forceStatic && fs.existsSync(join(root, "Dockerfile"));
  if (ownDockerfile && o.start) warn("--start ignored: the Dockerfile says how the app starts");
  // Without a Dockerfile of its own: an app landfall writes one for.
  const app = compose || image || forceStatic || ownDockerfile ? undefined : detectApp(root, o.start ?? project.start);
  if (app?.fix) fail(`${app.fix}; or say how it starts: --start <command>`);
  const detected = detectBuild(cwd);
  const dir = compose || image || ownDockerfile || app ? root : resolve(cwd, dirArg ?? project.dir ?? detectStaticDir(cwd, detected));
  const kind: SiteKind = compose ? "compose" : image ? "image" : ownDockerfile || app ? "dockerfile" : "static";
  const tool = kind === "static" && !dirArg && !project.dir ? detected.tool : undefined;
  // Publishing where the tool builds to: build first, or a redeploy would send the last build again (--build '' skips it).
  if (tool && buildCmd === undefined && detected.build) buildCmd = detected.build;
  if (buildCmd && !app) {
    install?.();
    step(`building locally: ${buildCmd}`);
    const r = spawnSync(buildCmd, { cwd, shell: true, stdio: "inherit" });
    if (r.status !== 0) fail(`build failed (exit ${r.status})`);
  }
  // A compose file or Dockerfile runs it, but the app inside still names the framework.
  const shown = app ?? (compose || ownDockerfile ? detectApp(root, o.start ?? project.start) : undefined);
  showStack(detectStack(root, shown?.name, shown?.tool ?? tool));
  if (tool) info(c.dim(`publishing ${relative(cwd, dir)}: where ${tool} builds the site (another folder: lf deploy <dir>)`));
  if (kind === "static" && !fs.existsSync(join(dir, "index.html"))) {
    warn(`no index.html in ${relative(cwd, dir) || "."}${tool && !buildCmd ? `: build first, or let deploy do it (--build "${detected.build}")` : ""}`);
  }
  if ((o.volume?.some(Boolean) || o.worker) && !KINDS[kind].port)
    fail(`--volume and --worker are for apps, Dockerfiles and images${kind === "compose" ? `: ${compose} names its volumes and routes itself` : ""}`);
  const worker = !!KINDS[kind].port && !!(o.worker ?? project.worker);
  const volumes = KINDS[kind].port ? [...new Set<string>(o.volume ?? project.volumes ?? app?.volumes ?? [])].filter(Boolean) : [];
  const notPath = volumes.filter((v) => !CONTAINER_PATH.test(v));
  if (notPath.length) fail(`--volume takes a folder in the container, like /app/data: not ${notPath.join(", ")}`);
  const guessed = o.port ?? project.port ?? (ownDockerfile ? exposedPort(join(dir, "Dockerfile")) : app?.port);
  // Traefik would send visitors to a port nothing listens on, and the deploy still say live: say the guess.
  // An image says its port itself (EXPOSE): deploy reads it on the server.
  if (KINDS[kind].port && guessed === undefined && !worker && kind !== "image")
    warn(`${ownDockerfile ? "the Dockerfile has no EXPOSE with a number" : "no port known"}: routing to 3000; pass --port if the app listens elsewhere`);
  const port = KINDS[kind].port && (guessed !== undefined || kind !== "image") ? checkInt(guessed ?? 3000, "--port", 1, 65535) : undefined;
  const appBuild = app && (buildCmd ?? app.build);
  if (app)
    info(
      c.dim(
        `${app.name} ${worker ? "worker" : "app"}${app.tool ? ` (${app.tool})` : ""}: built on the server${appBuild ? ` with ${appBuild}` : ""}, started with ${app.start}${worker ? "" : ` on port ${port}`}`,
      ),
    );
  if (volumes.length) info(c.dim(`kept across deploys: ${volumes.join(", ")}`));
  const spa = kind === "static" && !!(o.spa ?? project.spa);
  return { buildCmd, forceStatic, image, root, compose, beside, layered, ownDockerfile, app, detected, dir, kind, tool, worker, volumes, port, appBuild, spa };
}
