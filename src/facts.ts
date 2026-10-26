import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import type { Server } from "./config";
import { canLogin, runScript } from "./ssh";
import { effectiveSsh } from "./sshconfig";
import { OS_RELEASE, PRELUDE } from "./templates";

/** What a server runs on: distro, hardware, addresses. Read-only. */
const FACTS = String.raw`
set +e
kv() { printf '%s=%s\n' "$1" "$2"; }
${OS_RELEASE}
kv os "$PRETTY_NAME"
kv id "$ID"
kv version "$VERSION_ID"
kv like "$ID_LIKE"
kv arch "$(uname -m)"
kv kernel "$(uname -r)"
kv uptime "$(cut -d' ' -f1 /proc/uptime 2>/dev/null)"
kv cpus "$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null)"
kv load "$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)"
kv mem "$(awk '/^MemTotal:/ {t=$2} /^MemAvailable:/ {a=$2} END {print t, a}' /proc/meminfo 2>/dev/null)"
kv disk "$(df -Pk / 2>/dev/null | awk 'NR==2 {print $2, $3, $4}')"
kv pkg "$(pkg_mgr)"
kv docker "$(docker version --format '{{.Server.Version}}' 2>/dev/null)"
kv compose "$(docker compose version --short 2>/dev/null)"
kv podman "$(podman version --format '{{.Client.Version}}' 2>/dev/null)"
if [ -d /run/systemd/system ]; then kv init systemd; elif command -v rc-service >/dev/null 2>&1; then kv init openrc; else kv init other; fi
kv user "$(id -un)"
kv admin "$({ [ "$(id -u)" = 0 ] || sudo -n true 2>/dev/null; } && echo 1)"
kv ufw "$(command -v ufw >/dev/null 2>&1 && echo 1)"
# The source address of the default route; behind NAT that is a private one.
kv ip4 "$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -n1)"
kv ip6 "$(ip -6 route get 2606:4700:4700::1111 2>/dev/null | sed -n 's/.* src \([0-9a-fA-F:]*\).*/\1/p' | head -n1)"
kv reboot "$(reboot_needed && echo 1)"
exit 0
`;

export interface Support {
  /** eol: no more security updates; unsupported: setup cannot install packages; limited: the same on a system that installs its own way (DSM, SteamOS). */
  level: "ok" | "eol" | "unsupported" | "limited";
  note?: string;
}

/** What landfall can do on a server; `why` says what is missing for each false one. */
export const CAPS = ["setup", "packages", "docker", "compose", "firewall", "services", "admin"] as const;
export type Cap = (typeof CAPS)[number];
export interface Caps {
  can: Record<Cap, boolean>;
  why: Partial<Record<Cap, string>>;
}

export interface Facts {
  os: string;
  id: string;
  version: string;
  like: string;
  arch: string;
  kernel: string;
  /** Seconds. */
  uptime: number;
  cpus: number;
  load: string;
  /** Bytes. */
  mem: { total: number; available: number };
  disk: { total: number; used: number; available: number };
  /** apt-get, dnf, yum, apk, zypper or none. */
  pkg: string;
  /** Docker server version, empty without docker (or access to it). */
  docker: string;
  /** Docker Compose v2 version, empty without it. */
  compose: string;
  /** Podman's version where it is installed: landfall runs docker, not podman. */
  podman: string;
  /** synology, steamos, or empty for a plain distro. */
  platform: string;
  init: "systemd" | "openrc" | "other";
  /** The ssh login, and whether it is root or has passwordless sudo. */
  user: string;
  admin: boolean;
  ufw: boolean;
  ip4: string;
  ip6: string;
  reboot: boolean;
  support: Support;
}

