import { render } from "ink";
import { setQuiet } from "../ssh";
import { c } from "../ui";
import { App, type Action, type UiState } from "./app";

const ALT_SCREEN_ON = "\x1b[?1049h\x1b[H";
const ALT_SCREEN_OFF = "\x1b[?1049l";

/**
 * Full-screen dashboard. Commands run inside it (see job.ts); only an
 * interactive shell leaves it for the normal terminal and comes back.
 */
export async function dashboard(run: (argv: string[]) => Promise<number>): Promise<number> {
  const state: UiState = { server: 0, site: 0, focus: "servers", cache: new Map(), connect: new Set() };
  for (;;) {
    let action: Action | undefined;
    setQuiet(true);
    process.stdout.write(ALT_SCREEN_ON);
    try {
      const app = render(<App state={state} onAction={(a) => (action = a)} />, { exitOnCtrlC: false });
      await app.waitUntilExit();
    } finally {
      process.stdout.write(ALT_SCREEN_OFF);
      setQuiet(false);
    }
    if (!action) return 0;

    console.log(c.dim(`$ lf ${action.argv.join(" ")}\n`));
    // Ctrl-C ends the shell, not the dashboard.
    const ignore = () => {};
    process.on("SIGINT", ignore);
    const code = await run(action.argv).finally(() => process.off("SIGINT", ignore));
    if (action.server) state.cache.delete(action.server);
    await anyKey(code === 0 ? c.green("✓ done") : c.red("✗ failed"));
  }
}

function anyKey(status: string): Promise<void> {
  process.stdout.write(`\n${status}  ${c.dim("press any key to go back to the dashboard")}`);
  const { stdin } = process;
  return new Promise((resolve) => {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.once("data", () => {
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
      resolve();
    });
  });
}
