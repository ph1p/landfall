// lf autodeploy: a cron line runs sites/<name>/autodeploy.sh, which fetches the site's repository, picks the newest
// branch head or tag its rule allows and deploys it like lf deploy would, with no landfall on the server. The script is
// generated from site.json here, so every change to the site (deploy, rollback, scale, weight) writes it again.
import { type AutodeploySetting, COMPOSE_FILES, currentRelease, envComposeFile, OVERRIDE_FILES, type Release, type SiteMeta } from "./compose";
import { fail } from "./fail";
import { safeRemote } from "./git";
import { hookVars, serverCall, skipper } from "./hooks";
import { shq } from "./quote";
import { globRe } from "./refs";
import { CRON_RUNNING, cronChange, cronMinute, dropRelease, noSite, parseSiteMeta, plainWrite, siteDir, siteLines, switchJournal, withSite } from "./remote";
import { DEFAULT_KEEP, type Server } from "./config";
import { ensureTools } from "./privilege";
import { fetchLines, gitEnv, parseGitUrl } from "./remote-git";
import { REMOTE_PATH, runScript, UPDATE, writeFileCmd } from "./ssh";
import { PRELUDE, SITES, type Proxy } from "./templates";
import { LATEST_MIGRATION } from "./migrations";
import { VERSION } from "./version";

export const autodeployMark = (site: string) => `# landfall autodeploy ${site}:`;
export const autodeployPath = (site: string) => `${siteDir(site)}/autodeploy.sh`;
export const autodeployLog = (site: string) => `${siteDir(site)}/autodeploy.log`;

const LOG_LINES = 200;
/** What auto-deploy keeps in the site folder. */
export const AUTODEPLOY_FILES = ["autodeploy.sh", "autodeploy.sha", "autodeploy.log"];

/** "5m", "1h" as a crontab schedule; the minute of an hourly run is spread by site name. */
export function cronSchedule(every: string, site: string): string {
  const m = /^(\d+)(m|h)$/.exec(every);
  const n = m ? Number(m[1]) : 0;
  if (m?.[2] === "m" && n >= 1 && n <= 59) return n === 1 ? "* * * * *" : `*/${n} * * * *`;
  if (m?.[2] === "h" && n >= 1 && n <= 23) return `${cronMinute(site)} ${n === 1 ? "*" : `*/${n}`} * * *`;
  return fail(`--every ${every}: minutes (1m–59m) or hours (1h–23h), e.g. 5m or 1h`);
}

/** The crontab line that runs the script. */
export const cronLine = (site: string, every: string) =>
  `${cronSchedule(every, site)} bash ${autodeployPath(site)} >/dev/null 2>&1 ${autodeployMark(site)} every ${every}`;

/** Globs as one ERE alternation, for grep -E. */
const ere = (globs: string[]) => `^(${globs.map((g) => globRe(g).source.slice(1, -1)).join("|")})$`;

/** Why the site cannot deploy itself, or undefined when it can. */
export function autodeployBlocker(meta: SiteMeta): string | undefined {
  const cur = currentRelease(meta);
  if (meta.adopted) return `${meta.name} is adopted: landfall does not deploy it`;
  if (meta.kind === "static" || meta.kind === "image")
    return `${meta.name} is a ${meta.kind} site: only sites the server builds (compose, Dockerfile) deploy themselves`;
  if (!cur) return `${meta.name} has no release`;
  if (!cur.git?.sha) return `release ${cur.id} of ${meta.name} was not deployed from a git commit (lf deploy --git or --ref)`;
  if (!cur.services.some((s) => s.build)) return `${meta.name} builds no image on the server: nothing a commit changes would deploy`;
}

/**
 * The line that writes autodeploy.sh for meta, when it has auto-deploy; a site that cannot (any more) gets one that says why.
 * One generated file on purpose: most of it is siteLines for this meta, so a static runner beside a data file would still be
 * rewritten by every applySite, as two files instead of one.
 */
