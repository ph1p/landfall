// What the API returns: the CLI's --json shapes, declared here since their modules import node.

// ---- /api/state ---------------------------------------------------------------

export interface SavedServer {
  host: string;
  user?: string;
  port?: number;
  key?: string;
  email?: string;
  staging?: boolean;
  traefikImage?: string;
  hostNetwork?: boolean;
  http3?: boolean;
  domains?: string[];
  tunnelOnly?: boolean;
  admin?: string;
  dashboard?: { host: string; user: string };
}

export interface ServerEntry { name: string; registered: boolean; isDefault: boolean; target: string; saved: SavedServer | null }

export interface ProjectConfig {
  name: string;
  server?: string;
  domains: string[];
  compose?: string;
  dir?: string;
  spa?: boolean;
  static?: boolean;
  image?: string;
  port?: number;
  build?: string;
  start?: string;
  volumes?: string[];
  worker?: boolean;
  gitignore?: boolean;
  environments?: Record<string, Partial<Omit<ProjectConfig, "environments">>>;
}

export interface Remembered { path: string; name: string; server: string; domains: string[]; kind: string; environment?: string; at: string }

export interface Where { path: string; what: string }

export interface DefaultsView {
  configFile: string;
  default: string | null;
  defaults: { tunnelOnly?: boolean; email?: string; keep?: number };
  tunnelOnly: boolean;
  email: string | null;
  keep: number;
  locations: { local: Where[]; server: Where[] };
}

export interface State {
  version: string;
  cwd: string;
  project: ProjectConfig | null;
  projects: Remembered[];
  defaultImage: string;
  rules: { loginName: string; userName: string; minPassword: number; domain: string; siteName: string };
  paths: { root: string; sites: string; traefik: string; journal: string; proxy: string };
  defaults: DefaultsView;
  servers: ServerEntry[];
  jobs: import("./jobs").JobInfo[];
}

export interface Reach { state: "ok" | "login" | "down"; detail?: string; ms?: number }

// ---- sites ----------------------------------------------------------------------

export interface Route { port: number; subdomain?: string; domains?: string[] }

export interface Service {
  name: string;
  networks?: string[];
  build?: boolean;
  port?: number;
  domains?: string[];
  own?: boolean;
  routes?: Route[];
  private?: Record<string, number>;
  unpublish?: boolean;
}

export interface Release { id: string; at: string; services: Service[]; git?: { commit: string; branch?: string; dirty?: boolean }; by?: string }

