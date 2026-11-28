import { defineCommand, serverOpt } from "../cmd";
import { c, confirmRemoval, confirmRisky, fail, info, ok, printJson, table, warn } from "../../core/lib/term";
import { bytes } from "../../core/lib/format";
import { readKey } from "../../core/server/keys";
import { cloudFirewall, facts } from "../../core/server/facts";
import { usersLogin } from "../../core/server/users";
import { centralCompose } from "../../core/traefik/traefik";
import {
  addScript,
  asRoot,
  checkDomain,
  checkTenantName,
  cleanLimits,
  cleanRights,
  deactivateScript,
  domainsScript,
  limitsScript,
  nextPort,
  offScript,
  overlaps,
  PORTS,
  purgeScript,
  readTenants,
  restoreScript,
  rightsScript,
  rightsText,
  startScript,
  stopScript,
  tenantsView,
  type Limits,
  type TenantsView,
} from "../../core/server/tenants";
import { serverTarget } from "../target";
import { LIMIT_RULES, publicPortError, tenantInvite } from "../../core/server/tenant-policy";
import { effectiveSsh } from "../../core/ssh/sshconfig";
import { checkInt } from "../../core/lib/config";

const json = { type: "boolean", desc: "machine-readable output" } as const;
const limitOpts = {
  memory: { type: "string", desc: "memory limit of all the tenant's processes, like 2G (none: no limit)" },
  cpu: { type: "string", desc: "CPU limit, like 200% for two cores (none: no limit)" },
  tasks: { type: "string", desc: "limit on processes and threads, like 2000 (none: no limit)" },
} as const;

async function load(o: Record<string, any>) {
  const { name, server } = serverTarget(o);
  const admin = await usersLogin(server);
  return { name, server, admin, view: await readTenants(admin, { light: true }) };
}

function tenantOf(v: TenantsView, user: string, active?: boolean) {
  const t = v.tenants.find((t) => t.user === user) ?? fail(`${user} is not a tenant${v.on ? "" : " (no tenants on this server)"}`);
  if (active && !t.active) fail(`${user} is removed; lf tenant restore ${user} brings it back`);
  return t;
}

function limitsFrom(o: Record<string, any>): Limits {
  const l: Limits = {};
  for (const [k, r] of Object.entries(LIMIT_RULES) as [keyof Limits, (typeof LIMIT_RULES)[keyof Limits]][])
    if (o[k]) l[k] = r.re.test(o[k]) ? o[k] : fail(`--${k} takes ${r.hint}`);
  return l;
}

/** Domains must not reach into another tenant's. */
function checkFree(v: TenantsView, user: string, domains: string[]) {
  for (const d of domains)
    for (const t of v.tenants) if (t.user !== user) for (const e of t.domains) if (overlaps(d, e)) fail(`${d} overlaps ${e} of tenant ${t.user}`);
}

