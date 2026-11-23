import { defineCommand, serverOpt } from "../cmd";
import { registries, registryLogin, registryLogout } from "../../core/registries";
import { askSecret, c, fail, info, ok, passwordOption, printJson, step } from "../../core/term";
import { target } from "./system";

const json = { type: "boolean", desc: "machine-readable output" } as const;

export const registryList = defineCommand({
  name: "registries",
  summary: "List the registries the server's docker is logged in to (lf deploy --image pulls private images from them).",
  options: { server: serverOpt, json },
  async run(_, o) {
    const { name, server } = target(o);
    const list = await registries(server);
    if (o.json) return void printJson(list);
    if (!list.length) return void info(c.dim(`docker on ${name} is logged in to no registry: lf registry login <host> -u <user>`));
    for (const r of list) console.log(r);
  },
});

export const registryLoginCmd = defineCommand({
  name: "registry login",
  args: "<host>",
  summary: "Log the server's docker in to a registry (ghcr.io, docker.io, …), so deploys pull private images from it.",
  options: {
    server: serverOpt,
    user: { type: "string", short: "u", desc: "the registry user" },
    password: { type: "string", short: "p", desc: "the password or token (asked in a terminal; visible in ps, prefer --password-stdin)" },
    "password-stdin": { type: "boolean", desc: "read the password or token from stdin" },
  },
  async run([host], o) {
    if (!host) fail("usage: lf registry login <host> -u <user> [--password-stdin]");
    if (!o.user) fail("--user is required: the registry user (for ghcr.io, your GitHub name)");
    const { name, server } = target(o);
    const pw = (await passwordOption(o)) ?? (await askSecret(`password or token for ${o.user}@${host}:`));
    if (!pw) fail("no password given");
    step(`logging docker on ${name} in to ${host}`);
    await registryLogin(server, host, o.user, pw);
    ok(`docker on ${name} pulls from ${host} as ${o.user}`);
  },
});

export const registryLogoutCmd = defineCommand({
  name: "registry logout",
  args: "<host>",
  summary: "Log the server's docker out of a registry and remove the stored credentials.",
  options: { server: serverOpt },
  async run([host], o) {
    if (!host) fail("usage: lf registry logout <host>");
    const { name, server } = target(o);
    await registryLogout(server, host);
    ok(`docker on ${name} is logged out of ${host}`);
  },
});
