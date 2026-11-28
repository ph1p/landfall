import { defineCommand } from "../cmd";
import { checkInt } from "../../core/lib/config";
import { maskJobArgs, validateJobArgs } from "../job-args";

export const ui = defineCommand({
  name: "ui",
  tenant: true,
  summary: "Web dashboard in your browser: servers, sites, firewall, history, every action.\nRuns on 127.0.0.1 only; the printed link logs the browser in.",
  options: {
    port: { type: "string", short: "p", desc: "port to listen on (default: 4777, else the next free one)" },
    open: { type: "boolean", desc: "open the browser (--no-open to only print the link)", default: true },
  },
  async run(_, o) {
    const { webUi } = await import("../../ui/server/server");
    return webUi({
      port: o.port === undefined ? undefined : checkInt(o.port, "--port", 1, 65535),
      open: o.open,
      args: { validate: validateJobArgs, mask: maskJobArgs },
    });
  },
});
