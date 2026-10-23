import fs from "node:fs";
import { join, relative, resolve } from "node:path";
import { defineCommand } from "../cmd";
import { checkInt } from "../config";
import { detectProject } from "../projects";
import { c, fail, info, ok } from "../ui";

export const init = defineCommand({
  name: "init",
  args: "[dir]",
  summary: `Write a compose.yaml for this project, to run it locally and deploy it.

  compose.yaml           what runs on the server; x-landfall routes a service through Traefik
  compose.override.yaml  local only (docker compose merges it, lf deploy leaves it out):
                         publishes the port on localhost

\`docker compose up\` then runs the site locally, \`lf deploy\` on a server. Existing
files are never overwritten.`,
  options: {
    port: { type: "string", desc: "container port (default: EXPOSE, the saved port or 3000)" },
    postgres: { type: "boolean", desc: "add a Postgres service with a volume; the app gets DATABASE_URL" },
  },
  async run([dirArg], o) {
    const root = resolve(process.cwd(), dirArg ?? ".");
    if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) fail(`${dirArg} is not a folder`);
    const d = detectProject(root);
    if (d.kind === "compose") fail(`${d.compose} exists already: add x-landfall: { port: <port> } to the service Traefik should serve`);
    const files = { "compose.yaml": "", "compose.override.yaml": "" };
    const taken = Object.keys(files).filter((f) => fs.existsSync(join(root, f)));
    if (taken.length) fail(`${taken.join(" and ")} exist already`);

    const port = d.kind === "static" ? 80 : checkInt(o.port ?? d.port ?? 3000, "--port", 1, 65535);
    const local = d.kind === "static" ? 8080 : port;
    const db = !!o.postgres;
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
    restart: unless-stopped
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
}    x-landfall:
      port: ${port}
`;
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

# Survives deploys and rollbacks; \`lf sites rm --volumes\` deletes it.
volumes:
  db:
`
    : ""
}`;
    files["compose.override.yaml"] = `# Local only: docker compose merges this file, lf deploy leaves it out.
services:
  ${svc}:
    ports:
      - "127.0.0.1:${local}:${port}"
`;

    for (const [f, text] of Object.entries(files)) fs.writeFileSync(join(root, f), text);
    const at = relative(process.cwd(), root) || ".";
    ok(`wrote compose.yaml and compose.override.yaml in ${at}`);
    if (db && !fs.existsSync(join(root, ".env"))) info(`locally: put POSTGRES_PASSWORD=… in ${join(at, ".env")} (keep it out of git)`);
    info(`run it:    docker compose up${d.kind === "static" ? "" : " --build"}   → http://localhost:${local}`);
    info(`deploy it: lf deploy${db ? " -e POSTGRES_PASSWORD=<secret>   (the first time)" : ""}`);
  },
});
