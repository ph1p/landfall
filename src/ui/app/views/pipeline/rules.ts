import { S, tilde } from "../../lib/store";
import { goPipeline, loadGit } from "../../lib/api";
import { run } from "../../lib/jobs";
import { dialog, words, type Spec, type Values } from "../../ui/dialog";
import { ENVIRONMENT_NAME, hasRule, list, one, overlaps, refMatches, sameRule, type RefRule } from "../../../../core/deploy/refs";
import { envArgs, envLabel } from "./env";
import { refresh } from "./pipeline";
import { orderRefs } from "./ref-picker";

const ruleOf = (v: Values, i: number): RefRule | undefined => {
  const branch = words(v[`b${i}`] ?? "");
  const tag = words(v[`t${i}`] ?? "");
  if (!branch.length && !tag.length) return undefined;
  return {
    ...(branch.length && { branch: one(branch) }),
    ...(tag.length && { tag: one(tag) }),
    ...(v[`p${i}`] && { prerelease: true }),
    ...(v[`c${i}`] && { requireClean: true }),
  };
};

/** lf git track for one environment: its new rule, or --off. */
function trackArgv(env: string, rule: RefRule | undefined): string[] {
  if (!rule) return ["git", "track", ...envArgs(env), "--off"];
  return [
    "git",
    "track",
    ...envArgs(env),
    ...list(rule.branch).flatMap((b) => ["--branch", b]),
    ...list(rule.tag).flatMap((t) => ["--tag", t]),
    rule.prerelease ? "--prerelease" : "--no-prerelease",
    rule.requireClean ? "--require-clean" : "--no-require-clean",
  ];
}

/** Runs the jobs one after another: each writes the same .landfall.json. */
export function chain(path: string, jobs: string[][]) {
  const [first, ...rest] = jobs;
  if (!first) return;
  run(first, {
    cwd: path,
    after: (j) => {
      if (j.info.code !== 0) return;
      if (rest.length) chain(path, rest);
      else refresh(path);
    },
  });
}

/** Which branches and tags each environment deploys: one row per environment, written with lf git track. */
export async function rulesEditor(path: string) {
  // A fresh read: the rules may have changed since the page loaded.
  const before = S.git[path]?.data;
  const info = (await loadGit(path, true)) ?? before;
  const rules = info?.rules ?? {};
  const refs = info?.refs ?? [];
  const envs = Object.keys(rules);
  if (!envs.includes("")) envs.unshift("");
  const ADD = envs.length;
  const rulesFrom = (v: Values) => {
    const out: Record<string, RefRule | undefined> = {};
    envs.forEach((e, i) => (out[e] = ruleOf(v, i)));
    if (v.newName?.trim()) out[v.newName.trim()] = ruleOf(v, ADD);
    return out;
  };
  const previewOf = (i: number, env: (v: Values) => string) => (v: Values) => {
    const rule = ruleOf(v, i);
    if (!rule) return "deploys anything";
    const hits = orderRefs(refs, rule).filter((r) => refMatches(rule, r));
    const all = rulesFrom(v);
    const clash = overlaps(all, hits)
      .filter((x) => x.includes(env(v)))
      .flat()
      .filter((x) => x !== env(v));
    const names = hits.slice(0, 4).map((r) => r.name);
    const more = hits.length > 4 ? ` and ${hits.length - 4} more` : "";
    const head = hits.length ? `matches ${names.join(", ")}${more}` : "matches nothing here yet";
    return clash.length ? `${head}  ⚠ overlaps ${[...new Set(clash)].map(envLabel).join(", ")}: --for-ref cannot pick` : head;
  };
  const rowFor = (i: number, rule: RefRule | undefined, env: (v: Values) => string, when?: (v: Values) => unknown): Spec[] => [
    {
      row: [
        {
          name: `b${i}`,
          label: "Branches",
          value: list(rule?.branch).join(", "),
          mono: true,
          placeholder: "main, release/*",
          suggest: refs.filter((r) => r.kind === "branch").map((r) => r.name),
        },
        { name: `t${i}`, label: "Tags", value: list(rule?.tag).join(", "), mono: true, placeholder: "v*", preview: previewOf(i, env) },
      ],
      when,
    },
    { name: `p${i}`, type: "check", label: "Pre-release tags (v1.2.0-rc.1) too", value: !!rule?.prerelease, off: (v) => !words(v[`t${i}`] ?? "").length },
    { name: `c${i}`, type: "check", label: "Only a clean working tree: refuse uncommitted changes", value: !!rule?.requireClean, off: (v) => !ruleOf(v, i) },
  ];
  dialog({
    title: "Git deploys",
    text: `Which branches or tags each environment of ${tilde(path)} deploys, in .landfall.json. A deploy of something else is refused. Empty: it deploys anything. Globs: * stays within a /, ** crosses it.`,
    fields: [
      ...envs.map((env, i) => ({
        legend: env ? `Environment ${env}` : envs.length > 1 ? "The project (no -E)" : "The project",
        fields: rowFor(i, rules[env], () => env),
      })),
      {
        legend: "Add an environment",
        collapsed: true,
        note: "A new environment in .landfall.json (lf git track -E <name>). Give it a site name with lf deploy -E <name> -n <site>.",
        fields: [
          {
            name: "newName",
            label: "Name",
            placeholder: "staging",
            check: (x: string) => x && (!ENVIRONMENT_NAME.test(x) ? "Lowercase letters, digits and dashes" : envs.includes(x) && `${x} is listed above`),
          },
          ...rowFor(ADD, undefined, (v) => String(v.newName ?? "").trim()),
        ],
      },
    ],
    ok: "Save",
    onOk: (v) => {
      const jobs: string[][] = [];
      envs.forEach((env, i) => {
        const next = ruleOf(v, i);
        if (!sameRule(next, hasRule(rules[env]) ? rules[env] : undefined)) jobs.push(trackArgv(env, next));
      });
      const add = v.newName?.trim();
      if (add) {
        const rule = ruleOf(v, ADD);
        if (!rule) return { field: `b${ADD}`, error: `Say what ${add} deploys: a branch or a tag` };
        jobs.push(trackArgv(add, rule));
      }
      if (!jobs.length) return;
      chain(path, jobs);
      if (add || envs.some((e, i) => !hasRule(rules[e]) && ruleOf(v, i))) goPipeline(path);
    },
  });
}
