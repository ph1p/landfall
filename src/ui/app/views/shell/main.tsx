import { useEffect } from "react";
import { S, isTenant, server, sv, type Slot } from "../../lib/store";
import type { Overview } from "../../lib/types";
import { go, load, needs, pluginNameOf, SECTIONS, STORE } from "../../lib/api";
import { ifOk, run } from "../../lib/jobs";
import { Badge, Bone, Btn, Card, Dot, Empty, Note, Placeholder, Spin, cx, MONO } from "../../ui/kit";
import { MenuBtn } from "../../ui/menu";
import { addServer, setupFlow } from "../flows/setup";
import { PipelineView } from "../pipeline/pipeline";
import { StatusDot, FactsLine, FactsNote, errorHint, can, connected, sections, Star } from "../shared";
import { copy, runCommand, forget, makeDefault, uninstall } from "../domains";
import { rebootDlg, SystemView } from "../system";
import { UsersView } from "../users";
import { TenantsView } from "../tenants";
import { UpdatesView } from "../updates";
import { TunnelsView } from "../tunnels";
import { StatsView } from "../stats";
import { TrafficView } from "../traffic";
import { TraefikView } from "../settings/traefik";
import { SettingsView } from "../settings/settings";
import { FirewallView } from "../firewall";
import { HistoryView } from "../history";
import { HomeView } from "../home";
import { MapView } from "../map/map";
import { PluginView } from "../plugin";
import { stampSummary } from "../../../../core/lib/version";
import { SitesView } from "../sites/sites";
import { RotateCw } from "lucide-react";
import { SectionButtons } from "./sections";

// ---- the open server ---------------------------------------------------------

export function Main() {
  const n = S.sel;
  const s = server();
  const shown = n ? sections(n) : [];
  const wrong = !!s && !shown.some(([t]) => t === S.tab);
  // A section this server has no use for (no docker, no ufw…): open the first one it has.
  useEffect(() => {
    if (wrong && shown[0]) location.replace(`#/${encodeURIComponent(n!)}/${shown[0][0]}`);
  });
  if (S.pipeline) return <PipelineView path={S.pipeline} />;
  if (S.map) return <MapView />;
  if (!n) return <HomeView />;
  if (!s) {
    return (
      <Card>
        <Empty title={`No server named ${n}`}>
          <p>It is not in landfall's list or in ~/.ssh/config (anymore).</p>
          <p>
            <Btn cls="primary" on={() => go(null)}>
              All servers
            </Btn>{" "}
            <Btn on={addServer}>Add a server</Btn>
          </p>
        </Empty>
      </Card>
    );
  }
  if (wrong) return null;
  const k = can(n);
  const ov = S.overview[n] ?? { loading: true };
  const o = ov.data;
  const traefik = o ? (
    o.traefik ? (
      <>
        <StatusDot status={o.traefik} />
        {o.proxy} {o.traefik.toLowerCase()}
      </>
    ) : o.ready ? (
      <>
        <Dot kind="down" />
        no traefik
      </>
    ) : null
  ) : ov.error ? null : (
    <Bone className="w-24" />
  );
  const sub = [s.target, s.registered ? "" : "from ~/.ssh/config", traefik].filter(Boolean);
  // Reloading with something already on screen: keep it, show a small spinner.
  // Stats reload every few seconds and say so themselves.
  const reloading = needs(S.tab).some((t) => t !== "stats" && S[STORE[t]][n]?.loading && S[STORE[t]][n]?.data);
  return (
    <>
      <div className="flex flex-wrap items-start gap-x-5 gap-y-3 mb-5.5">
        <div className="flex-[1_1_320px] min-w-0">
          <h1 className="m-0 text-[24px] font-[650] tracking-[-.02em] leading-tight">
            {n}
            {s.isDefault && (
              <>
                {" "}
                <Star />
              </>
            )}{" "}
            {isTenant(n) && (
              <>
                <Badge
                  title={`${s.saved?.user ?? "This login"} is a tenant on ${s.saved?.host ?? n}: its own Docker, sites and domains. The server's admin manages the rest.`}
                >
                  tenant
                </Badge>{" "}
              </>
            )}
            <span className="font-normal text-faint">/ {(shown.find(([t]) => t === S.tab) ?? SECTIONS.find(([t]) => t === S.tab)!)[1]}</span>
            {reloading && (
              <>
                {" "}
                <Spin role="img" aria-label="reloading" />
              </>
            )}
          </h1>
          <div className="text-dim text-md mt-1">
            {sub.map((x, i) => (
              <span key={i}>
                {i > 0 && " · "}
                {x}
              </span>
            ))}
          </div>
          <FactsLine n={n} />
        </div>
        <div className="flex flex-wrap gap-1.5 ml-auto">
          {(!k || k.setup) && (
            <Btn on={() => setupFlow([n])} title="Shows what is installed and what setup would change; asks before applying">
              Set up / check
            </Btn>
          )}
          <Btn on={() => runCommand(n)} title="Run a shell command over ssh">
            Run
          </Btn>
          <Btn on={() => load(n, S.tab, true)} title="Reload" aria-label="Reload">
            <RotateCw className="inline-block size-3.5 -mt-px align-middle" aria-hidden="true" />
          </Btn>
          <MenuBtn
            title="More"
            cls=""
            items={[
              { label: "Server info", hint: "lf server info", run: () => run(["server", "info", n]) },
              (!k || k.docker) && { label: "Traefik status", hint: "lf traefik status", run: () => run(["traefik", "status", ...sv(n)]) },
              (!k || k.admin) && "-",
              (!k || k.admin) && { label: "Reboot", cls: "danger", hint: "lf reboot", run: () => rebootDlg(n) },
              !s.isDefault && { label: "Make default", title: "Commands without -s use it", run: () => makeDefault(n) },
              s.registered && "-",
              s.registered && { label: `Forget ${n}`, cls: "danger", hint: "lf server rm", run: () => forget(n) },
              s.registered &&
                !isTenant(n) &&
                (!k || k.docker) && {
                  label: "Uninstall landfall…",
                  cls: "danger",
                  hint: "lf server uninstall",
                  title: "Remove its sites, Traefik and what setup changed, then forget it",
                  run: () => uninstall(n),
                },
            ]}
          />
        </div>
      </div>
      <FactsNote n={n} />
      <LandfallNote n={n} />
      <div className="hidden max-[760px]:flex gap-1 p-1 bg-hover rounded-md mb-4.5 overflow-x-auto scrollbar-none sticky -top-3.5 z-2">
        <SectionButtons n={n} />
      </div>
      <View n={n} ov={ov} />
    </>
  );
}

