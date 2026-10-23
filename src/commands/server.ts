import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { defineCommand } from "../cmd";
import { checkDomain, CONFIG_PATH, DOMAIN, expandHome, guessDomains, loadConfig, mainDomain, withPrimary, resolveServer, saveConfig, tildify, type Server } from "../config";
import { runScript, sshExec } from "../ssh";
import { effectiveSsh, findHostBlock, hasManagedBlock, removeHostBlock, sshAliases } from "../sshconfig";
import { bytes, checkDns, duration, facts, serverIps } from "../facts";
import { describeTraefik, traefikSettings } from "./traefik";
import { c, confirmRemoval, fail, info, interactive, ok, table, warn } from "../ui";
import { ensureKeyLogin, loginPassword, serverEntry } from "../login";

export const serverAdd = defineCommand({
  name: "server add",
  args: "<name>",
  summary: `Register a server without setting it up (fresh or not).

Without --host, <name> is used as an ssh alias from ~/.ssh/config,
so \`lf server add vps\` works whenever \`ssh vps\` works.

With --host lf logs in with --key, or installs its own key
(~/.ssh/srv_<name>) using the password once, and writes \`Host <name>\`
to ~/.ssh/config (created if missing), so \`ssh <name>\` works afterwards.
The password comes from the prompt, --password-stdin or $SRV_PASSWORD.`,
  options: {
    host: { type: "string", desc: "hostname or IP (default: <name> as ssh alias)" },
    user: { type: "string", short: "u", desc: "login user (default: root for --host, else ssh config)" },
    port: { type: "string", short: "p", desc: "ssh port (default: from ssh config)" },
    key: { type: "string", short: "i", desc: "private key file to log in with" },
    "password-stdin": { type: "boolean", desc: "read the login password from stdin (installs landfall's key)" },
    "ssh-config": { type: "boolean", desc: "write Host <name> to ~/.ssh/config (--no-ssh-config)", default: true },
    email: { type: "string", desc: "contact e-mail for the Let's Encrypt account (optional)" },
    domain: { type: "string", desc: "main domain: sites default to <site>.<domain>" },
    default: { type: "boolean", desc: "make it the default server" },
  },
  async run([name], o) {
    if (!name) fail("usage: lf server add <name> [--host ...]");
    const domain = o.domain && checkDomain(o.domain);
    const cfg = loadConfig();
    const existing = cfg.servers[name];
    const ownAlias = sshAliases().includes(name) && !hasManagedBlock(name);
    if (o.host && ownAlias) fail(`${name} is already a Host in your ssh config; pick another name or drop --host`);
    const login: Server = {
      host: o.host ?? existing?.host ?? name,
      user: o.user ?? (o.host ? "root" : existing?.user),
      port: o.port ? Number(o.port) : existing?.port,
      key: o.key ?? existing?.key,
    };
    const password = await loginPassword(o["password-stdin"]);
    // Without a password or a terminal to type one, only report whether the key works.
    const keyPath = await ensureKeyLogin(name, login, { check: !password && !interactive(), password });
    const entry: Server = keyPath
      ? serverEntry(name, login, keyPath, { existing, sshConfig: o["ssh-config"], ownAlias, port: o.port, keyGiven: !!o.key })
      : { ...existing, ...login };
    if (!entry.key) delete entry.key;
    if (!entry.user) delete entry.user;
    if (!entry.port) delete entry.port;
    if (o.email) entry.email = o.email;
    if (domain) entry.domains = withPrimary(entry.domains, domain);
    cfg.servers[name] = entry;
    if (o.default || !cfg.default) cfg.default = name;
    saveConfig(cfg);
    ok(`added ${c.bold(name)}${cfg.default === name ? c.dim(" (default)") : ""}`);
    if (!keyPath) info(`then: ${c.bold(`lf setup ${name}`)} (asks for the password and installs a key)`);
    else info(c.dim(`next: lf setup ${name} --check shows what setup would install`));
  },
});

