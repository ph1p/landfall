import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { Server } from "./config";
import { builtImage } from "./compose";
import { onStop } from "./job";
import { runScript, sshPipe } from "./ssh";
import { c, fail, info, step } from "./term";

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
  if (/^armv7/.test(a)) return "linux/arm/v7";
  if (/^armv6/.test(a)) return "linux/arm/v6";
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
      if (/^[a-z]+:\/\//i.test(b.context ?? "") || /^git@/.test(b.context ?? "")) fail(`${service} builds from ${b.context}: build it on the server (leave out --build-local)`);
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
  const { stdout } = await runScript(server, "uname -m", { capture: true });
  const platform = dockerPlatform(stdout);
  const tags = builds.map((b) => b.tag);
  // Here they would only take up space: the server has them now, or the deploy failed.
  const drop = async () => void spawnSync("docker", ["image", "rm", ...tags], { stdio: "ignore" });
  const off = onStop(drop);
  try {
    for (const b of builds) {
      step(`building ${b.service} here (${platform})`);
      const r = spawnSync("docker", ["build", "--pull", "--platform", platform, "-t", b.tag, "-f", b.dockerfile, ...b.args, b.context], { stdio: "inherit" });
      if (r.status !== 0) fail(`building ${b.service} failed`);
    }
    step(`sending ${tags.length === 1 ? "the image" : `${tags.length} images`} to ${server.host}`);
    // gzip -1: images are mostly compressed layers already; speed matters more than the last few percent.
    await sshPipe(server, "gzip -dc | docker load -q >/dev/null", ["sh", "-c", 'docker save "$@" | gzip -1', "sh", ...tags], "up").catch((e) => fail(`sending the images failed: ${e?.message ?? e}`));
  } finally {
    off();
    await drop();
  }
  info(c.dim(`built here, sent: ${tags.join(", ")}`));
}

/** A folder for the files of one local build. */
export const buildTmp = () => fs.mkdtempSync(join(os.tmpdir(), "landfall-build-"));
