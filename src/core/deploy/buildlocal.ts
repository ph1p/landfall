import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { Server } from "../lib/config";
import { builtImage, exposedPorts } from "../site/compose";
import { onStop } from "../lib/job";
import { runScript, shq, sshPipe } from "../ssh/ssh";
import { c, fail, info, step } from "../lib/term";

/** One service's image, built on this machine instead of the server. */
export interface LocalBuild {
  service: string;
  tag: string;
  context: string;
  dockerfile: string;
  args: string[];
}

/** Docker's platform for `uname -m` of the server. */
export function dockerPlatform(arch: string): string {
  const a = arch.trim();
  if (a === "x86_64" || a === "amd64") return "linux/amd64";
  if (a === "aarch64" || a === "arm64") return "linux/arm64";
  if (a.startsWith("armv7")) return "linux/arm/v7";
  if (a.startsWith("armv6")) return "linux/arm/v6";
  return `linux/${a}`;
}

/**
 * The builds of `docker compose config` (paths on the server, under `serverDir`) as paths here: files the deploy
 * generates (its Dockerfile, .dockerignore) are written to `tmp`, the rest is the folder that was uploaded.
 */
export function localBuilds(
  config: any,
  o: { site: string; id: string; serverDir: string; localDir: string; generated: Record<string, string>; tmp: string },
): LocalBuild[] {
  const here = (p: string, service: string) => {
    const r = relative(o.serverDir, p);
    if (r.startsWith("..") || isAbsolute(r)) fail(`${service} builds from ${p}, outside the project: --build-local cannot send that`);
    if (o.generated[r] === undefined) return join(o.localDir, r);
    const f = join(o.tmp, r);
    fs.mkdirSync(dirname(f), { recursive: true });
    fs.writeFileSync(f, o.generated[r]);
    return f;
  };
  return Object.entries<any>(config?.services ?? {})
    .filter(([, s]) => s?.build)
    .map(([service, s]) => {
      const b = typeof s.build === "string" ? { context: s.build } : s.build;
      const unsupported = ["ssh", "secrets", "additional_contexts", "platforms"].filter((k) => b[k] !== undefined);
      if (unsupported.length) fail(`${service} builds with ${unsupported.join(", ")}: build it on the server (leave out --build-local)`);
      if (/^[a-z]+:\/\//i.test(b.context ?? "") || (b.context ?? "").startsWith("git@"))
        fail(`${service} builds from ${b.context}: build it on the server (leave out --build-local)`);
      const serverContext = b.context ?? o.serverDir;
      const context = here(serverContext, service);
      let dockerfile: string;
      if (b.dockerfile_inline !== undefined) {
        dockerfile = join(o.tmp, `${service}.Dockerfile`);
        fs.writeFileSync(dockerfile, b.dockerfile_inline);
      } else {
        const d = b.dockerfile ?? "Dockerfile";
        dockerfile = here(isAbsolute(d) ? d : join(serverContext, d), service);
        // A generated Dockerfile sits apart from the context: BuildKit reads <Dockerfile>.dockerignore next to it.
        const ignore = relative(o.serverDir, join(serverContext, ".dockerignore"));
        if (dockerfile.startsWith(o.tmp) && o.generated[ignore] !== undefined && !fs.existsSync(join(context, ".dockerignore")))
          fs.writeFileSync(`${dockerfile}.dockerignore`, o.generated[ignore]);
      }
      const args = [
        ...Object.entries<any>(b.args ?? {}).flatMap(([k, v]) => ["--build-arg", v === null || v === undefined ? k : `${k}=${v}`]),
        ...(b.target ? ["--target", String(b.target)] : []),
      ];
      return { service, tag: builtImage(o.site, service, o.id), context, dockerfile, args };
    });
}

/** Builds `builds` here for the server's platform, then loads them into the server's Docker. */
export async function buildLocally(server: Server, builds: LocalBuild[]) {
  if (!builds.length) return;
  if (spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "ignore" }).status !== 0)
    fail("--build-local needs Docker running on this machine");
  const { platform } = await serverImage(server);
  const tags = builds.map((b) => b.tag);
  // Here they would only take up space: the server has them now, or the deploy failed.
  await dropAfter(tags, async () => {
    for (const b of builds) {
      step(`building ${b.service} here (${platform})`);
      const r = spawnSync("docker", ["build", "--pull", "--platform", platform, "-t", b.tag, "-f", b.dockerfile, ...b.args, b.context], { stdio: "inherit" });
      if (r.status !== 0) fail(`building ${b.service} failed`);
    }
    step(`sending ${tags.length === 1 ? "the image" : `${tags.length} images`} to ${server.host}`);
    await pipeImages(server, tags);
  });
  info(c.dim(`built here, sent: ${tags.join(", ")}`));
}

