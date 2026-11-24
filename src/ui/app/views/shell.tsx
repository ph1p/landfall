import { useEffect, type ReactNode } from "react";
import { S, render, plural, server, sv, tilde, useStore, type Slot } from "../lib/store";
import type { Overview, ServerEntry } from "../lib/types";
import { go, load, loadReach, needs, pluginNameOf, SECTIONS, STORE, type CoreTab, type Tab } from "../lib/api";
import { run, runningJobs, openTunnels, showJob, JobPanel } from "../lib/jobs";
import { Badge, Bone, Btn, Card, Dot, Empty, Note, Placeholder, Spin, cx, MONO } from "../ui/kit";
import { MenuBtn } from "../ui/menu";
import { addServer, setupFlow, folderDialog, deployHere } from "./flows";
import {
  awaitingReach,
  ReachDot,
  StatusDot,
  FactsLine,
  FactsNote,
  errorHint,
  can,
  connected,
  sections,
  reachRank,
  reachCount,
  Star,
  REACH_WORD,
  REACH_KIND,
} from "./shared";
import { runCommand, forget, makeDefault, uninstall } from "./domains";
import { rebootDlg, SystemView } from "./system";
import { UsersView } from "./users";
import { updatesBadge, UpdatesView } from "./updates";
import { TunnelsView } from "./tunnels";
import { StatsView } from "./stats";
import { TrafficView } from "./traffic";
import { TraefikView, SettingsView } from "./settings";
import { FirewallView } from "./firewall";
import { HistoryView } from "./history";
import { HomeView } from "./home";
import { PluginView } from "./plugin";
import type { PanelIcon } from "../../../core/plugin-api";
import { SitesView } from "./sites";
import {
  Activity,
  Ban,
  Bell,
  Box,
  Bug,
  Cable,
  Database,
  KeyRound,
  Lock,
  Puzzle,
  ScanSearch,
  Search,
  ShieldCheck,
  Cpu,
  Download,
  ExternalLink,
  Gauge,
  Globe,
  History,
  LayoutGrid,
  RotateCw,
  Route,
  Settings,
  Shield,
  Users,
  type LucideIcon,
} from "lucide-react";

export function App() {
  useStore();
  if (!S.state) return null;
  const job = S.job && S.jobs.get(S.job);
  return (
    <div
      className={cx(
        "grid grid-rows-[56px_minmax(0,1fr)] h-screen max-[760px]:grid-cols-[minmax(0,1fr)]! max-[760px]:grid-rows-[56px_auto_minmax(0,1fr)]",
        job ? "grid-cols-[248px_minmax(0,1fr)_clamp(360px,32vw,520px)] max-[1100px]:grid-cols-[220px_minmax(0,1fr)]" : "grid-cols-[248px_minmax(0,1fr)]",
      )}
    >
      <Header />
      <Nav />
      <Pick />
      <main className="@container overflow-auto px-8 pt-7 pb-12 min-w-0 max-[760px]:px-4 max-[760px]:pt-4 max-[760px]:pb-10">
        <Main />
      </main>
      <JobPanel />
    </div>
  );
}

// ---- header -----------------------------------------------------------------