export function autodeployLines(meta: SiteMeta, proxy: Proxy): string[] {
  if (!meta.autodeploy) return [];
  const why = autodeployBlocker(meta);
  const log = shq(autodeployLog(meta.name));
  const text = why
    ? [
        "#!/usr/bin/env bash",
        `# Written by landfall ${VERSION}: ${meta.name} cannot deploy itself now. lf autodeploy --off stops it.`,
        `{ cat ${log} 2>/dev/null; printf '== %s (exit 1)\\n%s\\n' "$(date -u +%FT%TZ)" ${shq(why)}; } | tail -n ${LOG_LINES} >${log}.new && mv -f ${log}.new ${log}`,
        "exit 1",
        "",
      ].join("\n")
    : autodeployScript(meta, proxy);
  return [writeFileCmd(autodeployPath(meta.name), text, "700")];
}

/** What the auto release looks like; @@…@@ are filled in by the script. */
function autoRelease(meta: SiteMeta, cur: Release): Release {
  const a = meta.autodeploy!;
  const tags = !!a.rule.tag?.length;
  return {
    ...cur,
    id: "@@ID@@",
    at: "@@AT@@",
    by: "autodeploy",
    landfall: VERSION,
    git: {
      commit: "@@COMMIT@@",
      sha: "@@SHA@@",
      ...(tags ? { tag: "@@REF@@" } : { branch: "@@REF@@" }),
      remote: cur.git?.remote ?? safeRemote(a.url),
      source: "auto",
    },
  };
}

/**
 * sites/<name>/autodeploy.sh for meta as it is now. The deploy lines are siteLines' own, with placeholders the script
 * fills in; a commit that changes the compose files, the environment's layer, package.json or .landfall.json is not
 * deployed (those lines assume the services that run now), only logged.
 */
