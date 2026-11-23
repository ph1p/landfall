import { CliError } from "./term";

/** Private UI → CLI protocol. Values never appear in the child process's argv. */
export const JOB_INPUT = "--landfall-job-input";
export const MAX_JOB_INPUT = 1024 ** 2;
const invalid = () => new CliError("invalid dashboard job input");

export interface JobInput {
  argv: string[];
  /** The login's sudo password, as -K would ask for it: kept out of argv and the environment. */
  sudoPassword?: string;
}

export function encodeJobInput(argv: string[], sudoPassword?: string): string {
  const input = JSON.stringify({ version: 1, argv, ...(sudoPassword && { sudoPassword }) });
  if (Buffer.byteLength(input) > MAX_JOB_INPUT) throw new CliError("dashboard job input is too large");
  return input;
}

export function decodeJobInput(input: string): JobInput {
  if (Buffer.byteLength(input) > MAX_JOB_INPUT) throw invalid();
  let data: unknown;
  try {
    data = JSON.parse(input);
  } catch {
    throw invalid();
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw invalid();
  const { version, argv, sudoPassword } = data as { version?: unknown; argv?: unknown; sudoPassword?: unknown };
  if (version !== 1 || !Array.isArray(argv) || !argv.length || !argv.every((a) => typeof a === "string")) throw invalid();
  if (sudoPassword !== undefined && (typeof sudoPassword !== "string" || !sudoPassword)) throw invalid();
  return { argv, sudoPassword };
}

export async function readJobInput(input: AsyncIterable<Uint8Array> = process.stdin): Promise<JobInput> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    size += chunk.length;
    if (size > MAX_JOB_INPUT) throw invalid();
    chunks.push(Buffer.from(chunk));
  }
  return decodeJobInput(Buffer.concat(chunks).toString("utf8"));
}