export const serverList = defineCommand({
  name: "server list",
  summary: "List servers registered with landfall and aliases found in ~/.ssh/config.",
  options: { all: { type: "boolean", short: "a", desc: "also list every ssh config alias" } },
  async run(_, o) {
    const cfg = loadConfig();
    const rows = [[c.dim("NAME"), c.dim("TARGET"), c.dim("SOURCE")]];
    for (const [name, s] of Object.entries(cfg.servers)) {
      const target = `${s.user ? s.user + "@" : ""}${s.host}${s.port ? ":" + s.port : ""}`;
      rows.push([name + (cfg.default === name ? c.green(" *") : ""), target, "landfall"]);
    }
    if (o.all) {
      for (const alias of sshAliases()) {
        if (!cfg.servers[alias]) rows.push([alias, alias, hasManagedBlock(alias) ? "ssh (landfall)" : "ssh"]);
      }
    }
    if (rows.length === 1) {
      console.log(`no servers yet — ${c.bold("lf server add <ssh-alias>")} or ${c.bold("lf setup <name> --host <ip>")}`);
      return;
    }
    table(rows);
    if (!o.all) console.log(c.dim("\nAny ~/.ssh/config alias works too (--all to list them)."));
  },
});

export const serverRemove = defineCommand({
  name: "server rm",
  args: "<name>",
  summary: "Forget a server (nothing is changed on the server itself).",
  options: { "ssh-config": { type: "boolean", desc: "also remove the srv-managed Host block from ~/.ssh/config" } },
  async run([name], o) {
    if (!name) fail("usage: lf server rm <name>");
    const cfg = loadConfig();
    if (!cfg.servers[name] && !hasManagedBlock(name)) fail(`unknown server "${name}"`);
    await confirmRemoval(`Forget server ${name}? Nothing on the server changes.`);
    delete cfg.servers[name];
    if (cfg.default === name) delete cfg.default;
    saveConfig(cfg);
    if (o["ssh-config"] && removeHostBlock(name)) ok(`removed Host ${name} from ~/.ssh/config`);
    ok(`removed ${name}`);
  },
});

export const serverUse = defineCommand({
  name: "server use",
  args: "<name>",
  summary: "Set the default server used when --server is omitted.",
  async run([name]) {
    if (!name) fail("usage: lf server use <name>");
    const cfg = loadConfig();
    cfg.servers[name] ??= { host: name };
    cfg.default = name;
    saveConfig(cfg);
    ok(`default server: ${c.bold(name)}`);
  },
});

export const serverSsh = defineCommand({
  name: "ssh",
  args: "[name] [-- command...]",
  summary: "Open a shell on a server, or run a command there.",
  passthrough: true,
  async run([name], _, rest) {
    const { server } = resolveServer(name);
    return sshExec(server, rest);
  },
});

export const serverInfo = defineCommand({
  name: "server info",
  args: "[name]",
  summary: "Show OS, hardware, load, memory, disk, addresses and containers of a server.",
  options: { json: { type: "boolean", desc: "machine-readable output" } },
  async run([name], o) {
    const { name: n, server } = resolveServer(name);
    const f = await facts(server);
    if (o.json) return void console.log(JSON.stringify({ name: n, ...f, ips: await serverIps(server, f) }, null, 2));
    const pct = (used: number, total: number) => (total ? ` (${Math.round((used / total) * 100)}%)` : "");
    const memUsed = f.mem.total - f.mem.available;
    console.log(c.bold(n) + c.dim(` (${server.host})`));
    const rows: [string, string][] = [
      ["os", `${f.os}${f.pkg !== "none" ? c.dim(` · ${f.pkg}`) : ""}`],
      ["kernel", `${f.kernel} ${f.arch}`],
      ["uptime", `${duration(f.uptime)}${f.reboot ? c.yellow(" · reboot required") : ""}`],
      ["cpu", `${f.cpus} cores, load ${f.load}`],
      ["memory", `${bytes(memUsed)} / ${bytes(f.mem.total)}${pct(memUsed, f.mem.total)}`],
      ["disk", `${bytes(f.disk.used)} / ${bytes(f.disk.total)}${pct(f.disk.used, f.disk.total)}`],
      ["address", [f.ip4, f.ip6].filter(Boolean).join(", ") || "unknown"],
      ["docker", f.docker || "not installed or no access (run lf setup)"],
    ];
    for (const [k, v] of rows) console.log(`${c.dim(k.padEnd(8))} ${v}`);
    if (f.support.note) (f.support.level === "ok" ? console.log : warn)(f.support.note);
    if (f.docker) {
      console.log();
      await runScript(server, `docker ps --format 'table {{.Names}}\\t{{.Image}}\\t{{.Status}}' 2>/dev/null || true`);
    }
  },
});

