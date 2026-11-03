import { S, plural, sv, tilde } from "../lib/store";
import type { Detected, Overview, SiteStatus } from "../lib/types";
import { fetchInto, go, refreshState } from "../lib/api";
import { run, ifOk } from "../lib/jobs";
import { toast } from "../ui/toast";
import { Btn, Dot } from "../ui/kit";
import { confirmDlg, dialog, domainOk, passwordError, promptDlg, userError, words, type Spec, type Values } from "../ui/dialog";
import { autoDomain, browse, buildForm, mainDomain, openAfter } from "./flows";
import { Copy } from "lucide-react";
import { EnvTable, NO_ENV_CHANGE, type EnvChange } from "./env";

// ---- domains & login ---------------------------------------------------------

export function copy(text: string) {
  navigator.clipboard?.writeText(text).then(
    () => toast(`Copied ${text}`),
    () => toast(text),
  ) ?? toast(text);
}

const servedByOther = (n: string, site: string, d: string): string | undefined =>
  S.overview[n]?.data?.sites.find((s) => s.meta.name !== site && s.domains.includes(d))?.meta.name;

/**
 * Everything about a site in one form: its domains, login, environment and, deployed from here, how it builds.
 * Each section that changed runs its own lf command, one after the other; a build change redeploys.
 */
export function siteSettings(n: string, site: SiteStatus) {
  const m = site.meta;
  const proj = m.adopted ? undefined : (S.state.projects ?? []).find((p) => p.server === n && p.name === m.name);
  if (!proj) return settingsDialog(n, site);
  delete S.det[proj.path];
  browse(proj.path).then(
    (x) => settingsDialog(n, site, proj.path, x.detected, proj.environment),
    () => settingsDialog(n, site),
  );
}

/** The values a form starts with. */
const defaults = (specs: Spec[]): Values =>
  Object.assign(
    {},
    ...specs.map((x) => ("fields" in x ? defaults(x.fields) : "row" in x ? defaults(x.row) : { [x.name]: x.value ?? (x.type === "check" ? false : "") })),
  );

