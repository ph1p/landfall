import fs from "node:fs";
import { defineCommand } from "../cmd";
import { TRIVY, TRIVY_CACHE } from "../../core/scan";
import {
  checkDomain,
  checkEmail,
  DOMAIN,
  editList,
  forgetServer,
  loadConfig,
  mainDomain,
  withPrimary,
  resolveServer,
  updateConfig,
  patchServer,
  tildify,
  useServer,
  type Server,
} from "../../core/config";
import { securityNotes } from "../../core/security";
import { canLogin, runScript, shq, sshExec } from "../../core/ssh";
import { effectiveSsh, hasManagedBlock, removeHostBlock, sshAliases, SSH_CONFIG } from "../../core/sshconfig";
import { pct } from "../../core/format";
import { bytes, checkCloud, domainDns, duration, facts, serverCaps, suggestDomains } from "../../core/facts";
import { traefikState } from "../../core/traefik";
import { guardUndo } from "./history";
import { loginFor, pending, readJournal, undoSteps } from "../../core/journal";
import { listServers, reachAll } from "../../core/dashboard";
import { overview, removeLines, siteDir } from "../../core/remote";
import { DEFAULT_TRAEFIK_IMAGE, HELPER, PRELUDE, ROOT, TRAEFIK_DIR } from "../../core/templates";
import { c, confirmRemoval, fail, info, interactive, ok, step, table, warn, printJson } from "../../core/term";
import { ensureKeyLogin, keyFile, loginFrom, loginPassword, serverEntry } from "../../core/login";
import { configView, factsView, serverSettings } from "../../core/views";

export const serverAdd = defineCommand({
  name: "server add",
  args: "<name>",
  summary: `Register a server without setting it up (fresh or not).

Without --host, <name> is used as an ssh alias from ~/.ssh/config,
so \`lf server add vps\` works whenever \`ssh vps\` works.

With --host lf logs in with --key, or installs its own key
(~/.ssh/landfall_<name>) using the password once, and writes \`Host <name>\`
to ~/.ssh/config (created if missing), so \`ssh <name>\` works afterwards.
The password comes from the prompt, --password-stdin or $LANDFALL_PASSWORD.`,
  options: {
    host: { type: "string", desc: "hostname or IP (default: <name> as ssh alias)" },
    user: { type: "string", short: "u", desc: "login user (default: root for --host, else ssh config)" },
    port: { type: "string", short: "p", desc: "ssh port (default: from ssh config)" },
    key: { type: "string", short: "i", desc: "private key file to log in with" },
    "password-stdin": { type: "boolean", desc: "read the login password from stdin (installs landfall's key)" },
    "ssh-config": { type: "boolean", desc: "write Host <name> to ~/.ssh/config (--no-ssh-config)", default: true },
    email: { type: "string", desc: "contact e-mail for the Let's Encrypt account (optional)" },
    domain: { type: "string", desc: "main domain: sites default to <site>.<domain>" },
    cloud: { type: "string", desc: "the provider, if detection is wrong: aws, gcp, azure, hetzner, … none, or auto to detect again" },
    default: { type: "boolean", desc: "make it the default server" },
  },
  async run([name], o) {
    if (!name) fail("usage: lf server add <name> [--host ...]");
    const domain = o.domain && checkDomain(o.domain);
    const cloud = o.cloud === undefined ? undefined : (checkCloud(o.cloud) ?? "");
    const cfg = loadConfig();
    const existing = cfg.servers[name];
    const ownAlias = sshAliases().includes(name) && !hasManagedBlock(name);
    if (o.host && ownAlias) fail(`${name} is already a Host in your ssh config; pick another name or drop --host`);
    const login = loginFrom(name, o, existing);
    const password = await loginPassword(o["password-stdin"]);
    // Without a password or a terminal to type one, only report whether the key works.
    const keyPath = await ensureKeyLogin(name, login, { check: !password && !interactive(), password });
    const entry: Server = keyPath
      ? serverEntry(name, login, keyPath, { existing, sshConfig: o["ssh-config"], ownAlias, port: o.port, keyGiven: !!o.key })
      : { ...existing, ...login };
    if (!entry.key) delete entry.key;
    if (!entry.user) delete entry.user;
    if (!entry.port) delete entry.port;
    if (o.email) entry.email = checkEmail(o.email);
    if (domain) entry.domains = withPrimary(entry.domains, domain);
    if (cloud) entry.cloud = cloud;
    else if (cloud === "") delete entry.cloud;
    const saved = await updateConfig((fresh) => {
      patchServer(fresh, name, existing, entry);
      if (o.default || !fresh.default) fresh.default = name;
    });
    ok(`added ${c.bold(name)}${saved.default === name ? c.dim(" (default)") : ""}`);
    if (!keyPath) info(`then: ${c.bold(`lf setup ${name}`)} (asks for the password and installs a key)`);
    else {
      info(c.dim(`next: lf setup ${name} --check shows what setup would install`));
      await securityNotes(name, entry);
    }
  },
});