/** Everything landfall and ssh know about a server, without connecting to it. */
export function serverSettings(name: string) {
  const cfg = loadConfig();
  const saved = cfg.servers[name];
  const server: Server = saved ?? { host: name };
  const eff = effectiveSsh(server);
  const block = findHostBlock(server.host);
  const t = traefikSettings(server, {});
  return {
    name,
    isDefault: cfg.default === name,
    configFile: tildify(CONFIG_PATH),
    saved: saved ? { ...saved, dashboard: saved.dashboard && { host: saved.dashboard.host, user: saved.dashboard.user } } : null,
    domains: server.domains ?? [],
    traefik: { ...t, summary: describeTraefik(t), dashboard: server.dashboard?.host ?? null },
    ssh: {
      hostname: eff.hostname,
      user: eff.user,
      port: eff.port,
      keys: (server.key ? [server.key] : eff.identityFiles).map((f) => ({ file: tildify(f), exists: fs.existsSync(expandHome(f)) })),
      block: block ? { file: tildify(block.file), line: block.start + 1, managed: block.managed, text: block.lines.join("\n") } : null,
    },
  };
}

export const serverConfig = defineCommand({
  name: "server config",
  args: "[name]",
  summary: `Show every setting landfall uses for a server: its entry in landfall's config,
the main domain, Traefik settings, what ssh resolves (host, user, port, keys)
and the Host block in ~/.ssh/config. Nothing connects to the server.`,
  options: { json: { type: "boolean", desc: "machine-readable output" } },
  async run([n], o) {
    const { name } = resolveServer(n);
    const s = serverSettings(name);
    if (o.json) return void console.log(JSON.stringify(s, null, 2));
    const row = (k: string, v: string) => console.log(`  ${c.dim(k.padEnd(10))} ${v}`);
    console.log(`${c.bold(name)}${s.isDefault ? c.dim(" (default)") : ""}`);
    console.log(`\n${c.bold("landfall")} ${c.dim(s.configFile)}`);
    if (!s.saved) row("entry", c.dim("none — an ssh alias landfall was not told about (lf server add)"));
    else for (const [k, v] of Object.entries(s.saved)) if (v !== undefined && k !== "dashboard" && k !== "domains") row(k, String(v));
    if (!s.domains.length) row("domain", c.dim(`none (lf server domain ${name} example.com)`));
    s.domains.forEach((d, i) => row(i ? "" : s.domains.length > 1 ? "domains" : "domain", i ? d : `${d} ${c.dim(`(primary: new sites get <site>.${d})`)}`));
    row("traefik", `${s.traefik.summary}${s.traefik.email ? `, ${s.traefik.email}` : ""} ${c.dim("(when landfall installs it)")}`);
    row("dashboard", s.traefik.dashboard ? `https://${s.traefik.dashboard}` : c.dim("off"));
    console.log(`\n${c.bold("ssh")} ${c.dim(`ssh -G ${s.saved?.host ?? name}`)}`);
    row("login", `${s.ssh.user}@${s.ssh.hostname}:${s.ssh.port}`);
    for (const k of s.ssh.keys) row("key", k.exists ? k.file : `${k.file} ${c.dim("(missing)")}`);
    if (s.ssh.block) {
      console.log(`\n${c.bold("ssh config")} ${c.dim(`${s.ssh.block.file}:${s.ssh.block.line}${s.ssh.block.managed ? ", written by landfall" : ", your own"}`)}`);
      for (const l of s.ssh.block.text.split("\n")) console.log(`  ${l}`);
    } else console.log(`\n${c.bold("ssh config")} ${c.dim("no Host block; ssh uses its defaults")}`);
  },
});

/** Where the main domain and a name below it resolve to: both should point at the server. */
export async function domainDns(server: Server, domain: string) {
  const ips = await serverIps(server);
  const probe = `srv-${randomBytes(4).toString("hex")}.${domain}`;
  const [apex, wildcard] = await checkDns([domain, probe], ips);
  return { ips, apex, wildcard: { ...wildcard, domain: `*.${domain}` } };
}

