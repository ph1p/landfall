import { currentRelease, projectName, SECRETS_DIR, type Release, type SiteMeta, volumeDir } from "./meta";
import { overrideYaml, splitFile } from "./override";
import { wantedReplicas } from "./scale";
import { hookLines, type HookCall } from "./hooks";
import { siteDir } from "./site";
import { shq, writeFileCmd } from "../ssh/ssh";
import { DYNAMIC_DIR, JOURNAL, OWN_TRAEFIK, PROXY_FILE, type Proxy } from "../ssh/templates";

/** Hooks of one site change, each run in the site's container. */
export interface SiteHooks {
  /** In the running container, before the switch (prerollback). */
  pre?: HookCall;
  /** In a one-off container of the new release, before the switch (release). */
  release?: HookCall;
  /** In the new container once it runs (verify). */
  verify?: HookCall;
  /** In the new container once it runs and was verified; only reports (postdeploy, postrollback). */
  post?: HookCall;
}

// Not the script on stdin: Compose asks there, e.g. to recreate a volume whose configuration changed.
const UP = "dc up -d --wait --wait-timeout 300 --remove-orphans </dev/null";

/** Where a site's traffic splits live for Traefik's file provider. */
export const splitPath = (site: string) => `${DYNAMIC_DIR}/site-${site}.yml`;
export const rmSplit = (site: string) => `[ ! -e ${shq(splitPath(site))} ] || _as ${DYNAMIC_DIR} rm -f ${shq(splitPath(site))}`;

/** Shell that writes the site's traffic splits for Traefik's file provider, or removes them; splits need landfall's own Traefik. */
export function splitLines(meta: SiteMeta, release: Release, write: Writer = writeFileCmd): string[] {
  const path = splitPath(meta.name);
  const text = meta.adopted ? undefined : splitFile(meta, release);
  if (!text) return [rmSplit(meta.name)];
  return [
    `{ [ ! -f ${PROXY_FILE} ] && ${OWN_TRAEFIK}; } || { echo ${shq(`${meta.name} splits its traffic by weight, which needs landfall's own Traefik (its file provider): lf traefik setup, or drop x-landfall.weight`)} >&2; exit 1; }`,
    // Traefik watches the directory and must never read half a file.
    write(path, text),
  ];
}

/**
 * Shell for x-landfall.update: rolling: start the rest first, then per rolling service whose config or image
 * changed, new containers beside the old ones; once they run (and are healthy), the old ones go. Traefik
 * balances over both in between. Nothing for a service with no container yet, or none wanted.
 */
function rollLines(meta: SiteMeta, release: Release, failed: string[] = []): string[] {
  const rolling = release.services.filter((s) => s.update === "rolling");
  if (!rolling.length) return [];
  const others = release.services.filter((s) => s.update !== "rolling").map((s) => shq(s.name));
  const fail = [...failed, "exit 1"];
  const lines = others.length
    ? [
        `log "starting ${meta.name}'s other services before rolling ${rolling.map((s) => s.name).join(", ")}"`,
        `(cd -P current && dc up -d --wait --wait-timeout 300 --no-deps ${others.join(" ")} </dev/null) || { log "${meta.name} did not start:"; (cd -P current && dc ps -a >&2) || true; ${fail.join("; ")}; }`,
      ]
    : [];
  // One call for every rolling service's configuration hash: "<service> <hash>" lines.
  lines.push(`hashes=$(cd -P current && dc config --hash ${shq(rolling.map((s) => s.name).join(","))})`);
  for (const s of rolling) {
    const svc = shq(s.name);
    const want = wantedReplicas(meta, s);
    if (want < 1) continue;
    lines.push(
      `old=$(cd -P current && dc ps -q ${svc}) || old=""`,
      `n=$(printf '%s\n' "$old" | grep -c . || true)`,
      `roll=0`,
      `if [ "$n" -gt 0 ]; then`,
      `  h=$(printf '%s\n' "$hashes" | awk -v s=${svc} '$1 == s {print $2}')`,
      `  ref=$(docker inspect -f '{{.Config.Image}}' $(printf '%s\n' "$old" | head -1))`,
      `  img=$(docker image inspect -f '{{.Id}}' "$ref" 2>/dev/null || true)`,
      // Rolls when any running container has another configuration or image than the release wants.
      `  [ -z "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.config-hash"}} {{.Image}}' $old | grep -vxF "$h $img")" ] || roll=1`,
      `fi`,
      `if [ "$roll" = 1 ]; then`,
      `  log ${shq(`rolling ${s.name}: ${want} new container${want > 1 ? "s" : ""} beside the running ones`)}`,
      `  (cd -P current && dc up -d --no-deps --no-recreate --scale ${svc}=$((n + ${want})) ${svc} </dev/null) || { ${fail.join("; ")}; }`,
      `  new=$(cd -P current && dc ps -q ${svc} | grep -vxF "$old" || true)`,
      `  if ! wait_ready 300 $new; then`,
      `    log ${shq(`${s.name}'s new containers did not get ready; the old ones keep serving:`)}`,
      `    for c in $new; do docker logs --tail 30 "$c" >&2 || true; done`,
      `    docker rm -f $new >/dev/null || true`,
      ...fail.map((l) => `    ${l}`),
      `  fi`,
      // Traefik stops sending to a container once it stops; requests on the way may drop unless the app drains them.
      `  docker stop -t 30 $old >/dev/null && docker rm $old >/dev/null`,
      `fi`,
    );
  }
  return lines;
}

