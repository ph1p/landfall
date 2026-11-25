import type { ReleaseHooks } from "./hooks";
import { gitParts } from "../deploy/refs";
import { SITES } from "../ssh/templates";

/** A site's secret files, next to its .env; each release links it, so `./.secrets/<name>` works from compose.yaml. */
export const SECRETS_DIR = ".secrets";
/** What a Compose secret may be named, and a safe file name. */
export const SECRET_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/** A service of a release, as `docker compose config` showed it at deploy. */
export interface Service {
  name: string;
  /** Networks it is on; routed ones join the proxy network too. */
  networks: string[];
  /** Built from source: tagged per release, so a rollback never rebuilds. */
  build?: boolean;
  /** x-landfall.port: Traefik routes to this port. */
  port?: number;
  /** x-landfall.domains; none on a routed service = the site's domains (`lf domains`). */
  domains?: string[];
  /** Routed by its own traefik.* labels: landfall only adds the network. */
  own?: boolean;
  /** x-landfall.routes, or the further ports a plain compose.yaml publishes: each on its own domains. */
  routes?: Route[];
  /** x-landfall.private: ports never routed, reached by name with \`lf tunnel <site> <name>\`. */
  private?: Record<string, number>;
  /** x-landfall.private: { admin: { port: 3000, path: /admin } }: the path its tunnel opens, by private name. */
  paths?: Record<string, string>;
  /** A plain compose.yaml's ports: are dropped on the server; Traefik routes them instead. */
  unpublish?: boolean;
  /** x-landfall.allow: the addresses (IPs, CIDRs) that may reach its port; any when none. */
  allow?: string[];
  /** x-landfall's Traefik settings for its port's router: load balancer and middlewares. */
  opts?: RouteOpts;
  /** deploy.replicas (or scale:) in compose.yaml; `lf scale` overrides it (SiteMeta.scale). */
  replicas?: number;
  /** compose.yaml uses the legacy scale: key, so the override sets that one, not deploy.replicas. */
  scaleKey?: true;
  /** Has a healthcheck in compose.yaml (one in the image is not seen here). */
  healthcheck?: true;
  /** Sets container_name: it cannot run more than once. */
  named?: true;
  /** Keeps its ports: on the server (x-landfall.publish): it cannot run more than once either. */
  published?: true;
  /** x-landfall.weight: its share of the traffic to hosts it serves together with other weighted services. */
  weight?: number;
  /** x-landfall.update: rolling. Deploys start new containers beside the old ones and remove those once ready. */
  update?: "rolling";
  /** x-landfall.match: requests with this cookie or header go to this member of a traffic split, whatever the weights. */
  match?: Match;
}

/** Each a name=value pair; a request that has either one matches. */
export interface Match {
  cookie?: string;
  header?: string;
}

/** x-landfall's Traefik settings of one router (opt-in; none: Traefik's defaults). */
export interface RouteOpts {
  /** Sticky sessions: a cookie pins a client to one container; a string names the cookie. */
  sticky?: string | true;
  /** Traefik's own health check: it sends nothing to a container that fails it. */
  healthcheck?: { path: string; interval?: string; timeout?: string };
  /** Requests per second each client IP may make on average, and the burst above that. */
  ratelimit?: { average: number; burst?: number };
  /** gzip/brotli responses. */
  compress?: true;
  /** Response headers to set; an empty value removes one. */
  headers?: Record<string, string>;
  /** Retries a request this many times when the container cannot be reached. */
  retry?: number;
}

/** One more port of a service, on a subdomain of every site domain or on fixed domains. */
export interface Route {
  port: number;
  /** admin: admin.<d> for each of the site's domains (\`lf domains\`). */
  subdomain?: string;
  domains?: string[];
  /** The addresses (IPs, CIDRs) that may reach it; any when none. */
  allow?: string[];
  opts?: RouteOpts;
}

/** Where a release's files came from, in git terms. Every field past commit is optional: older releases lack them. */
export interface ReleaseGit {
  /** Short SHA (12). */
  commit: string;
  sha?: string;
  branch?: string;
  /** The tag deployed, or one at the commit. */
  tag?: string;
  dirty?: boolean;
  /** origin's URL, without credentials. */
  remote?: string;
  /** local: the working tree; ref: a clean export of --ref/--tag; ci: a CI run; server, auto: fetched on the server. */
  source?: "local" | "ref" | "server" | "ci" | "auto";
  ci?: { provider: string; url?: string };
}

