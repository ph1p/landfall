import fs from "node:fs";
import { defineCommand } from "../cmd";
import { checkDomain, checkEmail, defaults, loadConfig, mainDomain, withPrimary, saveConfig, tildify, type Server } from "../config";
import { securityNotes } from "../security";
import { canLogin, runScript } from "../ssh";
import { effectiveSsh, hasManagedBlock, sshAliases } from "../sshconfig";
import { assess, printChecks, probeServer, type Check, type Part } from "../inventory";
import { PLATFORM, support } from "../facts";
import { ensureKey, ensureKeyLogin, loginPassword, serverEntry } from "../login";
import { BOOTSTRAP, DEFAULT_TRAEFIK_IMAGE, PRELUDE } from "../templates";
import { latestCompose, latestDocker } from "../updates";
import { ask, c, confirm, confirmRisky, fail, info, interactive, ok, report, step, warn } from "../ui";
import { DEFAULT_USER, describeTraefik, installTraefik, traefikSettings, useProxy, type TraefikInstall } from "./traefik";

export const keygen = defineCommand({
  name: "keygen",
  args: "<name>",
  summary: "Create an ed25519 key pair at ~/.ssh/landfall_<name> (skips if it exists) and print the public key.",
  async run([name]) {
    if (!name) fail("usage: lf keygen <name>");
    const { path, created } = ensureKey(name);
    ok(`${created ? "created" : "key exists:"} ${tildify(path)}`);
    console.log(fs.readFileSync(`${path}.pub`, "utf8").trim());
  },
});

/** Parts setup may change: everything wanted, minus conflicts the user did not accept. */
async function decide(checks: Check[], force?: boolean): Promise<Set<Part>> {
  const apply = new Set<Part>();
  for (const ch of checks) {
    if (ch.status === "off") continue;
    if (ch.status !== "conflict") apply.add(ch.part);
    else if (ch.part === "traefik") warn(`skipping traefik: ${ch.detail} (free it, then \`lf traefik setup\`)`);
    else if (force || (await confirmRisky(`${ch.label}: ${ch.detail}. Apply anyway?`))) apply.add(ch.part);
    else warn(`skipping ${ch.label}: ${ch.detail} (--force to apply)`);
  }
  return apply;
}

/** Asks for the traefik settings no flag set, on a first install in a terminal. */
async function askTraefik(server: Server, o: TraefikInstall) {
  step("traefik settings (enter keeps the default)");
  o.image ??= server.traefikImage ?? (await ask("traefik image", DEFAULT_TRAEFIK_IMAGE));
  if (o.hostNetwork === undefined && server.hostNetwork === undefined) {
    info(c.dim("host network: traefik sees real client IPs (also IPv6) and ufw guards 80/443; default publishes the ports via Docker"));
    o.hostNetwork = await confirm("run traefik on the host network?", false);
  }
  if (o.email === undefined && server.email === undefined && defaults().email === undefined) {
    const typed = (await ask("Let's Encrypt e-mail (optional)", "")).trim();
    o.email = typed ? checkEmail(typed) : undefined;
  }
  const domain = mainDomain(server);
  o.dashboard ??= (await ask(`dashboard domain, behind basic auth (optional${domain ? ", `off` for none" : ""})`, domain ? `traefik.${domain}` : "")) || undefined;
  if (o.dashboard === "off") o.dashboard = undefined;
}

/** Runs setup from another command, with setup's defaults for what `o` leaves out. */
export function setupServer(name: string, o: Record<string, unknown>) {
  const defaults = Object.fromEntries(Object.entries(setup.options!).flatMap(([k, v]) => ("default" in v ? [[k, v.default]] : [])));
  return setup.run([name], { ...defaults, ...o }, []);
}