/**
 * Shell that starts the Compose project in `current`, printing its state and logs if it does not come up;
 * then `failed` runs (outside the `||`, where set -e would be ignored) and the script exits 1.
 * `only` limits it to these services (with --no-deps).
 */
const upLines = (name: string, failed: string[] = [], only: string[] = []) => [
  `log "starting ${name}: waits up to 5 minutes for its containers to run (and be healthy, if they have a healthcheck)"`,
  `up=1; (cd -P current && ${only.length ? UP.replace(" </dev/null", ` --no-deps ${only.map(shq).join(" ")} </dev/null`) : UP}) || { up=0; log "${name} did not start:"; (cd -P current && dc ps -a >&2; dc logs --tail 30 >&2) || true; }`,
  `if [ "$up" = 0 ]; then`,
  ...failed,
  `exit 1`,
  `fi`,
];

/** Shell that writes a file: writeFileCmd, or plainWrite where the text must stay readable in the script. */
export type Writer = (path: string, text: string, mode?: string) => string;
/** A Writer with the text in the script as it is (quoted), not base64: autodeploy.sh fills in placeholders in it. */
export const plainWrite: Writer = (path, text, mode) => `printf '%s' ${shq(text)} | _put ${shq(path)}${mode ? ` ${mode}` : ""}`;

export interface SiteLinesOpts {
  env?: string;
  /** Files of the site's folder to write (null: remove), e.g. `.secrets/KEY`; undo puts them back. */
  files?: Record<string, string | null>;
  /** Services to recreate after it starts: what they read from a changed file is not seen otherwise. */
  recreate?: string[];
  /** docker compose build the release's services that build (deploy). */
  build?: boolean;
  /** docker compose pull its images first (deploy). */
  pull?: boolean;
  /** package.json hooks: what fails of pre, release and verify puts the site back like a failed start. */
  hooks?: SiteHooks;
  /** Shell after the build and pull, before anything that changes the running site (journal it). */
  before?: string[];
  /** Shell when it does not start (put the previous release back). */
  failed?: string[];
  /** How files are written (default writeFileCmd). */
  write?: Writer;
  /** Shell that writes site.json, in place of writing meta. */
  json?: string[];
}

/**
 * Shell that writes a site's files for meta.current, points `current` at it and starts it.
 * Until the build and pull are done nothing the running site reads changes: the new .env waits in .env.new.
 */
