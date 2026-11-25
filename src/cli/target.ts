import { loadProject, projectServer } from "../core/lib/config";
import { fail } from "../core/lib/term";

/** The server of -s, else the one in ./.landfall.json, else the default server. */
export const serverTarget = (o: { server?: string }) => projectServer(o.server);

/** Site + server from args, falling back to ./.landfall.json. */
export function siteTarget(name: string | undefined, server: string | undefined) {
  const site = name ?? loadProject(process.cwd())?.name;
  if (!site) fail("which site? pass a name or run inside a folder with .landfall.json");
  return { site: site!, ...projectServer(server) };
}
