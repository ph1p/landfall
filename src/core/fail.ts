/** An error lf reports as `error: …` and exit 1. No node imports: the web page uses the validators that throw it. */
export class CliError extends Error {}

export const fail = (msg: string): never => {
  throw new CliError(msg);
};
