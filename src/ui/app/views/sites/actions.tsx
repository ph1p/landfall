import { S, sv, tilde } from "../../lib/store";
import type { Release, SiteStatus } from "../../lib/types";
import { run } from "../../lib/jobs";
import { MenuBtn } from "../../ui/menu";
import { confirmDlg, dialog } from "../../ui/dialog";
import { ROLLBACK_HOOKS } from "../../../../core/site/hook-names";
import { MAX_REPLICAS, MAX_WEIGHT } from "../../../../core/site/limits";
import { hookChoice } from "../hooks";
import { isUp } from "../shared";

const liveRelease = (site: SiteStatus) => site.meta.releases.find((r) => r.id === site.meta.current);

// Hooks a rollback runs: the leaving release's prerollback, the reached one's postrollback.
export function rollbackDialog(
  n: string,
  site: SiteStatus,
  { to, argv = [], ...d }: { to: Release; argv?: string[]; title: string; text: string; ok: string },
) {
  const hooks = hookChoice({ prerollback: liveRelease(site)?.hooks?.run.prerollback, postrollback: to.hooks?.run.postrollback }, ROLLBACK_HOOKS, "rollback");
  dialog({ ...d, fields: hooks.fields, onOk: (v) => run(["rollback", site.meta.name, ...sv(n), ...argv, "-y", ...hooks.skip(v)]) });
}

export function deleteSiteDialog(n: string, site: SiteStatus) {
  const { meta: m } = site;
  const name = m.name;
  const destroyHooks = hookChoice(liveRelease(site)?.hooks?.run, ["predestroy"], "sites rm", "The live release's predestroy hook runs before anything goes.");
  dialog({
    title: m.adopted ? `Stop and forget ${name}?` : `Delete ${name} from ${n}?`,
    text: m.adopted
      ? `Runs docker compose down in ${m.adopted}; its files and volumes stay.`
      : "Stops it and removes its files and releases. Its named volumes (databases, uploads) stay unless you delete them too.\nIts files and releases cannot be brought back.",
    fields: m.adopted
      ? []
      : [
          {
            name: "volumes",
            type: "check",
            label: "Also delete its volumes",
            hint: "Databases, uploads: all its data. Each is backed up to the site's backups folder first; lf undo brings them back. lf sites rm --volumes",
          },
          ...destroyHooks.fields,
        ],
    ok: m.adopted ? `Forget ${name}` : `Delete ${name}`,
    danger: true,
    typeToConfirm: m.adopted ? "" : name,
    onOk: (v) => run(["sites", "rm", name, ...sv(n), "-y", ...(v.volumes ? ["--volumes"] : []), ...destroyHooks.skip(v)]),
  });
}

// Empty fields keep what the site runs behind now: landfall's Traefik, or the one it uses.
export function ejectDialog(n: string, name: string, path: string) {
  const proxy = S.overview[n]?.data?.proxy;
  const own = S.state.ownProxy;
  const now = !proxy || proxy === own.container ? own : undefined;
  const as = (k: "network" | "entrypoint" | "resolver") => now?.[k] ?? `as ${proxy} has it`;
  dialog({
    title: `Eject ${name}`,
    text: `Writes compose.traefik.yaml into ${tilde(path)}: the Traefik labels, network and project name of its running release, to run it with docker compose behind your own Traefik. Nothing changes on ${n}; an existing compose.traefik.yaml is overwritten.`,
    fields: [
      { name: "network", label: "Docker network your Traefik watches", placeholder: as("network"), mono: true },
      {
        row: [
          { name: "entrypoint", label: "HTTPS entrypoint", placeholder: as("entrypoint"), mono: true },
          { name: "resolver", label: "Certificate resolver", placeholder: as("resolver"), mono: true },
        ],
      },
    ],
    ok: "Write it",
    onOk: (v) =>
      run(["eject", name, ...sv(n), "-y", ...(["network", "entrypoint", "resolver"] as const).flatMap((k) => (v[k] ? [`--${k}`, String(v[k]).trim()] : []))], {
        server: n,
        cwd: path,
      }),
  });
}

