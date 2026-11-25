import { list, type RefRule } from "../../../../core/deploy/refs";

export const envArgs = (env?: string) => (env ? ["-E", env] : []);

/** Intervals the UI offers; lf autodeploy --every takes any 1m–59m or 1h–23h. */
export const EVERY = ["1m", "5m", "15m", "30m", "1h", "6h"].map((x) => ({ value: x, label: x }));

export const envLabel = (env: string) => env || "project";

export const short = (sha?: string) => sha?.slice(0, 7) ?? "";

export const isTagRule = (r: RefRule | undefined) => list(r?.tag).length > 0;
