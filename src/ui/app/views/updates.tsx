import type { ReactNode } from "react";
import { S, errorMessage, http, plural, render, sv } from "../lib/store";
import { fetchInto, load } from "../lib/api";
import { ifOk, run } from "../lib/jobs";
import { confirmDlg } from "../ui/dialog";
import { Actions, Badge, Body, Btn, Card, CardHead, Kv, Spin, Sub, pending, waiting, cx, ACTS, HIDE, MONO, NUM, Table } from "../ui/kit";
import type { ImageScan, Severity, TrivyState } from "../lib/types";
import { toast } from "../ui/toast";
import { can, size } from "./shared";

// ---- updates ---------------------------------------------------------------

const IMG: Record<string, [string, string]> = { current: ["ok", "up to date"], update: ["warn", "newer image"], unknown: ["", "unknown"], pinned: ["", "pinned"], rebuild: ["", "rebuild"], foreign: ["", "not landfall's"], missing: ["bad", "missing"] };

const SEV: [Severity, string, string][] = [["CRITICAL", "bad", "critical"], ["HIGH", "warn", "high"], ["MEDIUM", "", "medium"], ["LOW", "", "low"]];
// Images whose vulnerabilities are listed.
const shownScans = new Set<string>();
// Servers whose scan includes the containers landfall did not deploy.
const scanOthers = new Set<string>();
// What Trivy keeps on each server, once asked; servers being asked.
const trivy = new Map<string, TrivyState>();
const asking = new Set<string>();
const loadTrivy = (n: string) => http<TrivyState>(`/api/servers/${encodeURIComponent(n)}/trivy`).then((t) => (trivy.set(n, t), render(), t));
// Shown as scanning at once: a scan takes a minute or more, and the click must answer now.
const scan = (n: string, install = false) => {
  const q = [scanOthers.has(n) && "others=1", install && "install=1"].filter(Boolean).join("&");
  void fetchInto("scan", n, "/scan" + (q && "?" + q)).then(() => void (install && loadTrivy(n).catch(() => {})));
  render();
};
const there = (t: TrivyState) => t.image !== undefined || t.cache !== undefined;
/** The first scan: Trivy is downloaded onto the server only once the user agrees. */
const firstScan = (n: string) => {
  asking.add(n);
  render();
  loadTrivy(n).then(
    (t) =>
      there(t)
        ? scan(n)
        : confirmDlg({
            title: `Install Trivy on ${n}?`,
            text: "Scanning runs Trivy on the server. It downloads its image (~190 MB) and its vulnerability databases (several GB, in the volume landfall-trivy), and keeps them for the next scans.\nRemove Trivy (or lf scan --remove) deletes them again.",
            ok: "Install and scan",
            onOk: () => scan(n, true),
          }),
    (e) => toast(errorMessage(e)),
  ).finally(() => (asking.delete(n), render()));
};
const removeTrivy = (n: string) =>
  confirmDlg({
    title: `Remove Trivy from ${n}?`,
    text: `Deletes Trivy's image and its vulnerability databases${trivy.get(n) ? ` (${size((trivy.get(n)!.image ?? 0) + (trivy.get(n)!.cache ?? 0))})` : ""}. The next scan asks to download them again.`,
    ok: "Remove",
    danger: true,
    onOk: () => run(["scan", "--remove", ...sv(n), "-y"], { server: n, after: ifOk(() => (delete S.scan[n], trivy.delete(n), render())) }),
  });