export const tenantAdd = defineCommand({
  name: "tenant add",
  args: "<user>",
  summary: `Add a tenant: a user with its own rootless Docker, sites and Traefik.

  lf tenant add anna --key ~/anna.pub --domain anna.dev --domain '*.anna.dev'

The central Traefik passes TLS for the tenant's domains through to it. The first
tenant moves the central Traefik to the host network (a short outage) and needs
an active firewall: ufw, or --provider-firewall when the provider's firewall guards
the server. lf tenant off undoes all of it.`,
  options: {
    server: serverOpt,
    key: { type: "string", short: "k", desc: "the tenant's public key line or .pub file" },
    domain: { type: "string", short: "d", multiple: true, desc: "a domain the tenant serves (repeat; *.example.com for all subdomains)" },
    port: { type: "string", desc: `the local port of the tenant's Traefik (default: the first free one of ${PORTS.min}-${PORTS.max})` },
    "provider-firewall": { type: "boolean", desc: "the provider's firewall, not ufw, keeps the tenants' ports closed" },
    force: { type: "boolean", desc: "the first tenant: accept the short outage of the sites without a question" },
    ...limitOpts,
  },
  async run([user], o) {
    if (!user || !o.key || !o.domain?.length) fail("usage: lf tenant add <user> --key <key|file.pub> --domain <domain> [--domain …]");
    checkTenantName(user);
    const key = readKey(o.key);
    const domains = [...new Set((o.domain as string[]).map(checkDomain))];
    const limits = cleanLimits(limitsFrom(o));
    const { name, server, admin, view } = await load(o);
    if (view.tenants.some((t) => t.user === user)) fail(`${user} is a tenant already`);
    checkFree(view, user, domains);
    const used = view.tenants.map((t) => t.port);
    const port = o.port ? checkInt(o.port, "--port", 1024, 65535) : nextPort(used);
    if (used.includes(port)) fail(`port ${port} belongs to another tenant`);
    let firewall = "ufw";
    if (!view.ufw) {
      const cloud = cloudFirewall((await facts(server)).cloud?.id);
      if (!o["provider-firewall"])
        fail(
          `tenants can open their own ports; enable the firewall first (lf firewall enable)${cloud ? `, or check the ${cloud} and pass --provider-firewall` : ""}`,
        );
      firewall = cloud ?? "provider";
    }
    const outage = `the first tenant moves the central Traefik of ${name} to the host network: sites are offline for a few seconds`;
    if (!view.on && !(o.force || (await confirmRisky(`${outage[0].toUpperCase()}${outage.slice(1)}. Go on?`)))) fail(`${outage}; pass --force to go on`);
    await asRoot(admin, addScript({ user, key, domains, port, limits, firewall, traefik: centralCompose(server) }));
    ok(`added tenant ${user} to ${name} (port ${port})`);
    info(`lf tenant invite ${user} prints what to send ${user}`);
  },
});

export const tenantList = defineCommand({
  name: "tenant ls",
  summary: "List the tenants: their domains, port, limits, sites and whether their Docker runs.",
  options: { server: serverOpt, json, sizes: { type: "boolean", desc: "also measure the disk each tenant uses (slow)" } },
  async run(_, o) {
    const view = await tenantsView(serverTarget(o).server, o.sizes);
    if (o.json) return void printJson(view);
    if (!view.on) return void info("no tenants on this server (lf tenant add)");
    const num = (x?: number) => (x === undefined ? c.dim("-") : String(x));
    table([
      ["user", "uid", "port", "state", "docker", "sites", "containers", "memory", ...(o.sizes ? ["disk"] : []), "limits", "rights", "domains"].map(c.dim),
      ...view.tenants.map((t) => [
        t.user,
        String(t.uid),
        String(t.port),
        t.active ? c.green("active") : c.yellow("removed"),
        t.running ? c.green("running") : c.dim("stopped"),
        num(t.sites),
        num(t.containers),
        t.memory === undefined ? c.dim("-") : bytes(t.memory),
        ...(o.sizes ? [t.disk === undefined ? c.dim("-") : bytes(t.disk)] : []),
        Object.entries(t.limits ?? {})
          .map(([k, v]) => `${k} ${v}`)
          .join(", ") || c.dim("none"),
        t.rights ? rightsText(t.rights) : c.dim("default"),
        t.domains.join(" "),
      ]),
    ]);
  },
});

export const tenantDomains = defineCommand({
  name: "tenant domains",
  args: "<user>",
  summary: "Add or remove domains the central Traefik passes to a tenant.",
  options: {
    server: serverOpt,
    add: { type: "string", multiple: true, desc: "a domain to add (repeat)" },
    rm: { type: "string", multiple: true, desc: "a domain to remove (repeat)" },
  },
  async run([user], o) {
    if (!user || (!o.add?.length && !o.rm?.length)) fail("usage: lf tenant domains <user> --add <domain> | --rm <domain>");
    const { name, admin, view } = await load(o);
    const t = tenantOf(view, user);
    const add = ((o.add ?? []) as string[]).map(checkDomain);
    const rm = new Set(((o.rm ?? []) as string[]).map(checkDomain));
    for (const d of rm) if (!t.domains.includes(d)) fail(`${d} is not a domain of ${user}`);
    const domains = [...new Set([...t.domains.filter((d) => !rm.has(d)), ...add])];
    if (!domains.length) fail(`${user} needs at least one domain; lf tenant rm ${user} removes the tenant`);
    checkFree(view, user, add);
    await asRoot(admin, domainsScript(t, view.raw[user], domains));
    ok(`${user} on ${name}: ${domains.join(" ")}`);
  },
});

