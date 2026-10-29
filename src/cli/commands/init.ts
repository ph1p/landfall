import fs from "node:fs";
import { join, relative, resolve } from "node:path";
import { defineCommand, serverOpt } from "../cmd";
import { checkInt, loadProject } from "../../core/config";
import { adoptCompose, COMPOSE_FILES, currentRelease, EJECT_FILE, localCompose, OVERRIDE_FILES, overrideYaml, routed, volumeName } from "../../core/compose";
import { detectApp, detectProject } from "../../core/projects";
import { requireSite } from "../../core/remote";
import { c, confirm, fail, info, ok, showDiff, showStack, warn } from "../../core/term";
import { target } from "./sites";

export const init = defineCommand({
  name: "init",
  args: "[dir]",
  summary: `Write a compose.yaml for this project, to run it locally and deploy it.

  compose.yaml           what runs on the server; x-landfall routes a service through Traefik
  compose.override.yaml  local only (docker compose merges it, lf deploy leaves it out):
                         publishes the port on localhost
  Dockerfile             an app without one (Next.js, Express, Django, Spring Boot, Go,
                         Rails, Laravel, …): the one lf deploy would generate, to
                         change it here

\`docker compose up\` then runs the site locally, \`lf deploy\` on a server. Existing
files are never overwritten, except an existing compose.yaml: init writes down the routes
a deploy picks without x-landfall, moves its ports: into compose.override.yaml and shows
the diff.`,
  options: {
    port: { type: "string", desc: "container port (default: EXPOSE, the saved port or the app's usual one)" },
    postgres: { type: "boolean", desc: "add a Postgres service with a volume; the app gets DATABASE_URL" },
  },
  async run([dirArg], o) {
    const root = resolve(process.cwd(), dirArg ?? ".");
    if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) fail(`${dirArg} is not a folder`);
    const d = detectProject(root);
    showStack(d.stack);
    if (d.kind === "compose") return adopt(root, d.compose!, d.analysis!);
    const files: Record<string, string> = { "compose.yaml": "", "compose.override.yaml": "" };
    const taken = Object.keys(files).filter((f) => fs.existsSync(join(root, f)));
    if (taken.length) fail(`${taken.join(" and ")} exist already`);

    const port = d.kind === "static" ? 80 : checkInt(o.port ?? d.port ?? 3000, "--port", 1, 65535);
    const found = d.start ? detectApp(root, d.start) : undefined;
    if (found) {
      files.Dockerfile = found.dockerfile({ build: d.build, start: d.start!, port });
      if (!fs.existsSync(join(root, ".dockerignore"))) files[".dockerignore"] = found.ignore.join("\n") + "\n";
    }
    const local = d.kind === "static" ? 8080 : port;
    const db = !!o.postgres;
    const worker = d.kind !== "static" && !!d.project?.worker;
    const volumes = d.kind === "static" ? [] : (d.project?.volumes ?? found?.volumes ?? []);
    let app: string;
    if (d.kind === "static") {
      const dir = d.dir ?? "dist";
      if (!d.dir) info(c.dim(`no built site found: serving ./${dir}, change it in compose.yaml if your build writes elsewhere`));
      app = `  web:
    image: nginx:alpine
    restart: unless-stopped
    volumes:
      - ./${dir}:/usr/share/nginx/html:ro
    x-landfall:
      port: 80
`;
    } else {
      app = `  app:
    ${d.kind === "image" ? `image: ${d.project!.image}` : "build: ."}
    restart: unless-stopped${d.start ? "\n    init: true" : ""}
    env_file:
      - path: .env
        required: false
${
  db
    ? `    environment:
      DATABASE_URL: postgres://app:\${POSTGRES_PASSWORD}@db:5432/app
    depends_on:
      db:
        condition: service_healthy
`
    : ""
}${volumes.length ? `    volumes:\n${volumes.map((v) => `      - ${volumeName(v)}:${v}\n`).join("")}` : ""}${worker ? "" : `    x-landfall:\n      port: ${port}\n`}`;
    }
    const svc = d.kind === "static" ? "web" : "app";
    files["compose.yaml"] = `# Runs locally with \`docker compose up\` and on a server with \`lf deploy\`.
# x-landfall.port: the port Traefik sends the site's requests to (HTTPS on its domains).
services:
${app}${
  db
    ? `  db:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: app
      POSTGRES_DB: app
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}
    volumes:
      - db:/var/lib/postgresql/data
    healthcheck:
      test: pg_isready -U app
      interval: 5s
      retries: 10

`
    : ""
}${
  db || volumes.length
    ? `
# Survive deploys and rollbacks; \`lf sites rm --volumes\` deletes them.
volumes:
${[...(db ? ["db"] : []), ...volumes.map(volumeName)].map((v) => `  ${v}:\n`).join("")}`
    : ""
}`;
    if (worker) delete files["compose.override.yaml"];
    else files["compose.override.yaml"] = `# Local only: docker compose merges this file, lf deploy leaves it out.
services:
  ${svc}:
    ports:
      - "127.0.0.1:${local}:${port}"
`;

    for (const [f, text] of Object.entries(files)) fs.writeFileSync(join(root, f), text);
    const at = relative(process.cwd(), root) || ".";
    ok(`wrote ${Object.keys(files).join(", ")} in ${at}`);
    if (db && !fs.existsSync(join(root, ".env"))) info(`locally: put POSTGRES_PASSWORD=… in ${join(at, ".env")} (keep it out of git)`);
    info(`run it:    docker compose up${d.kind === "static" ? "" : " --build"}${worker ? "" : `   → http://localhost:${local}`}`);
    if (found?.note) info(found.note);
    info(`deploy it: lf deploy${db ? " -e POSTGRES_PASSWORD=<secret>   (the first time)" : ""}`);
  },
});