export function autodeployScript(meta: SiteMeta, proxy: Proxy): string {
  // autodeployLines checked autodeployBlocker: a current release from a git commit.
  const a = meta.autodeploy!;
  const cur = currentRelease(meta)!;
  const g = parseGitUrl(a.url);
  const name = meta.name;
  const dir = siteDir(name);
  const tags = !!a.rule.tag?.length;
  const globs = (tags ? a.rule.tag : a.rule.branch) ?? [];
  const rel = autoRelease(meta, cur);
  const skip = skipper({});
  const vars = { ...hookVars(name, { release: rel, prev: cur }), LANDFALL_DEPLOYMENT_ID: "@@RUN@@" };
  const hooks = {
    release: serverCall(cur.hooks, "release", skip, vars),
    verify: serverCall(cur.hooks, "verify", skip, vars),
    post: serverCall(cur.hooks, "postdeploy", skip, vars),
  };
  const builds = cur.services.filter((s) => s.build).map((s) => s.name.toLowerCase());

  // Undo (lf undo): the release that ran before, as it ran, and the auto release gone.
  const back: SiteMeta = { ...meta, releases: [cur], current: cur.id };
  const undo = [
    `[ -d ${shq(dir)} ] || { log ${shq(`${name} was removed since, nothing to put back`)}; exit 0; }`,
    `[ -d ${shq(`${dir}/releases/${cur.id}`)} ] || { log ${shq(`release ${cur.id} of ${name} was removed since, nothing to go back to`)}; exit 0; }`,
    ...siteLines(back, proxy, {
      write: plainWrite,
      json: [`jq ${shq(`.current = "${cur.id}" | .releases |= map(select(.id != "@@ID@@"))`)} site.json | _put site.json`],
    }),
    ...dropRelease(meta, rel),
  ].join("\n");
  const T = siteLines({ ...meta, releases: [rel], current: rel.id }, proxy, {
    build: true,
    pull: true,
    write: plainWrite,
    json: [`jq --argjson r ${shq(JSON.stringify(rel))} '.releases += [$r] | .current = $r.id | .updatedAt = $r.at' site.json | _put site.json`],
    hooks,
    ...switchJournal(name, `autodeploy ${name} @@REF@@ @@COMMIT@@ release @@ID@@`, shq(undo), true),
  }).join("\n");
  if (T.split("\n").includes("LANDFALL_TEMPLATE")) fail("the deploy lines hold the template's end marker");

  const prefix = a.dir ? `${a.dir}/` : "";
  const watched = [...COMPOSE_FILES, ...OVERRIDE_FILES, ...(a.env ? COMPOSE_FILES.map((f) => envComposeFile(f, a.env)) : []), "package.json", ".landfall.json"];
  const lf = `lf deploy${a.env ? ` -E ${a.env}` : ""}`;
  const pick = tags
    ? `git --git-dir="$M" -c versionsort.suffix=- for-each-ref --sort=-v:refname --format='%(refname:lstrip=2)' refs/tags | grep -E ${shq(ere(globs))}${a.rule.prerelease ? "" : ` | grep -vE '[0-9]+\\.[0-9]+\\.[0-9]+-[0-9A-Za-z.-]+'`} | head -n1 || true`
    : `git --git-dir="$M" for-each-ref --sort=-committerdate --format='%(refname:lstrip=2)' refs/heads | grep -E ${shq(ere(globs))} | head -n1 || true`;

  return [
    "#!/usr/bin/env bash",
    `# Written by landfall ${VERSION} (lf autodeploy): lf rewrites it whenever ${name} changes. Run it by hand with -v.`,
    "set -euo pipefail",
    `export ${REMOTE_PATH}`,
    `export LANDFALL_ACTOR=autodeploy LANDFALL_CLI=${shq(VERSION)} LANDFALL_MIGRATION=${LATEST_MIGRATION} LANDFALL_UPDATE=${shq(UPDATE)}`,
    `export LANDFALL_CMD=${shq(`autodeploy ${name}`)} LANDFALL_RUN="auto-$(date -u +%Y%m%d%H%M%S)-$$"`,
    PRELUDE,
    `D=${shq(dir)}`,
    `NAME=${shq(name)}`,
    `SUB=${shq(a.dir)}`,
    `BASE=${shq(cur.git!.sha!)}`,
    `PREV=${shq(cur.id)}`,
    `LOCK=${shq(`${SITES}/.${name}.deploying`)}`,
    `ID=""`,
    `CAND=""`,
    `REF=""`,
    `IFS= read -r -d '' T <<'LANDFALL_TEMPLATE' || true`,
    T,
    "LANDFALL_TEMPLATE",
    // autodeploy.sha: "<sha> <result> <time> <ref>", the last commit it looked at; it never looks at one twice.
    `seen() { printf '%s %s %s %s\\n' "$CAND" "$1" "$(date -u +%FT%TZ)" "$REF" | _put "$D/autodeploy.sha"; }`,
    "cleanup() {",
    `  rm -rf "$LOCK"`,
    // A release that never made it into site.json (failed before the switch, or put back): its files and images go.
    `  if [ -n "$ID" ] && [ -d "$D/releases/$ID" ] && ! jq -e --arg id "$ID" 'any(.releases[]; .id == $id)' "$D/site.json" >/dev/null 2>&1; then`,
    `    rmf "$D/releases/$ID"`,
    ...builds.map((b) => `    docker image rm "$NAME-${b}:$ID" >/dev/null 2>&1 || true`),
    "  fi",
    "}",
    "main() {",
    // A deploy or change of the site runs: the next run looks again. Never takes over a lock.
    `  mkdir "$LOCK" 2>/dev/null || return 0`,
    `  printf 'autodeploy\\n' >"$LOCK/by"`,
    "  trap cleanup EXIT",
    `  cd "$D"`,
    `  [ -f site.json ] && [ -e current ] || { echo "$NAME has no release to follow" >&2; return 1; }`,
    `  [ "$(basename "$(readlink current)")" = "$PREV" ] || { echo "$NAME changed since autodeploy.sh was written: lf autodeploy -E ${a.env || "<env>"} writes it again" >&2; return 1; }`,
    ...gitEnv(g)
      .split("\n")
      .map((l) => `  ${l}`),
    ...fetchLines(g).map((l) => `  ${l}`),
    "  exec 9>&-",
    `  REF=$(${pick})`,
    `  [ -n "$REF" ] || { log ${shq(`no ${tags ? "tag" : "branch"} matches ${globs.join(", ")}`)}; return 0; }`,
    `  case "$REF" in *[!A-Za-z0-9._/+-]*) log "skipping $REF: lf deploys only names of letters, digits and ._/+-"; return 0 ;; esac`,
    `  CAND=$(git --git-dir="$M" rev-parse --verify -q "refs/${tags ? "tags" : "heads"}/$REF^{commit}")`,
    `  [ "$CAND" != "$(cut -d' ' -f1 autodeploy.sha 2>/dev/null || true)" ] || return 0`,
    `  NOW=$(jq -r '.current as $c | .releases[] | select(.id == $c) | .git.sha // ""' site.json)`,
    `  if [ "$CAND" = "$NOW" ]; then seen running; return 0; fi`,
    ...(tags
      ? [`  if git --git-dir="$M" merge-base --is-ancestor "$CAND" "$NOW" 2>/dev/null; then log "$REF is older than what runs"; seen older; return 0; fi`]
      : []),
    // The deploy lines assume the services that run now: a commit that changes them needs lf deploy.
    `  if ! git --git-dir="$M" cat-file -e "$BASE^{commit}" 2>/dev/null || ! git --git-dir="$M" diff --quiet "$BASE" "$CAND" -- ${watched.map((f) => shq(prefix + f)).join(" ")}; then`,
    `    echo "config changed in $REF (\${CAND:0:12}): run ${lf} --ref $REF" >&2`,
    "    seen skipped-config",
    "    return 0",
    "  fi",
    `  log "deploying $REF (\${CAND:0:12}) to $NAME"`,
    `  ID=$(date -u +%Y%m%d%H%M%S); while [ -e "releases/$ID" ]; do sleep 1; ID=$(date -u +%Y%m%d%H%M%S); done`,
    `  AT=$(date -u +%Y-%m-%dT%H:%M:%S.000Z); COMMIT=\${CAND:0:12}; SHA=$CAND; RUN=$LANDFALL_RUN`,
    `  mkdir -p "releases/$ID"`,
    `  git --git-dir="$M" archive --format=tar "$CAND\${SUB:+:$SUB}" | tar -x -C "releases/$ID"`,
    // The compose files as they run (the guard says they did not change), and what landfall generated or the
    // folder had beside git: the running release has them.
    `  for f in ${[...COMPOSE_FILES, ...OVERRIDE_FILES].map(shq).join(" ")}; do rm -f "releases/$ID/$f"; [ ! -e "releases/$PREV/$f" ] || cp -a "releases/$PREV/$f" "releases/$ID/"; done`,
    `  tracked=$(git --git-dir="$M" ls-tree --name-only "$BASE\${SUB:+:$SUB}")`,
    `  for p in "releases/$PREV"/* "releases/$PREV"/.[!.]* "releases/$PREV"/..?*; do`,
    `    { [ -e "$p" ] || [ -L "$p" ]; } || continue`,
    `    e=\${p##*/}`,
    `    case "$e" in .env|.secrets|.release.json) continue ;; esac`,
    `    { [ ! -e "releases/$ID/$e" ] && [ ! -L "releases/$ID/$e" ]; } || continue`,
    `    printf '%s\\n' "$tracked" | grep -qxF -- "$e" || cp -a "$p" "releases/$ID/"`,
    "  done",
    `  rm -rf "releases/$ID/.env"; ln -sfn ../../.env "releases/$ID/.env"`,
    "  seen deploying",
    `  t=$T`,
    `  for k in ID AT COMMIT SHA REF RUN; do t=\${t//@@$k@@/"\${!k}"}; done`,
    `  eval "$t"`,
    // Like lf deploy: the newest ${DEFAULT_KEEP}, the one that ran before kept for undo.
    `  old=$(jq -r --arg id "$ID" --arg prev "$PREV" '.releases | sort_by(.id) | reverse | to_entries[] | select(.key >= ${DEFAULT_KEEP} and .value.id != $id and .value.id != $prev) | "\\(.value.id) \\([.value.services[]? | select(.build) | .name | ascii_downcase] | join(" "))"' site.json)`,
    `  while read -r id svcs; do`,
    `    case "$id" in ""|*[!0-9]*) continue ;; esac`,
    `    log "removing old release $id of $NAME (keeping ${DEFAULT_KEEP})"`,
    `    for s in $svcs; do docker image rm "$NAME-$s:$id" >/dev/null 2>&1 || true; done`,
    `    rmf "releases/$id"`,
    `    jq --arg id "$id" '.releases |= map(select(.id != $id))' site.json | _put site.json`,
    `  done <<<"$old"`,
    `  docker image prune -f >/dev/null 2>&1 || true`,
    "  seen deployed",
    `  log "$NAME runs $REF (\${CAND:0:12}) as release $ID"`,
    "}",
    `v=""; [ "\${1:-}" != -v ] || v=1`,
    `set +e; out=$( set -e; main 2>&1 ); rc=$?; set -e`,
    `if [ "$rc" != 0 ] && [ -f "$D/autodeploy.sha" ]; then sed 's/ deploying / failed /' "$D/autodeploy.sha" | _put "$D/autodeploy.sha" || true; fi`,
    `if [ -n "$out" ]; then`,
    `  { cat "$D/autodeploy.log" 2>/dev/null || true; printf '== %s %s (exit %s)\\n' "$(date -u +%FT%TZ)" "$LANDFALL_RUN" "$rc"; printf '%s\\n' "$out" | sed "s/$(printf '\\033')\\[[0-9;]*m//g"; } | tail -n ${LOG_LINES} | _put "$D/autodeploy.log" 600 || true`,
    "fi",
    `[ -z "$v" ] || [ -z "$out" ] || printf '%s\\n' "$out" >&2`,
    `exit "$rc"`,
    "",
  ].join("\n");
}

