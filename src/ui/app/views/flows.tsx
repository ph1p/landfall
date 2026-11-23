import type { ReactNode } from "react";
import { S, http, plural, render, serverNamed, sv, tilde, errorMessage } from "../lib/store";
import { bytes } from "../../../core/format";
import { slug } from "../../../core/slug";
import { CLOUDS } from "../../../core/clouds";
import type { Browse, Detected, Redeploy, Remembered, SavedServer } from "../lib/types";
import type { LocalImage } from "../../../core/buildlocal";
import { go, load, refreshState } from "../lib/api";
import { run, rep, ifOk, type Job, type JobAction } from "../lib/jobs";
import { toast } from "../ui/toast";
import { Badge, Btn, cx } from "../ui/kit";
import {
  dialog,
  confirmDlg,
  promptDlg,
  invalid,
  openDialog,
  closeDialog,
  D,
  siteNameError,
  words,
  domainOk,
  portError,
  userError,
  passwordError,
  DFORM,
  DTITLE,
  DTEXT,
  DBTNS,
  type Spec,
  type Values,
} from "../ui/dialog";
import { EnvTable, envUrl, NO_ENV_CHANGE, type EnvChange } from "./env";

// ---- server flows ----------------------------------------------------------

export function setupFlow(args: string[], base = args) {
  run(["setup", ...args, "--check"], {
    server: args[0],
    after: (j) => {
      if (j.info.code !== 0) return;
      // Synology and other systems without a package manager: nothing for setup to apply.
      if (rep(j).refuse) return [{ label: "Back to the server", run: () => ((S.job = null), go(args[0], "sites")) }];
      if (rep(j).needsKey) {
        return [{ label: "Enter the password to install a key", run: () => passwordFor(args, base) }];
      }
      const todo = (rep(j).checks ?? []).filter((ch) => ch.status === "todo").length;
      return [
        {
          label: todo ? `Apply ${plural(todo, "change")}` : "Finish setup (nothing to install)",
          run: () => run(["setup", ...args, "-y"], { server: args[0], after: securityAfter(args[0]) }),
        },
        { label: "Change options", run: () => setupWizard(base) },
      ];
    },
  });
}

/** After a job that ends with security advice: a way to its fixes. */
export const securityAfter =
  (n: string) =>
  (j: Job): JobAction[] | undefined =>
    j.info.code === 0 && rep(j).advice?.length
      ? [{ label: `Security: ${plural(rep(j).advice!.length, "thing")} to look at`, run: () => go(n, "system") }]
      : undefined;

export function setupWizard(base: string[]) {
  const saved = serverNamed(base[0])?.saved ?? ({} as Partial<SavedServer>);
  dialog({
    title: `Set up ${base[0]}`,
    text: "landfall first shows what it finds and what it would change. Nothing is applied before you confirm.",
    ok: "Check",
    fields: [
      {
        name: "minimal",
        label: "Minimal: only Docker and landfall's folder",
        type: "check",
        value: base.includes("--minimal"),
        hint: "No Traefik, deploy user, packages, firewall or ssh change. Sites serve no domain: reach them through a tunnel.",
      },
      {
        legend: "Traefik (reverse proxy, automatic HTTPS)",
        when: full,
        fields: [
          {
            name: "traefik",
            label: "Mode",
            type: "select",
            value: saved.hostNetwork ? "host" : "docker",
            options: [
              { value: "docker", label: "Own Traefik, ports published by Docker" },
              { value: "host", label: "Own Traefik on the host network (real client IPs, ufw guards 80/443)" },
              { value: "none", label: "No Traefik (add later with traefik setup)" },
            ],
            hint: "If the server already runs a Traefik on 80/443, setup routes sites through it instead.",
          },
          {
            name: "email",
            label: "Let's Encrypt e-mail (optional)",
            value: saved.email ?? "",
            when: (v) => v.traefik !== "none",
            check: (x) => x && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x) && "An e-mail address",
          },
          {
            name: "dashboard",
            label: "Dashboard domain (optional)",
            value: "",
            placeholder: "traefik.example.com",
            mono: true,
            hint: "Behind basic auth; the password is shown after setup.",
            when: (v) => v.traefik !== "none",
            check: (x) => x && !domainOk(x) && "Not a domain",
          },
          {
            name: "http3",
            label: "HTTP/3 (QUIC on 443/udp)",
            type: "check",
            value: saved.http3 !== false,
            hint: "Browsers that can't use it fall back to HTTP/2.",
            when: (v) => v.traefik !== "none",
          },
          { name: "image", label: "Image", value: saved.traefikImage ?? S.state.defaultImage, mono: true, when: (v) => v.traefik !== "none" },
        ],
      },
      {
        name: "firewall",
        label: "Enable ufw: deny incoming except ssh, 80 and 443",
        type: "check",
        value: true,
        hint: "Skipped automatically if it would block ports in use, or if the provider's firewall is always in front (AWS, Google Cloud, Azure, …).",
        when: full,
      },
      {
        name: "cloud",
        label: "Provider",
        type: "select",
        value: saved.cloud ?? "auto",
        options: providerOptions(),
        hint: "Set it only where detection is wrong. landfall remembers it for this server.",
        when: full,
      },
      {
        name: "harden",
        label: "Key login only (turn off ssh passwords)",
        type: "check",
        value: true,
        hint: "Skipped automatically if other users still log in with a password.",
        when: full,
      },
      {
        name: "user",
        label: "Deploy user",
        value: "deploy",
        hint: "landfall deploys as this user (docker group, your key). Empty keeps the login user.",
        when: full,
      },
    ],
    onOk: (v) => {
      const args = base.filter((a) => a !== "--minimal");
      if (v.minimal) return setupFlow([...args, "--minimal"], args);
      const f: string[] = [];
      if (v.traefik === "none") f.push("--no-traefik");
      else {
        f.push(v.traefik === "host" ? "--host-network" : "--no-host-network");
        if (v.image.trim()) f.push(`--image=${v.image.trim()}`);
        if (v.email.trim()) f.push(`--email=${v.email.trim()}`);
        if (v.dashboard.trim()) f.push(`--dashboard=${v.dashboard.trim()}`);
        f.push(v.http3 ? "--http3" : "--no-http3");
      }
      if (!v.firewall) f.push("--no-firewall");
      // "auto" also forgets a provider set earlier.
      if (v.cloud !== "auto" || saved.cloud) f.push(`--cloud=${v.cloud}`);
      if (!v.harden) f.push("--no-harden");
      f.push(`--deploy-user=${v.user.trim()}`);
      setupFlow([...args, ...f], args);
    },
  });
}