/**
 * An existing compose file: write down the routes a deploy would pick (auto mode) as x-landfall, and move
 * published ports into the local-only override. Shows what changed; the files stay plain Compose.
 */
function adopt(root: string, file: string, a: NonNullable<ReturnType<typeof detectProject>["analysis"]>) {
  const fixable = (e: string) => / publishes .* on the server/.test(e);
  const errors = a.errors.filter((e) => !fixable(e));
  if (errors.length) fail(`${file}: ${errors.join("; ")}`);
  const overFile = OVERRIDE_FILES.find((f) => fs.existsSync(join(root, f))) ?? "compose.override.yaml";
  const before = fs.readFileSync(join(root, file), "utf8");
  const overBefore = fs.existsSync(join(root, overFile)) ? fs.readFileSync(join(root, overFile), "utf8") : undefined;
  const r = adoptCompose(before, overBefore, a);
  if (!r.routed.length && !r.moved.length) {
    ok(`${file} is ready for lf deploy: nothing to change`);
    for (const w of a.warnings) warn(w);
    return;
  }
  fs.writeFileSync(join(root, file), r.compose);
  showDiff(file, before, r.compose);
  if (r.moved.length) {
    fs.writeFileSync(join(root, overFile), r.override);
    showDiff(overFile, overBefore ?? "", r.override);
  }
  const at = relative(process.cwd(), root) || ".";
  ok(`wrote ${[file, ...(r.moved.length ? [overFile] : [])].join(" and ")} in ${at}`);
  if (r.routed.length) info(`x-landfall on ${r.routed.join(", ")}: the routes a deploy picked without it; change the ports or subdomains as you like`);
  if (r.moved.length) info(`ports of ${r.moved.join(", ")} now in ${overFile}: \`docker compose up\` still publishes them locally, lf deploy leaves them out`);
  for (const n of a.notes) info(c.dim(n));
  for (const w of a.warnings) warn(w);
}


export const eject = defineCommand({
  name: "eject",
  args: "[site]",
  summary: `Write what landfall adds to a site into its project, to run it behind your own Traefik.

  ${EJECT_FILE}   the Traefik labels (logins and allow included), the proxy network and
                         the project name of the running release; with compose.yaml:
                         docker compose -f compose.yaml -f ${EJECT_FILE} up -d

Run it in the site's project folder. Nothing changes on the server: the site keeps running
there, and lf deploy goes on as before.`,
  options: {
    server: serverOpt,
    network: { type: "string", desc: "the Docker network your Traefik watches (default: landfall's)" },
    entrypoint: { type: "string", desc: "your Traefik's HTTPS entrypoint (default: landfall's)" },
    resolver: { type: "string", desc: "your Traefik's certificate resolver (default: landfall's)" },
  },
  async run([n], o) {
    const { site, server, name: serverName } = target(n, o.server);
    const root = process.cwd();
    const file = loadProject(root)?.compose ?? COMPOSE_FILES.find((f) => fs.existsSync(join(root, f)));
    const { meta, proxy } = await requireSite(server, site, { deployed: "eject" });
    if (!file || !fs.existsSync(join(root, file)))
      fail(meta.kind === "compose" ? `no compose file here: run lf eject in the project folder of ${site}` : `${site} runs a compose.yaml landfall generated: write it into this project with lf init first`);
    const release = currentRelease(meta);
    if (!release) return fail(`${site} has no release to eject`);
    const local = Object.keys(localCompose(root, file!)?.services ?? {});
    const missing = release.services.filter((s) => routed(s) && !local.includes(s.name)).map((s) => s.name);
    if (missing.length) warn(`${file} has no service ${missing.join(", ")}, which ${site} routes on ${serverName}: is this its project?`);

    const own = { ...proxy, network: o.network ?? proxy.network, entrypoint: o.entrypoint ?? proxy.entrypoint, resolver: o.resolver ?? proxy.resolver };
    const text = overrideYaml(meta, release, own, { eject: true });
    const path = join(root, EJECT_FILE);
    const before = fs.existsSync(path) ? fs.readFileSync(path, "utf8") : undefined;
    if (before === text) return ok(`${EJECT_FILE} is up to date`);
    showDiff(EJECT_FILE, before ?? "", text);
    if (!(await confirm(before === undefined ? `Write ${EJECT_FILE}?` : `Overwrite ${EJECT_FILE}?`))) return;
    fs.writeFileSync(path, text);
    ok(`wrote ${EJECT_FILE} from release ${release.id} of ${site}`);
    info(`run it:  docker compose -f ${file} -f ${EJECT_FILE} up -d`);
    info(`your Traefik needs the network ${c.bold(own.network)} (docker network create ${own.network}), the entrypoint ${c.bold(own.entrypoint)} and the certificate resolver ${c.bold(own.resolver)}; --network, --entrypoint and --resolver change them`);
    if (meta.kind !== "static") info(`the site's .env: lf env --pull .env${meta.volumes?.length ? `; its data: lf volume pull <volume> (${meta.volumes.join(", ")})` : ""}`);
    if (meta.secrets?.length) info(`its secrets go in ./.secrets: ${meta.secrets.join(", ")}`);
  },
});
