import { describe, expect, test } from "vitest";
import { addVolumeMount, mountOf, removeVolumeMount } from "../../src/core/compose";

const COMPOSE = `# the shop
services:
  web:
    image: shop # the site
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
  db:
    image: postgres:17
volumes:
  other: {}
`;

describe("volume mounts in compose.yaml", () => {
  test("mountOf reads named volumes, not bind mounts", () => {
    expect(mountOf("db:/var/lib/postgresql/data")).toEqual({ key: "db", path: "/var/lib/postgresql/data" });
    expect(mountOf("data:/data:ro")).toEqual({ key: "data", path: "/data" });
    expect(mountOf("./conf:/etc/conf")).toEqual({ key: undefined, path: "/etc/conf" });
    expect(mountOf("/cache")).toEqual({ path: "/cache" });
    expect(mountOf({ type: "volume", source: "up", target: "/up" })).toEqual({ key: "up", path: "/up" });
    expect(mountOf({ type: "bind", source: "./x", target: "/x" })).toEqual({ key: undefined, path: "/x" });
  });

  test("add mounts the volume and declares it, keeping comments", () => {
    const { compose, key } = addVolumeMount(COMPOSE, "db", "/var/lib/postgresql/data", "db");
    expect(key).toBe("db");
    expect(compose).toContain("# the shop");
    expect(compose).toContain("image: shop # the site");
    expect(compose).toContain("  db:\n    image: postgres:17\n    volumes:\n      - db:/var/lib/postgresql/data\n");
    expect(compose).toContain("volumes:\n  other: {}\n  db: {}\n");
    // Next to what the service already mounts; the name defaults to the path's folders.
    const web = addVolumeMount(compose, "web", "/app/uploads/");
    expect(web.key).toBe("app-uploads");
    expect(web.compose).toContain("      - ./nginx.conf:/etc/nginx/nginx.conf:ro\n      - app-uploads:/app/uploads/\n");
  });

  test("add refuses what does not fit", () => {
    expect(() => addVolumeMount(COMPOSE, "api", "/data")).toThrow("no service api in the compose file: web, db");
    expect(() => addVolumeMount(COMPOSE, "web", "data")).toThrow("a folder in the container");
    expect(() => addVolumeMount(COMPOSE, "web", "/etc/nginx/nginx.conf/")).toThrow("web already has a folder at /etc/nginx/nginx.conf/");
    expect(() => addVolumeMount(COMPOSE, "web", "/data", "my data")).toThrow("a volume name takes");
  });

  test("remove unmounts, and drops the declaration once nothing mounts it", () => {
    let y = addVolumeMount(COMPOSE, "web", "/data", "shared").compose;
    y = addVolumeMount(y, "db", "/data", "shared").compose;
    const one = removeVolumeMount(y, "shared", "db");
    expect(one.from).toEqual(["db"]);
    expect(one.compose).toContain("  shared: {}");
    expect(one.compose).not.toContain("  db:\n    image: postgres:17\n    volumes:");
    const all = removeVolumeMount(y, "shared");
    expect(all.from).toEqual(["web", "db"]);
    expect(all.compose).toBe(COMPOSE);
    expect(removeVolumeMount(COMPOSE, "shared")).toEqual({ compose: COMPOSE, from: [] });
  });

  test("remove drops a volumes block it leaves empty", () => {
    const y = addVolumeMount("services:\n  app:\n    image: x\n", "app", "/app/data").compose;
    expect(removeVolumeMount(y, "app-data").compose).toBe("services:\n  app:\n    image: x\n");
  });
});
