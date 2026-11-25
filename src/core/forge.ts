// gh and glab: the forges' own CLIs, with their own logins. landfall keeps no forge tokens.
import { spawnSync } from "node:child_process";
import type { Forge } from "./refs";

/** The forges' CLIs: how each adds a deploy key and sets or deletes a CI secret, and where their pages are. */
export const FORGES = {
  github: {
    cli: "gh",
    name: "GitHub Actions",
    addKey: (file: string, repo: string, title: string) => ["repo", "deploy-key", "add", file, "-R", repo, "-t", title],
    keyPage: (p: string) => `https://github.com/${p}/settings/keys/new`,
    /** The value comes on stdin. */
    setSecret: (name: string, repo: string, _mask: boolean) => [["secret", "set", name, "-R", repo]],
    deleteSecret: (name: string, repo: string) => ["secret", "delete", name, "-R", repo],
    secretsPage: (p: string) => `https://github.com/${p}/settings/secrets/actions`,
    runsPage: (p: string) => `https://github.com/${p}/actions`,
  },
  gitlab: {
    cli: "glab",
    name: "GitLab CI",
    addKey: (file: string, repo: string, title: string) => ["deploy-key", "add", file, "-R", repo, "-t", title],
    keyPage: (p: string) => `https://gitlab.com/${p}/-/settings/repository#js-deploy-keys-settings`,
    // set fails on a variable that is there already: update it then.
    setSecret: (name: string, repo: string, mask: boolean) =>
      (["set", "update"] as const).map((verb) => ["variable", verb, name, "-R", repo, ...(mask ? ["--masked"] : [])]),
    deleteSecret: (name: string, repo: string) => ["variable", "delete", name, "-R", repo],
    secretsPage: (p: string) => `https://gitlab.com/${p}/-/settings/ci_cd#js-cicd-variables-settings`,
    runsPage: (p: string) => `https://gitlab.com/${p}/-/pipelines`,
  },
} as const satisfies Record<Forge, unknown>;

/** gh or glab, installed and logged in. */
export const loggedIn = (cli: string) => spawnSync(cli, ["auth", "status"], { stdio: "ignore" }).status === 0;
