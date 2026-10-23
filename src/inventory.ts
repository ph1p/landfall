import type { Server } from "./config";
import { runScript } from "./ssh";
import { parseProxy, PRELUDE, PROBE, TRAEFIK_DIR, type Proxy } from "./templates";
import { cmpVersion } from "./updates";
import { c, info } from "./ui";

export interface Listener {
  proto: "tcp" | "udp";
  addr: string;
  port: number;
  proc: string;
}

/** Parsed output of the PROBE script. */
export interface Probe {
  values: Record<string, string>;
  /** Sockets open on the host (ss/netstat). */
  listen: Listener[];
  /** Host ports Docker publishes for containers (`docker ps`). */
  published: Listener[];
  /** ufw rules as `ufw show added` prints them, without the leading `ufw`. */
  rules: string[];
}

/** `tcp 0.0.0.0:22 users:(("sshd",pid=1,fd=3))` (ss) or `udp :::53 1/dnsmasq` (netstat); older probes omit the protocol. */
function parseListener(value: string): Listener {
  const parts = value.split(" ");
  const proto = parts[0] === "udp" ? "udp" : "tcp";
  if (/^(tcp|udp)/.test(parts[0])) parts.shift();
  const [local, proc = ""] = parts;
  const j = local.lastIndexOf(":");
  return {
    proto,
    addr: local.slice(0, j),
    port: Number(local.slice(j + 1)),
    proc: proc.match(/"([^"]+)"/)?.[1] ?? proc.split("/")[1] ?? (proc || "?"),
  };
}

export function parseProbe(out: string): Probe {
  const p: Probe = { values: {}, listen: [], published: [], rules: [] };
  for (const line of out.split("\n")) {
    const i = line.indexOf("=");
    if (i < 0) continue;
    const key = line.slice(0, i);
    const value = line.slice(i + 1).trim();
    if (key === "listen" || key === "published") p[key].push(parseListener(value));
    else if (key === "ufw_rule") p.rules.push(value);
    else p.values[key] = value;
  }
  return p;
}

export async function probeServer(s: Server, env: { PUBKEY?: string; DEPLOY_USER?: string } = {}): Promise<Probe> {
  const { stdout } = await runScript(s, PRELUDE + PROBE, { env: { PUBKEY: env.PUBKEY ?? "", DEPLOY_USER: env.DEPLOY_USER ?? "" }, capture: true });
  return parseProbe(stdout);
}

export type Status = "done" | "todo" | "conflict" | "off";
export type Part = "packages" | "docker" | "layout" | "user" | "firewall" | "harden" | "traefik";

export interface Check {
  part: Part;
  label: string;
  status: Status;
  detail: string;
  /** traefik: route sites through this existing Traefik instead of installing landfall's. */
  proxy?: Proxy;
}

export interface Wanted {
  sshPort: number;
  loginUser: string;
  deployUser: string;
  firewall: boolean;
  harden: boolean;
  traefik: boolean;
}

const isLoopback = (addr: string) => /^(127\.|\[?::1\]?(%|$)|localhost)/.test(addr);
const isV6 = (addr: string) => addr.includes(":");
/** "25" for tcp, "53/udp" for udp. */
const portName = (l: Pick<Listener, "proto" | "port">) => (l.proto === "tcp" ? `${l.port}` : `${l.port}/udp`);
/** DHCP and mDNS replies, which ufw's default rules let in. */
const UFW_DEFAULT_UDP = [68, 546, 5353];

/** One line of `ufw show added`, e.g. `allow 25/tcp` or `allow from 10.0.0.0/8 to any port 5432 proto tcp comment 'db'`. */
export interface Rule {
  /** Exactly as ufw printed it, so `ufw delete <spec>` removes it. */
  spec: string;
  action: "allow" | "deny" | "reject" | "limit";
  /** `22`, `80,443`, `6000:6007`; undefined for app profiles like `OpenSSH`. */
  port?: string;
  proto?: "tcp" | "udp";
  /** Source address or network; undefined = anywhere. */
  from?: string;
  comment?: string;
  /** Outgoing rules never decide what reaches the server. */
  out: boolean;
}

export function parseRule(spec: string): Rule {
  const m = spec.match(/^(.*?)\s+comment\s+'(.*)'$/);
  const w = words(m ? m[1] : spec);
  const after = (k: string) => (w.includes(k) ? w[w.indexOf(k) + 1] : undefined);
  const action = (["allow", "deny", "reject", "limit"].find((a) => a === w[0]) ?? "allow") as Rule["action"];
  let port = after("port");
  let proto = after("proto");
  if (!w.includes("to") && !w.includes("from")) {
    const simple = w.find((x) => /^[\d,:]+(\/(tcp|udp))?$/.test(x));
    [port, proto] = simple?.split("/") ?? [];
  }
  const from = after("from");
  return {
    spec,
    action,
    port,
    proto: proto === "tcp" || proto === "udp" ? proto : undefined,
    from: from && from !== "any" ? from : undefined,
    comment: m?.[2],
    out: w[1] === "out",
  };
}

