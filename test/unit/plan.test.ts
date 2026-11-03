import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { planDeploy } from "../../src/cli/commands/deploy";

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

const project = (files: Record<string, string>) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-plan-"));
  for (const [f, s] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), s);
  }
  return dir;
};

describe("planDeploy", () => {
  test("a folder with index.html is a static site, without a port", () => {
    const p = planDeploy(project({ "index.html": "hi" }), undefined, {}, {});
    expect(p).toMatchObject({ kind: "static", port: undefined, spa: false });
  });

  test("a Dockerfile routes to its last EXPOSE", () => {
    const p = planDeploy(project({ Dockerfile: "FROM alpine\nEXPOSE 80\nEXPOSE 8080/tcp\n" }), undefined, {}, {});
    expect(p).toMatchObject({ kind: "dockerfile", port: 8080, ownDockerfile: true });
  });

  test("--port wins over the guess, and --volume is kept as given", () => {
    const p = planDeploy(project({ Dockerfile: "FROM alpine\nEXPOSE 80\n" }), undefined, { port: "9000", volume: ["/data", "/data"] }, {});
    expect(p).toMatchObject({ port: 9000, volumes: ["/data"] });
  });

  test("a compose.yaml deploys as it is, layered with the environment's file", () => {
    const cwd = project({ "compose.yaml": "services: {}\n", "compose.staging.yaml": "services: {}\n" });
    expect(planDeploy(cwd, undefined, {}, {}, "staging")).toMatchObject({
      kind: "compose",
      compose: "compose.yaml",
      layered: "compose.staging.yaml",
      port: undefined,
    });
  });

  test("--image wins over the folder", () => {
    const p = planDeploy(project({ "compose.yaml": "services: {}\n" }), undefined, { image: "nginx:1.27" }, {});
    expect(p).toMatchObject({ kind: "image", image: "nginx:1.27", compose: undefined, port: 3000 });
  });

  test("wrong combinations fail before anything is sent", () => {
    const cwd = project({ "index.html": "hi" });
    expect(() => planDeploy(cwd, undefined, { start: "node a.js", static: true }, {})).toThrow("exclude each other");
    expect(() => planDeploy(cwd, undefined, { volume: ["/data"] }, {})).toThrow("--volume and --worker are for apps");
    expect(() => planDeploy(project({ Dockerfile: "FROM alpine\n" }), undefined, { volume: ["data"] }, {})).toThrow("folder in the container");
    expect(() => planDeploy(cwd, undefined, { file: "other.yaml" }, {})).toThrow("no other.yaml");
  });

  test("publishing where a detected tool builds to runs its build first; --build '' does not", () => {
    const pkg = JSON.stringify({ scripts: { build: "mkdir -p dist && echo built > dist/index.html" }, devDependencies: { vite: "7" } });
    const cwd = project({ "package.json": pkg, "index.html": "source" });
    expect(planDeploy(cwd, undefined, { build: "" }, {})).toMatchObject({ kind: "static", buildCmd: "" });
    expect(fs.existsSync(path.join(cwd, "dist"))).toBe(false);
    const p = planDeploy(cwd, undefined, {}, {});
    expect(p).toMatchObject({ kind: "static", buildCmd: "npm run build", dir: path.join(cwd, "dist") });
    expect(fs.readFileSync(path.join(cwd, "dist/index.html"), "utf8")).toBe("built\n");
  });
});