function Header() {
  const st = S.state;
  const p = st.project;
  const running = runningJobs().length;
  return (
    <header className="col-span-full flex items-center gap-3 px-5 border-b border-line bg-panel max-[760px]:px-3.5 max-[760px]:gap-2">
      <a className="font-[650] text-[15px] flex items-center gap-[9px] tracking-[-.015em] text-fg hover:no-underline" href="#/">
        <svg viewBox="0 0 16 16" aria-hidden="true" className="size-6 flex-none">
          <rect width="16" height="16" rx="4" fill="var(--accent)" />
          <path d="M4 5h8M4 8h8M4 11h5" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        landfall <small className="font-medium text-faint text-xs tracking-normal px-[7px] py-px rounded-full bg-hover max-[760px]:hidden">{st.version}</small>
      </a>
      <div className="ml-auto flex items-center gap-2 text-dim text-md min-w-0 max-[760px]:[&_button]:px-2.5 max-[760px]:[&_button]:text-md">
        {S.jobs.size > 0 && !S.job && (
          <Btn on={() => showJob([...S.jobs.keys()].pop()!)} title="Show command output">
            {running ? <Spin className="size-2.5! mr-1" aria-hidden="true" /> : null}Jobs{running ? ` · ${running} running` : ""}
          </Btn>
        )}
        <span className={cx("overflow-hidden text-ellipsis whitespace-nowrap max-w-[36vw] max-[760px]:hidden", MONO)} title={st.cwd}>
          {p ? (
            <>
              <b>{p.name}</b> · {p.domains.join(", ")}
            </>
          ) : (
            tilde(st.cwd)
          )}
        </span>
        <Btn on={() => folderDialog(st.cwd)} title="Pick a folder, a recent project, or drop one here">
          Choose folder…
        </Btn>
        <Btn cls="primary" on={deployHere} title={`Check how ${st.cwd} deploys, then deploy it (lf deploy${p ? ", settings from .landfall.json" : ""})`}>
          Review & deploy…
        </Btn>
      </div>
    </header>
  );
}

// ---- server list --------------------------------------------------------------

// Unreachable starts folded on every load; only the other groups remember their state.
const navClosed = new Set<string>([
  ...(() => {
    try {
      return JSON.parse(localStorage.getItem("lf.navClosed") ?? "[]") as string[];
    } catch {
      return [];
    }
  })(),
  "down",
]);
function toggleGroup(key: string) {
  navClosed.has(key) ? navClosed.delete(key) : navClosed.add(key);
  try {
    localStorage.setItem("lf.navClosed", JSON.stringify([...navClosed].filter((k) => k !== "down")));
  } catch {}
  render();
}

const NONE = "text-faint text-sm px-2.5 py-1.5";
const SRV =
  "grid grid-cols-[8px_minmax(0,1fr)] gap-x-2.5 items-center w-full text-left border-0 bg-transparent shadow-none px-2.5 py-[7px] rounded-sm hover:bg-hover";
const SRV_ON = "bg-panel! shadow-[0_0_0_1px_var(--line),var(--sh)]";

