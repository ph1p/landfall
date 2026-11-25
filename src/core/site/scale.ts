import { currentRelease, type Service, type SiteMeta } from "./meta";
import { matchText, splitGroups } from "./routing";

/** How many containers each service runs and how it updates: what \`lf scale --json\` prints. */
export interface ScaleRow {
  service: string;
  replicas: number;
  /** Where the count comes from: lf scale, compose.yaml's deploy.replicas (or scale:), or Compose's default of 1. */
  source: "lf scale" | "compose.yaml" | "default";
  update: "rolling" | "recreate";
  /** Its share of a traffic split, and the split's name. */
  weight?: number;
  split?: string;
  /** What sends a request to it whatever the weights: "cookie ab=b", "header X-Variant=b". */
  match?: string;
}

/** The services of the live release with their container counts, update mode and traffic shares. */
export function scaleView(meta: SiteMeta): ScaleRow[] {
  const services = currentRelease(meta)?.services ?? [];
  const members = new Map(
    splitGroups(meta, services).flatMap((g) =>
      g.members.map((m) => [m.service.name, { weight: m.weight, split: g.name, ...(m.service.match && { match: matchText(m.service.match) }) }] as const),
    ),
  );
  return services.map((s) => ({
    service: s.name,
    replicas: wantedReplicas(meta, s),
    source: meta.scale?.[s.name] !== undefined ? "lf scale" : s.replicas !== undefined ? "compose.yaml" : "default",
    update: s.update ?? "recreate",
    ...members.get(s.name),
  }));
}

/** How many containers of `s` should run: lf scale's count, else compose.yaml's, else one. */
export const wantedReplicas = (meta: Pick<SiteMeta, "scale">, s: Service) => meta.scale?.[s.name] ?? s.replicas ?? 1;

/** A row that uses replicas, rolling deploys or a split: worth showing. */
export const scales = (r: Pick<ScaleRow, "replicas" | "update" | "split">) => r.replicas !== 1 || r.update === "rolling" || !!r.split;
