import { spawn } from "node:child_process";
import net from "node:net";
import { checkInt, type Server } from "./config";
import { dest, runScript, shq, targetArgs } from "./ssh";
import { c, fail, info, ok } from "./ui";

/** A container as a tunnel sees it: its address on each network, and its labels. */
export interface Ctr {
  name: string;
  /** network_mode: host — it listens on the server's own addresses. */
  host: boolean;
  ips: Record<string, string>;
  labels: Record<string, string>;
}

/** The first running container matching the `docker ps` filters, if any. */
export async function findContainer(s: Server, filters: string[]): Promise<Ctr | undefined> {
  const { stdout } = await runScript(
    s,
    `id=$(docker ps -q ${filters.map((f) => `--filter ${shq(f)}`).join(" ")} | head -n1)
[ -z "$id" ] || docker inspect -f '{{json .Name}}{{"\\t"}}{{json .HostConfig.NetworkMode}}{{"\\t"}}{{json .NetworkSettings.Networks}}{{"\\t"}}{{json .Config.Labels}}' "$id"`,
    { capture: true },
  );
  const line = stdout.trim();
  if (!line) return undefined;
  const [name, mode, nets, labels] = line.split("\t").map((x) => JSON.parse(x));
  const ips = Object.fromEntries(Object.entries<any>(nets ?? {}).map(([n, v]) => [n, v?.IPAddress]).filter(([, ip]) => ip));
  return { name: String(name).replace(/^\//, ""), host: mode === "host", ips, labels: labels ?? {} };
}

/** Where the server reaches the container: its address on `network` (else any), or loopback in host mode. */
export function ctrAddress(ctr: Ctr, network: string): string {
  if (ctr.host) return "127.0.0.1";
  const ip = ctr.ips[network] ?? Object.values(ctr.ips)[0];
  if (!ip) fail(`${ctr.name} has no IP address to tunnel to`);
  return ip;
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

/**
 * Forward localhost:<local> to addr:port as the server sees it, until Ctrl-C (or the job is stopped).
 * Nothing changes on the server: no port is published, the site's domains stay as they are.
 */
export async function openTunnel(s: Server, addr: string, port: number, o: { local?: string; path?: string; what: string; note?: string }) {
  const want = o.local === undefined ? undefined : checkInt(o.local, "--local", 1, 65535);
  const local = await freePort(want ?? (port >= 1024 ? port : 8080));
  if (want && local !== want) fail(`local port ${want} is taken; pick another with --local`);
  // Its own connection: a forward through the shared one would outlive this command.
  const args = [...targetArgs(s), "-o", "ControlPath=none", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15"];
  const ssh = spawn("ssh", [...args, "-N", "-L", `127.0.0.1:${local}:${addr}:${port}`, dest(s)], { stdio: ["ignore", "inherit", "inherit"] });
  const exited = new Promise<number>((resolve) => ssh.on("close", (code) => resolve(code ?? 1)));
  let stopped = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => ((stopped = true), ssh.kill()));
  for (let i = 0; i < 100 && ssh.exitCode === null && !(await listening(local)); i++) await new Promise((r) => setTimeout(r, 150));
  if (ssh.exitCode === null) {
    ok(`${o.what}: ${c.cyan(`http://localhost:${local}${o.path ?? "/"}`)}`);
    if (o.note) info(c.dim(o.note));
    info(c.dim("the tunnel stays open until Ctrl-C"));
  }
  const code = await exited;
  if (!stopped && code !== 0) fail(`the tunnel closed (ssh exit ${code})`);
}
