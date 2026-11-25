import type { Detected } from "../../lib/types";
import { words, portError, type Spec, type Values } from "../../ui/dialog";

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
  const volumes = det.volumes ?? [];
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