function Nav() {
  const all = S.state.servers.slice().sort((a, b) => reachRank(a.name) - reachRank(b.name));
  // A server shows once the first login check has answered for it; until then a placeholder holds its place.
  const list = all.filter((s) => !awaitingReach(s.name));
  const waiting = all.length - list.length;
  // Down servers sit in their own group, closed until opened, so the rest stay in view.
  const isDown = (s: ServerEntry) => S.reach[s.name]?.state === "down";
  const own = list.filter((s) => s.registered && !isDown(s));
  const aliases = list.filter((s) => !s.registered && !isDown(s));
  const down = list.filter(isDown);
  const q = S.filter.toLowerCase();
  const hit = (s: ServerEntry) => !q || s.name.toLowerCase().includes(q) || s.target.toLowerCase().includes(q) || s.name === S.sel;
  const few = all.length < 8;
  const item = (s: ServerEntry) => {
    const tunnels = openTunnels(s.name).length;
    const r = S.reach[s.name];
    const on = s.name === S.sel;
    return [
      <button key={s.name} type="button" className={cx(SRV, on && SRV_ON)} onClick={() => go(s.name, on ? S.tab : "sites")}>
        <ReachDot n={s.name} className="m-0" />
        <div className={cx("col-start-2 font-[550] flex items-center gap-1.5", r?.state === "down" && !on && "text-dim")}>
          {s.name}
          {s.isDefault && <Star />}
        </div>
        <div className={cx("col-start-2 text-sm flex min-w-0 whitespace-nowrap", on ? "text-dim" : "text-faint")}>
          <span className="overflow-hidden text-ellipsis min-w-0">{s.target}</span>
          {r?.state === "login" && (
            <span className="flex-none whitespace-pre">
              {" "}
              · <span className="text-warn">login refused</span>
            </span>
          )}
          {tunnels > 0 && (
            <span className="flex-none whitespace-pre">
              {" "}
              · <span className="text-ok">{plural(tunnels, "tunnel")}</span>
            </span>
          )}
        </div>
      </button>,
      on && (
        <div key={`${s.name}/sections`} className="grid gap-px mt-1 mb-2.5 ml-3 pl-2 border-l border-line-strong" role="list" aria-label={s.name}>
          <SectionButtons n={s.name} nav />
        </div>
      ),
    ];
  };
  const group = (key: string, title: string, l: ServerEntry[]) => {
    if (!l.length) return null;
    const shown = l.filter(hit);
    // A closed group still shows the open server; a filter opens every group.
    const closed = navClosed.has(key) && !q;
    const rows = closed ? shown.filter((s) => s.name === S.sel) : shown;
    return (
      <div key={key}>
        <h3 className="mt-3.5 mx-2.5 mb-1 text-xs text-faint font-medium flex justify-between">
          <button
            type="button"
            className="border-0 p-0 bg-transparent hover:bg-transparent shadow-none focus-visible:shadow-none text-inherit text-xs font-medium inline-flex items-center gap-[5px] hover:text-dim focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 rounded-[3px]"
            aria-expanded={!closed}
            onClick={() => toggleGroup(key)}
          >
            <span
              aria-hidden="true"
              className={cx("size-0 border-l-[5px] border-l-current border-y-4 border-y-transparent transition-transform", !closed && "rotate-90")}
            />
            {title}
          </button>
          <span>
            {q ? `${shown.length}/` : ""}
            {l.length}
          </span>
        </h3>
        {rows.length ? rows.map(item) : !closed && <div className={NONE}>no match</div>}
      </div>
    );
  };
  return (
    <nav className="border-r border-line bg-bg overflow-auto flex flex-col max-[760px]:hidden">
      <div className="sticky top-0 z-1 bg-bg flex gap-1.5 px-3 pt-3.5 pb-2">
        <input
          type="search"
          placeholder="Filter servers"
          autoComplete="off"
          spellCheck={false}
          aria-label="Filter servers"
          className="px-2.5 py-1.5 text-md"
          hidden={few}
          value={S.filter}
          onChange={(e) => ((S.filter = e.target.value.trim()), render())}
        />
        <Btn cls="flex-none px-2.5" on={addServer} title="Register an ssh alias or set up a fresh machine">
          {few ? "+ Add server" : "+"}
        </Btn>
      </div>
      <div className="px-2 pb-4">
        <button
          type="button"
          className={cx(SRV, "grid-cols-[14px_minmax(0,1fr)] gap-x-1 mt-1.5 mb-0.5", !S.sel && SRV_ON)}
          aria-current={S.sel ? undefined : "page"}
          onClick={() => go(null)}
        >
          <LayoutGrid className={cx("size-3.5", S.sel ? "text-faint" : "text-accent")} aria-hidden="true" />
          <div className="col-start-2 font-[550]">Overview</div>
        </button>
        {group("own", "Servers", own)}
        {group("ssh", "From ~/.ssh/config", aliases)}
        {group("down", "Unreachable", down)}
        {waiting > 0 && <NavBones n={waiting} head={!list.length} />}
        {!all.length && <div className={NONE}>No servers yet.</div>}
      </div>
      {all.length > 0 && (
        <div className="sticky bottom-0 mt-auto flex items-center gap-2 pt-2.5 pr-3 pb-3 pl-[18px] border-t border-line bg-bg text-sm">
          <ReachSummary list={all} />
        </div>
      )}
    </nav>
  );
}

/** Placeholder server rows while the first login check runs. */
function NavBones({ n, head }: { n: number; head: boolean }) {
  return (
    <div role="status" aria-label="Checking servers">
      {head ? (
        <h3 className="mt-3.5 mx-2.5 mb-1">
          <Bone className="w-16 h-2.5" />
        </h3>
      ) : (
        <div className="h-2" />
      )}
      {Array.from({ length: Math.min(n, 6) }, (_, i) => (
        <div key={i} className={cx(SRV, "hover:bg-transparent")}>
          <Bone className="size-2 rounded-full" />
          <Bone className="col-start-2 w-24 h-3" />
          <Bone className="col-start-2 w-36 h-2.5 mt-1.5" />
        </div>
      ))}
    </div>
  );
}

