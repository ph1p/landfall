import { spawn } from "node:child_process";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { checkInt, type Server } from "./config";
import { dest, runScript, shq, targetArgs } from "./ssh";
import { c, fail, info, ok } from "./ui";

/** A container as a tunnel sees it: its address on each network, its labels and its command-line flags. */
export interface Ctr {
  name: string;
  /** network_mode: host — it listens on the server's own addresses. */
  host: boolean;
  ips: Record<string, string>;
  labels: Record<string, string>;
  args: string[];
}

/** The first running container matching the `docker ps` filters, if any. */
export async function findContainer(s: Server, filters: string[]): Promise<Ctr | undefined> {
  const { stdout } = await runScript(
    s,
    `id=$(docker ps -q ${filters.map((f) => `--filter ${shq(f)}`).join(" ")} | head -n1)
[ -z "$id" ] || docker inspect -f '{{json .Name}}{{"\\t"}}{{json .HostConfig.NetworkMode}}{{"\\t"}}{{json .NetworkSettings.Networks}}{{"\\t"}}{{json .Config.Labels}}{{"\\t"}}{{json .Args}}' "$id"`,
    { capture: true },
  );
  const line = stdout.trim();
  if (!line) return undefined;
  const [name, mode, nets, labels, args] = line.split("\t").map((x) => JSON.parse(x));
  const ips = Object.fromEntries(Object.entries<any>(nets ?? {}).map(([n, v]) => [n, v?.IPAddress]).filter(([, ip]) => ip));
  return { name: String(name).replace(/^\//, ""), host: mode === "host", ips, labels: labels ?? {}, args: args ?? [] };
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
  const eps = label("entrypoints")?.split(",").map((e) => e.trim().toLowerCase()) ?? [...addrs.keys()];
  const tls = label("tls") === "true" || !!label("tls.certresolver");
  const ports = eps.map((e) => addrs.get(e)).filter((p): p is number => p !== undefined);
  const port = ports.find((p) => (p === 443) === tls) ?? ports[0];
  return port === undefined ? undefined : { port, tls };
}

/** `preferred` if nothing listens on it locally, else any free port. */
async function freePort(preferred?: number): Promise<number> {
  const tryPort = (p: number) =>
    new Promise<number | undefined>((resolve) => {
      const srv = net.createServer().once("error", () => resolve(undefined));
      srv.listen(p, "127.0.0.1", () => {
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
function hostProxy(port: number, to: number, as: AsHost) {
  const client = as.tls ? https : http;
  const srv = http.createServer((req, res) => {
    const up = client.request(
      { host: "127.0.0.1", port: to, servername: as.name, rejectUnauthorized: false, method: req.method, path: req.url, headers: { ...req.headers, host: as.name } },
      (r) => (res.writeHead(r.statusCode ?? 502, r.headers), r.pipe(res)),
    );
    up.on("error", (e) => (res.headersSent ? res.destroy() : res.writeHead(502).end(`${as.name}: ${e.message}\n`)));
    req.pipe(up);
  });
  return new Promise<http.Server>((resolve, reject) => srv.once("error", reject).listen(port, "127.0.0.1", () => resolve(srv)));
}

/**
 * Forward localhost:<local> to addr:port as the server sees it, until Ctrl-C (or the job is stopped).
 * Nothing changes on the server: no port is published, the site's domains stay as they are.
 */
export async function openTunnel(s: Server, addr: string, port: number, o: { local?: string; path?: string; what: string; note?: string; as?: AsHost }) {
  const want = o.local === undefined ? undefined : checkInt(o.local, "--local", 1, 65535);
  const local = await freePort(want ?? (port >= 1024 ? port : 8080));
  if (want && local !== want) fail(`local port ${want} is taken; pick another with --local`);
  // With `as`, ssh forwards to a side port and the host proxy serves the one shown.
  const fwd = o.as ? await freePort() : local;
  // Its own connection: a forward through the shared one would outlive this command.
  const args = [...targetArgs(s), "-o", "ControlPath=none", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15"];
  const ssh = spawn("ssh", [...args, "-N", "-L", `127.0.0.1:${fwd}:${addr}:${port}`, dest(s)], { stdio: ["ignore", "inherit", "inherit"] });
  const exited = new Promise<number>((resolve) => ssh.on("close", (code) => resolve(code ?? 1)));
  let stopped = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => ((stopped = true), ssh.kill()));
  for (let i = 0; i < 100 && ssh.exitCode === null && !(await listening(fwd)); i++) await new Promise((r) => setTimeout(r, 150));
  let proxy: http.Server | undefined;
  if (ssh.exitCode === null) {
    if (o.as) proxy = await hostProxy(local, fwd, o.as);
    ok(`${o.what}: ${c.cyan(`http://localhost:${local}${o.path ?? "/"}`)}`);
    if (o.note) info(c.dim(o.note));
    info(c.dim("the tunnel stays open until Ctrl-C"));
  }
  const code = await exited;
  proxy?.close();
  if (!stopped && code !== 0) fail(`the tunnel closed (ssh exit ${code})`);
}
