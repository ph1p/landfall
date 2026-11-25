import { spawn } from "node:child_process";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkInt, configDir, type Server } from "../lib/config";
import { dest, runScript, shq, targetArgs } from "./ssh";
import { c, fail, info, ok, report, warn } from "../lib/term";

/** A container as a tunnel sees it: its address on each network, its labels and its command-line flags. */
export interface Ctr {
  name: string;
  /** network_mode: host — it listens on the server's own addresses. */
  host: boolean;
  ips: Record<string, string>;
  labels: Record<string, string>;
  args: string[];
  /** TCP ports its image exposes (EXPOSE), lowest first. */
  ports: number[];
}

/** The first running container matching the `docker ps` filters, if any. */
export async function findContainer(s: Server, filters: string[]): Promise<Ctr | undefined> {
  const { stdout } = await runScript(
    s,
    `id=$(docker ps -q ${filters.map((f) => `--filter ${shq(f)}`).join(" ")} | head -n1)
[ -z "$id" ] || docker inspect -f '{{json .Name}}{{"\\t"}}{{json .HostConfig.NetworkMode}}{{"\\t"}}{{json .NetworkSettings.Networks}}{{"\\t"}}{{json .Config.Labels}}{{"\\t"}}{{json .Args}}{{"\\t"}}{{json .Config.ExposedPorts}}' "$id"`,
    { capture: true },
  );
  const line = stdout.trim();
  if (!line) return undefined;
  const [name, mode, nets, labels, args, exposed] = line.split("\t").map((x) => JSON.parse(x));
  const ips = Object.fromEntries(
    Object.entries<any>(nets ?? {})
      .map(([n, v]) => [n, v?.IPAddress])
      .filter(([, ip]) => ip),
  );
  const ports = Object.keys(exposed ?? {})
    .map((p) => p.match(/^(\d+)\/tcp$/)?.[1])
    .filter((p): p is string => !!p)
    .map(Number)
    .sort((a, b) => a - b);
  return { name: String(name).replace(/^\//, ""), host: mode === "host", ips, labels: labels ?? {}, args: args ?? [], ports };
}

/** Where the server reaches the container: its address on `network` (else any), or loopback in host mode. */
export function ctrAddress(ctr: Ctr, network: string): string {
  if (ctr.host) return "127.0.0.1";
  const ip = ctr.ips[network] ?? Object.values(ctr.ips)[0];
  if (!ip) fail(`${ctr.name} has no IP address to tunnel to`);
  return ip;
}

/**
 * Where a Traefik router listens: the port of its entrypoint (from the container's --entrypoints
 * flags), and whether it speaks TLS there.
 */
export function routerPort(traefik: Ctr, router: string): { port: number; tls: boolean } | undefined {
  const label = (k: string) => traefik.labels[`traefik.http.routers.${router}.${k}`];
  const addrs = new Map(
    traefik.args.flatMap((a) => {
      const m = a.match(/^--entrypoints\.([^.=]+)\.address=.*:(\d+)/i);
      return m ? [[m[1].toLowerCase(), Number(m[2])] as const] : [];
    }),
  );
  const eps = label("entrypoints")
    ?.split(",")
    .map((e) => e.trim().toLowerCase()) ?? [...addrs.keys()];
  const tls = label("tls") === "true" || !!label("tls.certresolver");
  const ports = eps.map((e) => addrs.get(e)).filter((p): p is number => p !== undefined);
  const port = ports.find((p) => (p === 443) === tls) ?? ports[0];
  return port === undefined ? undefined : { port, tls };
}

/** Well-known ports that speak something other than HTTP: the scheme a client connects with. */
const SCHEMES: Record<number, string> = {
  25: "smtp",
  110: "pop3",
  143: "imap",
  465: "smtps",
  587: "smtp",
  993: "imaps",
  995: "pop3s",
  3306: "mysql",
  5432: "postgresql",
  5672: "amqp",
  6379: "redis",
  11211: "memcached",
  27017: "mongodb",
};
export const portScheme = (port: number) => SCHEMES[port] ?? "http";

/** `preferred` if nothing listens on it at `host`, else any free port. */
async function freePort(preferred?: number, host = "127.0.0.1"): Promise<number> {
  const tryPort = (p: number) =>
    new Promise<number | undefined>((resolve) => {
      const srv = net.createServer().once("error", () => resolve(undefined));
      srv.listen(p, host, () => {
        const port = (srv.address() as net.AddressInfo).port;
        srv.close(() => resolve(port));
      });
    });
  return (preferred && (await tryPort(preferred))) || (await tryPort(0))!;
}

/** Whether something accepts connections on the local port yet. */
const listening = (port: number) =>
  new Promise<boolean>((resolve) => {
    const sock = net.connect(port, "127.0.0.1");
    sock.once("connect", () => (sock.destroy(), resolve(true)));
    sock.once("error", () => resolve(false));
  });

/** A domain to send requests as: for a Traefik router that only answers Host(<name>). */
export interface AsHost {
  name: string;
  tls: boolean;
}

/**
 * Serve localhost:<port> by passing each request on to localhost:<to> as one for `as`.
 * Its certificate is not checked: the connection already runs inside SSH, and may be self-signed.
 */
function hostProxy(port: number, to: number, as: AsHost, host: string) {
  const client = as.tls ? https : http;
  const srv = http.createServer((req, res) => {
    const up = client.request(
      {
        host: "127.0.0.1",
        port: to,
        servername: as.name,
        rejectUnauthorized: false,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: as.name },
      },
      (r) => (res.writeHead(r.statusCode ?? 502, r.headers), r.pipe(res)),
    );
    up.on("error", (e) => (res.headersSent ? res.destroy() : res.writeHead(502).end(`${as.name}: ${e.message}\n`)));
    req.pipe(up);
  });
  return new Promise<http.Server>((resolve, reject) => srv.once("error", reject).listen(port, host, () => resolve(srv)));
}

/** This machine's IPv4 addresses on its networks (Wi-Fi, ethernet, VPN): where other devices reach it. */
const lanAddresses = () =>
  Object.values(os.networkInterfaces())
    .flatMap((l) => l ?? [])
    .filter((a) => a.family === "IPv4" && !a.internal)
    .map((a) => a.address);

// ---- open tunnels ----------------------------------------------------------

/** Each running `lf tunnel` writes <pid>.json here and removes it when it closes: `lf tunnels` lists them. */
export const TUNNELS_DIR = join(configDir, "tunnels");

export interface OpenTunnel {
  pid: number;
  /** The lf command that opened it, like `tunnel blog -s prod`. */
  cmd: string;
  what: string;
  /** ssh's destination: user@host. */
  server: string;
  url: string;
  lan: string[];
  at: string;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it runs, as another user.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** The tunnels open on this machine, oldest first; files of ones that died without closing go. */
export function openTunnels(): OpenTunnel[] {
  let files: string[];
  try {
    files = readdirSync(TUNNELS_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: OpenTunnel[] = [];
  for (const f of files) {
    const file = join(TUNNELS_DIR, f);
    let t: OpenTunnel | undefined;
    try {
      t = JSON.parse(readFileSync(file, "utf8"));
    } catch {}
    if (t && alive(t.pid)) out.push(t);
    else rmSync(file, { force: true });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/** Notes this process's tunnel; the returned function removes the note. */
function noteTunnel(t: Omit<OpenTunnel, "pid" | "cmd" | "at">): () => void {
  const file = join(TUNNELS_DIR, `${process.pid}.json`);
  const drop = () => rmSync(file, { force: true });
  try {
    mkdirSync(TUNNELS_DIR, { recursive: true });
    writeFileSync(file, JSON.stringify({ pid: process.pid, cmd: process.argv.slice(2).join(" "), at: new Date().toISOString(), ...t }));
    process.once("exit", drop);
  } catch {}
  return drop;
}

/** What ssh prints when the server's sshd has AllowTcpForwarding no: forwards open, then every connection fails. */
export const FORWARD_DENIED = /administratively prohibited/;

/**
 * Forward localhost:<local> to addr:port as the server sees it, until Ctrl-C (or the job is stopped).
 * Nothing changes on the server: no port is published, the site's domains stay as they are.
 * With `lan` it listens on every interface, so a phone on the same network reaches it too.
 */
export async function openTunnel(
  s: Server,
  addr: string,
  port: number,
  o: { local?: string; lan?: boolean; path?: string; what: string; note?: string; as?: AsHost; scheme?: string },
) {
  const bind = o.lan ? "0.0.0.0" : "127.0.0.1";
  const want = o.local === undefined ? undefined : checkInt(o.local, "--local", 1, 65535);
  const local = await freePort(want ?? (port >= 1024 ? port : 8080), bind);
  if (want && local !== want) fail(`local port ${want} is taken; pick another with --local`);
  // With `as`, ssh forwards to a side port and the host proxy serves the one shown.
  const fwd = o.as ? await freePort() : local;
  // Its own connection: a forward through the shared one would outlive this command.
  const args = [...targetArgs(s), "-o", "ControlPath=none", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15"];
  const ssh = spawn("ssh", [...args, "-N", "-L", `${o.as ? "127.0.0.1" : bind}:${fwd}:${addr}:${port}`, dest(s)], { stdio: ["ignore", "inherit", "pipe"] });
  // ssh's errors pass through; a refused forward gets a hint once, since ssh itself keeps running.
  let hinted = false;
  ssh.stderr.on("data", (b: Buffer) => {
    process.stderr.write(b);
    if (hinted || !FORWARD_DENIED.test(b.toString())) return;
    hinted = true;
    warn(`${s.host}'s sshd refuses port forwarding: set AllowTcpForwarding yes (or local) in /etc/ssh/sshd_config and reload ssh, then open the tunnel again`);
  });
  const exited = new Promise<number>((resolve) => ssh.on("close", (code) => resolve(code ?? 1)));
  let stopped = false;
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(sig, () => ((stopped = true), ssh.kill()));
  for (let i = 0; i < 100 && ssh.exitCode === null && !(await listening(fwd)); i++) await new Promise((r) => setTimeout(r, 150));
  let proxy: http.Server | undefined;
  let drop = () => {};
  if (ssh.exitCode === null) {
    // The proxy's port taken: the forward must not stay open without it.
    if (o.as) proxy = await hostProxy(local, fwd, o.as, bind).catch((e) => (ssh.kill(), fail(`${e?.message ?? e}`)));
    const scheme = o.scheme ?? "http";
    const url = (host: string) => `${scheme}://${host}:${local}${scheme === "http" ? (o.path ?? "/") : ""}`;
    ok(`${o.what}: ${c.cyan(url("localhost"))}`);
    const ips = o.lan ? lanAddresses() : [];
    report({ url: url("localhost"), lan: ips.map(url) });
    drop = noteTunnel({ what: o.what, server: dest(s), url: url("localhost"), lan: ips.map(url) });
    if (o.lan) {
      info(ips.length ? `on your network: ${ips.map((ip) => c.cyan(url(ip))).join("  ")}` : "on your network: this machine has no network address yet");
      warn("anyone on that network reaches it too: close it when you are done");
    }
    if (o.note) info(c.dim(o.note));
    info(c.dim("the tunnel stays open until Ctrl-C"));
  }
  const code = await exited;
  drop();
  proxy?.close();
  if (!stopped && code !== 0) fail(`the tunnel closed (ssh exit ${code})`);
}