function passwordFor(args: string[], base: string[]) {
  const host = args.includes("--host") ? `root@${args[args.indexOf("--host") + 1]}` : (serverNamed(args[0])?.target ?? args[0]);
  promptDlg(
    `Password for ${host}`,
    "Used once to install landfall's ssh key (ssh-copy-id). It is not stored; afterwards only the key is used.",
    { type: "password", label: "Password" },
    (pw) => {
      if (!pw) return;
      run(["setup", ...args, "--key-only", "-y"], {
        password: pw,
        server: args[0],
        after: (j) => {
          if (j.info.code === 0) return void setTimeout(() => setupFlow(args, base));
          return [{ label: "Try the password again", run: () => passwordFor(args, base) }];
        },
      });
    },
    "Install key",
  );
}

export function addServer() {
  const known = (name: string) => !!serverNamed(name);
  dialog({
    title: "Add a server",
    text: "An alias from ~/.ssh/config (like vps) needs only its name. A new machine needs a name and its address, fresh or already in use: landfall writes its ssh config entry.",
    fields: [
      {
        row: [
          {
            name: "name",
            label: "Name",
            placeholder: "vps",
            required: "Give the server a name",
            preview: (v) => known(v.name.trim()) && "✓ in your ssh config: no address needed",
          },
          {
            name: "host",
            label: "Address (IP or hostname)",
            placeholder: "203.0.113.7",
            mono: true,
            check: (h, v) => !h && !known(v.name.trim()) && `${v.name.trim()} is not in your ssh config: give its IP or hostname`,
          },
        ],
      },
      {
        // Only a new address needs a login; an alias brings its own.
        legend: "Login",
        when: (v) => String(v.host ?? "").trim(),
        fields: [
          {
            row: [
              { name: "user", label: "User", placeholder: "root" },
              { name: "port", label: "SSH port", type: "number", placeholder: "22", check: portError },
            ],
          },
          {
            name: "key",
            label: "Private key file (optional)",
            placeholder: "~/.ssh/id_ed25519",
            mono: true,
            hint: "Empty: landfall makes ~/.ssh/landfall_<name> and installs it with the password.",
          },
          {
            name: "password",
            label: "Password (optional)",
            type: "password",
            hint: "Used once to install the key, never stored. Empty when the key already works.",
          },
        ],
      },
      { name: "setup", label: "Set it up now", hint: "Shows what it would change first.", type: "check", value: true },
    ],
    ok: "Add",
    onOk: (v) => {
      const [name, host, user, port, key] = [v.name, v.host, v.user, v.port, v.key].map((x: string) => x.trim());
      const args = [name, ...(host ? ["--host", host] : []), ...(user ? ["-u", user] : []), ...(port ? ["-p", port] : []), ...(key ? ["-i", key] : [])];
      // With a password: install the key now, then the setup wizard needs nothing but the alias.
      const then = ifOk(() => (v.setup ? setupWizard([name]) : go(name)));
      if (v.password) run(["server", "add", ...args], { server: name, password: v.password, after: then });
      else if (v.setup) setupWizard(args);
      else run(["server", "add", ...args], { server: name, after: (j) => void go(name, rep(j).advice?.length ? "system" : S.tab) });
    },
  });
}

const defaultServer = (): string | undefined => S.sel ?? S.state.servers.find((s) => s.isDefault)?.name;
export const mainDomain = (n: string): string | undefined => serverNamed(n)?.saved?.domains?.[0];
/** The server deploys new sites with no domain unless one is given: its own setting, else landfall's default. */
export const tunnelOnly = (n: string): boolean => serverNamed(n)?.saved?.tunnelOnly ?? S.state.defaults.tunnelOnly;

/** landfall's defaults for every server (lf config); a server's own setting wins. */
/** Wizard steps the minimal setup leaves out. */
const full = (v: Values) => !v.minimal;

const providerOptions = (found?: string) => [
  { value: "auto", label: found ? `Detect automatically (${found})` : "Detect automatically" },
  ...Object.entries(CLOUDS).map(([value, cl]) => ({ value, label: cl.firewall ? `${cl.name} (${cl.firewall} always in front: no ufw)` : cl.name })),
  { value: "none", label: "None of these (own hardware, another provider)" },
];

/** Set a server's provider in landfall's config: `lf server config --cloud`, no setup run. */
/** Which ~/.ssh/config Host does root work on n: lf server config --root-login. */
export function rootLoginDialog(n: string, current: string | null, others: { alias: string; user: string }[]) {
  const saved = current ?? "auto";
  const options = [
    { value: "auto", label: "Automatic: root, the admin user, then the Hosts below" },
    ...others.map((o) => ({ value: o.alias, label: `${o.alias} (${o.user})` })),
  ];
  if (current && !others.some((o) => o.alias === current)) options.push({ value: current, label: current });
  dialog({
    title: `Root login for ${n}`,
    text: "Used for root work (fail2ban, firewall, updates, undo) when the server's login has no passwordless sudo. landfall remembers it in its config.",
    fields: [
      {
        name: "alias",
        label: "Log in as",
        type: "select",
        value: saved,
        options,
        hint: others.length
          ? "Hosts from ~/.ssh/config that reach the same machine with another user."
          : "No other Host in ~/.ssh/config reaches this machine. Add one with User root (or a sudo user) and its key.",
      },
    ],
    ok: "Save",
    onOk: (v) => {
      if (v.alias === saved) return;
      run(["server", "config", n, `--root-login=${v.alias}`], { server: n, after: ifOk(() => load(n, "settings", true)) });
    },
  });
}

export function providerDialog(n: string) {
  const saved = serverNamed(n)?.saved?.cloud ?? "auto";
  dialog({
    title: `Provider of ${n}`,
    text: "landfall remembers it in its config. Nothing changes on the server.",
    fields: [
      {
        name: "cloud",
        label: "Provider",
        type: "select",
        value: saved,
        options: providerOptions(S.facts[n]?.data?.cloudDetected?.name),
        hint: "Where the provider's firewall is always in front, setup leaves ufw out and the Firewall section says so.",
      },
    ],
    ok: "Save",
    onOk: (v) => {
      if (v.cloud === saved) return;
      run(["server", "config", n, `--cloud=${v.cloud}`], { server: n });
    },
  });
}