/** Host names in the Traefik rules of the server's running containers (read-only). */
export async function routedHosts(server: Server): Promise<string[]> {
  const script = `docker ps -q | xargs -r docker inspect -f '{{range $k, $v := .Config.Labels}}{{println $v}}{{end}}' 2>/dev/null || true`;
  const { stdout } = await runScript(server, script, { capture: true });
  return [...stdout.matchAll(/Host\(`([^`]+)`\)/g)].map((m) => m[1]);
}

/** Main domains suggested by the sites already routed on the server, minus the ones it has. */
export const suggestDomains = async (server: Server) =>
  guessDomains(await routedHosts(server).catch(() => [])).filter((g) => !server.domains?.includes(g.domain));

export const serverDomain = defineCommand({
  name: "server domain",
  args: "[name] [domain...]",
  summary: `Show or set a server's main domains.

The first main domain is the primary: \`lf deploy\` serves a new site at
<site>.<primary>, \`--domain blog\` means blog.<primary>, and
\`lf traefik setup --dashboard traefik\` puts the dashboard at traefik.<primary>.
More main domains are listed and DNS-checked; use them with full names
(\`lf domains blog --add blog.other.org\`). Point a wildcard A record
(*.<domain>) at the server once per domain, and every site works without more DNS.

Domains given as arguments replace the list (the first becomes primary).
Without any, it lists them and, if there are none, suggests the base domains
the server's sites already use.`,
  options: {
    add: { type: "string", short: "a", multiple: true, desc: "add a main domain (after the primary)" },
    primary: { type: "string", desc: "make this main domain the primary (added if new)" },
    rm: { type: "string", multiple: true, desc: "remove a main domain" },
    clear: { type: "boolean", desc: "forget all main domains" },
    json: { type: "boolean", desc: "machine-readable output" },
  },
  async run(args, o) {
    // `lf server domain example.com` sets it on the default server.
    const cfg = loadConfig();
    const known = (a: string) => !!cfg.servers[a] || sshAliases().includes(a);
    const takesDomain = args.length > 0 && !known(args[0]) && DOMAIN.test(args[0].replace(/^\*\./, ""));
    const n: string | undefined = takesDomain ? undefined : args[0];
    const given = takesDomain ? args : args.slice(1);
    const { name, server } = resolveServer(n);
    if (given.length || o.add || o.rm || o.primary || o.clear) {
      const entry = (cfg.servers[name] ??= { host: name });
      const rm: string[] = (o.rm ?? []).map(checkDomain);
      let next: string[] = o.clear ? [] : given.length ? given.map(checkDomain) : [...(entry.domains ?? [])];
      next = [...new Set([...next, ...(o.add ?? []).map(checkDomain)])].filter((d) => !rm.includes(d));
      next = withPrimary(next, o.primary && checkDomain(o.primary))!;
      const missing = rm.filter((d) => !entry.domains?.includes(d));
      if (missing.length) warn(`${missing.join(", ")} is not a main domain of ${name}`);
      const dropped = (entry.domains ?? []).filter((d) => !next.includes(d));
      if (dropped.length) await confirmRemoval(`Remove the main domain${dropped.length > 1 ? "s" : ""} ${dropped.join(", ")} of ${name}? Sites keep their domains.`);
      if (next.length) entry.domains = next;
      else delete entry.domains;
      saveConfig(cfg);
      server.domains = entry.domains;
      ok(next.length ? `main domains of ${c.bold(name)}: ${next.map((d, i) => (i ? d : c.bold(d))).join(", ")}${next.length > 1 ? c.dim(" (first = primary)") : ""}` : `${name} has no main domain`);
      if (!next.length) return;
    }
    const domains = server.domains ?? [];
    if (!domains.length) {
      const suggest = await suggestDomains(server);
      if (o.json) return void console.log(JSON.stringify({ name, domains, suggest }));
      info(`${name} has no main domain yet`);
      for (const g of suggest) info(`${g.hosts} routed hosts use ${c.bold(g.domain)} — ${c.bold(`lf server domain ${name} --add ${g.domain}`)}`);
      if (!suggest.length) info(`set one: ${c.bold(`lf server domain ${name} example.com`)}`);
      return;
    }
    const dns = await Promise.all(domains.map((d) => domainDns(server, d)));
    if (o.json) return void console.log(JSON.stringify({ name, domains: domains.map((domain, i) => ({ domain, primary: i === 0, ...dns[i] })) }, null, 2));
    const width = Math.max(...domains.map((d) => d.length)) + 2;
    const records: string[] = [];
    domains.forEach((d, i) => {
      const r = dns[i];
      for (const x of [r.apex, r.wildcard]) {
        const state = x.ok ? c.green("dns ok") : x.ips.length ? c.yellow(`dns → ${x.ips.join(", ")}`) : c.red("no dns");
        console.log(`${x.domain.padEnd(width)}  ${state}${x === r.apex && i === 0 && domains.length > 1 ? c.dim("  primary") : ""}`);
        if (!x.ok) records.push(`  ${x.domain}  A  ${r.ips[0] ?? "<server ip>"}`);
      }
    });
    if (records.length) console.log(c.dim(`\nadd these DNS records at your DNS provider:\n`) + records.join("\n"));
    const main = mainDomain(server)!;
    info(c.dim(`sites: lf deploy -d blog → blog.${main} · dashboard: lf traefik setup --dashboard traefik`));
  },
});
