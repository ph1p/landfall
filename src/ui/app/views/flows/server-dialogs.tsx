import { S, serverNamed } from "../../lib/store";
import { CLOUDS } from "../../../../core/server/clouds";
import { load, refreshState } from "../../lib/api";
import { run, ifOk } from "../../lib/jobs";
import { dialog, type Values } from "../../ui/dialog";

export const defaultServer = (): string | undefined => S.sel ?? S.state.servers.find((s) => s.isDefault)?.name;

export const mainDomain = (n: string): string | undefined => serverNamed(n)?.saved?.domains?.[0];

/** The server deploys new sites with no domain unless one is given: its own setting, else landfall's default. */
export const tunnelOnly = (n: string): boolean => serverNamed(n)?.saved?.tunnelOnly ?? S.state.defaults.tunnelOnly;

/** landfall's defaults for every server (lf config); a server's own setting wins. */
/** Wizard steps the minimal setup leaves out. */
export const full = (v: Values) => !v.minimal;

export const providerOptions = (found?: string) => [
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
