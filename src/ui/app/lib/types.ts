// What the API returns: the CLI's --json shapes, taken from core. Type-only imports: no node code reaches the page.
import type { browse } from "../../server/local";
import type { state } from "../../server/server";
import type { configView, dnsView, factsView, firewallView, historyBrief, systemView, updatesView } from "../../../core/views";
export type { ProjectConfig } from "../../../core/config";
import type { Stats } from "../../../core/stats";
import type { Advice } from "../../../core/security";
import type { JobInfo } from "./jobs";
import type { volumes } from "../../../core/volumes";

type View<F extends (...args: any) => any> = Awaited<ReturnType<F>>;

export type { Advice, Stats };
export type { Detected, Remembered } from "../../../core/projects";
export type { Analysis, Release, Route, Service, SiteKind, SiteMeta } from "../../../core/compose";
export type { External, Overview, SiteStatus, Unrouted } from "../../../core/remote";
export type { Reach } from "../../../core/ssh";
export type { Cap, DnsCheck } from "../../../core/facts";
export type { Step } from "../../../core/journal";
export type { ImageStatus, PkgUpdate } from "../../../core/updates";
export type { ContainerStats, DiskUsage } from "../../../core/stats";
export type { ImageScan, Severity, TrivyState, Vuln } from "../../../core/scan";
export type { PrunePlan } from "../../../core/reclaim";
export type { Cert, CertError, Certs } from "../../../core/traffic";
export type { Detail, HostTraffic, StatusClass, Summary, Traffic } from "../../../core/traffic-merge";
export type { Account, Users } from "../../../core/users";
export type { TraefikRoute, TraefikStatus } from "../../../core/traefik";

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