/** The first rule ufw would apply to traffic reaching `l`, like ufw's own first-match order. */
export function ruleFor(rules: Rule[], l: Pick<Listener, "proto" | "port">): { rule: Rule; n: number } | undefined {
  const covers = (r: Rule) =>
    !r.out &&
    (!r.proto || r.proto === l.proto) &&
    !!r.port?.split(",").some((part) => {
      const [a, b = a] = part.split(":").map(Number);
      return l.port >= a && l.port <= b;
    });
  const n = rules.findIndex(covers);
  return n < 0 ? undefined : { rule: rules[n], n: n + 1 };
}

/** Opens `l` to everyone: from-restricted rules keep a public service blocked for most clients. */
const ruleOpens = (rules: Rule[], l: Listener) => {
  const r = ruleFor(rules, l)?.rule;
  return !!r && (r.action === "allow" || r.action === "limit") && !r.from;
};

const uniqPorts = (ls: Listener[], label: (l: Listener) => string) => [
  ...new Map([...ls].sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto)).map((l) => [portName(l), label(l)])).values(),
];

/**
 * ufw only filters traffic to the host itself. Container ports Docker publishes
 * with iptables NAT skip it; with the nftables backend, or for a family without
 * Docker's NAT chain, they would be dropped.
 */
function assessFirewall(p: Probe, w: Wanted): Check {
  const check = (status: Status, detail: string): Check => ({ part: "firewall", label: "firewall", status, detail });
  const { blocked, kept } = enableBlocks(p, [w.sshPort, 80, 443]);
  if (blocked.length) return check("conflict", `enabling ufw would block ${blocked.join(", ")}`);
  return check("todo", `enable ufw (ssh/80/443)${kept.length ? `; docker keeps ${kept.join(" ")} open` : ""}`);
}

/** What turning ufw on would cut off, when `tcp` ports get an allow rule first; `kept` = container ports docker keeps open. */
export function enableBlocks(p: Probe, tcp: number[]): { blocked: string[]; kept: string[] } {
  const v = p.values;
  const rules = p.rules.map(parseRule);
  const opened = (l: Listener) =>
    (l.proto === "tcp" && tcp.includes(l.port)) || (l.proto === "udp" && UFW_DEFAULT_UDP.includes(l.port)) || ruleOpens(rules, l);
  const exposed = (l: Listener) => !isLoopback(l.addr) && !opened(l);

  const host = p.listen.filter((l) => l.proc !== "docker-proxy" && exposed(l));
  // docker-proxy listeners cover published ports when `docker ps` could not be read.
  const docker = [...p.published, ...p.listen.filter((l) => l.proc === "docker-proxy")].filter(exposed);
  const nft = v.docker_fw === "nftables";
  const cut = docker.filter((l) => v[isV6(l.addr) ? "docker_nat6" : "docker_nat4"] !== "1");

  const anyPublished = p.published.length > 0 || p.listen.some((l) => l.proc === "docker-proxy");
  const blocked = [
    ...uniqPorts(host, (l) => `${portName(l)} (${l.proc})`),
    ...(nft
      ? anyPublished
        ? ["every published container port, 80/443 too (docker uses nftables)"]
        : []
      : uniqPorts(cut, (l) => `${portName(l)} (docker${isV6(l.addr) ? ", IPv6" : ""})`)),
  ];
  return { blocked, kept: nft ? [] : uniqPorts(docker.filter((l) => !cut.includes(l)), portName) };
}

export interface Reach {
  /** `25`, `53/udp` */
  port: string;
  proc: string;
  state: "open" | "limited" | "blocked" | "local";
  why: string;
}

