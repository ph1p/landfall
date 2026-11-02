import fs from "node:fs";
import { updateConfig } from "../../../src/core/config";

const [mode, name] = process.argv.slice(2);
process.send!("ready");
await new Promise<void>((resolve) => process.once("message", () => resolve()));
try {
  await updateConfig((cfg) => {
    if (mode === "hold") {
      process.send!("locked");
      fs.readSync(0, Buffer.alloc(1), 0, 1, null);
      cfg.defaults = { ...cfg.defaults, keep: 7 };
    } else cfg.servers[name] = { host: name };
  });
  process.send!("done", () => process.disconnect!());
} catch (e) {
  console.error(e);
  process.exit(1);
}