/** lf scan: what Trivy found in each image the server runs, and what fixes it. */
function ScanCard({ n }: { n: string }) {
  const st = S.scan[n];
  const tv = trivy.get(n);
  if (!st) return null;
  const wait = waiting(st) ? (
    <div role="status" className="px-[18px] py-4 text-dim text-sm flex items-center gap-2">
      <Spin /> Scanning every image. This takes a minute or more; the first scan also downloads Trivy's databases (several GB).
    </div>
  ) : (
    pending(st, "", () => scan(n))
  );
  const toggle = (id: string) => (shownScans.has(id) ? shownScans.delete(id) : shownScans.add(id), render());
  const used = (i: ImageScan) => i.used.map((u) => (u.service && u.service !== u.name ? `${u.name}/${u.service}` : u.name)).join(", ");
  return (
    <Card>
      <CardHead>
        Vulnerabilities <Sub className={HIDE}>Trivy, in the images {scanOthers.has(n) ? "every container runs" : "traefik and the sites run"}</Sub>
        <Actions>
          {st.data && (
            <label className="dim text-sm flex items-center gap-1.5" title="lf scan --others: also the images of containers landfall did not deploy">
              <input type="checkbox" checked={scanOthers.has(n)} disabled={st.loading} onChange={(e) => (e.target.checked ? scanOthers.add(n) : scanOthers.delete(n), void scan(n), render())} />
              Other containers too
            </label>
          )}
          {st.data && (st.loading ? <span role="status" className="dim text-sm flex items-center gap-2"><Spin /> Scanning…</span> : <Btn cls="sm" on={() => scan(n)}>Scan again</Btn>)}
          {!st.loading && <Btn cls="sm" title={`lf scan --remove: delete Trivy's image and databases from the server${tv ? ` (${size((tv.image ?? 0) + (tv.cache ?? 0))})` : ""}`} on={() => removeTrivy(n)}>Remove Trivy</Btn>}
        </Actions>
      </CardHead>
      {wait ?? (
        <Table head={<><th>Image</th><th className={HIDE}>Used by</th><th>Found</th><th className={cx(NUM, HIDE)}>Fixable</th><th></th></>}>
          {st.data!.length ? (
            st.data!.map((i) => {
              const open = shownScans.has(i.id);
              return [
                <tr key={i.id}>
                  <td>
                    <span className={MONO}>{i.ref}</span> {i.other && <Badge title="Run by containers landfall did not deploy">not landfall's</Badge>} {i.eol && <Badge kind="bad" title="Its OS no longer gets security fixes">OS end of life</Badge>}
                    {(i.error || i.hint) && <div className={cx("text-xs mt-1", i.error ? "text-bad" : "text-warn")}>{i.error ?? i.hint}</div>}
                  </td>
                  <td className={cx("dim", HIDE)}>{used(i)}</td>
                  <td>
                    {i.error ? (
                      <Badge kind="bad" title={i.error}>failed</Badge>
                    ) : i.vulns.length ? (
                      SEV.filter(([k]) => i.counts[k]).map(([k, kind, label]) => <Badge key={k} kind={kind} className="mr-1">{i.counts[k]} {label}</Badge>)
                    ) : (
                      <Badge kind="ok">none known</Badge>
                    )}
                  </td>
                  <td className={cx(NUM, HIDE)}>{i.error ? "" : i.fixable}</td>
                  <td className={ACTS}>{i.vulns.length > 0 && <Btn cls="sm ghost" on={() => toggle(i.id)}>{open ? "Hide" : "Show"}</Btn>}</td>
                </tr>,
                open && (
                  <tr key={`${i.id}-list`}>
                    <td colSpan={5} className="pt-0">
                      <Table head={<><th>Severity</th><th>CVE</th><th>Package</th><th className={HIDE}>Installed</th><th>Fixed in</th></>}>
                        {i.vulns.slice(0, 300).map((v) => (
                          <tr key={`${v.id} ${v.pkg} ${v.installed}`}>
                            <td><Badge kind={SEV.find(([k]) => k === v.severity)?.[1] ?? ""}>{v.severity.toLowerCase()}</Badge></td>
                            <td className={cx(MONO, "whitespace-nowrap")}><a href={`https://avd.aquasec.com/nvd/${v.id.toLowerCase()}`} target="_blank" rel="noreferrer">{v.id}</a></td>
                            <td>
                              <div className={MONO}>{v.pkg}</div>
                              {v.title && <div className={cx("dim text-xs max-w-[48ch] truncate", HIDE)} title={v.title}>{v.title}</div>}
                            </td>
                            <td className={cx(MONO, "dim", HIDE)}>{v.installed}</td>
                            <td className={MONO}>{v.fixed?.replaceAll(", ", " ") ?? <span className="faint">no fix yet</span>}</td>
                          </tr>
                        ))}
                        {i.vulns.length > 300 && <tr><td colSpan={5} className="dim">… {i.vulns.length - 300} more: lf scan --all</td></tr>}
                      </Table>
                    </td>
                  </tr>
                ),
              ];
            })
          ) : (
            <tr><td colSpan={5} className="dim">no images to scan</td></tr>
          )}
        </Table>
      )}
    </Card>
  );
}

/** The count of waiting updates for the section button, with its leading space; null when there are none. */
export function updatesBadge(n: string): ReactNode | null {
  const d = S.updates[n]?.data;
  if (!d) return null;
  const k = d.packages.updates.length + d.images.filter((i) => i.state === "update").length;
  const sec = d.packages.updates.some((u) => u.security);
  return k ? <>{" "}<Badge kind={sec ? "warn" : ""}>{k}</Badge></> : null;
}

export function refreshUpdates(n: string) {
  // Drops what is shown, for the refreshing spinner.
  S.updates[n] = { refreshing: true };
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
  const st = S.updates[n];
  const wait = pending(st, st?.refreshing ? "refreshing package lists…" : "checking packages and images…", () => load(n, "updates", true));
  if (wait) return wait;
  const { packages: p, images, engine: e } = st!.data!;
  const s = sv(n);
  const sec = p.updates.filter((u) => u.security);
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
  const imgUpdates = images.filter((i) => i.state === "update");
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
              {shown.map((u) => (
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
      {!e.docker && can(n)?.docker === false ? null : (
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
              <Actions>
                {!S.scan[n] && images.some((i) => i.id) && (asking.has(n) ? <span role="status" className="dim text-sm flex items-center gap-2"><Spin /> Checking for Trivy…</span> : <Btn cls="sm" title="lf scan: known vulnerabilities in each image (Trivy, on the server)" on={() => firstScan(n)}>Scan for vulnerabilities</Btn>)}{imgUpdates.length > 0 && <Btn cls="sm primary" on={() => updImg(imgUpdates.map((i) => i.name))}>Update all ({imgUpdates.length})</Btn>}</Actions>
            </CardHead>
            <Table head={<><th>Name</th><th className={HIDE}>Image</th><th>State</th><th className={HIDE}>Note</th><th></th></>}>
              {images.length ? (
                images.map((i) => {
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
          <ScanCard n={n} />
        </>
      )}
    </>
  );
}
