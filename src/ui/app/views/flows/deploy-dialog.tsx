import { S, http, plural, sv, tilde } from "../../lib/store";
import { expandHost, redirectHosts } from "../../../../core/traefik/redirects";
import type { Detected, ExposureCheck, GitInfo, Redeploy } from "../../lib/types";
import { loadGit } from "../../lib/api";
import { run } from "../../lib/jobs";
import { Btn, BtnGroup, cx } from "../../ui/kit";
import { allows, hasRule, namesAt, ruleText } from "../../../../core/deploy/refs";
import { dialog, invalid, siteNameError, words, domainOk, userError, passwordError, type Values } from "../../ui/dialog";
import { EnvTable, envUrl, NO_ENV_CHANGE, type EnvChange } from "../env";
import { DEPLOY_HOOKS, hookSource } from "../../../../core/site/hook-names";
import { hookChoice } from "../hooks";
import { defaultServer, mainDomain, tunnelOnly } from "./server-dialogs";
import { autoDomain, domainTaken, imageName } from "./names";
import { DeployAside } from "./describe";
import { buildForm } from "./build-form";
import { openAfter } from "./deploy";
import { type PickedRef, refArgs, refField } from "../pipeline/ref-picker";

interface DeployOpts {
  site?: Redeploy;
  upload?: boolean;
  files?: number;
  name?: string;
  /** An image deploy from an empty folder (deployImage): this machine's images, offered for the image field. */
  images?: string[];
  /** The server the form starts with, in place of the project's or the default: a drop on the map. */
  server?: string;
}

/**
 * Deploy a local folder (det from /api/fs or an upload). upload: a temporary folder, so no .landfall.json.
 * site: an existing site ({ server, name, domains }) this folder redeploys.
 */
export async function deployDialog(det: Detected, o: DeployOpts = {}) {
  const p = det.project;
  const re = o.site;
  const servers = S.state.servers.map((s) => ({ value: s.name, label: s.name }));
  const target = o.server ?? re?.server ?? p?.server ?? defaultServer() ?? "";
  const name = re?.name ?? o.name ?? det.name;
  const image = det.kind === "image";
  // An image deploy without a name: the image's, as blog for ghcr.io/me/blog:1.2.
  const siteName = (v: Values): string => v.name.trim() || (image ? imageName(v.image ?? "") : "");
  // A redeploy keeps the site's domains unless .landfall.json or the field names others.
  const keeps = re && !p?.domains ? re.domains : null;
  const keeping = (v: Values) => keeps && siteName(v) === re?.name && v.server === re?.server;
  const { fields: buildFields, argv: buildArgv, served } = buildForm(det);
  // An example's key with a value is only suggested (askable in core/site/env-vars): the CLI says it, the form leaves it out.
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
    const out = given.map((d) => expandHost(d, main));
    if (out.includes(undefined)) return [[], `@ means the main domain, and ${v.server} has none`];
    const bad = out.find((d) => !domainOk(d!));
    if (bad) return [out as string[], `Not a domain: ${bad}`];
    return [out as string[], out.map((d) => domainTaken(v.server, d!)).find(Boolean)];
  };
  const hooks = hookChoice(det.hooks?.run, DEPLOY_HOOKS, "deploy", `From ${hookSource(det.hooks?.pm).file}.`);
  // What the deploy redirects without --redirect: .landfall.json's, else the site's.
  const savedRedirects = (p?.redirects ?? re?.redirects ?? []).join(" ");
  const sends = p?.sendImage === true ? "send" : p?.sendImage === false ? "pull" : "";
  // A git checkout: deploy its working tree, as always, or a clean export of a branch or tag (lf deploy --ref/--tag).
  // And what lf exposure check finds in the upload: shown beside the form, so nothing risky goes out unnoticed.
  const [g, x] = await Promise.all([
    o.upload || o.images ? undefined : loadGit(det.path, true),
    o.images ? undefined : http<ExposureCheck>(`/api/exposure?path=${encodeURIComponent(det.path)}`).catch(() => undefined),
  ]);
  const source = g?.repo ? sourceFields(g) : undefined;
  dialog({
    title: re ? `Redeploy ${name}` : name ? `Deploy ${name}` : "Deploy a Docker image",
    text:
      (o.images
        ? "Runs an image as a site. Not remembered here: Redeploy on the site asks for the image again."
        : o.upload
          ? `Uploaded ${plural(o.files ?? 0, "file")}. Not remembered: drop it again to redeploy.`
          : `From ${tilde(det.path)}${p ? " (settings from .landfall.json)" : ""}`) +
      (re ? `\nGoes live as a new release of ${name} on ${re.server}: volumes keep their data, and Roll back returns to the current one.` : ""),
    aside: <DeployAside d={det} g={g} x={x} />,
    sidebar: true,
    fields: [
      ...(source ? [source] : []),
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
          {
            name: "redirects",
            label: "Redirect to the first domain",
            value: savedRedirects,
            off: (v) => v.noDomain,
            placeholder: "www",
            hint: "Hosts that answer with a permanent redirect, path and query kept. www = www.<first domain>. lf deploy --redirect",
            check: (x, v) => {
              const bad = words(x).find((d) => !domainOk(d) && !/^[a-z0-9-]+$/i.test(d));
              if (bad) return `Not a domain: ${bad}`;
              const [out] = addresses(v);
              const both = redirectHosts(words(x), out[0]).find((d) => out.includes(d));
              return both && `${both} is a domain of the site: it cannot also redirect`;
            },
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
      ...hooks.fields,
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
        const redirects = words(v.redirects);
        if (!v.noDomain && redirects.join(" ") !== savedRedirects)
          argv.push(...(redirects.length ? redirects.flatMap((d) => ["--redirect", d]) : ["--no-redirect"]));
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
      argv.push(...hooks.skip(v));
      if (source && v.source === "ref") argv.push(...refArgs(v.ref as PickedRef));
      run(argv, { server: v.server, cwd: det.path, after: openAfter });
    },
  });
}

