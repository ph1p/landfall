import type { ReactNode } from "react";
import { S, plural, render, sv, type Any } from "../lib/store";
import { fetchInto, load } from "../lib/api";
import { run } from "../lib/jobs";
import { confirmDlg } from "../ui/dialog";
import { Actions, Badge, Body, Btn, Card, CardHead, Kv, Sub, pending, cx, ACTS, HIDE, Table } from "../ui/kit";
import { can } from "./shared";

// ---- updates ---------------------------------------------------------------

const IMG: Record<string, [string, string]> = { current: ["ok", "up to date"], update: ["warn", "newer image"], unknown: ["", "unknown"], pinned: ["", "pinned"], rebuild: ["", "rebuild"], foreign: ["", "not landfall's"], missing: ["bad", "missing"] };

/** The count of waiting updates for the section button, with its leading space; null when there are none. */
export function updatesBadge(n: string): ReactNode | null {
  const d = S.updates[n]?.data;
  if (!d) return null;
  const k = d.packages.updates.length + d.images.filter((i: Any) => i.state === "update").length;
  const sec = d.packages.updates.some((u: Any) => u.security);
  return k ? <>{" "}<Badge kind={sec ? "warn" : ""}>{k}</Badge></> : null;
}

export function refreshUpdates(n: string) {
  // Drops what is shown, for the refreshing spinner.
  S.updates[n] = { refreshing: true } as Any;
  fetchInto("updates", n, "/updates?refresh=1");
  render();
}

/** "24.0.2 → 29.9.2 · how to get it", or "· newest" when it is (and the newest is known). */
const EngineLine = ({ have, latest, old, how }: { have: string; latest?: string; old?: string; how?: string }) => (
  <>
    <span className="mono">{have}</span>
    {old ? (
      <>
        {" "}<span className="dim">→</span> <span className="mono">{latest}</span>
        {how && <span className="faint"> · {how}</span>}
      </>
    ) : latest ? (
      <span className="faint"> · newest</span>
    ) : null}
  </>
);

