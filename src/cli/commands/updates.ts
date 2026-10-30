import { defineCommand, serverOpt } from "../cmd";
import { resolveServer } from "../../core/config";
import { adminLogin } from "../../core/privilege";
import { engineNotes, engineStatus, imageStatus, pkgStatus, updateCompose, updateImages, upgradePackages, type Engine, type ImageStatus, type PkgStatus } from "../../core/updates";
import { c, confirm, fail, info, ok, step, table, warn, printJson } from "../../core/term";
import { updatesView } from "../../core/views";

const STATE: Record<ImageStatus["state"], (s: string) => string> = {
  current: c.green,
  update: c.yellow,
  unknown: c.dim,
  pinned: c.dim,
  rebuild: c.dim,
  foreign: c.dim,
  missing: c.red,
};

function printPkgs(p: PkgStatus, all: boolean) {
  const sec = p.updates.filter((u) => u.security).length;
  if (p.mgr === "none") return info("packages: no supported package manager");
  const head = p.updates.length
    ? `${c.bold(String(p.updates.length))} package updates${sec ? `, ${c.yellow(`${sec} security`)}` : ""}`
    : c.green("packages up to date");
  console.log(`${head}${p.reboot ? c.yellow(" · reboot required") : ""}${p.refreshed ? "" : c.dim(" (package lists not refreshed)")}`);
  const shown = all ? p.updates : p.updates.slice(0, 15);
  table(shown.map((u) => ["  " + u.name, c.dim(u.from ?? ""), "→ " + u.to, u.security ? c.yellow("security") : ""]));
  if (shown.length < p.updates.length) console.log(c.dim(`  … ${p.updates.length - shown.length} more (--all)`));
}

function printImages(imgs: ImageStatus[]) {
  if (!imgs.length) return;
  console.log(`\n${c.bold("Images")}`);
  table(imgs.map((i) => ["  " + i.name, c.dim(i.ref || "-"), STATE[i.state](i.state === "update" ? "newer image" : i.state), c.dim(i.note ?? "")]));
}

function printEngine(e: Engine) {
  const n = engineNotes(e);
  console.log(`\n${c.bold("Docker")}  ${e.docker ? `${e.docker} · compose ${e.compose || c.red("missing")}` : c.red("not installed")}`);
  for (const t of [n.dockerNote, n.composeNote]) if (t) console.log("  " + c.yellow(t));
  if (!n.dockerNote && !n.composeNote && e.docker) console.log(c.dim("  newest releases"));
}

export const updatesList = defineCommand({
  name: "updates",
  summary: "Show pending OS package updates (security, reboot needed) and newer images for traefik and sites. Changes nothing.",
  options: {
    server: serverOpt,
    refresh: { type: "boolean", desc: "refresh package lists first (apt update; --no-refresh to skip)", default: true },
    all: { type: "boolean", desc: "list every package" },
    json: { type: "boolean", desc: "machine-readable output" },
  },
  async run(_, o) {
    const { name, server } = resolveServer(o.server);
    if (!o.json) step(`checking ${name} for updates${o.refresh ? " (refreshing package lists)" : ""}`);
    const view = await updatesView(server, o.refresh);
    if (o.json) return void printJson(view);
    const { packages, images, engine } = view;
    printPkgs(packages, o.all);
    printEngine(engine);
    printImages(images);
    const s = o.server ? ` -s ${o.server}` : "";
    const n = images.filter((i) => i.state === "update").length;
    if (packages.updates.length || n) console.log(c.dim(`\napply with: lf update${s}`));
    if (engineNotes(engine).composeUpdate) console.log(c.dim(`newest compose: lf update --compose${s}`));
  },
});

export const update = defineCommand({
  name: "update",
  args: "[site...]",
  summary: `Apply updates: OS packages and/or newer images (traefik, image and static sites).

Without --packages/--images both are updated. Package upgrades cannot be undone;
image updates can (\`lf undo\` puts the old image back). --compose replaces the
compose plugin setup installed with the newest release (undoable too).`,
  options: {
    server: serverOpt,
    packages: { type: "boolean", desc: "upgrade OS packages" },
    security: { type: "boolean", desc: "only security updates (apt, dnf/yum); implies --packages" },
    reboot: { type: "boolean", desc: "reboot afterwards if the upgrade needs it" },
    images: { type: "boolean", desc: "pull newer images and recreate their containers" },
    compose: { type: "boolean", desc: "update the compose plugin landfall installed to the newest release" },
  },
  async run(sites, o) {
    const { name, server } = resolveServer(o.server);
    if (o.compose) {
      if (sites.length || o.packages || o.images) fail("--compose goes alone");
      const login = await adminLogin(server, "updating docker compose");
      const e = await engineStatus(login);
      const notes = engineNotes(e);
      if (!notes.composeUpdate) return void (notes.composeNote ? info(notes.composeNote) : ok(`compose ${e.compose} is the newest`));
      if (await confirm(`Update compose ${e.compose} to ${e.latestCompose} on ${name}?`)) {
        step("downloading docker compose");
        await updateCompose(login);
        ok("compose updated (lf undo puts the old one back)");
      }
      return;
    }
    // --security and --reboot are package options: on their own they don't pull images.
    const both = !o.packages && !o.images && !o.security && !o.reboot;
    if (sites.length && o.packages) fail("sites only apply to --images");
    const doPkgs = !sites.length && (o.packages || both || o.security);
    const doImgs = o.images || both || sites.length > 0;

    if (doPkgs) {
      const login = await adminLogin(server, "upgrading packages");
      step(`checking ${name}'s packages`);
      const p = await pkgStatus(login);
      const pick = o.security ? p.updates.filter((u) => u.security) : p.updates;
      if (p.mgr === "none") warn("no supported package manager, skipping packages");
      else if (!pick.length) ok(o.security ? "no security updates" : "packages up to date");
      else {
        printPkgs({ ...p, updates: pick }, false);
        if (o.security && (p.mgr === "apk" || p.mgr === "zypper")) fail(`${p.mgr} has no security-only upgrades here; drop --security`);
        if (await confirm(`Upgrade ${pick.length} package${pick.length === 1 ? "" : "s"} on ${name}?`)) {
          step(`upgrading packages on ${name}`);
          await upgradePackages(login, {
            only: o.security ? pick.map((u) => u.name) : undefined,
            what: o.security ? `${pick.length} security packages` : `${pick.length} packages`,
            reboot: o.reboot,
          });
          ok("packages upgraded");
          if (o.reboot) info("rebooting if required; give it a minute");
        }
      }
    }

    if (doImgs) {
      step("checking images against their registries");
      const imgs = await imageStatus(server);
      if (sites.length) {
        const unknown = sites.filter((s) => !imgs.some((i) => i.name === s));
        if (unknown.length) fail(`no site or service ${unknown.join(", ")} on ${name}`);
      }
      const chosen = sites.length ? imgs.filter((i) => sites.includes(i.name)) : imgs;
      for (const i of chosen.filter((i) => i.state !== "update" && i.state !== "current" && i.state !== "unknown")) {
        info(c.dim(`${i.name}: ${i.note ?? i.state}`));
      }
      // "unknown" (registry gave no digest) is only pulled when asked for by name.
      const todo = chosen.filter((i) => i.state === "update" || (sites.includes(i.name) && i.state === "unknown"));
      if (!todo.length) ok("images up to date");
      else {
        printImages(todo);
        if (await confirm(`Pull and recreate ${todo.map((i) => i.name).join(", ")}?`)) {
          step("updating images");
          await updateImages(server, todo);
          ok("images updated (lf undo puts the old ones back)");
        }
      }
    }
  },
});
