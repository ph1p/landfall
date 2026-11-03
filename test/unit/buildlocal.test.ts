import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { dockerPlatform, localBuilds } from "../../src/core/buildlocal";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lf-build-"));
const at = { site: "blog", id: "20260101120000", serverDir: "/opt/landfall/sites/blog/releases/20260101120000", localDir: "/work/blog", generated: {} };

describe("--build-local", () => {
  test("the server's uname -m is Docker's platform", () => {
    expect(dockerPlatform("x86_64\n")).toBe("linux/amd64");
    expect(dockerPlatform("aarch64")).toBe("linux/arm64");
    expect(dockerPlatform("armv7l")).toBe("linux/arm/v7");
  });

  test("builds of compose config map from the release on the server to the folder here, tagged as on the server", () => {
    const config = {
      services: {
        web: { build: { context: `${at.serverDir}/web`, dockerfile: "Dockerfile.prod", args: { NODE_ENV: "production", EMPTY: null }, target: "run" } },
        db: { image: "postgres:17" },
      },
    };
    expect(localBuilds(config, { ...at, tmp: tmp() })).toEqual([
      {
        service: "web",
        tag: "blog-web:20260101120000",
        context: "/work/blog/web",
        dockerfile: "/work/blog/web/Dockerfile.prod",
        args: ["--build-arg", "NODE_ENV=production", "--build-arg", "EMPTY", "--target", "run"],
      },
    ]);
  });

  test("a generated Dockerfile and .dockerignore are written apart, next to each other", () => {
    const t = tmp();
    const generated = { Dockerfile: "FROM node:22\n", ".dockerignore": "node_modules\n" };
    const [b] = localBuilds({ services: { app: { build: { context: at.serverDir, dockerfile: "Dockerfile" } } } }, { ...at, generated, tmp: t });
    expect(b.context).toBe("/work/blog");
    expect(b.dockerfile).toBe(path.join(t, "Dockerfile"));
    expect(fs.readFileSync(b.dockerfile, "utf8")).toBe("FROM node:22\n");
    expect(fs.readFileSync(`${b.dockerfile}.dockerignore`, "utf8")).toBe("node_modules\n");
  });

  test("a build outside the project, from git, or with build secrets stays on the server", () => {
    expect(() => localBuilds({ services: { a: { build: { context: "/srv/other" } } } }, { ...at, tmp: tmp() })).toThrow(/outside the project/);
    expect(() => localBuilds({ services: { a: { build: { context: "https://github.com/x/y.git" } } } }, { ...at, tmp: tmp() })).toThrow(
      /leave out --build-local/,
    );
    expect(() => localBuilds({ services: { a: { build: { context: at.serverDir, secrets: ["npmrc"] } } } }, { ...at, tmp: tmp() })).toThrow(/secrets/);
  });
});
