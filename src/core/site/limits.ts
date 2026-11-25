// Limits shared by the CLI and the web UI (no node imports).

/** Most containers `lf scale` runs of one service. */
export const MAX_REPLICAS = 100;
/** Highest weight of a service in a traffic split. */
export const MAX_WEIGHT = 1000;
