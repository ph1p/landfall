import type { Server } from "./config";
import { runScript, shq } from "./ssh";
import { PRELUDE } from "./templates";
import { fail } from "./term";

/** A registry host as `docker login` takes it: ghcr.io, registry.example.com:5000. Docker Hub is docker.io. */
export const checkRegistry = (host: string) => {
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i.test(host)) fail(`${host} is not a registry host (like ghcr.io or registry.example.com:5000)`);
  return host;
};

/** The registry an image ref pulls from: the part before the first / when it has a dot or a port, else docker.io. */
export const registryOf = (image: string) => {
  const first = image.split("/")[0];
  return image.includes("/") && (/[.:]/.test(first) || first === "localhost") ? first : "docker.io";
};

/** The registries the login user's docker is logged in to: the keys of auths and credHelpers in ~/.docker/config.json. */
export async function registries(s: Server): Promise<string[]> {
  const script = [PRELUDE, `cat "\${DOCKER_CONFIG:-$HOME/.docker}/config.json" 2>/dev/null || true`].join("\n");
  const { stdout } = await runScript(s, script, { capture: true });
  return parseRegistries(stdout);
}

export function parseRegistries(text: string): string[] {
  let cfg: any;
  try {
    cfg = JSON.parse(text || "{}");
  } catch {
    return [];
  }
  const hosts = [...Object.keys(cfg?.auths ?? {}), ...Object.keys(cfg?.credHelpers ?? {})].map((h) =>
    h
      .replace(/^https?:\/\//, "")
      .replace(/\/v1\/?$/, "")
      .replace(/^index\.docker\.io$/, "docker.io"),
  );
  return [...new Set(hosts)].sort();
}

/** The registry checked, and how docker login and logout name it: nothing for Docker Hub. */
const loginArg = (host: string) => {
  const reg = checkRegistry(host);
  return { reg, h: reg === "docker.io" ? "" : shq(reg) };
};

/**
 * Log the server's docker in to a registry, so deploys pull private images from it.
 * The password travels in the script's environment on ssh's stdin and reaches docker on its stdin: never in argv or the journal.
 */
export async function registryLogin(s: Server, host: string, user: string, password: string) {
  const { reg, h } = loginArg(host);
  const script = [
    PRELUDE,
    `printf '%s' "$PW" | $DOCKER login ${h} -u "$U" --password-stdin >&2`,
    `record ${shq(`docker logged in to ${reg} as ${user}`)} ${shq(`docker logout ${h}`.trim())}`,
  ].join("\n");
  await runScript(s, script, { env: { U: user, PW: password } });
}

export async function registryLogout(s: Server, host: string) {
  const { reg, h } = loginArg(host);
  const script = [PRELUDE, `$DOCKER logout ${h} >&2`, `record ${shq(`docker logged out of ${reg}`)}`].join("\n");
  await runScript(s, script);
}