/** Who can reach each listening port right now, given ufw's state, its rules and Docker's NAT. */
export function reachability(p: Probe): Reach[] {
  const v = p.values;
  const rules = p.rules.map(parseRule);
  const active = v.ufw === "active";
  const dockerSkips = (l: Listener) => v.docker_fw !== "nftables" && v[isV6(l.addr) ? "docker_nat6" : "docker_nat4"] === "1";
  const reach = (l: Listener, docker: boolean): Omit<Reach, "port" | "proc"> => {
    if (isLoopback(l.addr)) return { state: "local", why: "localhost only" };
    if (!active) return { state: "open", why: "open, firewall off" };
    if (docker && dockerSkips(l)) return { state: "open", why: "open, docker skips ufw" };
    const hit = ruleFor(rules, l);
    if (hit) {
      const { rule, n } = hit;
      if (rule.action === "deny" || rule.action === "reject") return { state: "blocked", why: `blocked by rule ${n}` };
      if (rule.from) return { state: "limited", why: `only from ${rule.from} (rule ${n})` };
      return { state: "open", why: `allowed by rule ${n}${rule.action === "limit" ? ", rate-limited" : ""}` };
    }
    if (l.proto === "udp" && UFW_DEFAULT_UDP.includes(l.port)) return { state: "open", why: "ufw default rule" };
    if (v.ufw_in === "ACCEPT") return { state: "open", why: "default policy accepts" };
    return { state: "blocked", why: "blocked, no rule" };
  };
  const docker = [...p.published, ...p.listen.filter((l) => l.proc === "docker-proxy")];
  const all = [...p.listen.filter((l) => l.proc !== "docker-proxy").map((l) => ({ l, docker: false })), ...docker.map((l) => ({ l, docker: true }))];
  // One row per port and program; a public socket outranks a localhost one.
  const rows = new Map<string, Reach>();
  for (const { l, docker: d } of all.sort((a, b) => a.l.port - b.l.port || a.l.proto.localeCompare(b.l.proto))) {
    const key = `${portName(l)} ${d ? "docker" : l.proc}`;
    const r = { port: portName(l), proc: d ? "docker" : l.proc, ...reach(l, d) };
    if (!rows.has(key) || rows.get(key)!.state === "local") rows.set(key, r);
  }
  return [...rows.values()];
}
const words = (s = "") => s.split(/\s+/).filter(Boolean);

/** What setup would do to each part of the server, and what it must not touch. */
/** Docker Engine with compose: what every site runs on. Podman's `docker` shim is not enough. */
function assessDocker(v: Record<string, string>): Check {
  const check = (status: Status, detail = ""): Check => ({ part: "docker", label: "docker", status, detail });
  if (!v.docker) return check("todo", "install docker and compose");
  const docker = v.docker.match(/\d+(\.\d+)+/)?.[0] ?? v.docker;
  if (v.docker_podman === "1") return check("conflict", `${v.docker} is podman's docker shim; landfall needs Docker Engine (remove podman-docker, then re-run setup)`);
  const todo = [v.docker_running === "1" ? "" : "start it", Number(v.compose?.split(".")[0]) >= 2 ? "" : "install compose"].filter(Boolean);
  if (todo.length) return check("todo", `docker ${docker}, ${todo.join(" + ")}`);
  // docker_latest/compose_latest: the newest releases, filled in by setup when it can reach GitHub.
  const behind = (have: string, want = "") => (want && cmpVersion(have, want) < 0 ? ` (${want} is current)` : "");
  return check("done", `docker ${docker}${behind(docker, v.docker_latest)}, compose ${v.compose}${behind(v.compose, v.compose_latest)}`);
}

export function assess(p: Probe, w: Wanted): Check[] {
  const v = p.values;
  const check = (part: Part, label: string, status: Status, detail = ""): Check => ({ part, label, status, detail });
  const checks: Check[] = [];

  const missing = v.pkgs_missing ?? "";
  checks.push(
    v.pkg === "none"
      ? check("packages", "base packages", "done", "no supported package manager, skipped")
      : missing.trim()
        ? check("packages", "base packages", "todo", `install ${missing.trim()}`)
        : check("packages", "base packages", "done"),
  );

  checks.push(assessDocker(v));

  const layout = v.root_dir === "1" && v.network === "1";
  const sites = Number(v.sites || 0);
  checks.push(
    check("layout", "/opt/srv", layout ? "done" : "todo", layout ? `${sites} site${sites === 1 ? "" : "s"} (never touched by setup)` : "create dir and network"),
  );

  if (w.deployUser) {
    const label = `deploy user ${w.deployUser}`;
    if (v.user !== "1") checks.push(check("user", label, "todo", "create"));
    else {
      const add = [v.user_docker === "1" ? "" : "docker group", v.user_key === "1" ? "" : "ssh key"].filter(Boolean);
      checks.push(check("user", label, add.length ? "todo" : "done", add.length ? `exists, add ${add.join(" + ")}` : ""));
    }
  }

  if (!w.firewall) checks.push(check("firewall", "firewall", "off"));
  else if (v.ufw === "missing") checks.push(check("firewall", "firewall", "done", "ufw not available, skipped"));
  else if (v.ufw === "active") checks.push(check("firewall", "firewall", "done", "ufw active (landfall only adds ssh/80/443)"));
  else checks.push(assessFirewall(p, w));

  if (!w.harden) checks.push(check("harden", "ssh hardening", "off"));
  else if (v.hardened === "1") checks.push(check("harden", "ssh hardening", "done"));
  else {
    const others = words(v.password_users).filter((u) => u !== "root" && u !== w.loginUser && u !== w.deployUser);
    checks.push(
      others.length && v.password_auth !== "no"
        ? check("harden", "ssh hardening", "conflict", `${others.join(", ")} would lose ssh password login`)
        : check("harden", "ssh hardening", "todo", "keys only"),
    );
  }

  if (!w.traefik) checks.push(check("traefik", "traefik", "off"));
  else checks.push(assessTraefik(p));
  return checks;
}