export const serverList = defineCommand({
  name: "server list",
  summary: `List servers registered with landfall and aliases found in ~/.ssh/config.

Git hosts (github.com, gitlab.*, User git …) are left out: they are not servers.
--check logs in to each with its key (5s timeout, 8 at a time):
  ok     key login works
  login  sshd answers but refuses the key (lf setup installs one)
  down   no ssh: host off, wrong port, firewall, or name not found`,
  options: {
    all: { type: "boolean", short: "a", desc: "also list every ssh config alias" },
    check: { type: "boolean", short: "c", desc: "try an ssh login to each and show which are reachable" },
    json: { type: "boolean", desc: "machine-readable output (what the web UI lists)" },
  },
  async run(_, o) {
    const cfg = loadConfig();
    const list = listServers().filter((e) => e.registered || o.all);
    const target = (s: Server) => `${s.user ? s.user + "@" : ""}${s.host}${s.port ? ":" + s.port : ""}`;
    const status = o.check ? await reachAll(list.map((e) => e.name)) : {};
    if (o.json) {
      return printJson(list.map((e) => ({ ...e, target: e.registered ? target(cfg.servers[e.name]) : e.name, ...(o.check && { reach: status[e.name] }) })));
    }
    if (!list.length) {
      console.log(`no servers yet — ${c.bold("lf server add <ssh-alias>")} or ${c.bold("lf setup <name> --host <ip>")}`);
      return;
    }
    const paint = { ok: c.green, login: c.yellow, down: c.red };
    const rows = [[c.dim("NAME"), c.dim("TARGET"), c.dim("SOURCE"), ...(o.check ? [c.dim("STATUS")] : [])]];
    for (const e of list) {
      const r = status[e.name];
      rows.push([
        e.name + (e.isDefault ? c.green(" *") : ""),
        e.registered ? target(cfg.servers[e.name]) : e.name,
        e.registered ? "landfall" : hasManagedBlock(e.name) ? "ssh (landfall)" : "ssh",
        ...(r ? [`${paint[r.state](r.state)} ${c.dim(r.state === "ok" ? `${r.ms}ms` : r.detail)}`] : []),
      ]);
    }
    table(rows);
    if (!o.all) console.log(c.dim("\nAny ~/.ssh/config alias works too (--all to list them)."));
  },
});