/** The server's landfall is ahead of this one (update lf), or behind it (lf server upgrade). */
function LandfallNote({ n }: { n: string }) {
  const st = S.facts[n]?.data?.landfall;
  const note = st && stampSummary(st, S.state.updateCommand).note;
  if (!st || !note) return null;
  return (
    <Note kind="warn" className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="flex-1 min-w-0">
        landfall on {n}: {note}
        {!st.newer && <span className="dim"> ({st.pending.map((m) => m.what).join("; ")})</span>}
      </span>
      {st.newer ? (
        <Btn cls="sm" title={`Copy: ${S.state.updateCommand}`} on={() => copy(S.state.updateCommand)}>
          Copy update command
        </Btn>
      ) : isTenant(n) ? (
        <span className="dim">The server's admin upgrades it.</span>
      ) : (
        <Btn
          cls="sm"
          title="lf server upgrade: journaled, lf undo reverts it"
          on={() => void run(["server", "upgrade", n, "-y"], { server: n, after: ifOk(() => load(n, S.tab, true)) })}
        >
          Upgrade
        </Btn>
      )}
    </Note>
  );
}

function View({ n, ov }: { n: string; ov: Slot<Overview> }) {
  const o = ov.data;
  if (ov.error) {
    return (
      <>
        <Note kind="bad">
          <b>Cannot reach {n}.</b> {errorHint(ov.error)}
          <div className={cx(MONO, "mt-1.5")}>{ov.error}</div>
        </Note>
        <div className="flex flex-wrap gap-1.5">
          <Btn cls="primary" on={() => setupFlow([n])}>
            Set up
          </Btn>{" "}
          <Btn on={() => load(n, S.tab, true)}>Retry</Btn>
        </div>
      </>
    );
  }
  // Every tab waits for the facts too: they decide which tabs this server has, so none shows and then vanishes.
  if (!o || !connected(n)) return <Placeholder>connecting to {n}…</Placeholder>;
  // Docker did not answer: the lists below are empty, not known.
  const docker = o.docker && (
    <Note kind="bad">
      Docker on {n} does not answer, so its containers are not listed: <span className="mono">{o.docker}</span>
    </Note>
  );
  const plugin = pluginNameOf(S.tab);
  if (plugin) return <PluginView n={n} plugin={plugin} />;
  switch (S.tab) {
    case "sites":
      return (
        <>
          {docker}
          <SitesView n={n} o={o} />
        </>
      );
    case "tunnels":
      return (
        <>
          {docker}
          <TunnelsView n={n} o={o} />
        </>
      );
    case "stats":
      return <StatsView n={n} />;
    case "traffic":
      return <TrafficView n={n} />;
    case "traefik":
      return <TraefikView n={n} />;
    case "updates":
      return <UpdatesView n={n} />;
    case "firewall":
      return <FirewallView n={n} />;
    case "users":
      return <UsersView n={n} />;
    case "tenants":
      return <TenantsView n={n} />;
    case "system":
      return <SystemView n={n} />;
    case "settings":
      return <SettingsView n={n} />;
    default:
      return <HistoryView n={n} />;
  }
}