export function parseFacts(out: string, today = new Date()): Facts {
  const v: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) v[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  const nums = (s = "") => s.split(/\s+/).map((n) => Number(n) * 1024);
  const [memTotal = 0, memAvail = 0] = nums(v.mem);
  const [diskTotal = 0, diskUsed = 0, diskAvail = 0] = nums(v.disk);
  return {
    os: v.os || "unknown",
    id: v.id ?? "",
    version: v.version ?? "",
    like: v.like ?? "",
    arch: v.arch ?? "",
    kernel: v.kernel ?? "",
    uptime: Math.round(Number(v.uptime) || 0),
    cpus: Number(v.cpus) || 0,
    load: v.load ?? "",
    mem: { total: memTotal || 0, available: memAvail || 0 },
    disk: { total: diskTotal || 0, used: diskUsed || 0, available: diskAvail || 0 },
    pkg: v.pkg || "none",
    docker: v.docker ?? "",
    compose: v.compose ?? "",
    podman: v.podman ?? "",
    platform: v.platform ?? "",
    init: (["systemd", "openrc"].includes(v.init) ? v.init : "other") as Facts["init"],
    user: v.user ?? "",
    admin: v.admin === "1",
    ufw: v.ufw === "1",
    ip4: v.ip4 ?? "",
    ip6: v.ip6 ?? "",
    reboot: v.reboot === "1",
    support: support(v.id ?? "", v.version ?? "", v.pkg || "none", today, v.platform),
  };
}

export async function facts(s: Server): Promise<Facts> {
  const { stdout } = await runScript(s, PRELUDE + FACTS, { capture: true });
  return parseFacts(stdout);
}

/**
 * What landfall can do on a server, from its facts. `admin` is the login's own; pass `rootKey`
 * when root's (or the admin user's) key login works, as commands then use that (see adminLogin).
 */
export function capabilities(f: Facts, rootKey = false): Caps {
  const p = PLATFORM[f.platform];
  const admin = f.admin || rootKey;
  const why: Caps["why"] = {};
  const need = (cap: Cap, ok: boolean, reason: string) => (ok || (why[cap] = reason), ok);
  const noPkg = p ? p.name : NO_PKG;
  const setup = need("setup", f.pkg !== "none", noPkg);
  need("admin", admin, `${f.user || "the login"} has no passwordless sudo and root's key login does not work`);
  need("packages", setup && admin, setup ? why.admin! : noPkg);
  const noDocker = f.podman
    ? `only podman ${f.podman} here: landfall needs docker${p ? ` (${p.docker})` : ""}`
    : p ? p.docker : setup ? "no docker (or no access to it): lf setup installs it" : "no docker (or no access to it)";
  const docker = need("docker", !!f.docker, noDocker);
  need("compose", docker && !!f.compose, docker ? "docker has no compose plugin (v2)" : why.docker!);
  need("firewall", !noUfw(f.platform, f.pkg, f.ufw) && admin, noUfw(f.platform, f.pkg, f.ufw) ?? why.admin!);
  need("services", f.init !== "other", "no systemd or OpenRC");
  const can = Object.fromEntries(CAPS.map((k) => [k, !why[k]])) as Caps["can"];
  return { can, why };
}

/** Why ufw can't be used: the platform's own firewall, or nothing to install it with. */
export function noUfw(platform: string, pkg: string, ufw: boolean): string | undefined {
  if (PLATFORM[platform]?.firewall) return PLATFORM[platform].firewall;
  if (!ufw && pkg === "none") return `no ufw, and ${NO_PKG} to install it`;
}

/** capabilities(), trying root's key login (as adminLogin does) only when the login itself has no sudo. */
export async function serverCaps(s: Server, f: Facts): Promise<Caps> {
  const me = effectiveSsh(s).user;
  let rootKey = false;
  for (const user of f.admin ? [] : ["root", s.admin]) {
    if (user && user !== me && (rootKey = await canLogin({ ...s, user }))) break;
  }
  return capabilities(f, rootKey);
}

/**
 * End of security support (including LTS where the project runs it), by `ID VERSION_ID`;
 * debian/rhel-likes by major version, alpine by major.minor.
 */
