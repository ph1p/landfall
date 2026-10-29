// Container status rules shared by the CLI and the web UI (no node imports).

export const isUp = (status: string) => /^up/i.test(status);
/** A one-shot service that finished fine: not down. */
export const isDone = (status: string) => /^exited \(0\)/i.test(status);

/** A container status read as: up, up but not healthy (yet) or restarting, a one-shot that finished, or down. */
export type StatusKind = "up" | "warn" | "done" | "down";
export const statusKind = (status: string): StatusKind =>
  /^restarting|\((unhealthy|health: starting)\)/i.test(status) ? "warn" : isUp(status) ? "up" : isDone(status) ? "done" : "down";
/** Higher is worse: what a group of containers shows as its one status. */
export const STATUS_RANK: Record<StatusKind, number> = { up: 0, done: 1, warn: 2, down: 3 };
