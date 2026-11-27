import type { Server } from "../lib/config";
import { shq } from "../lib/quote";
import { JOURNAL, PROXY_FILE, ROOT, SITES, STAMP_FILE, TRAEFIK_DIR } from "./templates";

// Not where /tenants/ follows: a path already under a tenant root stays as it is.
const OWN = /\/opt\/landfall(?!\/tenants\/)(?![\w.-])/g;

// writeFileCmd's payload: a path in a written file (cron scripts, compose files) moves too.
const PAYLOAD = /printf %s '([A-Za-z0-9+/=]*)' \| base64 -d/g;

/** For a tenant server, its root in place of /opt/landfall; for any other server the text unchanged. */
export function remotePath(s: Server, text: string): string {
  const t = s.tenant;
  if (!t) return text;
  const swap = (x: string) => x.replace(OWN, () => t.root);
  return swap(text).replace(PAYLOAD, (all, b64: string) => {
    const was = Buffer.from(b64, "base64").toString();
    const now = swap(was);
    return now === was ? all : `printf %s ${shq(Buffer.from(now).toString("base64"))} | base64 -d`;
  });
}

/** The paths landfall shows for s. */
export const paths = (s: Server) => ({
  root: remotePath(s, ROOT),
  sites: remotePath(s, SITES),
  traefik: remotePath(s, TRAEFIK_DIR),
  journal: remotePath(s, JOURNAL),
  proxy: remotePath(s, PROXY_FILE),
  stamp: remotePath(s, STAMP_FILE),
});

/** Shell for a tenant login: its rootless Docker, and no root. Empty for any other server. */
export function tenantEnv(s: Server): string {
  if (!s.tenant) return "";
  const run = `/run/user/${s.tenant.uid}`;
  return `export XDG_RUNTIME_DIR=${run} DOCKER_HOST=unix://${run}/docker.sock LANDFALL_TENANT=${shq(s.host)}`;
}