export function defaultsDialog() {
  const d = S.state.defaults;
  dialog({
    title: "landfall defaults",
    text: `For every server, unless it sets its own. Saved in ${d.configFile}.`,
    fields: [
      {
        name: "default",
        label: "Default server",
        type: "select",
        value: d.default ?? "",
        options: [{ value: "", label: "none" }, ...S.state.servers.map((s) => ({ value: s.name, label: s.name }))],
        hint: "Commands in a terminal use it without --server.",
      },
      {
        name: "tunnelOnly",
        label: "New sites get no domain: tunnel only",
        type: "check",
        value: d.tunnelOnly,
        hint: "Nothing is served on the internet until a site gets a domain. A server's Settings can override it.",
      },
      { name: "email", label: "Let's Encrypt e-mail (optional)", value: d.email ?? "", hint: "For servers that set none, when landfall installs Traefik." },
      {
        name: "keep",
        label: "Releases to keep for rollback",
        type: "number",
        value: String(d.keep),
        placeholder: "5",
        check: (k) => k && (!/^\d+$/.test(k) || !Number(k)) && "A whole number from 1 up",
      },
    ],
    after: <WhereList loc={d.locations} />,
    ok: "Save",
    onOk: (v) => {
      const argv = ["config"];
      if (v.default !== (d.default ?? "")) argv.push(...(v.default ? ["--default", v.default] : ["--unset", "default"]));
      if (v.tunnelOnly !== d.tunnelOnly) argv.push(v.tunnelOnly ? "--tunnel-only" : "--no-tunnel-only");
      const email = v.email.trim();
      if (email !== (d.email ?? "")) argv.push(...(email ? ["--email", email] : ["--unset", "email"]));
      const keep = v.keep.trim();
      if (keep !== String(d.keep)) argv.push(...(keep ? ["--keep", keep] : ["--unset", "keep"]));
      if (argv.length === 1) return;
      run(argv, { after: ifOk(() => (S.sel && load(S.sel, "settings", true), refreshState())) });
    },
  });
}

interface Where {
  path: string;
  what: string;
}
/** Every place landfall writes to, from `lf config`: nothing it installs is hidden. */
export function WhereList({ loc }: { loc: { local: Where[]; server: Where[] } }) {
  const kv = (list: Where[]) => (
    <dl className="m-0 text-sm">
      {list.map((l) => [
        <dt key={`t${l.path}`} className="mono wrap-anywhere mt-1.5">
          {l.path}
        </dt>,
        <dd key={`d${l.path}`} className="dim m-0">
          {l.what}
        </dd>,
      ])}
    </dl>
  );
  const h3 = "text-sm font-semibold mt-3 mb-1.5";
  return (
    <details className="where">
      <summary className="cursor-pointer text-faint text-sm">Where landfall puts things</summary>
      <h3 className={h3}>On this machine</h3>
      {kv(loc.local)}
      <h3 className={h3}>On each server</h3>
      {kv(loc.server)}
    </details>
  );
}

/** What `lf deploy` picks without a domain: <site>.<main domain>, else the free sslip.io address. */
export function autoDomain(n: string, name: string) {
  const main = mainDomain(n);
  if (main) return `${name}.${main}`;
  const suffix = S.facts[n]?.data?.sslipSuffix;
  return suffix ? `${name}.${suffix}` : "";
}
const slugify = (s: string) => slug(s.toLowerCase().replace(/\.(zip|tgz|tar(\.gz)?)$/, ""));
/** ghcr.io/me/blog:1.2 → blog. */
export const imageName = (ref: string) =>
  slugify(
    ref
      .trim()
      .replace(/@.*$/, "")
      .replace(/:[\w.-]*$/, "")
      .split("/")
      .pop() ?? "",
  );

/** What landfall found in a folder and how it deploys it. */
const ROLE: Record<string, string> = { language: "Language", framework: "Framework", tooling: "Package manager or build tool" };

/** The languages, framework and tools landfall found in a folder, as chips: what it builds with at a glance. */
export function Stack({ d, className }: { d: Detected; className?: string }) {
  if (!d.stack?.length) return null;
  return (
    <div className={cx("flex flex-wrap gap-1.5", className)} aria-label="Detected">
      {d.stack.map((t) => (
        <Badge key={t.label} kind={t.role === "tooling" ? "" : "accent"} className={t.role === "framework" ? "font-semibold" : undefined} title={ROLE[t.role]}>
          {t.label}
        </Badge>
      ))}
    </div>
  );
}

/** plan: a compose project's services too (DeployAside shows them on their own). */
export function Describe({ d, before = true, plan = true }: { d: Detected; before?: boolean; plan?: boolean }) {
  const built = d.build ? (
    <>
      {" "}
      · builds with <code>{d.build}</code> first
    </>
  ) : null;
  const what: ReactNode =
    d.kind === "compose" ? (
      <>
        Compose project <code>{d.compose ?? "compose.yaml"}</code>: built and started on the server;{" "}
        {d.analysis?.auto ? "no x-landfall, so its HTTP ports are routed" : "x-landfall picks the routed services"}
        {plan && <ComposePlan a={d.analysis} />}
      </>
    ) : d.kind === "image" ? (
      d.project?.image ? (
        <>
          Docker image <code>{d.project.image}</code> (from .landfall.json)
        </>
      ) : (
        "Docker image: the server pulls it, or this machine sends it. Nothing is built."
      )
    ) : d.kind === "dockerfile" && d.start ? (
      <>
        {d.runtime} app{d.tool ? ` (${d.tool})` : ""}: built on the server
        {d.build ? (
          <>
            {" "}
            with <code>{d.build}</code>
          </>
        ) : (
          ""
        )}
        , started with <code>{d.start}</code> on port {d.port}
        {d.note && (
          <>
            <br />
            <span className="text-warn">{d.note}</span>
          </>
        )}
      </>
    ) : d.kind === "dockerfile" ? (
      `Dockerfile: built on the server, served on port ${d.port}`
    ) : d.dir ? (
      <>
        Static files from <code>{d.dir === "." ? "./" : d.dir + "/"}</code>
        {d.tool ? ` (where ${d.tool} builds the site)` : ""}
        {d.project?.spa ? " (single-page app)" : ""}
        {built}
      </>
    ) : d.build ? (
      <>
        Static site, built with <code>{d.build}</code> first
      </>
    ) : (
      <span className="text-warn">No compose.yaml, Dockerfile, index.html or build script here.</span>
    );
  return (
    <>
      {what}
      {d.beside && (
        <>
          {" "}
          · with {d.beside.services.join(", ")} from <code>{d.beside.file}</code> beside it
        </>
      )}
      {before && d.project?.server ? (
        <>
          {" "}
          <span className="dim">
            · deployed before to {d.project.server}
            {d.project.domains?.length ? ` as ${d.project.domains.join(", ")}` : ""}
          </span>
        </>
      ) : null}
    </>
  );
}

