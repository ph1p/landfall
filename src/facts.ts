import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import type { Server } from "./config";
import { runScript } from "./ssh";
import { effectiveSsh } from "./sshconfig";
import { PRELUDE } from "./templates";

/** What a server runs on: distro, hardware, addresses. Read-only. */
const FACTS = String.raw`
set +e
kv() { printf '%s=%s\n' "$1" "$2"; }
PRETTY_NAME=unknown; ID=; VERSION_ID=; ID_LIKE=; . /etc/os-release 2>/dev/null
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
# The source address of the default route; behind NAT that is a private one.
kv ip4 "$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -n1)"
kv ip6 "$(ip -6 route get 2606:4700:4700::1111 2>/dev/null | sed -n 's/.* src \([0-9a-fA-F:]*\).*/\1/p' | head -n1)"
kv reboot "$([ -f /var/run/reboot-required ] && echo 1)"
exit 0
`;

export interface Support {
  /** eol: no more security updates; unsupported: setup cannot install packages. */
  level: "ok" | "eol" | "unsupported";
  note?: string;
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
    ip4: v.ip4 ?? "",
    ip6: v.ip6 ?? "",
    reboot: v.reboot === "1",
    support: support(v.id ?? "", v.version ?? "", v.pkg || "none", today),
  };
}

export async function facts(s: Server): Promise<Facts> {
  const { stdout } = await runScript(s, PRELUDE + FACTS, { capture: true });
  return parseFacts(stdout);
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

export function support(id: string, version: string, pkg: string, today = new Date()): Support {
  if (pkg === "none") return { level: "unsupported", note: "no apt, dnf, yum, apk or zypper: setup cannot install packages" };
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