function settingsDialog(n: string, site: SiteStatus, path?: string, det?: Detected, environment?: string) {
  const { meta: m, main: svc } = site;
  const name: string = m.name;
  const managed = !m.adopted;
  const main = mainDomain(n);
  const free = autoDomain(n, name);
  const ips: string[] = S.dns[n]?.data?.ips ?? [];
  const users: string[] = (m.auth ?? []).map((a: string) => a.split(":")[0]);
  const build = det && buildForm(det);
  const served = (v: Values) => !build || build.served(v);
  // The untouched form already asks for flags (a detected build not yet saved): only a change from them redeploys.
  const untouched = build ? build.argv(defaults(build.fields)).join("\0") : "";
  dialog({
    title: `Edit ${name}`,
    text: `On ${n}${path ? `, deployed from ${tilde(path)}${environment ? ` as its ${environment} environment` : ""}` : ""}. Saving runs one lf command per changed section${build ? "; a build change redeploys" : ""}.`,
    sidebar: true,
    fields: [
      svc && {
        legend: "Domains",
        when: served,
        note: `Each domain needs an A record pointing at ${ips.join(", ") || "the server"}. Traefik fetches the certificate once it resolves.`,
        fields: [
          {
            name: "domains",
            label: "Domains (space separated)",
            value: m.domains.join(" "),
            mono: true,
            off: (v: Values) => v.noDomain,
            check: (x: string) =>
              words(x)
                .filter((d) => !domainOk(d))
                .map((d) => `Not a domain: ${d}`)[0],
          },
          {
            name: "noDomain",
            label: "No domain: reach it through a tunnel only",
            type: "check",
            value: !m.domains.length,
            hint: "Nothing is served on the internet; the site keeps running. Open via tunnel reaches it.",
          },
          main &&
            !m.domains.includes(main) && {
              name: "apex",
              label: `Also serve ${main}`,
              type: "check",
              value: false,
              when: (v: Values) => !v.noDomain,
              hint: servedByOther(n, name, main) ? `${servedByOther(n, name, main)} serves it now and hands it over.` : "The main domain itself.",
            },
          free &&
            !m.domains.includes(free) && {
              name: "free",
              label: main ? `Also add ${free}` : `Also add the free address ${free}`,
              type: "check",
              value: false,
              when: (v: Values) => !v.noDomain,
              hint: main ? `Under the main domain: works once *.${main} points at the server.` : "Works right away, no DNS setup.",
            },
        ].filter(Boolean),
      },
      managed && {
        legend: "Visitor login",
        when: served,
        note: users.length
          ? `Visitors log in as ${users.join(", ")}. A new password for an existing user changes theirs.`
          : "Optional: visitors log in (HTTP basic auth) before they see the site.",
        fields: [
          { name: "off", label: "Remove the login: the site is public again", type: "check", value: false, when: () => users.length },
          {
            row: [
              {
                name: "user",
                label: "User",
                value: users[0] ?? "admin",
                off: (v: Values) => v.off,
                check: (x: string, v: Values) => v.password && userError(x || "admin"),
              },
              {
                name: "password",
                label: `Password (${S.state.rules.minPassword}+ characters)`,
                type: "password",
                placeholder: users.length ? "unchanged" : "none",
                off: (v: Values) => v.off,
                check: (x: string) => x && passwordError(x),
              },
            ],
          },
        ],
      },
      managed && {
        legend: "Environment",
        note: `The site's .env on the server. Saving runs lf env ${name}, which recreates the services whose variables changed.`,
        fields: [
          {
            name: "env",
            type: "custom",
            value: NO_ENV_CHANGE,
            check: (x: EnvChange) => x.bad,
            render: (_: EnvChange, set: (v: EnvChange) => void) => <EnvTable n={n} site={name} onChange={set} />,
          },
        ],
      },
      managed &&
        m.kind !== "static" && {
          legend: "Secrets",
          note:
            (m.kind === "compose"
              ? "Files in the site's .secrets folder; compose.yaml mounts one with secrets: NAME: file: ./.secrets/NAME."
              : "Files every service reads at /run/secrets/NAME.") +
            ` Values never come back to this page. Saving runs lf secret ${name}, which restarts the services that use a changed one; multi-line files: lf secret --file NAME=path.`,
          fields: [
            {
              name: "secrets",
              type: "custom",
              value: NO_ENV_CHANGE,
              check: (x: EnvChange) => x.bad,
              render: (_: EnvChange, set: (v: EnvChange) => void) => <EnvTable n={n} site={name} onChange={set} secrets />,
            },
          ],
        },
      ...(build?.fields ?? []),
    ].filter(Boolean) as Spec[],
    ok: "Save",
    onOk: (v) => {
      const jobs: { argv: string[]; cwd?: string }[] = [];
      if (managed && served(v)) {
        if (v.off) jobs.push({ argv: ["auth", name, ...sv(n), "--off", "-y"] });
        else if (v.password) jobs.push({ argv: ["auth", name, ...sv(n), "-u", v.user.trim() || "admin", "--password", v.password] });
      }
      if (managed) {
        const e: EnvChange = v.env;
        const pairs = Object.entries(e.set).map(([k, x]) => `${k}=${x}`);
        const unset = e.unset.flatMap((k) => ["-u", k]);
        if (pairs.length || unset.length) jobs.push({ argv: ["env", name, ...sv(n), ...pairs, ...unset] });
        const s: EnvChange | undefined = v.secrets;
        if (s && (Object.keys(s.set).length || s.unset.length)) {
          jobs.push({ argv: ["secret", name, ...sv(n), ...Object.entries(s.set).map(([k, x]) => `${k}=${x}`), ...s.unset.flatMap((k) => ["-u", k])] });
        }
      }
      let domains: string[] | undefined;
      if (svc && served(v)) {
        const next = v.noDomain ? [] : words(v.domains);
        if (v.free && !v.noDomain) next.push(free);
        if (v.apex && !v.noDomain) next.push(main!);
        if (next.join(" ") !== m.domains.join(" ")) domains = next;
      }
      const flags = build?.argv(v) ?? [];
      const rebuild = flags.join("\0") !== untouched;
      // A redeploy takes the new domains along; run from the folder, both keep .landfall.json in step.
      if (rebuild) {
        const to = domains && (domains.length ? domains.flatMap((d) => ["-d", d]) : ["--no-domain"]);
        jobs.push({ argv: ["deploy", "-y", ...sv(n), ...(environment ? ["-E", environment] : []), "-n", name, ...flags, ...(to ?? [])], cwd: path });
      } else if (domains) {
        // None left: the site keeps running, unrouted.
        const args = domains.length ? domains.flatMap((d) => ["--set", d]) : m.domains.flatMap((d: string) => ["--rm", d]);
        jobs.push({ argv: ["domains", name, ...sv(n), ...args, "-y"], cwd: path });
      }
      if (!jobs.length) return void toast("Nothing changed");
      const chain = ([j, ...rest]: typeof jobs): unknown =>
        j && run(j.argv, { server: n, cwd: j.cwd, after: rest.length ? ifOk(() => chain(rest)) : j.argv[0] === "deploy" ? openAfter : undefined });
      chain(jobs);
    },
  });
}