/** The sidebar's foot: what the login check is doing, or what it found and when. */
function ReachSummary({ list }: { list: ServerEntry[] }) {
  const btn = (
    <Btn
      cls="sm ghost flex-none inline-flex items-center gap-1.5"
      disabled={S.reaching}
      title="Try landfall's ssh login on every server again (lf server list --check)"
      on={() => loadReach(true)}
    >
      {S.reaching ? <Spin className="size-2.5!" aria-hidden="true" /> : <RotateCw className="size-3" aria-hidden="true" />}
      {S.reaching ? "Checking" : "Check"}
    </Btn>
  );
  const what = "flex-1 min-w-0 text-dim";
  if (S.reaching)
    return (
      <>
        <div className={what} role="status">
          Trying ssh login on {plural(list.length, "server")}…
        </div>
        {btn}
      </>
    );
  if (!S.reachedAt)
    return (
      <>
        <div className={what}>Not checked yet</div>
        {btn}
      </>
    );
  const count = reachCount(list);
  const part = (k: keyof typeof count, word: string) =>
    count[k] ? (
      <span title={word}>
        <Dot kind={REACH_KIND[k]} className="mr-[5px]" />
        {count[k]} {word}
      </span>
    ) : null;
  const at = S.reachedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <>
      <div className={what} role="status">
        <div className="flex flex-wrap gap-x-2.5 gap-y-1 text-fg">
          {part("ok", "reachable")}
          {part("login", "refused")}
          {part("down", "down")}
        </div>
        <div className="text-faint text-xs mt-0.5">checked {at} · again every minute</div>
      </div>
      {btn}
    </>
  );
}

/** Phones: a select instead of the list. */
function Pick() {
  const list = S.state.servers.slice().sort((a, b) => reachRank(a.name) - reachRank(b.name));
  return (
    <div className="hidden max-[760px]:block px-4 pt-3">
      <select aria-label="Server" value={S.sel ?? ""} onChange={(e) => go(e.target.value || null)}>
        <option value="">{list.some((s) => awaitingReach(s.name)) ? "Pick a server… (checking the rest)" : "Pick a server…"}</option>
        {list
          .filter((s) => !awaitingReach(s.name))
          .map((s) => {
            const r = S.reach[s.name];
            return (
              <option key={s.name} value={s.name}>
                {s.name} · {s.target}
                {r && r.state !== "ok" ? ` · ${REACH_WORD[r.state as "ok"]}` : ""}
              </option>
            );
          })}
      </select>
    </div>
  );
}