/** The exit code of autodeployNowScript when the server has no such site: the caller says so with noSite. */
export const NOW_NO_SITE = 120;

/** Runs the check once, verbosely: its exit code is the check's. */
export function autodeployNowScript(site: string): string {
  const dir = siteDir(site);
  return [
    `[ -f ${shq(`${dir}/site.json`)} ] || exit ${NOW_NO_SITE}`,
    `[ -f ${shq(autodeployPath(site))} ] || { echo ${shq(`${site} does not deploy itself: turn it on with --every 5m first`)} >&2; exit 1; }`,
    `exec bash ${shq(autodeployPath(site))} -v`,
  ].join("\n");
}

/** Shell that prints what lf autodeploy shows: autodeploy.sha, the log's tail, the cron line, then site.json. */
export function autodeployStatusScript(site: string): string {
  const dir = siteDir(site);
  return [
    `cat ${shq(`${dir}/autodeploy.sha`)} 2>/dev/null || true`,
    "echo @@log",
    `tail -n 50 ${shq(autodeployLog(site))} 2>/dev/null || true`,
    "echo @@cron",
    `crontab -l 2>/dev/null | grep -F ${shq(autodeployMark(site))} || true`,
    "echo @@site",
    `cat ${shq(`${dir}/site.json`)} 2>/dev/null || true`,
  ].join("\n");
}

