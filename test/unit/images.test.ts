import { execFileSync } from "node:child_process";
import { beforeEach, describe, expect, test, vi } from "vitest";

// The shell landfall would run on the server, captured instead of sent.
const scripts: string[] = [];
const envs: (Record<string, string> | undefined)[] = [];
const reply = { stdout: "" };
vi.mock("../../src/core/ssh/ssh", async (orig) => ({
  ...(await orig<typeof import("../../src/core/ssh/ssh")>()),
  runScript: async (_s: unknown, script: string, o?: { env?: Record<string, string> }) => {
    scripts.push(script);
    envs.push(o?.env);
    return { code: 0, stdout: reply.stdout, stderr: "" };
  },
}));
const { parseRegistries, registryLogin, registryLogout, registryOf } = await import("../../src/core/server/registries");
const { imagePorts } = await import("../../src/core/site/releases");
const { exposedPorts } = await import("../../src/core/site/analyze");
const { parseLocalImages, samePlatform } = await import("../../src/core/deploy/buildlocal");
const { generatedCompose } = await import("../../src/core/site/generate");

const server = { host: "example.com" } as any;
const parses = (script: string) => execFileSync("bash", ["-n"], { input: script });

beforeEach(() => {
  scripts.length = envs.length = 0;
  reply.stdout = "";
});

describe("image ports", () => {
  test("EXPOSE lines are TCP ports, lowest first; UDP ones do not route", () => {
    expect(exposedPorts("8080/tcp 80/tcp 53/udp 8080 \n")).toEqual([80, 8080]);
    expect(exposedPorts("")).toEqual([]);
  });

  test("the server pulls the image only when it lacks it, then reads EXPOSE", async () => {
    reply.stdout = "3000/tcp ";
    expect(await imagePorts(server, "ghcr.io/me/app:1.2")).toEqual([3000]);
    parses(scripts[0]);
    expect(scripts[0]).toContain("image inspect 'ghcr.io/me/app:1.2' >/dev/null 2>&1 || $DOCKER pull -q 'ghcr.io/me/app:1.2'");
  });
});

describe("registries", () => {
  test("the registry of an image ref", () => {
    expect(registryOf("ghcr.io/me/app:1")).toBe("ghcr.io");
    expect(registryOf("registry.example.com:5000/app")).toBe("registry.example.com:5000");
    expect(registryOf("me/app:1")).toBe("docker.io");
    expect(registryOf("nginx")).toBe("docker.io");
  });

  test("docker's config.json lists the logged-in registries; Docker Hub is docker.io", () => {
    const cfg = { auths: { "https://index.docker.io/v1/": {}, "ghcr.io": { auth: "x" } }, credHelpers: { "123.dkr.ecr.eu-west-1.amazonaws.com": "ecr-login" } };
    expect(parseRegistries(JSON.stringify(cfg))).toEqual(["123.dkr.ecr.eu-west-1.amazonaws.com", "docker.io", "ghcr.io"]);
    expect(parseRegistries("")).toEqual([]);
    expect(parseRegistries("not json")).toEqual([]);
  });

  test("login sends the password on docker's stdin, never in argv or the journal", async () => {
    await registryLogin(server, "ghcr.io", "me", "s3cr'et");
    const s = scripts[0];
    parses(s);
    expect(s).toContain(`printf '%s' "$PW" | $DOCKER login 'ghcr.io' -u "$U" --password-stdin`);
    expect(envs[0]).toEqual({ U: "me", PW: "s3cr'et" });
    const journal = s.slice(s.lastIndexOf("record "));
    expect(journal).toContain("docker logged in to ghcr.io as me");
    expect(journal).toMatch(/docker logout .*ghcr\.io/);
    expect(journal).not.toContain("s3cr");
  });

  test("Docker Hub logs in without a host; bad hosts never reach the shell", async () => {
    await registryLogin(server, "docker.io", "me", "pw");
    expect(scripts[0]).toContain('$DOCKER login  -u "$U"');
    await registryLogout(server, "ghcr.io");
    parses(scripts[1]);
    expect(scripts[1]).toContain("$DOCKER logout 'ghcr.io'");
    await expect(registryLogin(server, "ghcr.io; rm -rf /", "me", "pw")).rejects.toThrow("not a registry host");
  });
});

describe("local images", () => {
  test("docker image ls lines; untagged images are left out", () => {
    expect(parseLocalImages("myapp:dev\tabc123\t120MB\t2 hours ago\n<none>:<none>\tdef\t1MB\t3 days ago\n")).toEqual([
      { ref: "myapp:dev", id: "abc123", size: "120MB", created: "2 hours ago" },
    ]);
  });

  test("an image runs on a server of the same platform; arm64/v8 is arm64", () => {
    expect(samePlatform("linux/amd64", "linux/amd64")).toBe(true);
    expect(samePlatform("linux/arm64/v8", "linux/arm64")).toBe(true);
    expect(samePlatform("linux/arm64", "linux/amd64")).toBe(false);
    expect(samePlatform("linux/arm/v6", "linux/arm/v7")).toBe(false);
  });

  test("a sent image is never pulled", () => {
    expect(generatedCompose("image", { image: "blog-app:1", sent: true, port: 3000 })).toContain('image: "blog-app:1"\n    pull_policy: never\n');
    expect(generatedCompose("image", { image: "nginx:1.27" })).not.toContain("pull_policy");
  });
});
