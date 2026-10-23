import type { Server } from "./config";
import { canLogin, runScript, shq } from "./ssh";
import { effectiveSsh } from "./sshconfig";
import { COMPOSE_INSTALL, COMPOSE_PLUGIN, PRELUDE, PROXY_CTR, SITES, TRAEFIK_DIR } from "./templates";
import { fail } from "./ui";

/** The login that may run root commands: the server's own if it is root or has sudo, else root's key login. */
export async function adminLogin(s: Server, what: string): Promise<Server> {
  const { stdout } = await runScript(s, `{ [ "$(id -u)" = 0 ] || sudo -n true 2>/dev/null; } && echo yes || true`, { capture: true });
  if (stdout.trim() === "yes") return s;
  const root = { ...s, user: "root" };
  if (effectiveSsh(s).user !== "root" && (await canLogin(root))) return root;
  return fail(`${what} needs root or passwordless sudo; ${effectiveSsh(s).user} has neither and root's key login does not work`);
}

// ---------------------------------------------------------------- OS packages

export interface PkgUpdate {
  name: string;
  from?: string;
  to: string;
  security: boolean;
}

export interface PkgStatus {
  /** apt-get, dnf, yum, apk, zypper or none. */
  mgr: string;
  updates: PkgUpdate[];
  /** The package lists were refreshed first (needs sudo). */
  refreshed: boolean;
  reboot: boolean;
}

/** Read-only, except that it refreshes the package lists (apt update) when it may. Env: REFRESH */
const PKG_LIST = String.raw`
set +e
S() { if [ -n "$SUDO" ]; then sudo -n "$@"; else "$@"; fi; }
m=$(pkg_mgr); echo "mgr=$m"
refresh() { [ "$REFRESH" = 1 ] && S true 2>/dev/null && "$@" >/dev/null 2>&1 && echo refreshed=1; }
case "$m" in
  apt-get)
    refresh S apt-get update -qq
    apt list --upgradable 2>/dev/null | sed -n 's|^\([^/]*\)/\([^ ]*\) \([^ ]*\) [^ ]* \[upgradable from: \(.*\)\]$|pkg=\1	\4	\3	\2|p' ;;
  dnf|yum)
    refresh S $m -q makecache
    $m -q -C check-update 2>/dev/null | awk 'NF == 3 && $1 ~ /\./ {print "pkg=" $1 "\t\t" $2 "\t" $3}'
    $m -q -C updateinfo list --security 2>/dev/null | awk 'NF >= 3 {print "sec=" $3}'
    command -v needs-restarting >/dev/null 2>&1 && { needs-restarting -r >/dev/null 2>&1; [ $? = 1 ] && echo reboot=1; } ;;
  apk)
    refresh S apk update -q
    apk version -l '<' 2>/dev/null | awk 'NR > 1 {print "apk=" $1 "\t" $3}' ;;
esac
[ -f /var/run/reboot-required ] && echo reboot=1
exit 0
`;

export function parsePkgList(out: string): PkgStatus {
  const st: PkgStatus = { mgr: "none", updates: [], refreshed: false, reboot: false };
  const sec: string[] = [];
  for (const line of out.split("\n")) {
    const i = line.indexOf("=");
    if (i < 0) continue;
    const [k, v] = [line.slice(0, i), line.slice(i + 1)];
    if (k === "mgr") st.mgr = v.trim();
    if (k === "refreshed") st.refreshed = true;
    if (k === "reboot") st.reboot = true;
    if (k === "sec") sec.push(v.trim());
    if (k === "pkg") {
      const [name, from, to, repo = ""] = v.split("\t");
      st.updates.push({ name, from: from || undefined, to, security: /security/i.test(repo) });
    }
    if (k === "apk") {
      // musl-1.2.5-r0 → musl, 1.2.5-r0
      const [full, to] = v.split("\t");
      const m = full.match(/^(.*)-(\d[^-]*-r\d+)$/);
      st.updates.push({ name: m?.[1] ?? full, from: m?.[2], to, security: false });
    }
  }
  // dnf lists security advisories as name-[epoch:]version-release.arch.
  for (const u of st.updates) {
    const base = u.name.replace(/\.[^.]+$/, "");
    if (sec.some((s) => s.startsWith(base + "-"))) u.security = true;
  }
  return st;
}