export interface AutodeployLast {
  sha: string;
  /** running, older, skipped-config, deploying, deployed, failed. */
  result: string;
  at: string;
  ref: string;
}

export interface AutodeployStatus {
  last?: AutodeployLast;
  log: string[];
  /** The crontab line, if there is one. */
  cron?: string;
}

export function parseAutodeployStatus(out: string): AutodeployStatus {
  const [sha = "", log = "", cron = ""] = out.split(/^@@(?:log|cron)$/m);
  const [s, result, at, ref] = sha.trim().split(" ");
  return {
    ...(s && { last: { sha: s, result: result ?? "", at: at ?? "", ref: ref ?? "" } }),
    log: log
      .replace(/^\n|\n$/g, "")
      .split("\n")
      .filter(Boolean),
    ...(cron.trim() && { cron: cron.trim() }),
  };
}

/** What lf autodeploy --json prints and the web UI shows. */
export interface AutodeployView extends AutodeployStatus, Partial<AutodeploySetting> {
  site: string;
  server: string;
  enabled: boolean;
}

export function autodeployView(site: string, server: string, meta: SiteMeta | undefined, status: AutodeployStatus): AutodeployView {
  const a = meta?.autodeploy;
  return {
    site,
    server,
    enabled: !!a,
    ...(a && { env: a.env, every: a.every, rule: a.rule, url: safeRemote(a.url), dir: a.dir }),
    ...status,
  };
}