/** A compose project's services as a deploy would run them: what each is built from, port to domains, private ports, volumes, problems. */
function ComposePlan({ a }: { a?: Detected["analysis"] }) {
  if (!a) return null;
  return (
    <span className="block mt-1.5">
      {(a.services ?? []).map((s) => {
        const about = a.about?.[s.name];
        const routes = (a.routes ?? []).filter((r) => r.service === s.name);
        const priv = Object.entries(s.private ?? {});
        return (
          <span key={s.name} className="block">
            <code>{s.name}</code> <span className="dim">{about?.build !== undefined ? `built from ${about.build}` : (about?.image ?? "")}</span>
            {routes.map((r) => (
              <span key={`${r.port}:${r.domains[0]}`} className="block pl-4">
                <code>:{r.port}</code> <span className="dim">→ {r.domains.join(", ")}</span>
              </span>
            ))}
            {priv.map(([k, p]) => (
              <span key={k} className="block pl-4">
                <code>
                  :{p}
                  {s.paths?.[k] ?? ""}
                </code>{" "}
                <span className="dim">
                  private, <code>lf tunnel … {k}</code>
                </span>
              </span>
            ))}
            {!routes.length && !priv.length && (
              <span className="block pl-4 dim">{s.own ? "routed by its own traefik labels" : "no port reached from outside"}</span>
            )}
            {about?.volumes?.length ? <span className="block pl-4 dim">volumes: {about.volumes.join(", ")}</span> : null}
          </span>
        );
      })}
      {[...(a.errors ?? []), ...(a.warnings ?? [])].map((e: string) => (
        <span key={e} className="block text-warn">
          {e}
        </span>
      ))}
      {a.notes?.map((n: string) => (
        <span key={n} className="block dim">
          {n}
        </span>
      ))}
    </span>
  );
}
const DETECTED = "text-md px-3 py-2.5 rounded-md bg-hover";
const ASIDE_HEAD = "m-0 mb-1.5 text-sm font-semibold text-dim";

/** The images a deploy pulls, so it is plain what runs: as they are, or as the base a build starts from. */
export function UsedImages({ d }: { d: Detected }) {
  if (!d.images?.length) return null;
  return (
    <ul className="m-0 p-0 list-none grid gap-1">
      {d.images.map((i) => (
        <li key={`${i.service} ${i.ref}`} className="min-w-0">
          <code className="break-all">{i.ref}</code> <span className="dim">{i.base ? `base of ${i.service}` : i.service}</span>
        </li>
      ))}
    </ul>
  );
}

/** The deploy dialog's right column: what landfall found, the services it runs and the images it pulls. */
function DeployAside({ d }: { d: Detected }) {
  return (
    <>
      <div>
        <Stack d={d} className="mb-2" />
        <Describe d={d} plan={false} />
      </div>
      {d.kind === "compose" && d.analysis ? (
        <div>
          <h3 className={ASIDE_HEAD}>Services</h3>
          <ComposePlan a={d.analysis} />
        </div>
      ) : null}
      {d.images?.length ? (
        <div>
          <h3 className={ASIDE_HEAD}>Images</h3>
          <UsedImages d={d} />
        </div>
      ) : null}
    </>
  );
}

/**
 * The build part of a deploy form for det: what to build and start, static or an app, its port and volumes.
 * argv: the lf deploy flags for what changed from det.
 */
