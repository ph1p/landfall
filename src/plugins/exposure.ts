// exposure: files and ports a site should not show the world. A built-in plugin.
// lf exposure check looks at what a deploy of this folder would upload, before it does (a predeploy hook can run it).
// The server side (files already in releases) is part of lf security.
import { definePlugin, type PluginContext } from "../core/plugins/plugin-api";
import { checkProject, type Severity } from "../core/deploy/exposure";

const paint = (ctx: PluginContext, s: Severity) => (s === "high" ? ctx.color.red(s) : s === "medium" ? ctx.color.yellow(s) : ctx.color.dim(s));

const json = { type: "boolean", desc: "machine-readable output" } as const;

export default definePlugin({
  name: "exposure",
  summary: "Find files and ports a deploy should not show the world: secrets, .git, agent settings, .DS_Store, open database ports.",
  commands: [
    {
      name: "check",
      args: "[dir]",
      local: true,
      summary: "Check what a deploy of this folder would upload and publish. Exits 1 on high or medium findings: use it as a predeploy hook.",
      options: {
        json,
        strict: { type: "boolean", desc: "also exit 1 on low findings (.DS_Store, editor folders, logs)" },
        allow: { type: "string", multiple: true, desc: "accept files matching this pattern (.gitignore syntax), e.g. --allow 'fixtures/*.sql'" },
        "allow-port": { type: "string", multiple: true, desc: "accept this published container port, e.g. --allow-port 25565" },
      },
      async run(ctx, [dirArg], o) {
        const r = await checkProject(process.cwd(), {
          dir: dirArg,
          allow: o.allow as string[] | undefined,
          allowPorts: ((o["allow-port"] as string[] | undefined) ?? []).map(Number),
          strict: !!o.strict,
        });
        const { files, ports } = r;
        if (r.composeError) ctx.log.warn(r.composeError);
        if (o.json) {
          ctx.json(r);
          return r.ok ? 0 : 1;
        }
        const { bold, dim } = ctx.color;
        if (ports.length) {
          ctx.print(bold(`Ports in ${r.compose}`));
          ctx.table([["severity", "service", "port", "why"].map(dim), ...ports.map((p) => [paint(ctx, p.severity), p.service, p.port, dim(p.why)])]);
        }
        if (files.length) {
          ctx.print(...(ports.length ? [""] : []), bold("Files the upload would send"));
          ctx.table([["severity", "file", "why"].map(dim), ...files.map((f) => [paint(ctx, f.severity), f.path, dim(f.why)])]);
        }
        if (!files.length && !ports.length) {
          ctx.log.ok("nothing risky in the upload");
          return 0;
        }
        if (files.length) ctx.log.info(dim(`leave them out with "exclude" in .landfall.json, or accept them with --allow <pattern>`));
        if (r.ok) {
          ctx.log.ok("only low findings: not blocking (--strict blocks them too)");
          return 0;
        }
        ctx.log.warn("risky files or ports: fix them before you deploy");
        return 1;
      },
    },
  ],
});