export interface SiteMeta {
  v: number;
  name: string;
  kind: "compose" | "static" | "image" | "dockerfile";
  domains: string[];
  auth?: string[];
  current: string;
  releases: Release[];
  adopted?: string;
  project?: string;
  secrets?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SiteStatus {
  meta: SiteMeta;
  status: string;
  services: { service: string; container: string; status: string }[];
  domains: string[];
  main?: string;
  state: "managed" | "adopted" | "old";
  kind: string;
}

export interface External { name: string; domains: string[]; status: string; containers: string[]; dir?: string; files?: string[] }
export interface Unrouted { container: string; status: string; image: string; project?: string; service?: string; ports: number[] }

export interface Overview {
  ready: boolean;
  traefik: string;
  proxy: string;
  adopted: boolean;
  sites: SiteStatus[];
  others: External[];
  dashboard: { hosts: string[]; tunnel: boolean };
  unrouted: Unrouted[];
}

export interface Volumes {
  volumes: { name: string; key: string; size?: number; mounts: { service: string; path: string }[] }[];
  backups: { file: string; size: number; time: string }[];
  schedule?: string;
}

export interface UrlCheck {
  domain: string;
  ok: boolean;
  status?: number;
  ms?: number;
  error?: string;
  tls?: { valid: boolean; error?: string; expires: string; days: number; issuer: string };
}
export interface DnsCheck { domain: string; ips: string[]; ok: boolean }
export interface Dns { ips: string[]; domains: (DnsCheck & { https: UrlCheck })[] }

// ---- a local folder -------------------------------------------------------------

export interface Analysis {
  services: Service[];
  errors: string[];
  warnings: string[];
  auto?: boolean;
  notes: string[];
  routes?: { service: string; port: number; domains: string[]; main?: boolean }[];
}

export type SiteKind = SiteMeta["kind"];

export interface Detected {
  path: string;
  name: string;
  kind: SiteKind;
  compose?: string;
  dir?: string;
  port?: number;
  build?: string;
  tool?: string;
  start?: string;
  runtime?: string;
  note?: string;
  volumes?: string[];
  worker?: boolean;
  node?: boolean;
  analysis?: Analysis;
  project?: ProjectConfig;
  stack: { label: string; role: "language" | "framework" | "tooling" }[];
}

export interface Browse { path: string; parent: string | null; home: string; dirs: string[]; detected: Detected }

/** An existing site a folder redeploys. */
export interface Redeploy { server: string; name: string; domains: string[]; old?: boolean }

// ---- a server -------------------------------------------------------------------

export type Cap = "setup" | "packages" | "docker" | "compose" | "firewall" | "services" | "admin" | "users";

export interface Facts {
  name: string;
  os: string;
  id: string;
  version: string;
  like: string;
  arch: string;
  kernel: string;
  uptime: number;
  cpus: number;
  load: string;
  mem: { total: number; available: number };
  disk: { total: number; used: number; available: number };
  pkg: string;
  docker: string;
  compose: string;
  podman: string;
  platform: string;
  init: "systemd" | "openrc" | "other";
  user: string;
  admin: boolean;
  ufw: boolean;
  usertool: string;
  ip4: string;
  ip6: string;
  reboot: boolean;
  support: { level: "ok" | "eol" | "unsupported" | "limited"; note?: string };
  can: Record<Cap, boolean>;
  why: Partial<Record<Cap, string>>;
  ips: string[];
  sslipIp: string | null;
  sslipSuffix: string | null;
}

export interface Firewall {
  ufw: "active" | "inactive" | "missing";
  policy: string;
  sshPort: number;
  rules: FirewallRule[];
  ports: { port: string; proc: string; state: "open" | "limited" | "blocked" | "local"; why: string }[];
  blocked: string[];
  asRoot: boolean;
}
export interface FirewallRule { n: number; spec: string; action: "allow" | "deny" | "reject" | "limit"; port?: string; proto?: "tcp" | "udp"; from?: string; comment?: string; out: boolean }

export interface DomainDns { ips: string[]; apex: DnsCheck; wildcard: DnsCheck }

export interface Config {
  name: string;
  isDefault: boolean;
  configFile: string;
  saved: SavedServer | null;
  domains: string[];
  tunnelOnly: boolean;
  tunnelOnlyOwn: boolean;
  traefik: { email?: string; staging: boolean; image: string; hostNetwork: boolean; http3: boolean; summary: string; dashboard: string | null };
  ssh: {
    hostname: string;
    user: string;
    port: number;
    keys: { file: string; exists: boolean }[];
    block: { file: string; line: number; managed: boolean; text: string } | null;
  };
  dns: DomainDns[];
  suggest: { domain: string; hosts: number }[];
}

export interface Step { line: number; time: string; user: string; what: string; undo?: string; undone: boolean; reverts?: number }
export interface Run { n: number; id: string; time: string; actor: string; cmd: string; steps: Step[]; pending: number }

export interface PkgUpdate { name: string; from?: string; to: string; security: boolean }
export interface ImageStatus {
  name: string;
  kind: "traefik" | "site" | "proxy";
  container: string;
  service?: string;
  dir: string;
  ref: string;
  state: "current" | "update" | "unknown" | "pinned" | "rebuild" | "foreign" | "missing";
  note?: string;
  newer?: string;
}
export interface Updates {
  packages: { mgr: string; updates: PkgUpdate[]; refreshed: boolean; reboot: boolean };
  images: ImageStatus[];
  engine: {
    docker: string;
    compose: string;
    composePath: string;
    dockerCe: boolean;
    synology: boolean;
    latestDocker?: string;
    latestCompose?: string;
    dockerNote?: string;
    composeNote?: string;
    composeUpdate: boolean;
    dockerHow?: string;
    composeHow?: string;
  };
}

export interface ContainerStats {
  name: string;
  site?: string;
  project?: string;
  service?: string;
  image: string;
  status: string;
  cpu: number;
  mem: number;
  memLimit: number;
  net: { rx: number; tx: number };
  block: { read: number; write: number };
  pids: number;
  restarts: number;
}
export interface Disk { mount: string; total: number; used: number; available: number }
export interface Stats {
  at: string;
  uptime: number;
  cpus: number;
  load: [number, number, number];
  cpu: number;
  mem: { total: number; available: number; swapTotal: number; swapFree: number };
  disks: Disk[];
  net: { iface: string; rx: number; tx: number }[];
  procs: { pid: number; name: string; cpu: number; rss: number }[];
  docker: boolean;
  containers: ContainerStats[];
}

export interface DiskUsage {
  root: boolean;
  disks: Disk[];
  landfall: number;
  sites: { name: string; size: number; releases: number; releasesSize: number }[];
  journald: number;
  docker: boolean;
  dockerDf: { type: string; count: number; active: number; size: number; reclaimable: number }[];
  volumes: { name: string; links: number; size: number }[];
  logs: { container: string; size?: number }[];
}

export interface PrunePlan {
  docker: boolean;
  all: boolean;
  images: { id: string; tags: string[]; size: number; created: string; keep?: "used" | "release" | "undo" | "tagged" }[];
  buildCache: number;
}

export type StatusClass = "2xx" | "3xx" | "4xx" | "5xx";
export interface Summary { requests: number; bytes: number; classes: Record<StatusClass, number>; codes: Record<string, number>; p50: number; p95: number }
export interface Detail extends Summary {
  paths: { path: string; count: number; errors: number }[];
  ips: { ip: string; count: number }[];
  errors: { status: number; path: string; count: number }[];
  series: ({ at: string } & Record<StatusClass, number>)[];
}
export interface HostTraffic extends Detail { host: string; site?: string; hist: Record<string, number> }
export interface Traffic {
  at: string;
  since: number;
  bucket: "minute" | "hour";
  proxy: boolean;
  own: boolean;
  format: "json" | "common" | "none";
  from?: string;
  to?: string;
  total: Detail;
  sites: (Summary & { site: string; hosts: string[] })[];
  hosts: HostTraffic[];
}

export interface Cert { domains: string[]; expires: string; days: number; issuer: string; staging: boolean; source: "acme" | "file"; path?: string }
export interface CertError { at?: string; domains: string[]; error: string }
export interface Certs {
  at: string;
  proxy: boolean;
  acme: string[];
  denied: string[];
  certs: Cert[];
  errors: CertError[];
  domains: { domain: string; site: string; cert?: Cert; error?: CertError }[];
}

export interface SystemService { unit: string; load: string; active: string; sub: string; description: string; enabled?: string }
export interface Advice {
  id: string;
  level: "risk" | "warn" | "info";
  title: string;
  why: string;
  fix?: { label: string; argv: string[]; confirm?: string; user?: string };
}
export interface SystemInfo {
  root: boolean;
  user: string;
  hostname: string;
  timezone: string;
  ntp?: boolean;
  time: string;
  init: "systemd" | "openrc" | "other";
  swap: { file: string; type: string; size: number; used: number }[];
  swappiness?: number;
  diskFree: number;
  mem: number;
  docker?: { driver: string; maxSize?: string; maxFile?: number; daemon: Record<string, unknown>; daemonError?: string };
  services: SystemService[];
  fail2ban: "running" | "stopped" | "missing";
  jails: { name: string; banned: number; total: number; failed: number; ips: string[] }[];
  keys: { user: string; type: string; fingerprint: string; comment: string; options: string; line: string; mine?: boolean }[];
  security: {
    passwordLogin?: boolean;
    rootLogin?: string;
    passwordUsers?: string[];
    pkg?: string;
    firewall?: "active" | "inactive" | "missing";
    autoUpdates?: boolean;
    reboot: boolean;
    platform?: string;
  };
  managed?: string;
  advice: Advice[];
}

export interface Account {
  name: string;
  uid: number;
  home: string;
  shell: string;
  groups: string[];
  sudo: boolean;
  nopasswd: boolean;
  password: "set" | "locked" | "none";
  keys: number;
  login: boolean;
  me: boolean;
  keep?: string;
}
export interface Users { admin: string; sudo: boolean; passwordLogin?: boolean; accounts: Account[] }

/** What a job told the UI through report(), merged: each command sets its own fields. */
export interface Report {
  refuse?: string;
  needsKey?: boolean;
  checks?: { part: string; label: string; status: string; detail: string }[];
  advice?: Advice[];
  url?: string;
  lan?: string[];
  force?: string;
  password?: string;
  keyFile?: string;
}