export function buildForm(det: Detected) {
  const p = det.project;
  // Static files or an app without a Dockerfile: what to build and run is landfall's to decide, and editable here.
  const runtime = det.runtime ?? "Node.js";
  const modal = det.kind === "static" || !!det.start;
  const image = det.kind === "image";
  const runs = det.kind === "dockerfile" || image;
  const isApp = (v: Values) => (modal ? (v.mode || (det.start ? "node" : "static")) === "node" : runs);
  const served = (v: Values) => !(isApp(v) && v.worker);
  const volumes: string[] = det.volumes ?? [];
  const app = [
    {
      name: "worker",
      label: "Background worker: no port, no domain",
      type: "check" as const,
      value: !!det.worker,
      hint: "A bot, a queue consumer, a scheduler: it runs, nothing routes to it.",
    },
    {
      name: "port",
      label: "Port it listens on",
      type: "number" as const,
      // An image says its port itself (EXPOSE): deploy reads it on the server unless one is given.
      value: det.port !== undefined ? String(det.port) : image ? "" : "3000",
      placeholder: image ? "what the image EXPOSEs" : undefined,
      hint: modal ? "The app gets it as PORT." : image ? "Empty: the port the image EXPOSEs, read on the server at each deploy." : "",
      when: (v: Values) => !v.worker,
      required: !image && "Which port does it listen on?",
      check: portError,
    },
    {
      name: "volumes",
      label: "Folders to keep",
      value: volumes.join(" "),
      placeholder: "/app/data",
      mono: true,
      hint: "In the container, space separated: their files outlive deploys and rollbacks (a Docker volume each). Empty: none.",
      check: (x: string) =>
        words(x)
          .filter((d) => !/^\/[\w./-]*\w$/.test(d))
          .map((d) => `${d} is not a folder like /app/data`)[0],
    },
  ];
  const fields: Spec[] = modal
    ? [
        {
          legend: "Build",
          fields: [
            ...(det.node || det.start
              ? [
                  {
                    name: "mode",
                    label: "Deploy as",
                    type: "select" as const,
                    value: det.start ? "node" : "static",
                    options: [
                      { value: "node", label: `${runtime} app (runs on the server)` },
                      { value: "static", label: "Static files" },
                    ],
                  },
                ]
              : []),
            {
              name: "build",
              label: "Build command",
              value: det.build ?? "",
              placeholder: "none",
              mono: true,
              hint: `Static files: runs here, before the upload. The ${runtime} app: runs on the server, in its image.`,
            },
            {
              legend: "Static files",
              id: "static",
              when: (v: Values) => !isApp(v),
              fields: [
                {
                  name: "dir",
                  label: "Folder to publish",
                  value: det.dir ?? ".",
                  placeholder: ".",
                  mono: true,
                  hint:
                    det.tool && !det.start
                      ? `Detected: ${det.tool} writes the site to ${det.dir}/ (it need not exist before the build).`
                      : "Relative to the project; it needs an index.html after the build.",
                  check: (x: string) => (/^[/-]/.test(x) || x.split("/").includes("..")) && "A folder inside the project",
                },
                { name: "spa", label: "Single-page app (unknown paths serve index.html)", type: "check" as const, value: !!p?.spa },
              ],
            },
            {
              legend: `${runtime} app`,
              id: "node",
              when: isApp,
              fields: [
                {
                  name: "start",
                  label: "Start command",
                  value: det.start ?? "",
                  placeholder: "node server.js",
                  mono: true,
                  required: "How does the app start? For example: node server.js",
                  hint: `${det.start && det.tool ? `Detected: ${det.tool}. ` : ""}landfall writes the Dockerfile (install, build, start); lf init puts it into the project to change it.`,
                },
                ...app,
              ],
            },
          ],
        },
      ]
    : runs
      ? [{ legend: det.kind === "image" ? "Container" : "Dockerfile app", fields: app }]
      : [];
  const argv = (v: Values) => {
    const asNode = isApp(v);
    const worker = asNode && v.worker;
    const argv: string[] = [];
    const build = v.build?.trim() ?? "";
    if (modal && asNode) {
      const start = v.start.trim();
      if (start !== det.start) argv.push("--start", start);
      if (build !== (det.build ?? "")) argv.push("--build", build);
    } else if (modal) {
      if (det.start) argv.push("--static");
      // Unsaved, an emptied field says so: deploy would run the detected build otherwise.
      if (p?.build === undefined ? build || det.build : build !== p.build) argv.push("--build", build);
      if (v.spa && !p?.spa) argv.push("--spa");
      const dir = v.dir.trim().replace(/\/+$/, "") || ".";
      if (dir !== (det.dir ?? ".")) argv.push(dir);
    }
    if (asNode) {
      if (worker !== !!det.worker) argv.push(worker ? "--worker" : "--no-worker");
      const port = v.port.trim() ? Number(v.port.trim()) : undefined;
      if (!worker && port !== undefined && port !== (det.port ?? (image ? undefined : 3000))) argv.push("--port", String(port));
      const vols = words(v.volumes);
      if (vols.join(" ") !== volumes.join(" ")) argv.push(...(vols.length ? vols.flatMap((x) => ["--volume", x]) : ["--volume", ""]));
    }
    return argv;
  };
  return { fields, argv, served };
}

interface DeployOpts {
  site?: Redeploy;
  upload?: boolean;
  files?: number;
  name?: string;
  /** An image deploy from an empty folder (deployImage): this machine's images, offered for the image field. */
  images?: string[];
}
/**
 * Deploy a local folder (det from /api/fs or an upload). upload: a temporary folder, so no .landfall.json.
 * site: an existing site ({ server, name, domains }) this folder redeploys.
 */