/**
 * The server's platform (one ssh round trip). With `id` and `tag`: when the server's docker has that image
 * already (a redeploy of the same local image), it is tagged `tag` there and `has` is true.
 */
async function serverImage(server: Server, id?: string, tag?: string) {
  const has = id && tag ? `\nif docker image inspect ${shq(id)} >/dev/null 2>&1; then docker tag ${shq(id)} ${shq(tag)} && echo has; fi` : "";
  const { stdout } = await runScript(server, `uname -m${has}`, { capture: true });
  const [arch, found] = stdout.trim().split("\n");
  return { platform: dockerPlatform(arch ?? ""), has: found === "has" };
}

/** Runs `work`, then removes the local `tags`, also when lf stops: the images stay, the extra tags go. */
async function dropAfter(tags: string[], work: () => Promise<void>) {
  const drop = async () => void spawnSync("docker", ["image", "rm", ...tags], { stdio: "ignore" });
  const off = onStop(drop);
  try {
    await work();
  } finally {
    off();
    await drop();
  }
}

/** docker save | gzip | ssh docker load. gzip -1: images are mostly compressed layers already; speed matters more than the last few percent. */
const pipeImages = (server: Server, tags: string[]) =>
  sshPipe(server, "gzip -dc | docker load -q >/dev/null", ["sh", "-c", 'docker save "$@" | gzip -1', "sh", ...tags], "up").catch((e) =>
    fail(`sending ${tags.join(", ")} failed: ${e?.message ?? e}`),
  );

/** A folder for the files of one local build. */
export const buildTmp = () => fs.mkdtempSync(join(os.tmpdir(), "landfall-build-"));

/** An image in this machine's Docker, as `docker image ls` shows it. */
export interface LocalImage {
  ref: string;
  id: string;
  size: string;
  created: string;
}

/** The tagged images in this machine's Docker, newest first; none when Docker is not running here. */
export function localImages(): LocalImage[] {
  const r = spawnSync("docker", ["image", "ls", "--format", "{{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.Size}}\t{{.CreatedSince}}"], { encoding: "utf8" });
  return r.status === 0 ? parseLocalImages(r.stdout) : [];
}

export const parseLocalImages = (text: string): LocalImage[] =>
  text
    .split("\n")
    .map((l) => l.split("\t"))
    .filter(([ref, id]) => ref && id && !ref.includes("<none>"))
    .map(([ref, id, size, created]) => ({ ref, id, size: size ?? "", created: created ?? "" }));

/** What deploying an image of this machine's Docker needs to know; undefined when Docker here does not have it. */
export interface LocalImageInfo {
  /** The image id: the same on the server once loaded there. */
  id: string;
  /** os/arch[/variant], as Docker names platforms. */
  platform: string;
  ports: number[];
  /** Pulled from or pushed to a registry: it has a repo digest. */
  pushed: boolean;
}

export function localImage(ref: string): LocalImageInfo | undefined {
  const format = "{{.ID}}|{{.Os}}/{{.Architecture}}{{with .Variant}}/{{.}}{{end}}|{{len .RepoDigests}}|{{range $p, $_ := .Config.ExposedPorts}}{{$p}} {{end}}";
  const r = spawnSync("docker", ["image", "inspect", "--format", format, ref], { encoding: "utf8" });
  if (r.status !== 0) return;
  const [id, platform, digests, ports] = r.stdout.trim().split("|");
  return { id, platform, pushed: +digests > 0, ports: exposedPorts(ports ?? "") };
}

/** Whether an image built for `image` runs on a server of `server` (both os/arch[/variant]); arm64's v8 is arm64. */
export function samePlatform(image: string, server: string): boolean {
  const norm = (p: string) => p.trim().replace(/^(linux\/arm64)\/v8$/, "$1");
  const [a, b] = [norm(image), norm(server)];
  return a === b || (!a.split("/")[2] && a === b.split("/").slice(0, 2).join("/"));
}

/**
 * Sends an image of this machine's Docker to the server as `tag`, without a registry: docker save | gzip | ssh docker load.
 * Fails before sending anything when the image is built for another platform than the server's.
 */
export async function sendImage(server: Server, ref: string, local: LocalImageInfo, tag: string) {
  const { platform, has } = await serverImage(server, local.id, tag);
  if (has) return void info(c.dim(`${server.host} has ${ref} already: tagged it ${tag}`));
  if (!samePlatform(local.platform, platform))
    fail(
      `${ref} is built for ${local.platform}, ${server.host} runs ${platform}: build it with docker build --platform ${platform}, or deploy with --build-local`,
    );
  if (spawnSync("docker", ["tag", ref, tag], { stdio: "ignore" }).status !== 0) fail(`could not tag ${ref} as ${tag}`);
  step(`sending ${ref} to ${server.host} (${local.platform})`);
  await dropAfter([tag], () => pipeImages(server, [tag]));
  info(c.dim(`sent ${ref} as ${tag}`));
}
