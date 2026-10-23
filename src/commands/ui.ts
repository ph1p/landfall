import { defineCommand } from "../cmd";

export const ui = defineCommand({
  name: "ui",
  summary: "Web dashboard in your browser: servers, sites, firewall, history, every action.\nRuns on 127.0.0.1 only; the printed link logs the browser in.",
  options: {
    port: { type: "string", short: "p", desc: "port to listen on", default: "4777" },
    open: { type: "boolean", desc: "open the browser (--no-open to only print the link)", default: true },
  },
  async run(_, o) {
    const { webUi } = await import("../web/server");
    return webUi({ port: Number(o.port) || 4777, open: o.open });
  },
});