/** The open server's sections as buttons, each with its count: in the list, or as tabs on phones. */
function SectionButtons({ n, nav }: { n: string; nav?: boolean }) {
  const o = S.overview[n]?.data;
  const tunnels = openTunnels(n).length;
  const badge: Record<string, ReactNode> = {
    sites: o ? (
      <>
        {" "}
        <Badge>{o.sites.length}</Badge>
      </>
    ) : null,
    tunnels: tunnels ? (
      <>
        {" "}
        <Badge kind="ok">{tunnels} open</Badge>
      </>
    ) : null,
    // Comes with its own leading space.
    updates: updatesBadge(n),
  };
  const look = nav
    ? (on: boolean) =>
        cx(
          "flex items-center gap-2 w-full text-left border-0 shadow-none px-2.5 py-[5px]",
          on ? "bg-accent-bg text-accent font-[550] hover:bg-accent-bg" : "bg-transparent text-dim font-[450] hover:bg-hover hover:text-fg",
        )
    : (on: boolean) =>
        cx(
          "border-0 rounded-sm shadow-none px-3 py-1.5 flex-none",
          on ? "text-fg bg-panel shadow-[var(--sh),0_0_0_1px_var(--line)] hover:bg-panel" : "bg-transparent text-dim hover:bg-transparent hover:text-fg",
        );
  // Which sections it has comes with its facts: grey stand-ins until then, not all of them for a moment.
  if (!connected(n) && !S.overview[n]?.error)
    return Array.from({ length: nav ? 7 : 4 }, (_, i) => (
      <div key={i} aria-hidden="true" className={nav ? "px-2.5 py-[9px]" : "px-3 py-2 flex-none"}>
        <Bone className={nav ? ["w-12", "w-16", "w-10", "w-14"][i % 4] : "w-12"} />
      </div>
    ));
  const cl = S.facts[n]?.data?.cloud;
  const groupHead = (key: string, title: string, first = false) => (
    <div key={key} role="presentation" className={cx("px-2.5 pb-0.5 text-[11px] uppercase tracking-[.06em] text-faint font-medium", first ? "pt-1" : "pt-2.5")}>
      {title}
    </div>
  );
  // The provider's own console: where its firewall, snapshots and the machine itself are managed.
  const provider =
    nav && cl?.console
      ? [
          groupHead("provider/group", "Provider"),
          <a key="provider" href={cl.console} target="_blank" rel="noopener" className={cx(look(false), "no-underline")} title={cl.console}>
            <ExternalLink className="size-3.5 flex-none opacity-75" aria-hidden="true" />
            <span className="mr-auto">{cl.name} console</span>
          </a>,
        ]
      : [];
  const list = sections(n).map(([t, label, grp], i, all) => {
    const Icon = iconOf(t);
    const btn = (
      <button
        key={t}
        type="button"
        className={look(S.tab === t)}
        aria-current={S.tab === t ? "page" : undefined}
        title={`${label} (${i + 1})`}
        onClick={() => go(n, t)}
      >
        {nav && <Icon className="size-3.5 flex-none opacity-75" aria-hidden="true" />}
        <span className={cx(nav && "mr-auto")}>{label}</span>
        {badge[t]}
      </button>
    );
    // The list heads each group; tabs on phones run on in one row.
    if (!nav || all[i - 1]?.[2] === grp) return btn;
    return [groupHead(`${t}/group`, grp, !i), btn];
  });
  return [...list, ...provider];
}

// A plugin's panel names its icon from PANEL_ICONS; anything else is a puzzle piece.
const PLUGIN_ICON: Record<PanelIcon, LucideIcon> = {
  puzzle: Puzzle,
  shield: ShieldCheck,
  bug: Bug,
  lock: Lock,
  scan: ScanSearch,
  activity: Activity,
  database: Database,
  bell: Bell,
  key: KeyRound,
  box: Box,
  ban: Ban,
  search: Search,
};
const iconOf = (t: Tab): LucideIcon => {
  if (t in ICON) return ICON[t as CoreTab];
  const icon = S.state.plugins.find((p) => p.name === pluginNameOf(t))?.panel?.icon;
  return PLUGIN_ICON[icon as PanelIcon] ?? Puzzle;
};
const ICON: Record<CoreTab, LucideIcon> = {
  sites: Globe,
  tunnels: Cable,
  stats: Gauge,
  traffic: Activity,
  history: History,
  traefik: Route,
  firewall: Shield,
  updates: Download,
  users: Users,
  system: Cpu,
  settings: Settings,
  facts: Cpu,
};

// ---- the open server ---------------------------------------------------------

function Main() {
  const n = S.sel;
  const s = server();
  const shown = n ? sections(n) : [];
  const wrong = !!s && !shown.some(([t]) => t === S.tab);
  // A section this server has no use for (no docker, no ufw…): open the first one it has.
  useEffect(() => {
    if (wrong) location.replace(`#/${encodeURIComponent(n!)}/${shown[0][0]}`);
  });
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
      <div className="flex flex-wrap items-start gap-x-5 gap-y-3 mb-[22px]">
        <div className="flex-[1_1_320px] min-w-0">
          <h1 className="m-0 text-[24px] font-[650] tracking-[-.02em] leading-[1.25]">
            {n}
            {s.isDefault && (
              <>
                {" "}
                <Star />
              </>
            )}{" "}
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
      <div className="hidden max-[760px]:flex gap-1 p-1 bg-hover rounded-md mb-[18px] overflow-x-auto [scrollbar-width:none] sticky -top-3.5 z-2">
        <SectionButtons n={n} />
      </div>
      <View n={n} ov={ov} />
    </>
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
    case "system":
      return <SystemView n={n} />;
    case "settings":
      return <SettingsView n={n} />;
    default:
      return <HistoryView n={n} />;
  }
}
