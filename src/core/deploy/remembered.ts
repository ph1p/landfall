import fs from "node:fs";
import { join, resolve } from "node:path";
import { configDir, environmentOf, loadProject, saveProject, tildify, writeAtomic, type ProjectConfig } from "../lib/config";
import type { SiteKind } from "../site/meta";
import { warn } from "../lib/term";

export interface Remembered {
  path: string;
  name: string;
  server: string;
  domains: string[];
  kind: SiteKind;
  /** The environment of .landfall.json it was deployed as (lf deploy -E). */
  environment?: string;
  /** Last deploy. */
  at: string;
}

const PROJECTS = join(configDir, "projects.json");

export const loadProjects = (): Remembered[] => readProjects() ?? [];

/** Undefined when the file is there but not readable: writing over it would lose the list. */
function readProjects(): Remembered[] | undefined {
  if (!fs.existsSync(PROJECTS)) return [];
  try {
    const list = JSON.parse(fs.readFileSync(PROJECTS, "utf8"));
    return Array.isArray(list) ? (list as Remembered[]).filter((p) => fs.existsSync(p.path)) : undefined;
  } catch {
    return undefined;
  }
}

function saveProjects(list: Remembered[]) {
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeAtomic(PROJECTS, JSON.stringify(list, null, 2) + "\n", 0o600);
}

const unreadable = () => warn(`${tildify(PROJECTS)} is not readable JSON: left as it is (fix or delete it)`);

/** Most recent first; one entry per folder. */
export function rememberProject(p: Omit<Remembered, "at">) {
  const path = resolve(p.path);
  // One entry per folder and environment: staging and production deploy from the same folder.
  const known = readProjects();
  if (!known) return unreadable();
  saveProjects(
    [{ ...p, path, at: new Date().toISOString() }, ...known.filter((x) => x.path !== path || (x.environment ?? "") !== (p.environment ?? ""))].slice(0, 50),
  );
}

/** The project with `redirects` set, or without the key when there are none. */
export function withRedirects(p: ProjectConfig, redirects: string[]): ProjectConfig {
  const { redirects: _, ...rest } = p;
  return redirects.length ? { ...rest, redirects } : rest;
}

/** Keep remembered projects and their .landfall.json in step after a site's domains and redirects changed on the server. */
export function updateProjectDomains(server: string, name: string, domains: string[], redirects: string[]) {
  const list = readProjects();
  if (!list) return unreadable();
  for (const p of list.filter((p) => p.server === server && p.name === name)) {
    p.domains = domains;
    const env = environmentOf(p.path, name);
    // The server already changed: a project file that is gone or broken only misses the update.
    let cfg;
    try {
      cfg = env === undefined ? undefined : loadProject(p.path, env);
    } catch {}
    if (cfg?.name === name) saveProject(p.path, withRedirects({ ...cfg, domains }, redirects), env);
  }
  if (list.length) saveProjects(list);
}
