import { type ReactNode } from "react";
import { S, isTenant } from "../../lib/store";
import { go, pluginNameOf, type CoreTab, type Tab } from "../../lib/api";
import { openTunnels } from "../../lib/jobs";
import { Badge, Bone, cx } from "../../ui/kit";
import { connected, sections } from "../shared";
import { updatesBadge } from "../updates";
import type { PanelIcon } from "../../../../core/plugins/plugin-api";
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
  Route,
  Settings,
  Shield,
  Building2,
  Users,
  type LucideIcon,
} from "lucide-react";

/** The open server's sections as buttons, each with its count: in the list, or as tabs on phones. */
export function SectionButtons({ n, nav }: { n: string; nav?: boolean }) {
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
      <div key={i} aria-hidden="true" className={nav ? "px-2.5 py-2.25" : "px-3 py-2 flex-none"}>
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
  // A server that cannot have tenants (no systemd, no user tools…) still lists the section, greyed out, with the reason.
  const noTenants = nav && !isTenant(n) && S.facts[n]?.data?.can?.tenants === false ? S.facts[n]!.data!.why.tenants : undefined;
  const offTenants = noTenants && (
    <div
      key="tenants"
      role="presentation"
      className={cx(look(false), "items-start cursor-default text-faint hover:bg-transparent hover:text-faint")}
      title={`Tenants: not on ${n}: ${noTenants}`}
    >
      <Building2 className="size-3.5 flex-none opacity-50 mt-[3px]" aria-hidden="true" />
      <span className="mr-auto min-w-0">
        Tenants
        <span className="block text-[11px] leading-tight truncate">{noTenants}</span>
      </span>
    </div>
  );
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
    const shown = t === "system" && offTenants ? [offTenants, btn] : btn;
    if (!nav || all[i - 1]?.[2] === grp) return shown;
    return [groupHead(`${t}/group`, grp, !i), shown];
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
  tenants: Building2,
};
