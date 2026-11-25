import fs from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { SECRETS_DIR } from "./meta";

/** The services of a `docker compose config` that mount one of these files of .secrets. */
export function secretUsers(config: any, keys: string[]): string[] {
  const names = Object.entries<any>(config?.secrets ?? {})
    .filter(([, d]) => keys.some((k) => String(d?.file ?? "").endsWith(`/${SECRETS_DIR}/${k}`)))
    .map(([n]) => n);
  return Object.entries<any>(config?.services ?? {})
    .filter(([, s]) => (s?.secrets ?? []).some((x: any) => names.includes(typeof x === "string" ? x : x?.source)))
    .map(([n]) => n);
}

/**
 * The named volumes of `config` (`docker compose config`) that live in the site's folder: Compose's own,
 * with no driver, options or name of their own. Those of `prev` stay unless compose.yaml now makes them its own.
 */
export function folderVolumes(config: any, prev: string[] = []): string[] {
  const vols: Record<string, any> = config?.volumes ?? {};
  const own = (k: string) => {
    const v = vols[k] ?? {};
    return !v.external && !v.driver_opts && (!v.driver || v.driver === "local") && v.name === `${config.name}_${k}`;
  };
  return [...new Set([...prev.filter((k) => !(k in vols) || own(k)), ...Object.keys(vols).filter(own)])].sort();
}

/** Where \`lf eject\` writes a site's override in its project. */
export const EJECT_FILE = "compose.traefik.yaml";
/** Compose file names, in the order `docker compose` looks for them. */
export const COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];
export const OVERRIDE_FILES = ["compose.override.yaml", "compose.override.yml", "docker-compose.override.yaml", "docker-compose.override.yml"];
/** What an environment layers over a compose file, as `docker compose -f compose.yaml -f compose.staging.yaml` would. */
export const envComposeFile = (file: string, env: string) => file.replace(/(\.ya?ml)?$/, (ext) => `.${env}${ext || ".yaml"}`);

/** `${VAR}`, `${VAR:-default}`, `${VAR-default}`, `${VAR:+alt}`, `$VAR` and `$$`, as docker compose fills them in. */
function interpolate(text: string, env: Record<string, string | undefined>): string {
  return text.replace(/\$(?:\$|\{(\w+)(?:(:?[-+?])([^}]*))?\}|(\w+))/g, (m, name, op, arg, bare) => {
    if (m === "$$") return "$";
    const v = env[name ?? bare];
    if (op === ":-") return v || arg;
    if (op === "-") return v ?? arg;
    if (op === ":+") return v ? arg : "";
    if (op === "+") return v !== undefined ? arg : "";
    return v ?? "";
  });
}

/** A short-syntax port (`8080:80`, `127.0.0.1:3000:3000/tcp`, `3000-3002`) in the long form `docker compose config` prints. */
function longPort(p: unknown): any[] {
  if (p && typeof p === "object") return [p];
  const [spec, protocol = "tcp"] = String(p).split("/");
  const at = spec.lastIndexOf(":");
  const target = spec.slice(at + 1);
  const rest = at < 0 ? "" : spec.slice(0, at);
  const pubAt = rest.lastIndexOf(":");
  const published = rest.slice(pubAt + 1) || undefined;
  const host_ip = pubAt < 0 ? undefined : rest.slice(0, pubAt).replace(/^\[|\]$/g, "");
  const range = /^(\d+)-(\d+)$/.exec(target);
  const targets = range ? Array.from({ length: Math.min(Math.max(+range[2] - +range[1] + 1, 0), 100) }, (_, i) => +range[1] + i) : [Number(target)];
  return targets.map((t) => ({ target: t, ...(published && { published }), ...(host_ip && { host_ip }), protocol }));
}

/**
 * A local compose file in the shape `docker compose config` prints, for `analyze`: variables filled from the
 * environment and .env, ports in long form. Overrides are left out, as on deploy.
 */
export function localCompose(dir: string, file: string): any {
  const dotenv: Record<string, string> = {};
  try {
    for (const l of fs.readFileSync(join(dir, ".env"), "utf8").split("\n")) {
      const m = /^\s*(?:export\s+)?(\w+)\s*=\s*(.*?)\s*$/.exec(l);
      if (!m) continue;
      const quoted = /^(["'])(.*)\1$/.exec(m[2]);
      dotenv[m[1]] = quoted ? quoted[2] : m[2].replace(/\s#.*$/, "").trim();
    }
  } catch {}
  const env = { ...dotenv, ...process.env };
  const fill = (v: unknown): unknown =>
    typeof v === "string"
      ? interpolate(v, env)
      : Array.isArray(v)
        ? v.map(fill)
        : v && typeof v === "object"
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]))
          : v;
  const config: any = fill(parseYaml(fs.readFileSync(join(dir, file), "utf8")) ?? {});
  for (const svc of Object.values<any>(config?.services ?? {})) if (Array.isArray(svc?.ports)) svc.ports = svc.ports.flatMap(longPort);
  return config;
}