/** Reads the site's auto-deploy state on the server. */
export async function readAutodeploy(s: Server, server: string, site: string): Promise<AutodeployView> {
  // One round trip: the status and site.json together.
  const { stdout } = await runScript(s, autodeployStatusScript(site), { capture: true });
  const [status, json = ""] = stdout.split(/^@@site$/m);
  const meta = parseSiteMeta(s, site, json) ?? (await noSite(s, site));
  return autodeployView(site, server, meta, parseAutodeployStatus(status));
}

/**
 * Turns auto-deploy on (build returns a setting) or off (no setting): site.json, autodeploy.sh and the crontab line, one journal entry.
 * `on` says ahead of the lock whether git and jq must be there.
 * Turning it on fetches first, so a repository the server cannot read is refused now, not in the log later.
 */
export async function setAutodeploy(
  s: Server,
  name: string,
  on: boolean,
  build: (meta: SiteMeta) => { setting?: AutodeploySetting; what: string } | undefined,
): Promise<SiteMeta | undefined> {
  // Before the lock: installing may ask for the sudo password.
  if (on) await ensureTools(s, [{ cmd: "git" }, { cmd: "jq" }], "for auto-deploy");
  // build() sees the site as read under the lock; nothing to change returns undefined.
  return withSite(s, name, { deployed: "deploy" }, async ({ meta, proxy }) => {
    const change = build(meta);
    if (!change) return undefined;
    const { setting, what } = change;
    meta.autodeploy = setting;
    const why = setting && autodeployBlocker(meta);
    if (why) fail(why);
    meta.updatedAt = new Date().toISOString();
    const line = setting ? cronLine(name, setting.every) : "";
    const cron = cronChange(autodeployMark(name), line, "deploy on its own");
    const g = setting && parseGitUrl(setting.url);
    await runScript(
      s,
      [
        PRELUDE,
        `cd ${shq(siteDir(name))}`,
        ...cron.check,
        ...(g ? [gitEnv(g), ...fetchLines(g), "exec 9>&-"] : []),
        "u1=$(saved site.json) || exit 1",
        "u2=$(saved autodeploy.sh) || exit 1",
        writeFileCmd("site.json", JSON.stringify(meta, null, 2) + "\n"),
        ...(setting ? autodeployLines(meta, proxy) : ["rmf autodeploy.sh"]),
        ...cron.set,
        // Undo puts back site.json, the script and the crontab line that was there (or none).
        `record ${shq(what)} "$u1"${shq("\n")}"$u2"${shq("\n")}${cron.undo}`,
        ...(line ? [`${CRON_RUNNING} || echo 'cron is not running on the server: start it (Alpine: rc-service crond start), or nothing runs' >&2`] : []),
      ].join("\n"),
    );
    return meta;
  });
}
