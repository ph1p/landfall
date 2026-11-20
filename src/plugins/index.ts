// The plugins landfall ships with. They use the same API as yours (src/core/plugin-api.ts).
import type { Plugin } from "../core/plugin-api";
import fail2ban from "./fail2ban";
import trivy from "./trivy";

export const BUILTIN: Plugin[] = [fail2ban, trivy];