export const serverRemove = defineCommand({
  name: "server rm",
  args: "<name>",
  summary: "Forget a server (nothing is changed on the server itself).",
  options: { "ssh-config": { type: "boolean", desc: "also remove the landfall-managed Host block from ~/.ssh/config" } },
  async run([name], o) {
    if (!name) fail("usage: lf server rm <name>");
    const cfg = loadConfig();
    if (!cfg.servers[name] && !hasManagedBlock(name)) fail(`unknown server "${name}"`);
    await confirmRemoval(`Forget server ${name}? Nothing on the server changes.`);
    await forgetServer(name);
    if (o["ssh-config"] && removeHostBlock(name)) ok(`removed Host ${name} from ${tildify(SSH_CONFIG)}`);
    ok(`removed ${name}`);
    // Said, not deleted: the key may still be the way in, and the Host block is plain ssh config.
    const key = /^[\w@:[\]][\w.@:[\]-]*$/.test(name) ? keyFile(name) : "";
    const kept = [
      ...(hasManagedBlock(name) ? [`Host ${name} in ${tildify(SSH_CONFIG)} (--ssh-config removes it)`] : []),
      ...(key && fs.existsSync(key) ? [`the key ${tildify(key)}`] : []),
    ];
    if (kept.length) info(c.dim(`kept on this machine: ${kept.join(", ")}`));
  },
});

/** Journal runs `server uninstall` reverts: what setup and traefik setup changed outside ROOT. */
const SETUP_RUN = /^(setup|traefik setup|traefik use)( |$)/;