export interface Release {
  id: string;
  at: string;
  services: Service[];
  /** The commit it was deployed from, when the project is a git checkout; dirty: with uncommitted changes. */
  git?: ReleaseGit;
  /** Who deployed it: user@machine. */
  by?: string;
  /** The landfall version that deployed it; missing on releases by landfall before 0.17. */
  landfall?: string;
  /** package.json's server hooks as deployed: rollback and removal run the ones of the release they leave or reach. */
  hooks?: ReleaseHooks;
}

/** "a1b2c3d4e5f6 main, uncommitted changes" for a release deployed from git. */
export function gitLabel(g: Release["git"]) {
  if (!g) return "";
  const { source } = gitParts(g);
  return `${g.tag ? `${g.tag} ` : ""}${g.commit}${g.branch ? ` ${g.branch}` : ""}${g.dirty ? ", uncommitted changes" : ""}${source ? `, ${source}` : ""}`;
}

export interface AutodeploySetting {
  /** The environment whose rule it follows; "" for the project's own. */
  env: string;
  /** 5m, 1h: how often cron runs it. */
  every: string;
  /** Branches (newest commit wins) or tags (newest version wins), not both. */
  rule: { branch?: string[]; tag?: string[]; prerelease?: boolean };
  /** The repository the server fetches. */
  url: string;
  /** The project's folder in the repository; "" for its root. */
  dir: string;
}

/** What the site was deployed from: static, image and dockerfile get a generated compose.yaml. */
export type SiteKind = "compose" | "static" | "image" | "dockerfile";

/** Metadata stored on the server next to each site (site.json). */
export interface SiteMeta {
  name: string;
  kind: SiteKind;
  /** Domains of the routed service that names none itself; what `lf domains` changes. */
  domains: string[];
  /** Hosts that answer with a permanent redirect to the first of `domains`, path and query kept (www.example.com). */
  redirects?: string[];
  /** htpasswd lines (user:bcrypt): the site asks for a login. */
  auth?: string[];
  /** Logins of single routes by routeKey (\`lf auth --route\`), in place of the site's; [] = public. */
  routeAuth?: Record<string, string[]>;
  current: string;
  releases: Release[];
  /** Adopted: a Compose project landfall did not deploy, run where it is; `current` points there. */
  adopted?: string;
  /** Compose project name of an adopted site; landfall's own are named like the site. */
  project?: string;
  /** Files in its .secrets folder (lf secret); an app, Dockerfile or image gets each at /run/secrets/<name>. */
  secrets?: string[];
  /** Named volumes kept in the site's folder, volumes/<key>, not in Docker's. Never shrinks: a rollback or undo finds them there too. */
  volumes?: string[];
  /** Containers per service (lf scale), over compose.yaml's deploy.replicas. */
  scale?: Record<string, number>;
  /** Traffic shares per service of a split (lf weight), over compose.yaml's x-landfall.weight. */
  weights?: Record<string, number>;
  /** lf autodeploy: the server's crontab runs autodeploy.sh, which deploys new commits of the rule's branch or tags. */
  autodeploy?: AutodeploySetting;
  createdAt: string;
  updatedAt: string;
}

/** Parsed site.json that has what landfall reads from it. */
export function isSiteMeta(x: unknown): x is SiteMeta {
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  const m = x as Record<string, unknown>;
  return typeof m.name === "string" && Array.isArray(m.domains) && Array.isArray(m.releases) && m.releases.every((r) => Array.isArray(r?.services));
}

export const projectName = (meta: SiteMeta) => meta.project ?? meta.name;

/** Where a volume of the site keeps its files on the server. */
export const volumeDir = (site: string, key: string) => `${SITES}/${site}/volumes/${key}`;

/** The live release. */
export const currentRelease = (meta: SiteMeta) => meta.releases.find((r) => r.id === meta.current);

/** compose, static, … ; or adopted. */
export const kindOf = (meta: { kind: string; adopted?: string }) => (meta.adopted ? "adopted" : meta.kind);

/** Shell that prints each site's site.json on one line, after SITE and a tab. */
export const SITE_LINES = `for f in ${SITES}/*/site.json; do [ -f "$f" ] || continue; printf 'SITE\\t'; tr -d '\\n' < "$f"; echo; done`;
/** The site.json in a SITE_LINES line; undefined for other lines and when it is corrupt. */
export function readSiteLine(line: string): SiteMeta | undefined {
  if (!line.startsWith("SITE\t")) return undefined;
  try {
    const meta = JSON.parse(line.slice("SITE\t".length));
    return isSiteMeta(meta) ? meta : undefined;
  } catch {
    return undefined;
  }
}

/** Image a service built for release `id` is tagged with. */
export const builtImage = (site: string, service: string, id: string) => `${site}-${service.toLowerCase()}:${id}`;