/**
 * How to route through a Traefik container someone else runs, read from its
 * command line (`docker inspect` → `foreign_proxy=/name|image|net1,net2,|args`).
 * `missing` lists what its flags don't say (e.g. it is configured by a file).
 */
export function foreignProxy(line = ""): { name: string; proxy?: Proxy; missing: string[] } | undefined {
  const [rawName = "", image = "", nets = "", args = ""] = line.split("|");
  if (!/traefik/.test(image)) return undefined;
  const name = rawName.replace(/^\//, "");
  const flag = (re: RegExp) => args.match(re)?.[1];
  const entrypoint = flag(/--entrypoints\.([\w-]+)\.address=[^\s]*:443\b/);
  const networks = nets.split(",").filter((n) => n && n !== "bridge" && n !== "host");
  const found: Partial<Proxy> = {
    container: name,
    network: flag(/--providers\.docker\.network=(\S+)/) ?? (networks.length === 1 ? networks[0] : undefined),
    entrypoint,
    resolver:
      (entrypoint && flag(new RegExp(`--entrypoints\\.${entrypoint}\\.http\\.tls\\.certresolver=(\\S+)`))) ??
      flag(/--certificatesresolvers\.([\w-]+)\./),
  };
  const missing = (["network", "entrypoint", "resolver"] as const).filter((k) => !found[k]);
  return { name, proxy: missing.length ? undefined : (found as Proxy), missing };
}

const describeProxy = (p: Proxy) => `${p.container} (network ${p.network}, entrypoint ${p.entrypoint}, resolver ${p.resolver})`;

export function assessTraefik(p: Probe): Check {
  const v = p.values;
  const t = (status: Status, detail: string, proxy?: Proxy): Check => ({ part: "traefik", label: "traefik", status, detail, proxy });
  const adopted = parseProxy(v.proxy ?? "");
  if (adopted) return t("done", `sites use your traefik ${describeProxy(adopted)}`, adopted);
  if (v.traefik_compose === "foreign") return t("conflict", `${TRAEFIK_DIR}/docker-compose.yml was not written by landfall`);
  const [state, workdir] = words(v.traefik_container);
  const ours = state !== undefined && workdir === TRAEFIK_DIR;
  if (state && !ours) {
    const other = foreignProxy(v.foreign_proxy);
    if (!other || other.name !== "traefik") return t("conflict", "a container named traefik exists that landfall did not create");
  }
  for (const port of [80, 443]) {
    const containers = words(v[`publish_${port}`]).filter((n) => !(ours && n === "traefik"));
    if (containers.length) {
      const other = foreignProxy(v.foreign_proxy);
      if (other?.proxy) return t("todo", `use your traefik ${describeProxy(other.proxy)}`, other.proxy);
      if (other) {
        return t(
          "conflict",
          `traefik ${other.name} owns 80/443, its flags don't name the ${other.missing.join(", ")}: lf traefik use ${other.name} ${other.missing.map((m) => `--${m} …`).join(" ")}`,
        );
      }
      return t("conflict", `port ${port} is published by container ${containers.join(", ")}`);
    }
    // landfall's traefik on the host network listens itself.
    const host = p.listen.find((l) => l.port === port && l.proc !== "docker-proxy" && !(ours && l.proc === "traefik"));
    if (host) return t("conflict", `port ${port} is in use by ${host.proc}`);
  }
  if (ours && state === "running") return t("done", "running (config refreshed)");
  return t("todo", ours ? `${state}, start` : "install");
}

export function printChecks(checks: Check[]) {
  const mark: Record<Status, string> = { done: c.green("✓"), todo: c.cyan("→"), conflict: c.yellow("!"), off: c.dim("-") };
  const w = Math.max(...checks.map((ch) => ch.label.length));
  for (const ch of checks) {
    const detail = ch.status === "off" ? c.dim("disabled") : ch.status === "conflict" ? c.yellow(ch.detail) : c.dim(ch.detail);
    info(`${mark[ch.status]} ${ch.label.padEnd(w)}  ${detail}`);
  }
}