export function siteLines(meta: SiteMeta, proxy: Proxy, o: SiteLinesOpts = {}): string[] {
  const write = o.write ?? writeFileCmd;
  const dir = siteDir(meta.name);
  const release = currentRelease(meta)!;
  const rel = shq("releases/" + meta.current);
  const project = projectName(meta);
  const lines = [
    `mkdir -p ${shq(dir)} && cd ${shq(dir)}`,
    // Compose finds containers by project name alone: one started elsewhere under the same name would be
    // recreated or removed by this site's 'up --remove-orphans'.
    `here=$(pwd -P)/`,
    `other=$(docker ps -a --filter ${shq(`label=com.docker.compose.project=${project}`)} --format '{{.Label "com.docker.compose.project.working_dir"}}' 2>/dev/null | while read -r d; do case "$d/" in ("$here"*) ;; (*) echo "\${d:-a container without a folder}"; break ;; esac; done || true)`,
    `[ -z "$other" ] || { echo ${shq(`a Compose project named ${project} already runs from`)} "$other:" ${shq(`deploying would replace its containers. Pick another site name, or make it a site with lf adopt ${project}`)} >&2; exit 1; }`,
    o.env !== undefined ? writeFileCmd(".env.new", o.env, "600") : "[ -e .env ] || { touch .env && chmod 600 .env; }",
    // Releases from before .secrets get the link too, so a rollback still finds them.
    ...(meta.adopted
      ? []
      : [`[ -d ${SECRETS_DIR} ] || install -d -m 700 ${SECRETS_DIR}`, `(cd -P ${rel} && ln -sfn ../../${SECRETS_DIR} ${SECRETS_DIR}) || exit 1`]),
    `(cd -P ${rel} && ${write("compose.override.yaml", overrideYaml(meta, release, proxy))}) || { rm -f .env.new; exit 1; }`,
    // The override binds them there: Docker cannot create a volume on a folder that is not.
    ...(meta.adopted ? [] : (meta.volumes ?? []).map((k) => `mkdir -p ${shq(volumeDir(meta.name, k))}`)),
  ];
  // Interpolated with the new .env (the release's .env links the live one).
  const dc = o.env !== undefined ? "dc --env-file ../../.env.new" : "dc";
  const bail = o.env !== undefined ? "{ rm -f .env.new; exit 1; }" : "exit 1";
  if (o.build && release.services.some((s) => s.build)) {
    // Not -q: a build can take minutes, and its steps show it is getting somewhere.
    lines.push(`log "building ${meta.name}"`, `(cd -P ${rel} && ${dc} build --pull) || ${bail}`);
  }
  if (o.pull) lines.push(`log "pulling images of ${meta.name}"`, `(cd -P ${rel} && ${dc} pull --ignore-buildable >&2) || ${bail}`);
  lines.push(
    ...(o.before ?? []),
    ...(o.env !== undefined ? ["mv -f .env.new .env"] : []),
    // Secrets are 644 so a container's non-root user reads them; the folder (700) keeps others on the host out.
    ...Object.entries(o.files ?? {}).map(([f, text]) =>
      text === null ? `rm -f ${shq(f)}` : writeFileCmd(f, text, f.startsWith(`${SECRETS_DIR}/`) ? "644" : "600"),
    ),
  );
  // With the new .env in place, before the switch: what fails goes back like a failed start.
  lines.push(...hookLines(o.hooks?.pre, "exec", "current", o.failed), ...hookLines(o.hooks?.release, "run", rel, o.failed));
  // site.json only now, with the switch: a failed build or pull leaves it naming the release that still runs.
  lines.push(...(o.json ?? [write("site.json", JSON.stringify(meta, null, 2) + "\n")]));
  // Swapped in one rename, so `current` always points at a whole release.
  lines.push(
    `ln -sfn ${rel} current.new && mv -Tf current.new current`,
    ...splitLines(meta, release, write),
    ...rollLines(meta, release, o.failed),
    // After a roll, only the rolling services: rollLines started the others already.
    ...upLines(
      meta.name,
      o.failed,
      release.services.filter((s) => s.update === "rolling").map((s) => s.name),
    ),
  );
  if (o.recreate?.length)
    lines.push(
      `log ${shq(`recreating ${o.recreate.join(", ")}`)}`,
      `if ! (cd -P current && ${UP} --force-recreate --no-deps ${o.recreate.map(shq).join(" ")}); then`,
      ...(o.failed ?? []),
      `exit 1`,
      `fi`,
    );
  lines.push(...hookLines(o.hooks?.verify, "exec", "current", o.failed), ...hookLines(o.hooks?.post, "exec", "current"));
  return lines;
}

/**
 * siteLines' before and failed: journal the switch once built, with `undo` (shell words that make the undo
 * shell) as its undo; a start that fails puts the site back right away (back), or leaves a new site for lf undo.
 */
export function switchJournal(name: string, what: string, undo: string, back: boolean): Pick<SiteLinesOpts, "before" | "failed"> {
  // Journaled once built, before the switch: a site that fails to start is still put back by undo.
  // Its journal line is known only if no one else wrote one in between; then the rollback marks it undone.
  const count = `$(wc -l 2>/dev/null <${JOURNAL} || echo 0)`;
  return {
    before: [`undo=${undo}`, `jn=${count}`, `record ${shq(what)} "$undo"`, `jl=${count}; [ "$((jl))" -eq "$((jn + 1))" ] || jl=""`],
    failed: back
      ? [
          `set +e; ( set -e; eval "$undo" ); rc=$?; set -e`,
          `if [ "$rc" = 0 ]; then [ -z "$jl" ] || _journal undo "$jl" ""; log ${shq(`${name} is back as it was`)}`,
          `else log ${shq(`could not put ${name} back as it was: lf undo`)}; fi`,
        ]
      : [`log ${shq(`lf undo removes ${name}`)}`],
  };
}