export async function deployDialog(det: Detected, o: DeployOpts = {}) {
  const p = det.project;
  const re = o.site;
  const servers = S.state.servers.map((s) => ({ value: s.name, label: s.name }));
  const target: string = re?.server ?? p?.server ?? defaultServer() ?? "";
  const name: string = re?.name ?? o.name ?? det.name;
  const image = det.kind === "image";
  // An image deploy without a name: the image's, as blog for ghcr.io/me/blog:1.2.
  const siteName = (v: Values): string => v.name.trim() || (image ? imageName(v.image ?? "") : "");
  // A redeploy keeps the site's domains unless .landfall.json or the field names others.
  const keeps: string[] | null = re && !p?.domains ? re.domains : null;
  const keeping = (v: Values) => keeps && siteName(v) === re?.name && v.server === re?.server;
  const { fields: buildFields, argv: buildArgv, served } = buildForm(det);
  // An example's key with a value is only suggested (askable in core/compose): the CLI says it, the form leaves it out.
  const required = (det.required ?? []).filter((r) => r.example === undefined);
  // What the site's .env on the server has (names only): read for the target the dialog opens with.
  // None there, or the server not answering: nothing is claimed to be kept.
  const has = new Set<string>();
  if (required.length && (re || p?.server)) {
    const d = await http<{ vars: { key: string; length: number }[] }>(envUrl(target, name, false)).catch(() => undefined);
    for (const x of d?.vars ?? []) if (x.length) has.add(x.key);
  }
  const seeds = det.seeds ?? [];
  const sameTarget = (v: Values) => siteName(v) === name && v.server === target;
  // A static site has no .env; the mode field, when there is one, says which it deploys as.
  const hasEnv = (v: Values) => (v.mode || (det.kind === "static" ? "static" : "node")) === "node";
  // Images to build: a compose.yaml's build: services, a Dockerfile, or the one landfall writes for an app.
  const builds = (v: Values) => hasEnv(v) && (det.kind === "compose" ? Object.values(det.analysis?.about ?? {}).some((x) => x.build) : det.kind !== "image");
  /** What the domains field deploys to, as the CLI expands it: [domains] or an error. */
  const addresses = (v: Values): [string[], string?] => {
    const main = mainDomain(v.server);
    const given = words(v.domains);
    if (!given.length) return [keeping(v) ? keeps! : [siteName(v) && autoDomain(v.server, siteName(v))].filter(Boolean)];
    const out = given.map((d) => (d === "@" ? main : !d.includes(".") && main ? `${d}.${main}` : d)?.toLowerCase());
    if (out.includes(undefined)) return [[], `@ means the main domain, and ${v.server} has none`];
    const bad = out.find((d) => !domainOk(d!));
    return [out as string[], bad && `Not a domain: ${bad}`];
  };
  const sends = p?.sendImage === true ? "send" : p?.sendImage === false ? "pull" : "";
  dialog({
    title: re ? `Redeploy ${name}` : name ? `Deploy ${name}` : "Deploy a Docker image",
    text:
      (o.images
        ? "Runs an image as a site. Not remembered here: Redeploy on the site asks for the image again."
        : o.upload
          ? `Uploaded ${plural(o.files ?? 0, "file")}. Not remembered: drop it again to redeploy.`
          : `From ${tilde(det.path)}${p ? " (settings from .landfall.json)" : ""}`) +
      (re ? `\nGoes live as a new release of ${name} on ${re.server}: volumes keep their data, and Roll back returns to the current one.` : ""),
    aside: <DeployAside d={det} />,
    sidebar: true,
    fields: [
      ...(image
        ? [
            {
              legend: "Image",
              fields: [
                {
                  name: "image",
                  label: "Image",
                  value: p?.image ?? "",
                  mono: true,
                  placeholder: "ghcr.io/you/app:1.2",
                  suggest: o.images,
                  required: "Which image? For example ghcr.io/you/app:1.2",
                  check: (x: string) => /\s/.test(x) && "One image reference, without spaces",
                  hint: "Public, from a registry the server is logged in to (Registries in the server's settings), or one only this machine's Docker has.",
                },
                {
                  name: "send",
                  label: "How the server gets it",
                  type: "select" as const,
                  value: sends,
                  options: [
                    { value: "", label: "Pull it, or send it when only this machine has it" },
                    { value: "send", label: "Send it from this machine (docker save)" },
                    { value: "pull", label: "Pull it on the server" },
                  ],
                  hint: "Sending needs no registry: this machine's Docker saves the image and the server loads it. lf deploy --send-image",
                },
              ],
            },
          ]
        : []),
      {
        legend: "Site",
        fields: [
          {
            row: [
              {
                name: "name",
                label: "Site name",
                value: name,
                required: !image && "Give the site a name",
                placeholder: image ? "the image's name" : undefined,
                check: (x: string) => x && siteNameError(x),
                preview: (v: Values) => !v.name.trim() && siteName(v) && `→ ${siteName(v)}`,
                hint: re ? "Another name deploys a new site." : "",
              },
              { name: "server", label: "Server", type: "select", options: servers, value: target, required: "Pick a server" },
            ],
          },
        ],
      },
      {
        legend: "Address",
        when: served,
        fields: [
          {
            name: "domains",
            label: "Domains",
            value: (p?.domains ?? []).join(" "),
            off: (v) => v.noDomain,
            placeholder: keeps ? keeps.join(" ") || "none" : "empty: the address below",
            hint: mainDomain(target)
              ? "A bare name like blog is under the main domain, @ is the main domain itself. Others need an A record pointing at the server."
              : "Own domains need an A record pointing at the server.",
            check: (_, v) => addresses(v)[1],
            preview: (v) => {
              const [out, bad] = addresses(v);
              return bad ? "" : out.length ? `→ ${out.map((d) => `https://${d}`).join("  ")}` : "→ no domain: tunnel only";
            },
          },
          {
            name: "noDomain",
            label: "No domain: reach it through a tunnel only",
            type: "check",
            value: p?.domains ? !p.domains.length : re ? false : !!tunnelOnly(target),
            hint: "Nothing is served on the internet. Give it a domain later with Edit on the site.",
          },
        ],
      },
      ...buildFields,
      {
        legend: "Images",
        when: builds,
        fields: [
          {
            name: "buildLocal",
            type: "check" as const,
            value: !!p?.buildLocal,
            label: "Build them on this machine, not on the server",
            hint: "Needs Docker running here. The server only loads and runs them: no CPU, memory or build cache spent there. Remembered. lf deploy --build-local",
          },
        ],
      },
      // A folder left out of the upload, named like a volume: what the volume should hold (lf deploy --fill-volumes).
      ...(seeds.length
        ? [
            {
              legend: "Volumes",
              when: hasEnv,
              note: "Volumes keep their data across deploys and rollbacks. Back up, push and pull them in the site's Volumes box.",
              fields: [
                {
                  name: "fill",
                  type: "check" as const,
                  value: true,
                  label: `Fill ${seeds.join(", ")} with ${seeds.map((f) => `./${f}`).join(", ")} while empty`,
                  hint: `Left out of the upload. Only an empty volume is filled: data already there stays. lf deploy --fill-volumes`,
                },
              ],
            },
          ]
        : []),
      ...(required.length
        ? [
            {
              legend: "Environment",
              note: `What ${[...new Set(required.map((r) => r.from))].join(" and ")} asks for, set in the site's .env on the server. Your local .env is sent only for what is left empty here and the server's lacks.`,
              fields: required.map((r) => ({
                name: `env_${r.name}`,
                label: r.name,
                type: "password" as const,
                mono: true,
                hint: [
                  r.message,
                  has.has(r.name) ? "Empty: keeps the value the server's .env has." : r.local ? "Empty: your local .env's value." : r.optional && "Optional.",
                ]
                  .filter(Boolean)
                  .join(". "),
                check: (x: string, v: Values) =>
                  /[\r\n]/.test(x)
                    ? "One line: put multi-line text in a secret"
                    : // Compose would refuse to start without it.
                      !x && r.strict && !r.local && !has.has(r.name) && sameTarget(v) && (r.message || `${r.from} needs ${r.name}`),
              })),
            },
          ]
        : []),
      {
        legend: "More variables",
        collapsed: true,
        when: hasEnv,
        note: "Also set in the site's .env, e.g. SPRING_PROFILES_ACTIVE=prod or NODE_ENV=production. Change it later with Edit on the site.",
        fields: [
          {
            name: "env",
            type: "custom",
            value: NO_ENV_CHANGE,
            check: (x: EnvChange) => x.bad,
            render: (_: EnvChange, set: (v: EnvChange) => void) => <EnvTable n={target} onChange={set} />,
          },
        ],
      },
      {
        legend: "Visitor login",
        note: "Optional: HTTP basic auth. Set or remove it later with Edit on the site.",
        when: served,
        fields: [
          {
            row: [
              { name: "authUser", label: "User", value: "admin", placeholder: "admin", check: (x, v) => v.authPassword && userError(x || "admin") },
              { name: "authPassword", label: `Password (${S.state.rules.minPassword}+ characters)`, type: "password", check: (x) => x && passwordError(x) },
            ],
          },
        ],
      },
    ],
    ok: re ? "Redeploy" : "Deploy",
    onOk: (v) => {
      const n = siteName(v);
      if (!n) return invalid("name", "Give the site a name");
      if (siteNameError(n)) return invalid("name", `${n} is no site name: lowercase letters, digits and dashes`);
      const argv = ["deploy", "-y", ...sv(v.server), "-n", n];
      if (image) {
        const ref = v.image.trim();
        if (ref !== p?.image) argv.push("--image", ref);
        if (v.send && v.send !== sends) argv.push(v.send === "send" ? "--send-image" : "--no-send-image");
      }
      if (served(v)) {
        const domains = words(v.domains);
        // The server's default would leave it unrouted though the box is unticked.
        if (!v.noDomain && !domains.length && !p?.domains?.length && !keeping(v) && tunnelOnly(v.server))
          return invalid("domains", `${v.server} gives new sites no domain: name one, or tick No domain`);
        argv.push(...(v.noDomain ? ["--no-domain"] : domains.flatMap((d) => ["-d", d])));
      }
      argv.push(...buildArgv(v));
      for (const r of required) if (v[`env_${r.name}`]) argv.push("-e", `${r.name}=${v[`env_${r.name}`]}`);
      if (hasEnv(v)) for (const [k, x] of Object.entries((v.env as EnvChange).set)) argv.push("-e", `${k}=${x}`);
      // Only what the server's .env lacks: the CLI never sends the rest of the local .env.
      if (required.some((r) => r.local && !v[`env_${r.name}`])) argv.push("--local-env");
      if (seeds.length && hasEnv(v) && v.fill) argv.push("--fill-volumes");
      if (builds(v) && v.buildLocal !== !!p?.buildLocal) argv.push(v.buildLocal ? "--build-local" : "--no-build-local");
      // The login counts once there is a password; the user defaults to admin.
      if (served(v) && v.authPassword) argv.push("--auth-user", v.authUser.trim() || "admin", "--auth-password", v.authPassword);
      // An upload or an image's empty folder is thrown away: nothing to save .landfall.json in.
      if (o.upload || o.images) argv.push("--no-save");
      run(argv, { server: v.server, cwd: det.path, after: openAfter });
    },
  });
}

