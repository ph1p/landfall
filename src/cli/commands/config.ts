import { defineCommand } from "../cmd";
import { checkEmail, checkInt, DEFAULT_KEEP, updateConfig, type Defaults } from "../../core/config";
import { c, fail, ok, printJson } from "../../core/term";
import { defaultsView } from "../../core/views";

const KEYS = ["tunnel-only", "email", "keep", "default"] as const;

export const config = defineCommand({
  name: "config",
  summary: `Show or change landfall's defaults for every server.

A server's own setting wins over these (lf server config shows which applies):
  --tunnel-only   new sites get no domain unless -d gives one; reach them with lf tunnel
                  (per server: lf server domain <name> --tunnel-only)
  --email         Let's Encrypt contact for servers that set none (per server: lf traefik setup --email)
  --keep          releases a deploy keeps for rollback (per deploy: lf deploy --keep)
  --default       the server commands use without --server (same as lf server use)

--unset <key> goes back to landfall's built-in value.`,
  options: {
    "tunnel-only": { type: "boolean", desc: "new sites get no domain unless -d gives one (--no-tunnel-only)" },
    email: { type: "string", desc: "Let's Encrypt contact e-mail" },
    keep: { type: "string", desc: `releases to keep for rollback (built in: ${DEFAULT_KEEP})` },
    default: { type: "string", desc: "default server" },
    unset: { type: "string", multiple: true, desc: `forget a setting: ${KEYS.join(", ")}` },
    json: { type: "boolean", desc: "machine-readable output" },
  },
  async run(_, o) {
    const unset: string[] = o.unset ?? [];
    const bad = unset.filter((k) => !(KEYS as readonly string[]).includes(k));
    if (bad.length) fail(`cannot unset ${bad.join(", ")}: one of ${KEYS.join(", ")}`);
    const changing = o["tunnel-only"] !== undefined || o.email !== undefined || o.keep !== undefined || o.default !== undefined || unset.length > 0;
    if (changing) {
      const email = o.email !== undefined ? checkEmail(o.email) : undefined;
      const keep = o.keep !== undefined ? checkInt(o.keep, "--keep", 1) : undefined;
      await updateConfig((cfg) => {
        if (o.default !== undefined) {
          cfg.servers[o.default] ??= { host: o.default };
          cfg.default = o.default;
        }
        const d: Defaults = (cfg.defaults ??= {});
        if (o["tunnel-only"] !== undefined) d.tunnelOnly = o["tunnel-only"];
        if (email !== undefined) d.email = email;
        if (keep !== undefined) d.keep = keep;
        if (unset.includes("tunnel-only")) delete d.tunnelOnly;
        if (unset.includes("email")) delete d.email;
        if (unset.includes("keep")) delete d.keep;
        if (unset.includes("default")) delete cfg.default;
        if (!Object.keys(d).length) delete cfg.defaults;
      });
      ok("saved");
    }
    const v = defaultsView();
    if (o.json) return void printJson(v);
    const own = (k: keyof Defaults) => (v.defaults[k] === undefined ? c.dim(" (built in)") : "");
    const row = (k: string, val: string) => console.log(`  ${c.dim(k.padEnd(12))} ${val}`);
    console.log(`${c.bold("landfall defaults")} ${c.dim(v.configFile)}`);
    row("default", v.default ?? c.dim("none (lf config --default <server>)"));
    row("new sites", `${v.tunnelOnly ? "no domain, tunnel only" : "get a domain"}${own("tunnelOnly")}`);
    row("e-mail", v.email ?? c.dim("none"));
    row("keep", `${v.keep} releases${own("keep")}`);
    for (const [title, list] of [["on this machine", v.locations.local], ["on each server", v.locations.server]] as const) {
      console.log(`\n${c.bold(title)}`);
      const w = Math.max(...list.map((l) => l.path.length));
      for (const l of list) console.log(`  ${l.path.padEnd(w)}  ${c.dim(l.what)}`);
    }
  },
});
