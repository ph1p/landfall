import pkg from "../../package.json";
import { plural } from "./format";

/** This landfall's version. Remote scripts get it as $LANDFALL_CLI; the server stamps it into landfall.json. */
export const VERSION: string = pkg.version;

/** Compare dotted versions numerically (a leading v is ignored): negative, 0 or positive. */
export function cmpVersion(a: string, b: string): number {
  const x = a.replace(/^v/, "").split(/[.+-]/).map(Number);
  const y = b.replace(/^v/, "").split(/[.+-]/).map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** a > b; a -prerelease suffix is ignored (as the server's ver_gt does). */
export const versionGt = (a: string, b: string) => cmpVersion(a.replace(/-.*/, ""), b.replace(/-.*/, "")) > 0;

/** How to update, guessed from where this `lf` was installed. */
export function updateCommand(bin = process.argv[1] ?? ""): string {
  if (/[\\/]pnpm[\\/]/.test(bin)) return "pnpm add -g landfall@latest";
  if (/[\\/]\.bun[\\/]/.test(bin)) return "bun add -g landfall@latest";
  if (/[\\/]yarn[\\/]/.test(bin)) return "yarn global add landfall@latest";
  return "npm i -g landfall@latest";
}

/** How a server's landfall compares with this one (/opt/landfall/landfall.json). Stable shape: --json and the web UI read it. */
export interface StampStatus {
  /** The landfall that changed the server last (the journal's last line); undefined: unknown. */
  version?: string;
  /** The newest landfall that ever changed it. */
  newest?: string;
  /** Migrations applied on the server. */
  migration: number;
  /** Migrations this landfall would run (lf server upgrade). */
  pending: { id: number; since: string; what: string; admin?: boolean }[];
  /** A newer landfall changed the server: update lf. */
  newer: boolean;
}

/** One line for humans: "0.17.0 · migration 1", plus what to do when lf or the server is behind. */
export function stampSummary(s: StampStatus, update = updateCommand()): { text: string; note?: string } {
  const text = `${s.version ?? "unknown"} · migration ${s.migration}`;
  if (s.newer) return { text, note: `a newer landfall${s.newest ? ` (${s.newest})` : ""} changed it, yours is ${VERSION}: ${update}` };
  if (s.pending.length) return { text, note: `${plural(s.pending.length, "upgrade")} pending: lf server upgrade` };
  return { text };
}
