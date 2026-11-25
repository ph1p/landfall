// What the API returns: the CLI's --json shapes, taken from core. Type-only imports: no node code reaches the page.
import type { browse } from "../../server/local";
import type { state } from "../../server/server";
import type { ciView } from "../../../core/deploy/ci";
import type { configView, dnsView, gitView, factsView, firewallView, historyBrief, systemView, updatesView } from "../../../core/views/views";
export type { ProjectConfig } from "../../../core/lib/config";
import type { Stats } from "../../../core/server/stats";
import type { Advice } from "../../../core/server/security";
import type { JobInfo } from "./jobs";
import type { volumes } from "../../../core/site/volumes";

type View<F extends (...args: any) => any> = Awaited<ReturnType<F>>;

export type { Advice, Stats };
export type { Detected, Remembered } from "../../../core/deploy/projects";
export type { Analysis, Release, Route, Service, SiteKind, SiteMeta } from "../../../core/site/compose";
export type { External, Overview, SiteStatus, Unrouted } from "../../../core/site/remote";
export type { Reach } from "../../../core/ssh/ssh";
export type { Cap, DnsCheck } from "../../../core/server/facts";
export type { Step } from "../../../core/ssh/journal";
export type { ImageStatus, PkgUpdate } from "../../../core/server/updates";
export type { ContainerStats, DiskUsage } from "../../../core/server/stats";
export type { ImageScan, Severity, TrivyState, Vuln } from "../../../core/server/scan";
export type { PrunePlan } from "../../../core/server/reclaim";
export type { Cert, CertError, Certs } from "../../../core/traefik/traffic";
export type { Detail, HostTraffic, StatusClass, Summary, Traffic } from "../../../core/traefik/traffic-merge";
export type { Account, Users } from "../../../core/server/users";
export type { TraefikRoute, TraefikStatus } from "../../../core/traefik/traefik";
export type { EnvRefs, RefsView } from "../../../core/views/views";
export type { AutodeployView } from "../../../core/deploy/autodeploy";
export type { Ref, RefKind, RefRule } from "../../../core/deploy/refs";

// ---- a project's git (lf git track, lf refs) ----------------------------------

/** GET /api/git?path=: the checkout, its branches and tags, and the rules of .landfall.json. */
export type GitInfo = Awaited<ReturnType<typeof gitView>>;

/** GET /api/ci?path=&forge=: what lf ci init would write and set (lf ci init --dry-run --json). */
export type CiView = Awaited<ReturnType<typeof ciView>>;

// ---- /api/state ---------------------------------------------------------------

export type State = Omit<View<typeof state>, "jobs"> & { jobs: JobInfo[] };
export type ServerEntry = State["servers"][number];
export type SavedServer = NonNullable<ServerEntry["saved"]>;
export type DefaultsView = State["defaults"];
export type Where = DefaultsView["locations"]["local"][number];

// ---- sites ----------------------------------------------------------------------

export type Volumes = View<typeof volumes>;
export type Dns = View<typeof dnsView>;
export type UrlCheck = Dns["domains"][number]["https"];

// ---- a local folder -------------------------------------------------------------

export type Browse = View<typeof browse>;

/** An existing site a folder redeploys. */
export interface Redeploy {
  server: string;
  name: string;
  domains: string[];
  redirects?: string[];
}

// ---- a server -------------------------------------------------------------------

export type Facts = View<typeof factsView>;
export type Firewall = View<typeof firewallView>;
export type FirewallRule = Firewall["rules"][number];
export type Config = View<typeof configView>;
export type DomainDns = Config["dns"][number];
export type Run = View<typeof historyBrief>[number];
export type Updates = View<typeof updatesView>;
export type Disk = Stats["disks"][number];
export type SystemInfo = View<typeof systemView>;
export type SystemService = SystemInfo["services"][number];

/** What a job told the UI through report(), merged: each command sets its own fields. */
export interface Report {
  /** It journaled a change lf undo can take back. */
  undoable?: boolean;
  refuse?: string;
  needsKey?: boolean;
  checks?: { part: string; label: string; status: string; detail: string }[];
  advice?: Advice[];
  url?: string;
  lan?: string[];
  force?: string;
  /** It needs root and the login may sudo only with a password: the error, which names -K. */
  sudo?: string;
  password?: string;
  keyFile?: string;
}