export async function pkgStatus(s: Server, refresh = true): Promise<PkgStatus> {
  const { stdout } = await runScript(s, PRELUDE + PKG_LIST, { capture: true, env: { REFRESH: refresh } });
  return parsePkgList(stdout);
}

/** Upgrade all packages, or only ONLY (names). Not reversible. Env: ONLY WHAT REBOOT */
export const PKG_UPGRADE = String.raw`
if [ -n "$SUDO" ] && ! sudo -n true 2>/dev/null; then echo "upgrading packages needs root or passwordless sudo" >&2; exit 1; fi
keep="-o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold"
case "$(pkg_mgr)" in
  apt-get)
    $SUDO apt-get update -qq
    if [ -n "$ONLY" ]; then $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -q --only-upgrade $keep $ONLY
    else $SUDO env DEBIAN_FRONTEND=noninteractive apt-get upgrade -y -q $keep; fi ;;
  dnf|yum) $SUDO $(pkg_mgr) upgrade -y -q $ONLY ;;
  apk) $SUDO apk update -q && $SUDO apk upgrade $ONLY ;;
  zypper) $SUDO zypper -n update $ONLY ;;
  *) echo "no supported package manager" >&2; exit 1 ;;
esac
record "upgraded $WHAT"
if [ "$REBOOT" = 1 ] && { [ -f /var/run/reboot-required ] || { command -v needs-restarting >/dev/null 2>&1 && ! needs-restarting -r >/dev/null 2>&1; }; }; then
  log "rebooting"
  record "rebooted after upgrading"
  # Detached, so this ssh session can end cleanly first.
  (sleep 2; $SUDO systemctl reboot 2>/dev/null || $SUDO reboot) >/dev/null 2>&1 &
fi
`;

export async function upgradePackages(s: Server, o: { only?: string[]; what: string; reboot?: boolean }) {
  await runScript(s, PRELUDE + PKG_UPGRADE, { env: { ONLY: (o.only ?? []).join(" "), WHAT: o.what, REBOOT: !!o.reboot } });
}

// ---------------------------------------------------------------- docker images

export interface ImageRef {
  registry: string;
  repo: string;
  tag: string;
  digest?: string;
}

/** Docker's own normalization: `nginx:alpine` is registry-1.docker.io/library/nginx:alpine. */
export function parseRef(ref: string): ImageRef {
  let [name, digest] = ref.split("@");
  let tag = "latest";
  const colon = name.lastIndexOf(":");
  if (colon > name.lastIndexOf("/")) {
    tag = name.slice(colon + 1);
    name = name.slice(0, colon);
  }
  const first = name.split("/")[0];
  let registry = "registry-1.docker.io";
  if (name.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost")) {
    registry = first === "docker.io" ? registry : first;
    name = name.slice(first.length + 1);
  }
  if (registry === "registry-1.docker.io" && !name.includes("/")) name = `library/${name}`;
  return { registry, repo: name, tag, digest };
}

const MANIFESTS = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
].join(", ");