/** Package upgrades, the Docker engine and compose, and the images of Traefik and the sites. */
export function UpdatesView({ n }: { n: string }) {
  const st = S.updates[n] as Any;
  const wait = pending(st, st?.refreshing ? "refreshing package lists…" : "checking packages and images…", () => load(n, "updates", true));
  if (wait) return wait;
  const { packages: p, images, engine: e } = st.data;
  const s = sv(n);
  const sec = p.updates.filter((u: Any) => u.security);
  const upgrade = (flags: string[], what: string, k: number) =>
    confirmDlg({
      title: `Upgrade ${what} on ${n}?`,
      text: `${plural(k, "package")} through ${p.mgr}, as root. Package upgrades cannot be undone.${flags.includes("--reboot") ? "\nReboots afterwards if the upgrade needs it: sites are offline for a minute or two." : ""}`,
      ok: "Upgrade",
      danger: flags.includes("--reboot"),
      onOk: () => run(["update", "--packages", ...flags, ...s, "-y"], { server: n }),
    });
  // Package upgrades need a package manager and root (the CLI's can.packages).
  const pkgOk = p.mgr !== "none" && (can(n)?.packages ?? true);
  const shown = p.updates.slice(0, 200);
  const imgUpdates = images.filter((i: Any) => i.state === "update");
  const updImg = (names: string[]) =>
    confirmDlg({
      title: `Update ${names.join(", ")}?`,
      text: "Pulls the newer image and recreates the container (a few seconds offline). Undo puts the old image back.",
      ok: "Update",
      onOk: () => run(["update", ...names, "--images", ...s, "-y"], { server: n }),
    });
  const head = p.updates.length ? (
    <>
      <Badge>{p.updates.length}</Badge>
      {sec.length > 0 && <Badge kind="warn">{sec.length} security</Badge>}
    </>
  ) : (
    <Badge kind="ok">up to date</Badge>
  );
  return (
    <>
      {p.mgr !== "none" && (
        <Card>
          <CardHead>
            Packages {head}
            {p.reboot && <Badge kind="warn">reboot required</Badge>}
            <Sub className={HIDE}>{p.mgr}{p.refreshed ? "" : " · lists not refreshed"}</Sub>
            <Actions>
              {pkgOk && (
                <>
                  <Btn cls="sm" title="Fetch the newest package lists first (apt update)" on={() => refreshUpdates(n)}>Refresh lists</Btn>
                  {sec.length > 0 && p.mgr !== "apk" && <Btn cls="sm" on={() => upgrade(["--security"], "security updates", sec.length)}>Security only ({sec.length})</Btn>}
                  {p.updates.length > 0 && <Btn cls="sm primary" on={() => upgrade([], "all packages", p.updates.length)}>Upgrade all</Btn>}
                  {p.updates.length > 0 && <Btn cls="sm danger" on={() => upgrade(["--reboot"], "all packages", p.updates.length)}>Upgrade + reboot</Btn>}
                </>
              )}
            </Actions>
          </CardHead>
          {shown.length > 0 && (
            <Table head={<><th>Package</th><th className={HIDE}>Installed</th><th>New</th><th></th></>}>
              {shown.map((u: Any) => (
                <tr key={u.name}>
                  <td className="mono">{u.name}</td>
                  <td className={cx("mono dim", HIDE)}>{u.from ?? ""}</td>
                  <td className="mono">{u.to}</td>
                  <td>{u.security && <Badge kind="warn">security</Badge>}</td>
                </tr>
              ))}
              {p.updates.length > shown.length && <tr><td colSpan={4} className="dim">… {p.updates.length - shown.length} more</td></tr>}
            </Table>
          )}
          {!pkgOk && <p className="dim">{S.facts[n]?.data?.why?.packages ?? ""}</p>}
        </Card>
      )}
      {!e.docker && can(n) && !can(n).docker ? null : (
        <>
          <Card>
            <CardHead>
              Docker{" "}
              <Badge kind={!e.docker || e.dockerNote || e.composeNote ? "warn" : "ok"}>{!e.docker ? "not installed" : e.dockerNote || e.composeNote ? "update available" : "up to date"}</Badge>
              <Actions>{e.composeUpdate && <Btn cls="sm primary" on={() => run(["update", "--compose", ...s, "-y"], { server: n })}>Update compose</Btn>}</Actions>
            </CardHead>
            {e.docker && (
              <Body>
                <Kv
                  pairs={[
                    ["Docker", <EngineLine have={e.docker} latest={e.latestDocker} old={e.dockerNote} how={e.dockerHow} />],
                    ["Compose", e.compose ? <EngineLine have={e.compose} latest={e.latestCompose} old={e.composeNote} how={e.composeHow} /> : <><Badge kind="warn">missing</Badge> <span className="faint">lf setup installs it</span></>],
                  ]}
                />
              </Body>
            )}
          </Card>
          <Card>
            <CardHead>
              Images <Sub>Traefik and sites</Sub>
              <Actions>{imgUpdates.length > 0 && <Btn cls="sm primary" on={() => updImg(imgUpdates.map((i: Any) => i.name))}>Update all ({imgUpdates.length})</Btn>}</Actions>
            </CardHead>
            <Table head={<><th>Name</th><th className={HIDE}>Image</th><th>State</th><th className={HIDE}>Note</th><th></th></>}>
              {images.length ? (
                images.map((i: Any) => {
                  const [cls, label] = IMG[i.state] ?? ["", i.state];
                  const pullable = i.state === "update" || i.state === "unknown";
                  return (
                    <tr key={i.name}>
                      <td><b>{i.name}</b> <span className="faint">{i.kind}</span></td>
                      <td className={cx("mono dim", HIDE)}>{i.ref || "-"}</td>
                      <td><Badge kind={cls}>{label}</Badge></td>
                      <td className={cx("dim", HIDE)}>{i.note ?? ""}</td>
                      <td className={ACTS}>{pullable && <Btn cls={i.state === "update" ? "sm primary" : "sm"} on={() => updImg([i.name])}>{i.state === "update" ? "Update" : "Pull anyway"}</Btn>}</td>
                    </tr>
                  );
                })
              ) : (
                <tr><td colSpan={5} className="dim">no containers</td></tr>
              )}
            </Table>
          </Card>
        </>
      )}
    </>
  );
}