/** Why the project's git rule refuses the working tree (lf deploy without --ref), if it does. */
function treeRefused(g: GitInfo): string | undefined {
  const repo = g.repo!;
  const rule = g.rules[""];
  if (!hasRule(rule)) return undefined;
  if (!allows(rule, namesAt(repo.sha, g.refs, [{ name: repo.branch, kind: "branch" }])))
    return `The project deploys ${ruleText(rule)}; ${repo.branch ? `HEAD on ${repo.branch}` : "HEAD"} is not one`;
  if (rule.requireClean && repo.dirty) return `The project deploys only committed files, and ${plural(repo.dirty, "file")} changed: commit them or pick a ref`;
  return undefined;
}

/** The deploy form's Source section: the working tree, or a branch or tag of the checkout. */
function sourceFields(g: GitInfo) {
  const repo = g.repo!;
  const refused = treeRefused(g);
  const rule = g.rules[""];
  const tree = `Working tree${repo.dirty ? ` (${plural(repo.dirty, "change")})` : ""}`;
  return {
    legend: "Source",
    fields: [
      {
        name: "source",
        label: "Deploy",
        type: "custom" as const,
        value: refused ? "ref" : "tree",
        render: (x: string, set: (v: string) => void) => (
          <div className="grid gap-1">
            <BtnGroup label="What to deploy">
              <Btn cls={cx("sm", x === "tree" && "primary")} aria-pressed={x === "tree"} disabled={!!refused} title={refused} on={() => set("tree")}>
                {tree}
              </Btn>
              <Btn cls={cx("sm", x === "ref" && "primary")} aria-pressed={x === "ref"} on={() => set("ref")}>
                Git ref
              </Btn>
            </BtnGroup>
            <span className="text-sm text-dim">
              {x === "tree"
                ? `The folder as it is now, on ${repo.branch ?? "a detached HEAD"}${repo.dirty ? ", uncommitted changes included" : ""}.`
                : (refused ?? "A clean copy of a commit: nothing uncommitted, nothing ignored.")}
            </span>
          </div>
        ),
      },
      refField(g.refs, rule, { when: (v: Values) => v.source === "ref", hint: hasRule(rule) ? `The project deploys ${ruleText(rule)}.` : undefined }),
    ],
  };
}
