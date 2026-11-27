// What a site should not show the world: files that do not belong on a web server, and ports open past the firewall.
// The exposure plugin and the deploy dialog of lf ui both read it.
import fs from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { basename, join } from "node:path";
import { loadProject, type ProjectConfig } from "../lib/config";
import { fail } from "../lib/fail";
import { isPlain } from "../site/analyze";
import { isLoopback } from "../server/inventory";
import { localCompose, longPort } from "../site/compose-config";
import { matches, parseIgnore, uploadList } from "./ignore";
import { composeFile } from "./projects";
import { bySeverity, classify, keyName, type Severity } from "../site/file-rules";

export { classify, type Severity };

/** Well-known ports of databases, caches and admin interfaces: never meant for the internet. */
const SENSITIVE_PORTS: Record<number, string> = {
  2375: "the Docker API (root on the server)",
  2376: "the Docker API (root on the server)",
  3306: "MySQL",
  5432: "PostgreSQL",
  6379: "Redis",
  9200: "Elasticsearch",
  11211: "memcached",
  27017: "MongoDB",
  5984: "CouchDB",
  8086: "InfluxDB",
  9090: "Prometheus",
  15672: "RabbitMQ admin",
  5672: "RabbitMQ",
  9000: "an admin interface (MinIO, Portainer, PHP-FPM)",
};

const portSeverity = (port?: number): Severity => (port && SENSITIVE_PORTS[port] ? "high" : "medium");
const portWhat = (port: number) => (SENSITIVE_PORTS[port] ? `${SENSITIVE_PORTS[port]} on ` : "") + `port ${port}`;

interface FileFinding {
  path: string;
  dir: boolean;
  severity: Severity;
  why: string;
}

interface PortFinding {
  service: string;
  port: string;
  /** The container port, when the spec names one. */
  container?: number;
  severity: Severity;
  why: string;
}

/**
 * The ports a compose service publishes on every interface, as written. Docker writes its own iptables rules,
 * so these are open even when ufw blocks the port. Loopback bindings (127.0.0.1:5432:5432) are fine.
 */
function publishedPorts(svc: any): { spec: string; container: number | undefined }[] {
  const out: { spec: string; container: number | undefined }[] = [];
  for (const p of (svc?.ports ?? []).flatMap(longPort)) {
    if (p.host_ip && isLoopback(String(p.host_ip))) continue;
    out.push({ spec: `${p.host_ip ? `${p.host_ip}:` : ""}${p.published ?? "random"}:${p.target}`, container: Number(p.target) || undefined });
  }
  return out;
}

/** A compose file's published ports. A plain one (no x-landfall, no Traefik labels) has them dropped on the server. */
export function composePorts(config: any): PortFinding[] {
  if (!config?.services || isPlain(config)) return [];
  const out: PortFinding[] = [];
  for (const [name, svc] of Object.entries<any>(config.services))
    for (const p of publishedPorts(svc))
      out.push({
        service: name,
        port: p.spec,
        container: p.container,
        severity: portSeverity(p.container),
        why: `publishes ${p.container ? portWhat(p.container) : p.spec} on every interface, past the firewall: bind it to 127.0.0.1, or use expose and lf tunnel`,
      });
  return out;
}

/** The first 64 KB of a file, as text; empty when it cannot be read. */
async function head(file: string): Promise<string> {
  let fd: FileHandle | undefined;
  try {
    fd = await open(file);
    const { buffer, bytesRead } = await fd.read({ buffer: Buffer.alloc(65536) });
    return buffer.toString("utf8", 0, bytesRead);
  } catch {
    return "";
  } finally {
    await fd?.close();
  }
}

/** What a deploy of `root` would upload that should not be on a server. A flagged folder is reported once, not its contents. */
export async function checkFiles(
  root: string,
  o: { project?: string; gitignore?: boolean; rules?: { exclude?: string[]; include?: string[] } } = {},
): Promise<FileFinding[]> {
  const out: FileFinding[] = [];
  let skip = "";
  for (const e of await uploadList(root, o)) {
    if (skip && e.path.startsWith(skip)) continue;
    const name = basename(e.path);
    let hasKey = false;
    if (!e.dir && keyName(name)) hasKey = (await head(join(root, e.path))).includes("PRIVATE KEY");
    const r = classify(name, e.dir, hasKey);
    if (!r) continue;
    out.push({ path: e.dir ? `${e.path}/` : e.path, dir: e.dir, severity: r.severity, why: r.why });
    if (e.dir) skip = `${e.path}/`;
  }
  return out;
}

/** The check of a project folder before a deploy. */
export interface ExposureCheck {
  files: FileFinding[];
  ports: PortFinding[];
  /** The compose file the ports come from. */
  compose?: string;
  /** Why the compose file could not be read. */
  composeError?: string;
  /** Whether nothing blocks: no high or medium finding (strict: no finding at all). */
  ok: boolean;
}

/**
 * Checks what lf deploy would upload from the project in `cwd` (its .landfall.json, `dir` or the folder itself),
 * and the ports its compose file publishes. allow: .gitignore patterns of accepted files; allowPorts: accepted container ports.
 */
export async function checkProject(cwd: string, o: { dir?: string; allow?: string[]; allowPorts?: number[]; strict?: boolean } = {}): Promise<ExposureCheck> {
  const project: Partial<ProjectConfig> = loadProject(cwd) ?? {};
  const root = join(cwd, o.dir ?? project.dir ?? ".");
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) fail(`not a folder: ${root}`);
  const allow = parseIgnore((o.allow ?? []).join("\n"));
  const allowPorts = new Set(o.allowPorts ?? []);
  // A pattern accepts the path itself or a folder it sits in, as in .gitignore: --allow keys/ accepts keys/a.key.
  const allowed = (path: string, dir: boolean): boolean =>
    !!matches(allow, path, dir) || (path.includes("/") && allowed(path.slice(0, path.lastIndexOf("/")), true));
  const files = (await checkFiles(root, { project: cwd, gitignore: project.gitignore, rules: project }))
    .filter((f) => !allowed(f.path.replace(/\/$/, ""), f.dir))
    .sort(bySeverity);
  const compose = composeFile(cwd, project);
  let ports: PortFinding[] = [];
  let composeError: string | undefined;
  if (compose && fs.existsSync(join(cwd, compose))) {
    try {
      // Variables come from .env and the environment, as on deploy.
      ports = composePorts(localCompose(cwd, compose))
        .filter((p) => !(p.container && allowPorts.has(p.container)))
        .sort(bySeverity);
    } catch (e) {
      composeError = `${compose} did not parse: ${(e as Error).message}`;
    }
  }
  const ok = ![...files, ...ports].some((f) => f.severity !== "low" || o.strict);
  return { files, ports, compose, composeError, ok };
}
