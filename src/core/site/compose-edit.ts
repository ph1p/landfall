import { Document, isMap, isSeq, parseDocument, YAMLSeq, type YAMLMap } from "yaml";
import type { Analysis } from "./analyze";
import { fail } from "../lib/term";

/** The named volume for a folder in the container: /app/storage is app-storage. */
export const volumeName = (target: string) => target.replace(/^\/+|\/+$/g, "").replace(/[^\w.-]+/g, "-") || "data";

/** A folder in a container: absolute, as `--volume` and `lf volume add` take it. */
export const CONTAINER_PATH = /^\/[\w./-]*\w\/*$/;
/** A named volume's key in compose.yaml. */
export const VOLUME_KEY = /^\w[\w.-]*$/;

/** A compose.yaml volume entry ("db:/var/lib/data:ro" or the long syntax): the named volume it mounts (none: a bind mount or anonymous) and where. */
export function mountOf(item: unknown): { key?: string; path?: string } {
  if (typeof item === "string") {
    const [src, dst] = item.split(":");
    if (dst === undefined) return { path: src };
    return { key: VOLUME_KEY.test(src) ? src : undefined, path: dst };
  }
  if (!item || typeof item !== "object") return {};
  const o = item as Record<string, unknown>;
  return {
    key: (o.type ?? "volume") === "volume" && typeof o.source === "string" ? o.source : undefined,
    path: typeof o.target === "string" ? o.target : undefined,
  };
}

/** mountOf for an item of a parsed document's volumes list. */
const nodeMount = (i: unknown) => mountOf((i as { toJSON?: () => unknown })?.toJSON?.() ?? i);

/**
 * compose.yaml with a named volume `key` mounted at `path` in `service`, declared under the top-level
 * volumes too: plain Compose, comments and order kept. The key defaults to the path's last folders (/app/data: app-data).
 */
export function addVolumeMount(text: string, service: string, path: string, key = volumeName(path)): { compose: string; key: string } {
  if (!CONTAINER_PATH.test(path)) fail(`a volume goes on a folder in the container, like /app/data: not ${path}`);
  if (!VOLUME_KEY.test(key)) fail(`a volume name takes letters, digits, ., _ and -: not ${key}`);
  const doc = parseDocument(text);
  const svc = doc.getIn(["services", service], true);
  if (!isMap(svc)) {
    const names = Object.keys((doc.toJS()?.services ?? {}) as object);
    fail(`no service ${service} in the compose file${names.length ? `: ${names.join(", ")}` : ""}`);
  }
  const s = svc as YAMLMap;
  const at = (p: string) => p.replace(/\/+$/, "");
  const list = s.get("volumes", true);
  const taken = isSeq(list) ? list.items.map(nodeMount).find((m) => m.path && at(m.path) === at(path)) : undefined;
  if (taken) fail(`${service} already has ${taken.key ? `volume ${taken.key}` : "a folder"} at ${path}`);
  const entry = doc.createNode(`${key}:${path}`);
  if (isSeq(list)) list.items.push(entry);
  else {
    const seq = new YAMLSeq();
    seq.items.push(entry);
    s.set("volumes", seq);
  }
  const top = doc.get("volumes", true);
  if (!isMap(top) || !top.has(key)) doc.setIn(["volumes", key], doc.createNode({}, { flow: true }));
  return { compose: doc.toString(), key };
}

/**
 * compose.yaml without the named volume `key`: its mounts (in `service` only, if given) and, once nothing mounts it,
 * its top-level declaration. Lists and maps left empty go too. The data stays on the server. `from` is empty when nothing mounts it.
 */
export function removeVolumeMount(text: string, key: string, service?: string): { compose: string; from: string[] } {
  const doc = parseDocument(text);
  const services = doc.get("services", true);
  const from: string[] = [];
  let left = false;
  if (isMap(services))
    for (const pair of services.items) {
      const name = String((pair.key as any)?.value ?? pair.key);
      const list = isMap(pair.value) ? pair.value.get("volumes", true) : undefined;
      if (!isSeq(list)) continue;
      const mine = (i: unknown) => nodeMount(i).key === key;
      if (service && name !== service) {
        left ||= list.items.some(mine);
        continue;
      }
      const keep = list.items.filter((i) => !mine(i));
      if (keep.length === list.items.length) continue;
      from.push(name);
      if (keep.length) list.items = keep;
      else (pair.value as YAMLMap).delete("volumes");
    }
  if (!from.length) return { compose: text, from };
  const top = doc.get("volumes", true);
  if (!left && isMap(top)) {
    top.delete(key);
    if (!top.items.length) doc.delete("volumes");
  }
  return { compose: doc.toString(), from };
}

/**
 * `lf init` on an existing compose file: writes down what auto mode routes as x-landfall, and moves published
 * `ports:` into the local-only override (merged with one that exists). Comments and order stay.
 */
export function adoptCompose(
  text: string,
  override: string | undefined,
  a: Analysis,
): { compose: string; override: string; routed: string[]; moved: string[] } {
  const doc = parseDocument(text);
  const over = override !== undefined ? parseDocument(override) : new Document({ services: {} });
  if (override === undefined) over.commentBefore = " Local only: docker compose merges this file, lf deploy leaves it out.";
  const routed: string[] = [];
  const moved: string[] = [];
  for (const s of a.services) {
    const svc = doc.getIn(["services", s.name], true);
    if (!isMap(svc)) continue;
    if (a.auto && (s.port || s.routes?.length)) {
      const x = doc.createNode({
        ...(s.port && { port: s.port }),
        ...(s.routes?.length && { routes: s.routes.map((r) => ({ port: r.port, subdomain: r.subdomain })) }),
      }) as YAMLMap;
      const routes = x.get("routes", true);
      if (isSeq(routes)) for (const r of routes.items) if (isMap(r)) r.flow = true;
      svc.set("x-landfall", x);
      routed.push(s.name);
    }
    const ports = svc.get("ports", true);
    if (!isSeq(ports) || svc.getIn(["x-landfall", "publish"])) continue;
    const local = over.getIn(["services", s.name, "ports"], true);
    const have = new Set(isSeq(local) ? local.items.map((i) => JSON.stringify((i as any)?.toJSON?.() ?? i)) : []);
    // The nodes themselves, so "8080:80" stays quoted (unquoted, YAML 1.1 reads it as a number in base 60).
    const add = ports.items.filter((i) => !have.has(JSON.stringify((i as any)?.toJSON?.() ?? i))).map((i) => (i as any)?.clone?.() ?? i);
    if (isSeq(local)) local.items.push(...add);
    else {
      const seq = new YAMLSeq();
      seq.items.push(...add);
      over.setIn(["services", s.name, "ports"], seq);
    }
    svc.delete("ports");
    moved.push(s.name);
  }
  return { compose: doc.toString(), override: over.toString(), routed, moved };
}