/** Check the sites' domains (DNS and HTTPS) once, again when forced. Call it from an effect. */
export function ensureDns(n: string, o: Overview | undefined, force = false) {
  if ((S.dns[n] && !force) || S.dns[n]?.loading || !o?.sites.length) return;
  const domains = [...new Set(o.sites.flatMap((x) => x.domains))];
  fetchInto("dns", n, `/dns?domains=${encodeURIComponent(domains.join(","))}`);
}

/** A site's domain as a link, with a dot for its DNS and HTTPS check and a copy button. */
export function DomainChip({ n, d }: { n: string; d: string }) {
  const c = S.dns[n]?.data?.domains.find((x) => x.domain === d);
  const url = `https://${d}`;
  let dot = "",
    title = "checking…";
  if (c) {
    const { status: st, ms, tls } = c.https;
    const cert = tls ? (tls.valid ? ` · certificate ${plural(tls.days, "day")} left` : ` · certificate: ${tls.error}`) : "";
    if (!c.ips.length) ((dot = "down"), (title = "DNS: does not resolve"));
    else if (!c.ok) ((dot = "warn"), (title = `DNS points at ${c.ips.join(", ")}, not this server`));
    else if (st && st < 500 && tls && (!tls.valid || tls.days < 7)) ((dot = "warn"), (title = `HTTPS ${st}${cert}`));
    else if (st && st < 500) ((dot = "up"), (title = `HTTPS ${st}${st === 401 ? " (login required)" : ""} in ${ms} ms${cert}`));
    else ((dot = "down"), (title = `HTTPS: ${st ?? c.https.error}`));
  }
  return (
    <span className="group inline-flex items-center gap-0.5 max-w-full">
      <Dot kind={dot} title={title} />
      <a
        href={url}
        target="_blank"
        rel="noopener"
        title={title}
        className="overflow-hidden text-ellipsis whitespace-nowrap"
        onClick={(e) => e.stopPropagation()}
      >
        {d}
      </a>
      <Btn
        cls="ghost px-[5px]! py-0! text-sm! min-w-6 min-h-6 text-faint! group-hover:text-fg! focus-visible:text-fg!"
        title="Copy the address"
        on={() => copy(url)}
      >
        <Copy className="size-3.5" aria-hidden="true" />
      </Btn>
    </span>
  );
}

export function runCommand(n: string) {
  promptDlg(
    `Run a command on ${n}`,
    "Runs through ssh as the server's login; output shows on the right.",
    { label: "Command", placeholder: "df -h", type: "text" },
    (cmd) => {
      if (cmd) run(["ssh", n, "--", cmd], { server: n });
    },
    "Run",
  );
}

export function forget(n: string) {
  confirmDlg({
    title: `Forget ${n}?`,
    text: "Removes it from landfall (and the Host block landfall wrote to ~/.ssh/config).\nNothing on the server is changed.",
    ok: `Forget ${n}`,
    danger: true,
    typeToConfirm: n,
    onOk: () => run(["server", "rm", n, "-y"], { server: n, after: ifOk(() => go(null)) }),
  });
}

export function uninstall(n: string) {
  dialog({
    title: `Uninstall landfall from ${n}?`,
    text: "Deletes every site landfall deployed and forgets adopted ones (they keep running), stops landfall's Traefik, reverts what setup changed and deletes /opt/landfall with its journal. Then forgets the server here.\nDocker, packages and firewall rules from lf firewall stay. This cannot be undone.",
    fields: [
      { name: "volumes", type: "check", label: "Also delete the sites' named volumes (their data)" },
      { name: "keep", type: "check", label: "Keep the deploy user, ufw and ssh hardening" },
    ],
    ok: "Uninstall",
    danger: true,
    typeToConfirm: n,
    onOk: (v) =>
      run(["server", "uninstall", n, "-y", ...(v.volumes ? ["--volumes"] : []), ...(v.keep ? ["--keep-setup"] : [])], {
        server: n,
        after: ifOk(() => (go(null), refreshState())),
      }),
  });
}

export function makeDefault(n: string) {
  run(["server", "use", n], { server: n, after: ifOk(refreshState) });
}