export const tenantLimits = defineCommand({
  name: "tenant limits",
  args: "<user>",
  summary: "Set what a tenant's processes may use together: memory, CPU, tasks (none removes a limit).",
  options: { server: serverOpt, ...limitOpts },
  async run([user], o) {
    const limits = limitsFrom(o);
    if (!user || !Object.keys(limits).length) fail("usage: lf tenant limits <user> [--memory 2G] [--cpu 200%] [--tasks 2000]");
    const { name, admin, view } = await load(o);
    const t = tenantOf(view, user);
    await asRoot(admin, limitsScript(t, view.raw[user], limits));
    ok(`limits of ${user} on ${name} set`);
  },
});

const startStop = (stop: boolean) =>
  defineCommand({
    name: stop ? "tenant stop" : "tenant start",
    args: "<user>",
    summary: stop ? "Stop a tenant's Docker and with it all its sites." : "Start a tenant's Docker again.",
    options: { server: serverOpt },
    async run([user], o) {
      if (!user) fail(`usage: lf tenant ${stop ? "stop" : "start"} <user>`);
      const { name, admin, view } = await load(o);
      tenantOf(view, user, true);
      if (stop) await confirmRemoval(`Stop all sites of ${user} on ${name}?`);
      await asRoot(admin, (stop ? stopScript : startScript)(user));
      ok(`${stop ? "stopped" : "started"} the Docker of ${user}`);
    },
  });
export const tenantStop = startStop(true);
export const tenantStart = startStop(false);

export const tenantRemove = defineCommand({
  name: "tenant rm",
  args: "<user>",
  summary: `Remove a tenant: its logins, Docker and routes stop, its open ports close; its data stays (lf tenant restore).

--purge also deletes the user and all its data. That cannot be undone.`,
  options: { server: serverOpt, purge: { type: "boolean", desc: "delete the user, its sites, volumes and images" } },
  async run([user], o) {
    if (!user) fail("usage: lf tenant rm <user> [--purge]");
    const { name, admin, view } = await load(o);
    const t = tenantOf(view, user);
    if (o.purge) {
      await confirmRemoval(`Delete tenant ${user} on ${name} with its user, sites, volumes and images? This cannot be undone.`, user);
      await asRoot(admin, purgeScript(user, view.raw[user]));
      return void ok(`deleted tenant ${user}`);
    }
    if (!t.active) fail(`${user} is removed already; --purge deletes it`);
    await confirmRemoval(`Stop all sites of ${user} on ${name} and lock its logins?`);
    await asRoot(admin, deactivateScript(user, view.raw[user]));
    ok(`removed tenant ${user}; lf tenant restore ${user} brings it back`);
  },
});

export const tenantRestore = defineCommand({
  name: "tenant restore",
  args: "<user>",
  summary: "Bring a removed tenant back: logins, Docker, sites and routes.",
  options: { server: serverOpt },
  async run([user], o) {
    if (!user) fail("usage: lf tenant restore <user>");
    const { admin, view } = await load(o);
    const t = tenantOf(view, user);
    if (t.active) fail(`${user} is active`);
    await asRoot(admin, restoreScript(user, view.raw[user]));
    ok(`restored tenant ${user}`);
  },
});

