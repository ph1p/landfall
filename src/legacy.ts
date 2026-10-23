/**
 * Support for machines and servers from when landfall was called srv. To drop it, delete
 * this file and the lines that import it: the rest of landfall does not depend on it.
 */
import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Server } from "./config";
import { runScript } from "./ssh";
import { COMPOSE_PLUGIN, PRELUDE, PROXY_FILE, ROOT, SITES, SSHD_CONF, TRAEFIK_DIR } from "./templates";
import { c, confirm, info, ok, warn } from "./ui";

// Function declarations, not consts: config.ts calls these while modules still load.

/** $SRV_<name>, read when $LANDFALL_<name> is not set. */
export function oldEnv(name: string) {
  return process.env[`SRV_${name}`];
}

/** Rename ~/.config/srv to landfall's config dir, once. */
export function adoptOldConfig(configHome: string, configDir: string) {
  const old = join(configHome, "srv");
  if (!fs.existsSync(configDir) && fs.existsSync(join(old, "config.json"))) fs.renameSync(old, configDir);
}

/** The project file's old name: still read, removed on the next save. */
export const OLD_PROJECT_FILE = "srv.json";

/** Keys made by srv stay where they are: ssh configs point at them. */
export const oldKeyFile = (name: string) => join(homedir(), ".ssh", `srv_${name}`);

/** Tag of the ~/.ssh/config blocks srv wrote (`# >>> srv:<alias>`). */
export const OLD_BLOCK = "srv";

export const OLD_ROOT = "/opt/srv";

/** Stops every script on a server that `lf setup` has not moved from /opt/srv yet. */
export const OLD_LAYOUT = `[ ! -d ${OLD_ROOT} ] || [ -e ${ROOT} ] || { echo "this server still uses ${OLD_ROOT} from when landfall was called srv; run 'lf setup' for it once to move it" >&2; exit 3; }\n`;

/** Journal line of MIGRATE: steps before it reverted srv's paths and names, so they can no longer be undone. */
export const MIGRATED = `moved ${OLD_ROOT} to ${ROOT} (landfall was called srv); older changes can no longer be undone`;

/**
 * One-time move of a server set up when landfall was called srv: /opt/srv, srv-<site>
 * containers and their labels, 00-srv.conf. Each site's new container starts before
 * the old one goes, so only traefik restarts once. Needs root or passwordless sudo.
 */
export const MIGRATE = String.raw`
if [ -n "$SUDO" ] && ! sudo -n true 2>/dev/null; then
  echo "moving ${OLD_ROOT} needs root or passwordless sudo for $(id -un) (try: lf setup <name> --user root)" >&2
  exit 1
fi
[ ! -e ${ROOT} ] || { echo "both ${OLD_ROOT} and ${ROOT} exist; merge them by hand, then remove ${OLD_ROOT}" >&2; exit 1; }
log "moving ${OLD_ROOT} to ${ROOT}"
$SUDO mv ${OLD_ROOT} ${ROOT}
# Only the older journal steps restored these backups; the .env copies hold secrets.
$SUDO find ${ROOT} /etc/ssh -name '.*.srv-*' -type f -delete 2>/dev/null || true
$SUDO rm -f ${COMPOSE_PLUGIN}.srv-*
old_conf=/etc/ssh/sshd_config.d/00-srv.conf
[ ! -f $old_conf ] || $SUDO mv $old_conf ${SSHD_CONF}
# Rewrite a file in place, keeping its owner (deploy users must still write it).
rewrite() { o=$($SUDO stat -c %u:%g "$1"); $SUDO sed -i -E "$2" "$1"; $SUDO chown "$o" "$1"; }
dc version >/dev/null 2>&1 || true
sdc() { $SUDO $DC "$@"; }
[ ! -f ${PROXY_FILE} ] || rewrite ${PROXY_FILE} 's/^# srv routes/# landfall routes/; s/let srv run/let landfall run/'
f=${TRAEFIK_DIR}/docker-compose.yml
if [ -f $f ] && grep -q "managed by srv" $f; then
  rewrite $f 's/managed by srv/managed by landfall/'
  log "restarting traefik from ${TRAEFIK_DIR}"
  (cd ${TRAEFIK_DIR} && sdc up -d --force-recreate --quiet-pull)
fi
for d in ${SITES}/*; do
  n=$(basename "$d"); f="$d/docker-compose.yml"
  [ -f "$f" ] && grep -q "managed by srv" "$f" || continue
  rewrite "$f" 's/managed by srv/managed by landfall/; s/^name: srv-/name: landfall-/; s/container_name: srv-/container_name: landfall-/; s/(routers|services|middlewares)\.srv-/\1.landfall-/g; s/middlewares=srv-/middlewares=landfall-/; s/"srv\.(managed|site)=/"landfall.\1=/'
  [ ! -f "$d/nginx.conf" ] || rewrite "$d/nginx.conf" 's/managed by srv/managed by landfall/'
  # A stopped site stays stopped.
  if [ "$($SUDO docker inspect -f '{{.State.Running}}' "srv-$n" 2>/dev/null)" = true ]; then act="up -d"; else act=create; fi
  log "moving srv-$n to landfall-$n"
  if (cd "$d" && sdc $act --quiet-pull >/dev/null); then $SUDO docker rm -f "srv-$n" >/dev/null 2>&1 || true
  else log "landfall-$n did not start, srv-$n keeps running; redeploy $n"; fi
done
record "${MIGRATED}"
`;

/**
 * Setup's first step on a server srv set up: move it to landfall's layout.
 * Returns false when setup should stop (declined, or --check).
 */
export async function migrateServer(login: Server, o: { check?: boolean }): Promise<boolean> {
  const { stdout } = await runScript(login, `[ ! -d ${OLD_ROOT} ] || echo old`, { capture: true, oldLayout: true });
  if (stdout.trim() !== "old") return true;
  warn(`${OLD_ROOT} is from when landfall was called srv: its sites, traefik and journal move to ${ROOT}`);
  info(c.dim("sites keep running; traefik restarts once; changes made before the move can no longer be undone"));
  if (o.check || !(await confirm(`move ${OLD_ROOT} to ${ROOT}?`))) return false;
  await runScript(login, PRELUDE + MIGRATE, { oldLayout: true });
  ok(`moved to ${ROOT}`);
  return true;
}
