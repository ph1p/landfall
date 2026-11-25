// The plugins landfall ships with. They use the same API as yours (src/core/plugins/plugin-api.ts).
import type { Plugin } from "../core/plugins/plugin-api";
import fail2ban from "./fail2ban";
import trivy from "./trivy";

export const BUILTIN: Plugin[] = [fail2ban, trivy];