export function stopDialog(n: string, site: SiteStatus) {
  const name = site.meta.name;
  confirmDlg({
    title: `Stop ${name}?`,
    text: `${site.domains.join(", ") || "The site"} stops answering until you start it again.`,
    ok: "Stop it",
    danger: true,
    onOk: () => run(["stop", name, ...sv(n)]),
  });
}

// Replicas: the count lf scale stores, written into compose.override.yaml; "default" goes back to compose.yaml's.
function scaleDialog(n: string, site: SiteStatus, svc: string) {
  const name = site.meta.name;
  const r = site.scale?.[svc];
  dialog({
    title: `Scale ${svc} of ${name}`,
    text: "Containers of it that run behind the load balancer. Changing the count starts or stops containers; running ones are not recreated.",
    fields: [
      {
        name: "n",
        label: "Replicas",
        type: "number",
        value: String(r?.replicas ?? (site.services.filter((x) => x.service === svc).length || 1)),
        required: true,
        check: (v) => (!/^\d+$/.test(v) || +v > MAX_REPLICAS) && `A number from 0 to ${MAX_REPLICAS}`,
        hint: r?.source === "lf scale" ? "Set with lf scale. Clear it to go back to compose.yaml." : "",
      },
      ...(r?.source === "lf scale" ? [{ name: "reset", type: "check" as const, label: "Use compose.yaml's count again" }] : []),
    ],
    ok: "Scale",
    onOk: (v) => run(["scale", name, `${svc}=${v.reset ? "default" : String(v.n).trim()}`, ...sv(n), "-y"]),
  });
}

// Weights of a split's services: Traefik sends each the share weight / sum.
function splitDialog(n: string, site: SiteStatus, group: string) {
  const name = site.meta.name;
  const members = Object.entries(site.scale ?? {}).filter(([, r]) => r.split === group);
  dialog({
    title: `Traffic split of ${name}`,
    text: "Each service gets its weight's share of the requests. 0 sends it none. Only the routing changes: no container restarts.",
    fields: members.map(([svc, r]) => ({
      name: svc,
      label: svc,
      type: "number" as const,
      value: String(r.weight ?? 0),
      required: true,
      check: (v: string) => (!/^\d+$/.test(v) || +v > MAX_WEIGHT) && `A number from 0 to ${MAX_WEIGHT}`,
    })),
    ok: "Save",
    onOk: (v) => run(["weight", name, ...members.map(([svc]) => `${svc}=${String(v[svc]).trim()}`), ...sv(n), "-y"]),
  });
}

export function ServiceMenu({ n, site, x }: { n: string; site: SiteStatus; x: SiteStatus["services"][number] }) {
  const name = site.meta.name;
  const managed = !site.meta.adopted;
  const split = site.scale?.[x.service]?.split;
  return (
    <MenuBtn
      title={`${x.service} of ${name}`}
      cls="sm ghost"
      items={[
        { label: "Logs", hint: `lf logs ${name} ${x.service}`, run: () => run(["logs", name, x.service, ...sv(n), "-f"]) },
        { label: "Restart", hint: "lf restart", run: () => run(["restart", name, x.service, ...sv(n)]) },
        isUp(x.status)
          ? {
              label: "Stop",
              hint: "lf stop",
              run: () =>
                confirmDlg({
                  title: `Stop ${x.service} of ${name}?`,
                  text: "It stays stopped until you start it again.",
                  ok: "Stop it",
                  danger: true,
                  onOk: () => run(["stop", name, x.service, ...sv(n)]),
                }),
            }
          : { label: "Start", hint: "lf start", run: () => run(["start", name, x.service, ...sv(n)]) },
        managed && "-",
        managed && {
          label: "Scale…",
          hint: "lf scale",
          title: "How many containers of it run behind the load balancer",
          run: () => scaleDialog(n, site, x.service),
        },
        managed && split && { label: "Traffic split…", hint: "lf weight", run: () => splitDialog(n, site, split) },
      ]}
    />
  );
}
