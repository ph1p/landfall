import {
  ArrowRightLeft,
  Box,
  Container,
  FolderGit2,
  Globe,
  HardDrive,
  Laptop,
  Package,
  Plus,
  Server,
  UserRound,
  Waypoints,
  type LucideIcon,
} from "lucide-react";
import type { GraphOptions, Health, NodeKind } from "../../../../core/views/infra-graph";

export const PAD = 48;

export const HEAD = 40;

export const MIN_K = 0.25;

export const MAX_K = 1.6;

/** Fitting never shrinks the map below this; the rest is a scroll away. */
export const FIT_K = 0.6;

/** Room for the search and zoom bar above the map. */
export const TOOLBAR = 44;

/** How far the map may be pushed past a window edge. */
export const EDGE = 40;

export const ICON: Record<NodeKind, LucideIcon> = {
  machine: Laptop,
  project: FolderGit2,
  server: Server,
  proxy: Waypoints,
  site: Package,
  external: Box,
  container: Container,
  service: Container,
  volume: HardDrive,
  domain: Globe,
  redirect: ArrowRightLeft,
  tenant: UserRound,
  add: Plus,
};

export const TINT: Partial<Record<NodeKind, string>> = {
  machine: "text-dim",
  project: "text-dim",
  server: "text-accent",
  proxy: "text-accent",
  site: "text-accent",
  tenant: "text-accent",
  domain: "text-ok",
};

export const STROKE: Record<Health, string> = { up: "var(--ok)", warn: "var(--warn)", down: "var(--bad)", "": "var(--line-strong)" };

export const DASHED = new Set(["tunnel", "deploys", "redirect"]);

export const LAYERS: [Exclude<keyof GraphOptions, "folded">, string][] = [
  ["containers", "Containers"],
  ["volumes", "Volumes"],
  ["domains", "Domains"],
  ["others", "Not landfall's"],
  ["tenants", "Tenants"],
  ["add", "Add buttons"],
];

export const PROJECT = "application/x-landfall-project";