/**
 * Deploy a Docker image (lf deploy --image), or redeploy a site that runs one. It runs in an empty folder:
 * the folder lf ui started in may hold another project's .landfall.json.
 */
export async function deployImage(site?: Redeploy) {
  try {
    const [images, { path }] = await Promise.all([http<LocalImage[]>("/api/images"), http<{ path: string }>("/api/image-folder", {})]);
    await deployDialog({ path, name: site?.name ?? "", kind: "image", stack: [] }, { site, images: images.map((i) => i.ref) });
  } catch (e) {
    toast(errorMessage(e));
  }
}

/** After a deploy: offer the address it printed. */
export function openAfter(j: Job): JobAction[] | undefined {
  if (j.info.code !== 0) return;
  const url: string | undefined = rep(j).url;
  if (url) return [{ label: `Open ${url.replace("https://", "")}`, run: () => void window.open(url, "_blank", "noopener") }];
}

export const browse = (path?: string) => http<Browse>(`/api/fs${path ? `?path=${encodeURIComponent(path)}` : ""}`);

/** What a site's folder holds and how it builds: detected once per folder, for the site details. Call from an effect. */
export function detected(path: string) {
  if (path in S.det) return;
  S.det[path] = null;
  browse(path).then(
    (x) => ((S.det[path] = x.detected), render()),
    () => (S.det[path] = false),
  );
}

/** Redeploy a folder with its saved settings (.landfall.json), after saying exactly what runs. */
export function redeploy(path: string, server: string, name: string, kind?: string, environment?: string) {
  const argv = ["deploy", "-y", ...sv(server), ...(environment ? ["-E", environment] : [])];
  confirmDlg({
    title: `Redeploy ${name} to ${server}?`,
    text: `${kind === "static" ? "Runs its build here (if it has one), uploads" : "Uploads"} ${tilde(path)} with its saved settings and makes it the live release. The current release stays for Roll back.`,
    extra: (
      <code className="block mono text-sm px-3 py-2 rounded-md bg-hover wrap-anywhere">
        cd {tilde(path)} && lf {argv.join(" ")}
      </code>
    ),
    ok: "Redeploy",
    onOk: () => run(argv, { server, cwd: path, after: openAfter }),
  });
}

/** Detect the project in path, then open the deploy dialog for it. */
export function deployFrom(path: string) {
  browse(path).then(
    (x) => deployDialog(x.detected),
    (e) => toast(errorMessage(e)),
  );
}
export const deployHere = () => deployFrom(S.state.cwd);

// ---- picking a folder --------------------------------------------------------

const ROW =
  "flex gap-2.5 items-baseline border-0 rounded-none shadow-none font-normal border-b border-line last:border-b-0 text-left bg-transparent px-3 py-[7px] min-w-0 hover:bg-hover";
const LIST = "grid border border-line rounded-md max-h-[260px] overflow-auto";
const PICK = "inline text-accent cursor-pointer text-md font-normal";

/**
 * Pick a folder on this machine: recent projects, a folder browser, or drop/choose files to upload.
 * site: an existing site the folder redeploys (one this machine does not remember a folder for).
 */
export async function folderDialog(path?: string, site?: Redeploy) {
  let b: Browse;
  try {
    b = await browse(path);
  } catch (e) {
    return toast(errorMessage(e));
  }
  // Files dropped while it is open redeploy the site too.
  openDialog(<FolderDialog b={b} site={site} />, "wide", site);
}