export const setup = defineCommand({
  name: "setup",
  args: "<name>",
  summary: `Prepare a server: SSH key, Docker, firewall, deploy user, Traefik.

Turns a fresh box into a deploy target (safe to re-run):
  1. create a dedicated SSH key (~/.ssh/landfall_<name>) and install it (asks for the password once)
  2. install Docker, rsync, firewall (ufw: ssh/80/443), fail2ban, unattended-upgrades
  3. create a deploy user with docker access, disable SSH password login
  4. write \`Host <name>\` to ~/.ssh/config so \`ssh <name>\` just works
  5. install Traefik with automatic Let's Encrypt certificates

Works on existing ssh aliases too: \`lf setup vps\`.

Before changing anything, setup inspects the server and only does what is
missing. Steps that would break services already running there are skipped:
  - firewall, if enabling ufw would block public TCP/UDP ports in use
    (host services, or container ports when Docker's NAT doesn't skip ufw)
  - ssh hardening, if other users still log in with a password
  - traefik, if ports 80/443 or the name are taken by something else;
    a Traefik already running there is used instead (lf traefik use)
Use --check to only see that report, --force to apply firewall/hardening anyway.
In a terminal, a first Traefik install asks for image, host network, e-mail and
dashboard unless given as flags.`,
  options: {
    host: { type: "string", desc: "IP or hostname of a new server" },
    user: { type: "string", short: "u", desc: "initial login user (default: root for --host, else ssh config)" },
    port: { type: "string", short: "p", desc: "ssh port" },
    key: { type: "string", short: "i", desc: "use this private key instead of generating one" },
    "deploy-user": { type: "string", desc: "user landfall deploys as (empty = keep login user)", default: "deploy" },
    email: { type: "string", desc: "contact e-mail for the Let's Encrypt account (optional)" },
    harden: { type: "boolean", desc: "disable ssh password auth (--no-harden to skip)", default: true },
    firewall: { type: "boolean", desc: "enable ufw (--no-firewall to skip)", default: true },
    traefik: { type: "boolean", desc: "install traefik (--no-traefik to skip)", default: true },
    "ssh-config": { type: "boolean", desc: "write Host block to ~/.ssh/config (--no-ssh-config)", default: true },
    staging: { type: "boolean", desc: "Let's Encrypt staging CA, remembered (--no-staging to switch back)" },
    domain: { type: "string", desc: "main domain: sites default to <site>.<domain> (lf server domain)" },
    dashboard: { type: "string", desc: "traefik dashboard domain (`traefik` = traefik.<main domain>)" },
    image: { type: "string", desc: `traefik image, remembered (default: ${DEFAULT_TRAEFIK_IMAGE})` },
    "host-network": { type: "boolean", desc: "run traefik on the host network: real client IPs, ufw applies; remembered" },
    http3: { type: "boolean", desc: "traefik serves HTTP/3 on 443/udp, on by default; remembered (--no-http3)" },
    check: { type: "boolean", desc: "only report what is set up and what setup would change" },
    force: { type: "boolean", desc: "apply firewall/ssh hardening despite conflicts" },
    "key-only": { type: "boolean", desc: "only install the ssh key, change nothing else" },
    "password-stdin": { type: "boolean", desc: "read the login password from stdin instead of asking (also: $LANDFALL_PASSWORD)" },
  },
  async run([name], o) {
    if (!name) fail("usage: lf setup <name> [--host <ip>]");
    const cfg = loadConfig();
    const existing = cfg.servers[name];
    // Never shadow a Host entry the user wrote themselves (e.g. `Host vps`).
    const isOwnAlias = sshAliases().includes(name) && !hasManagedBlock(name);

    const login: Server = {
      host: o.host ?? existing?.host ?? name,
      user: o.user ?? (o.host ? "root" : existing?.user),
      port: o.port ? Number(o.port) : existing?.port,
      key: o.key ?? existing?.key,
    };
    // Re-running setup on a server we already set up: landfall now logs in as the
    // deploy user, but bootstrapping needs root, which kept key-only access.
    // Root may be locked: then the sudo user that bootstrapped it the first time.
    if (!o.user && o["deploy-user"] && effectiveSsh(login).user === o["deploy-user"]) {
      let admin: string | undefined;
      for (const user of ["root", existing?.admin]) {
        if (!admin && user && (await canLogin({ ...login, user }))) admin = user;
      }
      if (admin) login.user = admin;
      else warn(`${o["deploy-user"]} can't change the system and root's key login does not work; pass -u <a sudo user> if setup fails`);
    }
    const eff = effectiveSsh(login);
    step(`setting up ${c.bold(name)} ${c.dim(`(${eff.user}@${eff.hostname}:${eff.port})`)}`);
    let stage = 0;
    const next = (msg: string) => step(`[${++stage}/5] ${msg}`);

    // 1. key-based access
    next("ssh key");
    const keyPath = await ensureKeyLogin(name, login, { check: o.check, password: await loginPassword(o["password-stdin"]) });
    if (!keyPath || o["key-only"]) return;
    const pubkey = fs.readFileSync(`${keyPath}.pub`, "utf8").trim();
    const deployUser: string = o["deploy-user"] === eff.user ? "" : o["deploy-user"];

    // 2. inspect before touching anything
    next("checking what is already set up");
    const probeEnv = { PUBKEY: pubkey, DEPLOY_USER: deployUser };
    const [probe, dockerLatest, composeLatest] = await Promise.all([probeServer(login, probeEnv), latestDocker(), latestCompose()]);
    Object.assign(probe.values, { docker_latest: dockerLatest ?? "", compose_latest: composeLatest ?? "" });
    // The port sshd listens on, which differs from eff.port behind port forwarding.
    const sshPort = Number(probe.values.ssh_port) || eff.port;
    const checks = assess(probe, {
      sshPort,
      loginUser: eff.user,
      deployUser,
      firewall: o.firewall,
      harden: o.harden,
      traefik: o.traefik,
    });
    const traefik = checks.find((ch) => ch.part === "traefik");
    const tOpts: TraefikInstall = {
      email: o.email && checkEmail(o.email),
      staging: o.staging,
      image: o.image,
      hostNetwork: o["host-network"],
      http3: o.http3,
      dashboard: o.dashboard,
      dashboardUser: DEFAULT_USER,
    };
    const ownTraefik = traefik && !traefik.proxy && traefik.status !== "conflict" && traefik.status !== "off";
    if (ownTraefik) traefik.detail += c.dim(` · ${describeTraefik(traefikSettings(existing ?? login, tOpts))}`);
    const os = support(probe.values.os_id ?? "", probe.values.os_version ?? "", probe.values.pkg ?? "none", undefined, probe.values.platform);
    info(`os: ${probe.values.os ?? "unknown"}${probe.values.pkg ? c.dim(` · ${probe.values.pkg}`) : ""}`);
    if (os.note) (os.level === "eol" || os.level === "unsupported" ? warn : info)(os.note);
    // Setup installs packages; without a package manager there is nothing it can do safely,
    // so only what deploys need (docker, traefik) is worth showing.
    const refuse = probe.values.pkg === "none" && `setup cannot change this server: ${PLATFORM[probe.values.platform ?? ""]?.name ?? "it has no apt, dnf, yum, apk or zypper"}${existing ? "" : `. Register it with \`lf server add ${name}\``}`;
    const shown = refuse ? checks.filter((ch) => ch.part === "docker" || ch.part === "traefik") : checks;
    printChecks(shown);
    report({ checks: shown.map(({ part, label, status, detail }) => ({ part, label, status, detail })), ...(refuse && { refuse }) });
    if (o.check) return void (refuse && warn(refuse));
    if (refuse) fail(refuse);
    const apply = await decide(checks, o.force);
    const firstTraefik = ownTraefik && traefik.status === "todo" && interactive();
    let domain = o.domain ? checkDomain(o.domain) : existing && mainDomain(existing);
    // Asked with the other traefik settings: the dashboard defaults to traefik.<domain>.
    if (domain === undefined && firstTraefik) {
      const typed = await ask("main domain for sites, e.g. example.com (optional)", "");
      domain = typed.trim() ? checkDomain(typed) : undefined;
    }
    if (firstTraefik) {
      await askTraefik({ ...(existing ?? login), domains: withPrimary(existing?.domains, domain) }, tOpts);
      info(`traefik: ${describeTraefik(traefikSettings(existing ?? login, tOpts))}${tOpts.dashboard ? `, dashboard ${tOpts.dashboard}` : ""}`);
    }
    const changes = checks.filter((ch) => ch.status !== "done" && apply.has(ch.part)).length;
    if (changes && !(await confirm(`apply the ${changes} change${changes === 1 ? "" : "s"} above?`))) return;

    // 3. bootstrap, only if something is missing
    const bootstrap: Part[] = ["packages", "docker", "layout", "user", "firewall", "harden"];
    if (checks.some((ch) => bootstrap.includes(ch.part) && ch.status !== "done" && apply.has(ch.part))) {
      next("bootstrapping (docker, firewall, users, ssh hardening)");
      await runScript(login, PRELUDE + BOOTSTRAP, {
        env: {
          PUBKEY: pubkey,
          DEPLOY_USER: deployUser,
          SSH_PORT: sshPort,
          HARDEN: apply.has("harden"),
          FIREWALL: apply.has("firewall"),
          HTTP3: (tOpts.http3 ?? existing?.http3) !== false,
        },
      });
      ok("server bootstrapped");
    } else {
      next("bootstrap");
      ok("already bootstrapped, nothing to change");
    }

    let target: Server = { ...login };
    if (deployUser) {
      const asDeploy: Server = { ...login, user: deployUser };
      if (await canLogin(asDeploy)) {
        ok(`deploy user ${c.bold(deployUser)} ready`);
        target = asDeploy;
      } else warn(`cannot log in as ${deployUser}; staying with ${eff.user}`);
    }

    // 4. ssh config + landfall config
    next("ssh config + landfall config");
    const entry = serverEntry(name, target, keyPath, { existing, sshConfig: o["ssh-config"], ownAlias: isOwnAlias, port: o.port, keyGiven: !!o.key });
    if (domain) entry.domains = withPrimary(entry.domains, domain);
    if (eff.user !== "root" && effectiveSsh(target).user !== eff.user) entry.admin = eff.user;
    cfg.servers[name] = entry;
    cfg.default ??= name;
    saveConfig(cfg);

    // 5. traefik
    next("traefik");
    if (traefik?.proxy) {
      if (apply.has("traefik") && traefik.status === "todo") await useProxy(entry, traefik.proxy);
      else ok(traefik.detail);
    } else if (apply.has("traefik")) await installTraefik(name, entry, tOpts);
    else info(c.dim("skipped"));

    if (domain) {
      console.log(`\n${c.green("Done.")} Point ${c.bold(domain)} and ${c.bold(`*.${domain}`)} (A records) at ${c.bold(eff.hostname)}, then:\n`);
      console.log(`  lf deploy ./dist --domain blog --server ${name}   ${c.dim(`# https://blog.${domain}`)}`);
      console.log(`  lf server domain ${name}                          ${c.dim("# check the DNS")}\n`);
    } else {
      console.log(`\n${c.green("Done.")} Point a domain's A record at ${c.bold(eff.hostname)}, then:\n`);
      console.log(`  lf deploy ./dist --domain example.com --server ${name}\n`);
    }
    await securityNotes(name, entry, login);
  },
});