/** The digest a tag points to now, asked from the registry anonymously (no pull). Undefined: private or unreachable. */
/** A registry API call, with the anonymous token dance registries ask for. Undefined when unreachable. */
async function registry(r: ImageRef, path: string, method = "GET"): Promise<Response | undefined> {
  const url = path.startsWith("https://") ? path : `https://${r.registry}/v2/${r.repo}/${path}`;
  const signal = AbortSignal.timeout(10000);
  const call = (auth?: string) => fetch(url, { method, signal, headers: { accept: MANIFESTS, ...(auth ? { authorization: auth } : {}) } });
  try {
    let res = await call();
    if (res.status === 401) {
      // Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull"
      const challenge = res.headers.get("www-authenticate") ?? "";
      const p = Object.fromEntries([...challenge.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
      if (!/^bearer/i.test(challenge) || !p.realm) return undefined;
      const t = new URL(p.realm);
      if (p.service) t.searchParams.set("service", p.service);
      t.searchParams.set("scope", p.scope ?? `repository:${r.repo}:pull`);
      const tok = (await fetch(t, { signal }).then((x) => (x.ok ? x.json() : undefined))) as { token?: string; access_token?: string } | undefined;
      const token = tok?.token ?? tok?.access_token;
      if (!token) return undefined;
      res = await call(`Bearer ${token}`);
    }
    return res.ok ? res : undefined;
  } catch {
    return undefined;
  }
}

export async function remoteDigest(ref: string): Promise<string | undefined> {
  const r = parseRef(ref);
  if (r.digest) return r.digest;
  return (await registry(r, `manifests/${r.tag}`, "HEAD"))?.headers.get("docker-content-digest") || undefined;
}

/** Every tag of the image's repository (a few pages at most). */
export async function remoteTags(ref: string): Promise<string[]> {
  const r = parseRef(ref);
  const tags: string[] = [];
  let next: string | undefined = "tags/list?n=1000";
  for (let page = 0; next && page < 10; page++) {
    const res = await registry(r, next);
    if (!res) break;
    tags.push(...(((await res.json().catch(() => ({}))) as { tags?: string[] }).tags ?? []));
    // Link: </v2/library/traefik/tags/list?last=v2.1&n=1000>; rel="next"
    const link = res.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
    next = link ? `https://${r.registry}${link}` : undefined;
  }
  return tags;
}

/** Compares dotted version numbers: 3.10 > 3.9. */
export function cmpVersion(a: string, b: string): number {
  const x = a.replace(/^v/, "").split(/[.+-]/).map(Number);
  const y = b.replace(/^v/, "").split(/[.+-]/).map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
}

const VERSION_TAG = /^(v?)(\d+(?:\.\d+){0,2})$/;

/**
 * A newer version tag of the same shape: v3.6 -> v3.7, 1.27 -> 1.29, v3 -> v4.
 * Tags that are not plain versions (alpine, latest, 1.2-slim) have none.
 */
export function newerTag(tag: string, tags: string[]): string | undefined {
  const m = VERSION_TAG.exec(tag);
  if (!m) return undefined;
  const depth = m[2].split(".").length;
  let best = m[2];
  for (const t of tags) {
    const x = VERSION_TAG.exec(t);
    if (x && x[1] === m[1] && x[2].split(".").length === depth && cmpVersion(x[2], best) > 0) best = x[2];
  }
  return best === m[2] ? undefined : m[1] + best;
}

/** The ref with another tag: traefik:v3.6 -> traefik:v3.7. */
export const withTag = (ref: string, tag: string) => `${ref.slice(0, ref.lastIndexOf(":"))}:${tag}`;

const latest = new Map<string, Promise<string | undefined>>();
/** The newest release of a GitHub project, from the /releases/latest redirect (no API rate limit). */
export function latestRelease(repo: string): Promise<string | undefined> {
  if (!latest.has(repo))
    latest.set(
      repo,
      fetch(`https://github.com/${repo}/releases/latest`, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(10000) })
        .then((r) => r.headers.get("location")?.match(/\/tag\/(?:docker-)?v?([^/]+)$/)?.[1])
        .catch(() => undefined),
    );
  return latest.get(repo)!;
}
export const latestDocker = () => latestRelease("moby/moby");
export const latestCompose = () => latestRelease("docker/compose");

export interface Engine {
  /** Docker server version, empty without docker. */
  docker: string;
  compose: string;
  /** The compose plugin's file; COMPOSE_PLUGIN when setup installed it. */
  composePath: string;
  /** docker-ce from Docker's repo: package upgrades keep it current. */
  dockerCe: boolean;
  latestDocker?: string;
  latestCompose?: string;
}

/** Docker and compose versions on the server next to the newest releases. */
export async function engineStatus(s: Server): Promise<Engine> {
  const script = String.raw`
${PRELUDE}
set +e
printf 'docker=%s
' "$(docker version --format '{{.Server.Version}}' 2>/dev/null)"
printf 'compose=%s
' "$(docker compose version --short 2>/dev/null | sed 's/^v//')"
printf 'path=%s
' "$(docker info --format '{{range .ClientInfo.Plugins}}{{if eq .Name "compose"}}{{.Path}}{{end}}{{end}}' 2>/dev/null)"
printf 'ce=%s
' "$(pkg_has docker-ce && echo 1)"
exit 0`;
  const [{ stdout }, ld, lc] = await Promise.all([runScript(s, script, { capture: true }), latestDocker(), latestCompose()]);
  const v = Object.fromEntries(stdout.split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
  return { docker: v.docker ?? "", compose: v.compose ?? "", composePath: v.path ?? "", dockerCe: v.ce === "1", latestDocker: ld, latestCompose: lc };
}

/** What to tell about the engine, and whether landfall can update compose itself. */
export function engineNotes(e: Engine): { dockerNote?: string; composeNote?: string; composeUpdate: boolean } {
  const old = (have: string, want?: string) => !!have && !!want && cmpVersion(have, want) < 0;
  const dockerNote = old(e.docker, e.latestDocker)
    ? `docker ${e.docker}, ${e.latestDocker} is current${e.dockerCe ? " (comes with the package upgrades)" : " (distro package: switch to Docker's repo for the newest)"}`
    : undefined;
  const composeUpdate = old(e.compose, e.latestCompose) && e.composePath === COMPOSE_PLUGIN;
  const composeNote = !e.compose
    ? "docker compose missing: lf setup installs it"
    : old(e.compose, e.latestCompose)
      ? `compose ${e.compose}, ${e.latestCompose} is current${composeUpdate ? "" : e.dockerCe ? " (comes with the package upgrades)" : ` (from ${e.composePath || "the distro"})`}`
      : undefined;
  return { dockerNote, composeNote, composeUpdate };
}

export async function updateCompose(s: Server) {
  await runScript(s, PRELUDE + COMPOSE_INSTALL + `compose_install || { log "could not download docker compose"; exit 1; }\n`);
}

export interface ImageStatus {
  /** "traefik", the site name, or the foreign proxy's container. */
  name: string;
  kind: "traefik" | "site" | "proxy";
  container: string;
  /** A site's compose service. */
  service?: string;
  /** Where its compose file is (`cd -P` it); empty for a foreign proxy. */
  dir: string;
  ref: string;
  /** update: the registry has a newer image for the tag. */
  state: "current" | "update" | "unknown" | "pinned" | "rebuild" | "foreign" | "missing";
  note?: string;
  /** A newer version tag than the one it runs (traefik:v3.6 while v3.7 is out). */
  newer?: string;
}

/** Image, image id and repo digests of landfall's traefik and every container of every site. */
const IMAGES = String.raw`
set +e
P=${PROXY_CTR}
img() { # img <kind> <name> <container> <dir> [service]
  svc=; [ $# -lt 5 ] || svc=$5
  x=$(docker inspect -f '{{.Config.Image}} {{.Image}}' "$3" 2>/dev/null) || { printf 'IMG\t%s\t%s\t%s\t%s\t%s\t\t\n' "$1" "$2" "$3" "$4" "$svc"; return 0; }
  read -r ref id <<EOF
$x
EOF
  printf 'IMG\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" "$svc" "$ref" "$(docker image inspect -f '{{range .RepoDigests}}{{.}} {{end}}' "$id" 2>/dev/null)"
}
if [ "$P" = traefik ] && grep -q "managed by landfall" ${TRAEFIK_DIR}/docker-compose.yml 2>/dev/null; then img traefik traefik traefik ${TRAEFIK_DIR}
else img proxy "$P" "$P" ""; fi
# All containers at once: <name> <service> <project>, the last two empty outside Compose.
PS=$(docker ps -a --format '{{.Names}} {{.Label "com.docker.compose.service"}} {{.Label "com.docker.compose.project"}}' 2>/dev/null)
for f in ${SITES}/*/site.json; do
  [ -f "$f" ] || continue
  d=$(dirname "$f"); n=$(basename "$d")
  # Sites of landfall before Compose sites: one container, its compose file next to site.json.
  if ! grep -q '"v": *2' "$f"; then img site "$n" "landfall-$n" "$d"; continue; fi
  p=$(sed -n 's/^ *"project": *"\([^"]*\)".*/\1/p' "$f"); [ -n "$p" ] || p=$n
  printf '%s\n' "$PS" | while read -r c svc pr; do [ "$pr" != "$p" ] || img site "$n" "$c" "$d/current" "$svc"; done
done
exit 0
`;

export async function imageStatus(s: Server): Promise<ImageStatus[]> {
  const { stdout } = await runScript(s, IMAGES, { capture: true });
  const rows = stdout
    .split("\n")
    .filter((l) => l.startsWith("IMG\t"))
    .map((l) => l.split("\t"));
  const digests = new Map<string, Promise<string | undefined>>();
  const tags = new Map<string, Promise<string[]>>();
  const newer = async (ref: string) => {
    const repo = ref.slice(0, ref.lastIndexOf(":"));
    if (!VERSION_TAG.test(parseRef(ref).tag)) return undefined;
    if (!tags.has(repo)) tags.set(repo, remoteTags(ref));
    const t = newerTag(parseRef(ref).tag, await tags.get(repo)!);
    return t && withTag(ref, t);
  };
  return Promise.all(
    rows.map(async ([, kind, name, ctr, dir, service = "", ref = "", local = ""]): Promise<ImageStatus> => {
      const base = { name, container: ctr, dir, ref, service: service || undefined };
      // Tagged per release by landfall's override: <site>-<service>:<release id>.
      if (kind === "site" && ref.startsWith(`${name}-`) && /:\d{14}$/.test(ref)) return { ...base, kind: "site", state: "rebuild", note: "built on the server: redeploy to rebuild" };
      if (!ref) return { ...base, kind: kind as ImageStatus["kind"], state: "missing", note: "no container" };
      if (kind === "proxy") return { ...base, kind: "proxy", state: "foreign", note: "not landfall's traefik: update it where it was set up" };
      if (ref.includes("@")) return { ...base, kind: kind as ImageStatus["kind"], state: "pinned", note: "pinned to a digest" };
      if (!digests.has(ref)) digests.set(ref, remoteDigest(ref));
      const [remote, tag] = await Promise.all([digests.get(ref)!, newer(ref)]);
      const k = kind as ImageStatus["kind"];
      const major = (r: string) => parseRef(r).tag.replace(/^v/, "").split(".")[0];
      const how = k === "traefik" ? `lf traefik setup --image ${tag}` : "redeploy with it";
      const hint = tag ? { newer: tag, note: `newer version ${tag} (${major(tag) === major(ref) ? "" : "new major, read its upgrade notes; "}${how})` } : {};
      if (!remote) return { ...base, kind: k, state: "unknown", note: "registry did not answer (private image?)", ...hint };
      return { ...base, kind: k, state: local.split(" ").some((d) => d.endsWith(`@${remote}`)) ? "current" : "update", ...hint };
    }),
  );
}

/**
 * Pull each image and recreate the containers on it that run an older one.
 * Journaled per container: undo tags the old image back and recreates.
 */
export async function updateImages(s: Server, targets: ImageStatus[]) {
  const byRef = new Map<string, ImageStatus[]>();
  for (const t of targets) byRef.set(t.ref, [...(byRef.get(t.ref) ?? []), t]);
  const lines = [PRELUDE];
  for (const [ref, ts] of byRef) {
    lines.push(`log ${shq(`pulling ${ref}`)}`, `docker pull -q ${shq(ref)} >/dev/null`, `new=$(docker image inspect -f '{{.Id}}' ${shq(ref)})`);
    for (const t of ts) {
      const svc = t.service ? ` ${shq(t.service)}` : "";
      const undo = `docker tag $old ${shq(ref)} && cd -P ${shq(t.dir)} && dc up -d${svc}`;
      lines.push(
        `old=$(docker inspect -f '{{.Image}}' ${shq(t.container)})`,
        `if [ "$old" = "$new" ]; then log ${shq(`${t.name} already runs the newest ${ref}`)}; else`,
        `  record ${shq(`updated ${t.name} to the newest ${ref}`)} "${undo.replace(/"/g, '\\"')}"`,
        `  log ${shq(`recreating ${t.container}`)}`,
        `  (cd -P ${shq(t.dir)} && dc up -d --quiet-pull${svc}) && ensure_running ${shq(t.container)} || exit 1`,
        "fi",
      );
    }
  }
  await runScript(s, lines.join("\n"));
}