export const serverUninstall = defineCommand({
  name: "server uninstall",
  args: "<name>",
  summary: `Remove landfall from a server: its sites, Traefik, ${ROOT} and what setup changed.

Deletes every site landfall deployed (named volumes stay unless --volumes) and forgets
adopted ones, which keep running. Stops landfall's Traefik (a Traefik of your own is left
alone), reverts what \`lf setup\` changed (deploy user, ufw, ssh hardening, docker network)
and deletes ${ROOT}, its journal included. Then forgets the server locally.
Docker, packages, landfall's key for root and rules from \`lf firewall\` stay.`,
  options: {
    volumes: { type: "boolean", desc: "also delete the sites' named volumes (their data)" },
    "keep-setup": { type: "boolean", desc: "keep the deploy user, ufw and ssh hardening; only remove sites, traefik and " + ROOT },
    force: { type: "boolean", desc: "even if it leaves ufw on without an ssh rule" },
  },
  async run([n], o) {
    if (!n) fail("usage: lf server uninstall <name>");
    const { name, server: saved } = resolveServer(n);
    // After lf undo --all the deploy user is gone: root's key still gets in.
    const server = (await canLogin(saved)) ? saved : { ...saved, user: "root" };
    if (server !== saved && !(await canLogin(server))) fail(`cannot log in to ${name}, neither as ${effectiveSsh(saved).user} nor as root`);
    // Deleting ROOT needs root: found now, while the deploy user still exists.
    const root = await loginFor(server, "root");
    const [ov, st, runs] = await Promise.all([overview(server), traefikState(server), readJournal(server)]);
    if (st.compose === "foreign") fail(`${TRAEFIK_DIR}/docker-compose.yml was not written by landfall: move it out of ${ROOT} first`);
    // Whatever lives under ROOT goes with it; undoing it step by step could trip over what is already gone.
    const steps = o["keep-setup"]
      ? []
      : runs
          .filter((r) => SETUP_RUN.test(r.cmd))
          .flatMap(pending)
          .filter((x) => !x.undo!.includes(ROOT));

    step(`uninstall landfall from ${c.bold(name)}`);
    for (const x of ov.sites) {
      const what = x.meta.adopted
        ? `forget ${x.meta.name} (keeps running from ${x.meta.adopted})`
        : `delete ${x.meta.name} (${x.domains.join(", ") || "no domains"})`;
      console.error(`  ${c.red("-")} ${what}${o.volumes && !x.meta.adopted ? " and its volumes" : ""}`);
    }
    if (st.compose) console.error(`  ${c.red("-")} stop and remove traefik and its certificates`);
    console.error(`  ${c.red("-")} remove landfall's images (${st.compose ? "traefik, " : ""}trivy, ${HELPER}) and lf scan's database`);
    if (st.proxy) console.error(`  ${c.dim(`· your traefik ${st.proxy} stays`)}`);
    for (const x of [...steps].reverse()) console.error(`  ${c.cyan("↺")} ${x.what}`);
    console.error(`  ${c.red("-")} delete ${ROOT}, its journal included`);
    console.error(`  ${c.red("-")} forget ${name} locally`);
    console.error(`  ${c.dim(`· docker, packages, landfall's key for root${o["keep-setup"] ? ", deploy user, ufw and ssh hardening" : ""} stay`)}`);
    await guardUndo(server, steps, o.force);
    await confirmRemoval(`Uninstall landfall from ${name}? This cannot be undone.`, name);

    const lines = [PRELUDE];
    for (const { meta } of ov.sites) {
      // Adopted projects run from their own folder: only landfall's notes go.
      const rm = meta.adopted ? [`rmf ${shq(siteDir(meta.name))}`] : removeLines(meta, { volumes: o.volumes });
      lines.push(`log ${shq(`removing ${meta.name}`)}`, "(", ...rm, ")", `record ${shq(`removed site ${meta.name}`)}`);
    }
    if (st.compose) lines.push(`log "stopping traefik"`, `(cd ${TRAEFIK_DIR} && dc down --remove-orphans)`, `record "removed traefik"`);
    // lf scan's database: a cache, not data. landfall's own images go too; one a container still uses stays.
    const images = [TRIVY, HELPER, ...(st.compose ? [server.traefikImage || DEFAULT_TRAEFIK_IMAGE] : [])];
    lines.push(`! command -v docker >/dev/null || { docker volume rm ${TRIVY_CACHE}; docker image rm ${images.map(shq).join(" ")}; } >/dev/null 2>&1 || true`);
    if (lines.length > 1) await runScript(server, lines.join("\n"));
    if (steps.length) {
      step(`reverting setup (${steps.length} change${steps.length > 1 ? "s" : ""})`);
      await undoSteps(server, steps);
    }
    await runScript(root.login, `rm -rf ${ROOT}`, { sudo: root.sudo });
    ok(`landfall removed from ${name}`);

    await forgetServer(name);
    if (removeHostBlock(name)) ok(`removed Host ${name} from ${tildify(SSH_CONFIG)}`);
    ok(`forgot ${name}`);
    if (fs.existsSync(keyFile(name))) info(c.dim(`${tildify(keyFile(name))} stays: root on ${name} still accepts it`));
  },
});

export const serverUse = defineCommand({
  name: "server use",
  args: "<name>",
  summary: "Set the default server used when --server is omitted.",
  async run([name]) {
    if (!name) fail("usage: lf server use <name>");
    await useServer(name);
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
    if (o.json) return void printJson(await factsView(n, server));
    const f = await facts(server);
    const caps = await serverCaps(server, f);
    const share = (used: number, total: number) => (total ? ` (${pct(used, total)}%)` : "");
    const memUsed = f.mem.total - f.mem.available;
    console.log(c.bold(n) + c.dim(` (${server.host})`));
    const rows: [string, string][] = [
      ["os", `${f.os}${f.pkg !== "none" ? c.dim(` · ${f.pkg}`) : ""}`],
      ["kernel", `${f.kernel} ${f.arch}`],
      ...(f.cloud ? [["provider", `${f.cloud.name}${f.cloud.firewall ? c.dim(` · ${f.cloud.firewall} in front`) : ""}`] as [string, string]] : []),
      ["uptime", `${duration(f.uptime)}${f.reboot ? c.yellow(" · reboot required") : ""}`],
      ["cpu", `${f.cpus} cores, load ${f.load}`],
      ["memory", `${bytes(memUsed)} / ${bytes(f.mem.total)}${share(memUsed, f.mem.total)}`],
      ["disk", `${bytes(f.disk.used)} / ${bytes(f.disk.total)}${share(f.disk.used, f.disk.total)}`],
      ["address", [f.ip4, f.ip6].filter(Boolean).join(", ") || "unknown"],
      ["login", `${f.user}${caps.can.admin ? (f.admin ? c.dim(" · root or sudo") : c.dim(" · root's key for admin work")) : c.yellow(" · no sudo")}`],
      ["init", f.init === "other" ? c.dim("no systemd or OpenRC") : f.init],
      ["docker", f.docker ? `${f.docker}${f.compose ? c.dim(` · compose ${f.compose}`) : c.yellow(" · no compose")}` : caps.why.docker!],
      ["firewall", f.ufw ? "ufw" : caps.can.firewall ? c.dim("none (lf setup installs ufw)") : c.dim(caps.why.firewall!)],
    ];
    for (const [k, v] of rows) console.log(`${c.dim(k.padEnd(8))} ${v}`);
    if (f.support.note) (f.support.level === "eol" || f.support.level === "unsupported" ? warn : info)(f.support.note);
    if (f.docker) {
      console.log();
      await runScript(server, `docker ps --format 'table {{.Names}}\\t{{.Image}}\\t{{.Status}}' 2>/dev/null || true`);
    }
  },
});

export const serverConfig = defineCommand({
  name: "server config",
  args: "[name]",
  summary: `Show every setting landfall uses for a server: its entry in landfall's config,
the main domain, Traefik settings, what ssh resolves (host, user, port, keys)
and the Host block in ~/.ssh/config. Nothing connects to the server.`,
  options: { json: { type: "boolean", desc: "machine-readable output" } },
  async run([n], o) {
    const { name, server } = resolveServer(n);
    if (o.json) return void printJson(await configView(name, server));
    const s = serverSettings(name);
    const row = (k: string, v: string) => console.log(`  ${c.dim(k.padEnd(10))} ${v}`);
    console.log(`${c.bold(name)}${s.isDefault ? c.dim(" (default)") : ""}`);
    console.log(`\n${c.bold("landfall")} ${c.dim(s.configFile)}`);
    if (!s.saved) row("entry", c.dim("none — an ssh alias landfall was not told about (lf server add)"));
    else for (const [k, v] of Object.entries(s.saved)) if (v !== undefined && k !== "dashboard" && k !== "domains" && k !== "tunnelOnly") row(k, String(v));
    if (!s.domains.length) row("domain", c.dim(`none (lf server domain ${name} example.com)`));
    s.domains.forEach((d, i) => row(i ? "" : s.domains.length > 1 ? "domains" : "domain", i ? d : `${d} ${c.dim(`(primary: new sites get <site>.${d})`)}`));
    row("new sites", `${s.tunnelOnly ? "no domain, tunnel only" : "get a domain"}${s.tunnelOnlyOwn ? "" : c.dim(" (landfall default, lf config)")}`);
    row("traefik", `${s.traefik.summary}${s.traefik.email ? `, ${s.traefik.email}` : ""} ${c.dim("(when landfall installs it)")}`);
    row("dashboard", s.traefik.dashboard ? `https://${s.traefik.dashboard}` : c.dim("off"));
    console.log(`\n${c.bold("ssh")} ${c.dim(`ssh -G ${s.saved?.host ?? name}`)}`);
    row("login", `${s.ssh.user}@${s.ssh.hostname}:${s.ssh.port}`);
    for (const k of s.ssh.keys) row("key", k.exists ? k.file : `${k.file} ${c.dim("(missing)")}`);
    if (s.ssh.block) {
      console.log(
        `\n${c.bold("ssh config")} ${c.dim(`${s.ssh.block.file}:${s.ssh.block.line}${s.ssh.block.managed ? ", written by landfall" : ", your own"}`)}`,
      );
      for (const l of s.ssh.block.text.split("\n")) console.log(`  ${l}`);
    } else console.log(`\n${c.bold("ssh config")} ${c.dim("no Host block; ssh uses its defaults")}`);
  },
});

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
the server's sites already use.

--tunnel-only makes new sites deploy with no domain unless -d gives one:
nothing is served on the internet, \`lf tunnel <site>\` reaches them.
--no-tunnel-only goes back to <site>.<primary>. Existing sites keep theirs.
Without either, the server follows landfall's default (\`lf config --tunnel-only\`).`,
  options: {
    add: { type: "string", short: "a", multiple: true, desc: "add a main domain (after the primary)" },
    primary: { type: "string", desc: "make this main domain the primary (added if new)" },
    rm: { type: "string", multiple: true, desc: "remove a main domain" },
    clear: { type: "boolean", desc: "forget all main domains" },
    "tunnel-only": { type: "boolean", desc: "new sites get no domain unless -d gives one (--no-tunnel-only)" },
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
    const tunnelOnly: boolean | undefined = o["tunnel-only"];
    const changing = !!(given.length || o.add || o.rm || o.primary || o.clear);
    let next: string[] | undefined;
    if (changing) {
      const rm: string[] = (o.rm ?? []).map(checkDomain);
      const base = o.clear ? [] : given.length ? given.map(checkDomain) : (server.domains ?? []);
      next = withPrimary(editList(base, (o.add ?? []).map(checkDomain), rm), o.primary && checkDomain(o.primary))!;
      const missing = rm.filter((d) => !server.domains?.includes(d));
      if (missing.length) warn(`${missing.join(", ")} is not a main domain of ${name}`);
      const dropped = (server.domains ?? []).filter((d) => !next!.includes(d));
      if (dropped.length)
        await confirmRemoval(`Remove the main domain${dropped.length > 1 ? "s" : ""} ${dropped.join(", ")} of ${name}? Sites keep their domains.`);
    }
    if (changing || tunnelOnly !== undefined) {
      const saved = await updateConfig((fresh) => {
        const entry = { ...server };
        if (next) {
          if (next.length) entry.domains = next;
          else delete entry.domains;
        }
        if (tunnelOnly !== undefined) {
          // Follow the latest global default when the requested value matches it.
          if (tunnelOnly === (fresh.defaults?.tunnelOnly ?? false)) delete entry.tunnelOnly;
          else entry.tunnelOnly = tunnelOnly;
        }
        patchServer(fresh, name, cfg.servers[name], entry);
      });
      Object.assign(server, saved.servers[name]);
      server.domains = saved.servers[name].domains;
      server.tunnelOnly = saved.servers[name].tunnelOnly;
    }
    if (tunnelOnly !== undefined) {
      ok(
        tunnelOnly
          ? `new sites on ${c.bold(name)} get no domain: reach them with lf tunnel, or deploy with -d`
          : `new sites on ${c.bold(name)} get a domain again`,
      );
      if (!changing) return;
    }
    if (next) {
      ok(
        next.length
          ? `main domains of ${c.bold(name)}: ${next.map((d, i) => (i ? d : c.bold(d))).join(", ")}${next.length > 1 ? c.dim(" (first = primary)") : ""}`
          : `${name} has no main domain`,
      );
      if (!next.length) return;
    }
    const domains = server.domains ?? [];
    if (!domains.length) {
      const suggest = await suggestDomains(server);
      if (o.json) return void printJson({ name, domains, suggest });
      info(`${name} has no main domain yet`);
      for (const g of suggest) info(`${g.hosts} routed hosts use ${c.bold(g.domain)} — ${c.bold(`lf server domain ${name} --add ${g.domain}`)}`);
      if (!suggest.length) info(`set one: ${c.bold(`lf server domain ${name} example.com`)}`);
      return;
    }
    const dns = await Promise.all(domains.map((d) => domainDns(server, d)));
    if (o.json) return void printJson({ name, domains: domains.map((domain, i) => ({ domain, primary: i === 0, ...dns[i] })) });
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