const EOL: Record<string, string> = {
  "ubuntu 18.04": "2023-05-31",
  "ubuntu 20.04": "2025-05-31",
  "ubuntu 22.04": "2027-06-01",
  "ubuntu 23.10": "2024-07-11",
  "ubuntu 24.04": "2029-05-31",
  "ubuntu 24.10": "2025-07-10",
  "ubuntu 25.04": "2026-01-15",
  "ubuntu 25.10": "2026-07-09",
  "ubuntu 26.04": "2031-05-31",
  "debian 9": "2022-06-30",
  "debian 10": "2024-06-30",
  "debian 11": "2026-08-31",
  "debian 12": "2028-06-30",
  "debian 13": "2030-06-30",
  "centos 7": "2024-06-30",
  "centos 8": "2021-12-31",
  "rhel 8": "2029-05-31",
  "rhel 9": "2032-05-31",
  "rocky 8": "2029-05-31",
  "rocky 9": "2032-05-31",
  "almalinux 8": "2029-05-31",
  "almalinux 9": "2032-05-31",
  "alpine 3.17": "2024-11-22",
  "alpine 3.18": "2025-05-09",
  "alpine 3.19": "2025-11-01",
  "alpine 3.20": "2026-04-01",
  "alpine 3.21": "2026-11-01",
  "alpine 3.22": "2027-05-01",
};

/** Systems that bring their own way of installing things: setup stays away from them. */
export const PLATFORM: Record<string, { name: string; docker: string; firewall?: string; bans?: string }> = {
  synology: {
    name: "Synology DSM manages its packages, users, ssh and firewall itself",
    docker: "install Container Manager in Package Center",
    firewall: "DSM has its own firewall: Control Panel → Security → Firewall",
    bans: "DSM bans addresses that keep failing to log in itself: Control Panel → Security → Protection → Auto Block",
  },
  steamos: { name: "SteamOS resets the system on every OS update", docker: "install Docker in your home directory" },
};
const NO_PKG = "no apt, dnf, yum, apk or zypper";

export function support(id: string, version: string, pkg: string, today = new Date(), platform = ""): Support {
  if (pkg === "none") {
    const p = PLATFORM[platform];
    return p ? { level: "limited", note: `${p.name}: landfall uses it as it is, without setup or package updates` } : { level: "unsupported", note: `${NO_PKG}: setup cannot install packages` };
  }
  const major = version.split(".")[0];
  const minor = version.split(".").slice(0, 2).join(".");
  const end = EOL[`${id} ${version}`] ?? EOL[`${id} ${minor}`] ?? EOL[`${id} ${major}`];
  if (!end) return { level: "ok" };
  const days = (Date.parse(end) - today.getTime()) / 86400000;
  if (days < 0) return { level: "eol", note: `${id} ${version} reached end of life on ${end}: no more security updates, upgrade the release` };
  if (days < 90) return { level: "ok", note: `${id} ${version} reaches end of life on ${end}` };
  return { level: "ok" };
}

const PRIVATE4 = /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;
export const isPublic4 = (ip: string) => isIP(ip) === 4 && !PRIVATE4.test(ip);

/** The server's IPv4 addresses as the world sees them: what ssh connects to, and its own default route. */
export async function serverIps(s: Server, f?: Pick<Facts, "ip4">): Promise<string[]> {
  const host = effectiveSsh(s).hostname;
  const resolved = isIP(host) ? [host] : await dns.resolve4(host).catch(() => [] as string[]);
  return [...new Set([...resolved, ...(f?.ip4 ? [f.ip4] : [])])];
}

/** The address a no-DNS URL should point at: public first, else whatever ssh reaches. */
export const pickIp = (ips: string[]) => ips.find(isPublic4) ?? ips[0];

/** `<name>.<1-2-3-4>.sslip.io`: resolves to the IP without any DNS setup. */
export const sslipDomain = (name: string, ip: string) => `${name}.${ip.replace(/\./g, "-")}.sslip.io`;

export interface DnsCheck {
  domain: string;
  /** Addresses the domain resolves to. */
  ips: string[];
  /** Points at this server. */
  ok: boolean;
}

export async function checkDns(domains: string[], serverIpList: string[]): Promise<DnsCheck[]> {
  return Promise.all(
    domains.map(async (domain) => {
      const ips = await dns.resolve4(domain).catch(() => [] as string[]);
      return { domain, ips, ok: ips.some((ip) => serverIpList.includes(ip)) };
    }),
  );
}

export const bytes = (n: number) => {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) (n /= 1024), i++;
  return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
};

export const duration = (s: number) => {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  return d ? `${d}d ${h}h` : h ? `${h}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}m`;
};
