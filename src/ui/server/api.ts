import { pluginContext, pluginNamed, pluginsView } from "../../core/plugins/plugins";
import { panelView } from "../../core/plugins/plugin-api";
import { updateCommand, VERSION } from "../../core/lib/version";
import { DOMAIN, LOGIN_NAME, MIN_PASSWORD, loadConfig, loadProject, resolveServer } from "../../core/lib/config";
import { ENV_NAME } from "../../core/site/env-vars";
import { SECRET_NAME } from "../../core/site/meta";
import { listServers, reachAll, target } from "../../core/views/dashboard";
import { browse, emptyFolder, jobCwd, receiveUpload } from "./local";
import { localImages } from "../../core/deploy/buildlocal";
import { ciView } from "../../core/deploy/ci";
import { checkProject } from "../../core/deploy/exposure";
import { readAutodeploy } from "../../core/deploy/autodeploy";
import { SITE_NAME, requireSite, validName } from "../../core/site/site";
import { envView } from "../../core/site/dotenv";
import { overview } from "../../core/server/overview";
import { readSecrets } from "../../core/site/live";
import { parseSince } from "../../core/traefik/traffic";
import { volumes } from "../../core/site/volumes";
import { USER_NAME } from "../../core/server/users";
import { trivyState } from "../../core/server/scan";
import { registries } from "../../core/server/registries";
import {
  configView,
  defaultsView,
  savedView,
  diskView,
  dnsView,
  factsView,
  firewallView,
  historyBrief,
  pruneView,
  scanView,
  statsView,
  systemView,
  trafficView,
  siteTrafficView,
  certsView,
  traefikView,
  updatesView,
  usersView,
  refsView,
  gitView,
  projectsView,
} from "../../core/views/views";
import { DEFAULT_TRAEFIK_IMAGE, JOURNAL, OWN_PROXY, PROXY_FILE, ROOT, SITES, TRAEFIK_DIR } from "../../core/ssh/templates";
import { availableUpdate, updateCheckOff } from "../../core/lib/self-update";
import { failure, json } from "./http";
import { jobList, jobsApi, type JobArgsPolicy } from "./jobs";

/** The project lf ui started in; a broken .landfall.json there must not keep the page from loading. */
function projectHere() {
  try {
    return loadProject(process.cwd()) ?? null;
  } catch {
    return null;
  }
}

// `lf ui` runs through the CLI, which refreshes the cached answer; this only reads it.
function updateLine() {
  const latest = updateCheckOff() ? undefined : availableUpdate(VERSION);
  return latest ? { latest } : null;
}

/** What /api/state sends: everything the page needs before it shows a thing. */
export function state() {
  const cfg = loadConfig();
  return {
    version: VERSION,
    // A newer landfall on npm, from the daily check, and how to install it.
    update: updateLine(),
    // How to update this landfall, wherever it was installed (a server a newer one changed says so).
    updateCommand: updateCommand(),
    cwd: process.cwd(),
    project: projectHere(),
    projects: projectsView(),
    defaultImage: DEFAULT_TRAEFIK_IMAGE,
    ownProxy: OWN_PROXY,
    // The CLI's own input rules, so forms reject what the command would.
    rules: {
      loginName: LOGIN_NAME.source,
      userName: USER_NAME.source,
      minPassword: MIN_PASSWORD,
      domain: DOMAIN.source,
      siteName: SITE_NAME.source,
      envName: ENV_NAME.source,
      secretName: SECRET_NAME.source,
    },
    paths: { root: ROOT, sites: SITES, traefik: TRAEFIK_DIR, journal: JOURNAL, proxy: PROXY_FILE },
    defaults: defaultsView(),
    servers: listServers().map((e) => ({ ...e, target: target(e.name), saved: savedView(cfg.servers[e.name]) })),
    jobs: jobList(),
    // Sections the plugins add to each server's page; GET servers/<n>/plugins/<plugin> loads one.
    plugins: pluginsView(),
  };
}