export const tenantOff = defineCommand({
  name: "tenant off",
  summary: `Undo what the first tenant changed on the server: Traefik's network, modes, ufw rules,
the systemd and AppArmor files. Removed tenants keep their data.

  lf tenant off --rm-tenants     remove the active tenants first`,
  options: {
    server: serverOpt,
    "rm-tenants": { type: "boolean", desc: "remove the active tenants first (their data stays)" },
    "remove-packages": { type: "boolean", desc: "also remove the packages the first tenant installed" },
  },
  async run(_, o) {
    const { name, admin, view } = await load(o);
    const state = view.state ?? fail(`tenants are off on ${name}`);
    const active = view.tenants.filter((t) => t.active).map((t) => t.user);
    if (active.length && !o["rm-tenants"]) fail(`tenants are active: ${active.join(", ")}; lf tenant rm them first, or pass --rm-tenants`);
    await confirmRemoval(
      `Turn tenants off on ${name}${active.length ? `, stopping ${active.join(", ")}` : ""}? The central Traefik restarts (a short outage).`,
    );
    if (view.tenants.length > active.length) warn(`removed tenants keep their users and data; lf tenant rm <user> --purge deletes them`);
    await asRoot(admin, offScript(state, view.raw.state, { rmTenants: o["rm-tenants"], removePackages: o["remove-packages"] }));
    ok(`tenants off on ${name}`);
  },
});

export const tenantRights = defineCommand({
  name: "tenant rights",
  args: "<user>",
  summary: `Show or change what a tenant may do beyond its domains and limits.

  lf tenant rights anna                      print them
  lf tenant rights anna --open 25565/tcp     open a port for anna's containers
  lf tenant rights anna --no-cron            take away anna's crontab

A port opens in ufw; without ufw, open it in the provider's firewall too.
--no-cron keeps the crontab aside (cron.deny) and brings it back with --cron.`,
  options: {
    server: serverOpt,
    json,
    cron: { type: "boolean", desc: "allow a crontab (the default); --no-cron forbids it" },
    open: { type: "string", multiple: true, desc: "a port to open for the tenant, like 25565/tcp (repeat)" },
    close: { type: "string", multiple: true, desc: "an open port to close again (repeat)" },
  },
  async run([user], o) {
    if (!user) fail("usage: lf tenant rights <user> [--cron | --no-cron] [--open <port/proto>] [--close <port/proto>]");
    const open = (o.open ?? []) as string[];
    const close = (o.close ?? []) as string[];
    for (const p of open) {
      const e = publicPortError(p);
      if (e) fail(e);
    }
    const { name, admin, view } = await load(o);
    const t = tenantOf(view, user);
    if (o.cron === undefined && !open.length && !close.length) {
      if (o.json) return void printJson({ cron: t.rights?.cron !== false, ports: t.rights?.ports ?? [] });
      return void table([
        ["cron", t.rights?.cron === false ? c.yellow("off") : "allowed"],
        ["ports", t.rights?.ports?.join(" ") || c.dim("none")],
      ]);
    }
    tenantOf(view, user, true);
    const ports = new Set(t.rights?.ports);
    for (const p of close) if (!ports.has(p)) fail(`${p} is not open for ${user}`);
    for (const p of open) {
      const other = view.tenants.find((x) => x.user !== user && x.rights?.ports?.includes(p));
      if (other) fail(`${p} is open for tenant ${other.user} already`);
    }
    const next = cleanRights({ cron: o.cron ?? t.rights?.cron, ports: [...[...ports].filter((p) => !close.includes(p)), ...open] });
    if (rightsText(next) === rightsText(t.rights)) return void info(`${user} has these rights already`);
    if (open.length && !view.ufw) warn(`ufw is not active: open ${open.join(", ")} in the provider's firewall too`);
    await asRoot(admin, rightsScript(t, view.raw[user], next ?? {}));
    ok(`rights of ${user} on ${name}: ${rightsText(next)}`);
  },
});

export const tenantInviteCmd = defineCommand({
  name: "tenant invite",
  args: "<user>",
  summary: `Print what to send a tenant: install lf, log in, start Traefik, point DNS, deploy.

  lf tenant invite anna | pbcopy`,
  options: { server: serverOpt, host: { type: "string", desc: "the address the tenant reaches the server at (default: the one lf uses)" } },
  async run([user], o) {
    if (!user) fail("usage: lf tenant invite <user> [--host <address>]");
    const { server, view } = await load(o);
    const t = tenantOf(view, user, true);
    const ssh = effectiveSsh(server);
    console.log(tenantInvite({ user, host: o.host ?? ssh.hostname, port: ssh.port, domains: t.domains, rights: t.rights }));
  },
});