function FolderDialog({ b, site }: { b: Browse; site?: Redeploy }) {
  const recent: Remembered[] = site ? [] : (S.state.projects ?? []).slice(0, 8);
  const parts: string[] = b.path.split("/").filter(Boolean);
  const to = (p: string) => () => void folderDialog(p, site);
  const crumb = "px-1.5! py-px!";
  return (
    <form method="dialog" className={DFORM} onSubmit={(e) => (e.preventDefault(), deployDialog(b.detected, { site }))}>
      <h2 id="dlg-title" className={DTITLE}>
        {site ? `Redeploy ${site.name}` : "Deploy a folder"}
      </h2>
      {site && (
        <div className={DTEXT}>
          This machine does not know which folder {site.name} on {site.server} was deployed from. Pick it: this machine remembers it, so the next redeploy is
          one click. Dropped files are not remembered.
        </div>
      )}
      {recent.length > 0 && (
        <fieldset>
          <legend>Recent</legend>
          <div className={LIST}>
            {recent.map((r) => (
              <button key={r.path} type="button" className={ROW} title="Deploy again" onClick={() => deployFrom(r.path)}>
                <b>{r.name}</b>
                <span className="dim">
                  → {r.server}
                  {r.domains[0] ? ` · ${r.domains[0]}` : ""}
                </span>
                <span className="faint mono ml-auto overflow-hidden text-ellipsis">{tilde(r.path)}</span>
              </button>
            ))}
          </div>
        </fieldset>
      )}
      <div className="flex flex-wrap gap-0.5 items-center mono">
        <Btn cls={cx("ghost sm", crumb)} on={to("/")}>
          /
        </Btn>
        {parts.map((x, i) => [
          i > 0 && (
            <span key={`s${i}`} className="faint">
              /
            </span>
          ),
          <Btn key={i} cls={cx("ghost sm", crumb)} on={to("/" + parts.slice(0, i + 1).join("/"))}>
            {x}
          </Btn>,
        ])}{" "}
        <Btn cls={cx("ghost sm", crumb)} on={to(b.home)} title="Home">
          ~
        </Btn>
      </div>
      <div className={LIST}>
        {b.parent && (
          <button type="button" className={ROW} onClick={to(b.parent)}>
            ↑ ..
          </button>
        )}
        {b.dirs.length ? (
          b.dirs.map((d: string) => (
            <button key={d} type="button" className={ROW} onClick={to(b.path.replace(/\/$/, "") + "/" + d)}>
              📁 {d}
            </button>
          ))
        ) : (
          <div className={cx(ROW, "faint hover:bg-transparent")}>no subfolders</div>
        )}
      </div>
      <div className={DETECTED}>
        <Stack d={b.detected} className="mb-2" />
        <b>{b.detected.name}</b>: <Describe d={b.detected} />
      </div>
      <div className="border-[1.5px] border-dashed border-line-strong rounded-md p-3.5 text-center text-dim text-md">
        Or drop a folder or .zip anywhere ·{" "}
        <label className={PICK}>
          choose a folder
          <input
            type="file"
            hidden
            multiple
            // @ts-expect-error not in React's types
            webkitdirectory=""
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              upload(
                files.filter((f) => !skipped(f.webkitRelativePath)).map((f) => [f, f.webkitRelativePath || f.name]),
                files[0]?.webkitRelativePath.split("/")[0],
                site,
              );
            }}
          />
        </label>{" "}
        ·{" "}
        <label className={PICK}>
          choose a .zip
          <input
            type="file"
            hidden
            accept=".zip,.tar,.tgz,.gz"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) upload([[f, f.name]], f.name, site);
            }}
          />
        </label>{" "}
        ·{" "}
        <button
          type="button"
          className={cx(PICK, "border-0 bg-transparent p-0 shadow-none")}
          title="Run an image from a registry or this machine's Docker (lf deploy --image)"
          onClick={() => deployImage(site)}
        >
          a Docker image
        </button>
      </div>
      <div className={DBTNS}>
        <Btn cls="ghost" id="dlg-cancel" on={closeDialog}>
          Cancel
        </Btn>
        <Btn type="submit" cls="primary" title="Check its settings, then deploy">
          Next
        </Btn>
      </div>
    </form>
  );
}

// Dropped folders: walk the entries (skipping dependencies and VCS data), then upload with relative paths.
type Pair = [File, string];
const SKIP = new Set(["node_modules", ".git", ".DS_Store", "__MACOSX"]);
const skipped = (rel: string) => rel.split("/").some((x) => SKIP.has(x));
async function droppedFiles(roots: FileSystemEntry[]) {
  const out: Pair[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (SKIP.has(entry.name)) return;
    if (entry.isFile) out.push([await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej)), prefix + entry.name]);
    else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (let batch; (batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej))).length;) {
        for (const e of batch) await walk(e, `${prefix}${entry.name}/`);
      }
    }
  };
  for (const r of roots) await walk(r, "");
  return out;
}

async function upload(pairs: Pair[], label = "site", site?: Redeploy) {
  if (!pairs.length) return toast("Nothing to upload");
  const fd = new FormData();
  for (const [f, path] of pairs) (fd.append("file", f), fd.append("path", path));
  toast(`Uploading ${plural(pairs.length, "file")}, ${bytes(pairs.reduce((n, [f]) => n + f.size, 0))}…`);
  try {
    const r = await fetch("/api/upload", { method: "POST", body: fd });
    const data: { files: number; detected: Detected; error?: string } = await r.json().catch(() => ({ error: `${r.status} ${r.statusText}` }));
    if (!r.ok) throw new Error(data.error);
    toast(`Uploaded ${plural(data.files, "file")}`);
    deployDialog(data.detected, { upload: true, files: data.files, name: slugify(label), site });
  } catch (e) {
    toast(`Upload failed: ${errorMessage(e)}`);
  }
}

/** A folder or .zip dropped anywhere on the page deploys it. */
export function listenForDrops() {
  const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes("Files");
  addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    document.body.classList.add("dragging");
  });
  addEventListener("dragleave", (e) => {
    if (!e.relatedTarget) document.body.classList.remove("dragging");
  });
  addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    document.body.classList.remove("dragging");
    // Entries must be taken while the event is live.
    const dt = e.dataTransfer!;
    const roots = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter((x): x is FileSystemEntry => !!x);
    const label = roots[0]?.name ?? dt.files[0]?.name;
    const files = roots.length ? droppedFiles(roots) : Promise.resolve([...dt.files].map((f): Pair => [f, f.name]));
    const site = D.node ? D.site : undefined;
    files.then(
      (pairs) => upload(pairs, label, site),
      (err) => toast(errorMessage(err)),
    );
  });
}