// Separate from state: logging in to every server takes seconds, the list should not wait.
async function reach(q: URLSearchParams): Promise<Response> {
  const names = listServers().map((e) => e.name);
  const fresh = q.get("fresh") === "1";
  if (q.get("stream") !== "1") return json(await reachAll(names, fresh));
  // ?stream=1: one JSON line per server as its answer comes, then {"done":true}.
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(ctl) {
      const send = (v: unknown) => {
        try {
          ctl.enqueue(enc.encode(`${JSON.stringify(v)}\n`));
        } catch {} // the page went away
      };
      try {
        await reachAll(names, fresh, (name, reach) => send({ name, reach }));
        send({ done: true });
      } catch (e: any) {
        send({ error: e.message });
      }
      try {
        ctl.close();
      } catch {}
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
}

async function serverRead(name: string, sub: string | undefined, rest: string | undefined, q: URLSearchParams): Promise<Response | undefined> {
  const { server } = resolveServer(name);
  const site = () => validName(q.get("site") ?? "");
  // The same views `--json` prints.
  switch (sub) {
    case undefined:
      return json(await overview(server));
    case "firewall":
      return json(await firewallView(server));
    case "config":
      return json(await configView(name, server));
    case "history":
      return json(await historyBrief(server));
    case "registries":
      return json(await registries(server));
    case "facts":
      return json(await factsView(name, server));
    case "stats":
      return json(await statsView(server));
    case "disk":
      return json(await diskView(server));
    case "prune":
      return json(await pruneView(server));
    case "system":
      return json(await systemView(name, server));
    case "users":
      return json(await usersView(server));
    case "updates":
      return json(await updatesView(server, q.get("refresh") === "1"));
    case "scan":
      return json(await scanView(server, q.get("others") !== "0", q.get("install") === "1"));
    case "trivy":
      return json(await trivyState(server, q.get("sizes") !== "0"));
    case "traffic": {
      const t = await trafficView(server, parseSince(q.get("since") ?? "24h"));
      const only = q.get("site");
      return json(only ? siteTrafficView(t, only) : t);
    }
    case "certs":
      return json(await certsView(server));
    case "traefik":
      return json(await traefikView(server));
    case "env": {
      const { env } = await requireSite(server, site(), { deployed: "manage the .env of" });
      return json(envView(env, q.get("reveal") === "1"));
    }
    case "secrets": {
      const s = site();
      const [, have] = await Promise.all([requireSite(server, s, { deployed: "manage the secrets of" }), readSecrets(server, s)]);
      // Names and sizes only: no route ever sends a secret's content.
      return json({ vars: have.map((x) => ({ key: x.key, length: x.size })) });
    }
    case "volumes": {
      // lf volumes --json: sizes, mounts and backups. sizes=0 skips du (slow on big volumes) but still tells which are empty.
      const sizes = q.get("sizes") !== "0";
      return json(await volumes(server, site(), sizes, !sizes));
    }
    // lf autodeploy <site> --json: the setting, what it saw last, the log tail.
    case "autodeploy":
      return json(await readAutodeploy(server, name, site()));
    case "plugins": {
      const p = pluginNamed(rest ?? "")?.plugin;
      if (!p?.panel) return failure(`no plugin panel ${rest ?? ""}`, 404);
      return json(await p.panel.load(pluginContext(p.name, name), panelView(p.panel, q.get("view"))));
    }
    case "dns": {
      const domains = (q.get("domains") ?? "")
        .split(",")
        .filter((d) => DOMAIN.test(d))
        .slice(0, 50);
      return json(await dnsView(server, domains));
    }
  }
  return undefined;
}

export async function api(req: Request, path: string[], policy: JobArgsPolicy): Promise<Response> {
  const [what, name, sub, rest] = path;
  const method = req.method;
  const q = new URL(req.url).searchParams;

  if (what === "state" && method === "GET") return json(state());
  if (what === "reach" && method === "GET") return reach(q);
  if (what === "servers" && name && method === "GET") {
    const r = await serverRead(name, sub, rest, q);
    if (r) return r;
  }
  if (what === "jobs") return jobsApi(req, name, sub, policy);

  if (what === "fs" && method === "GET") return json(browse(q.get("path") ?? undefined));
  // This machine's Docker images, for lf deploy --image (and --send-image); none when Docker is not running here.
  if (what === "images" && method === "GET") return json(localImages());
  // A project folder's git: its checkout, branches and tags, and the rules of .landfall.json (lf git track).
  // envs adds what runs in each environment (lf refs --json), which reads the servers and takes longer: the pipeline's one request.
  if (what === "git" && method === "GET") {
    const cwd = jobCwd(q.get("path") ?? "");
    if (!cwd) throw new Error("path is required");
    const g = await gitView(cwd);
    if (name === "envs") return json({ ...g, envs: (await refsView(cwd, undefined, g)).envs });
    return json(g);
  }
  // What lf ci init would write and set (lf ci init --dry-run --json): the CI wizard's preview.
  if (what === "ci" && method === "GET") {
    const cwd = jobCwd(q.get("path") ?? "");
    if (!cwd) throw new Error("path is required");
    return json(await ciView(cwd, q.get("forge") || undefined));
  }
  // What lf exposure check would report: risky files the upload would send, published compose ports. The deploy dialog shows it.
  if (what === "exposure" && method === "GET") {
    const cwd = jobCwd(q.get("path") ?? "");
    if (!cwd) throw new Error("path is required");
    return json(await checkProject(cwd));
  }
  if (what === "image-folder" && method === "POST") return json({ path: emptyFolder() });
  if (what === "upload" && method === "POST") {
    const up = await receiveUpload(await req.formData());
    return json({ ...up, detected: browse(up.path).detected });
  }

  return failure("not found", 404);
}
