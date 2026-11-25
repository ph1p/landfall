import { tokenize } from "./cmd";
import { find } from "./registry";
import { CliError } from "../core/lib/term";

/** Never return parser errors here: Node's error text can include the rejected value. */
function jobArgs(argv: string[]) {
  const found = find(argv);
  if (!found.cmd || ["ui", "plugin add", "plugin rm", "plugin new"].includes(found.cmd.name))
    throw new CliError("invalid dashboard command; use a supported CLI command");
  try {
    return { ...found, cmd: found.cmd, parsed: tokenize(found.cmd, found.rest) };
  } catch {
    throw new CliError("invalid dashboard command arguments; check the command's --help");
  }
}

/** The envelope owns stdin. A local dotenv filename still works; direct terminal stdin is unchanged. */
export function validateJobArgs(argv: string[]) {
  const { parsed } = jobArgs(argv);
  if (parsed.values.dotenv === "-" || parsed.values["password-stdin"] === true) {
    throw new CliError("dashboard jobs cannot read command stdin; use a dotenv filename or the dashboard's password/value fields");
  }
}

/** Display only. Spawning uses a blanket-safe private envelope, not this classification. */
export function maskJobArgs(argv: string[]): string[] {
  try {
    const { cmd, prefix, parsed } = jobArgs(argv);
    const out = [...argv];
    const userinfo = (value: string) => value.replace(/(:\/\/)[^/@\s]+@/, "$1***@");
    const pair = (value: string) => (value.includes("=") ? value.slice(0, value.indexOf("=")) + "=***" : "***");
    for (const token of parsed.tokens) {
      const index = prefix + token.index;
      if (token.kind === "positional") {
        if ((cmd.name === "env" || cmd.name === "secret") && token.value.includes("=")) out[index] = pair(token.value);
      } else if (token.kind === "option" && token.value !== undefined) {
        const password = /(^|-)password$/.test(token.name);
        const env = cmd.name === "deploy" && token.name === "env";
        const masked = password ? "***" : env ? pair(token.value) : userinfo(token.value);
        if (masked === token.value) continue;
        if (token.inlineValue) {
          // An attached short value may share its argv slot with boolean short flags.
          const original = out[index];
          out[index] = original.slice(0, original.length - token.value.length) + masked;
        } else out[index + 1] = masked;
      }
    }
    return out;
  } catch {
    return ["[invalid command arguments hidden]"];
  }
}
