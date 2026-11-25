import { S, render, plural, tilde } from "../../lib/store";
import type { ServerEntry } from "../../lib/types";
import { go, goMap, loadReach } from "../../lib/api";
import { openTunnels } from "../../lib/jobs";
import { Bone, Btn, Dot, Spin, cx } from "../../ui/kit";
import { addServer } from "../flows/setup";
import { pipelineProjects } from "../pipeline/pipeline";
import { awaitingReach, ReachDot, reachRank, reachCount, Star, REACH_WORD, REACH_KIND } from "../shared";
import { GitBranch, LayoutGrid, Network, RotateCw } from "lucide-react";
import { SectionButtons } from "./sections";

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

export function Nav() {
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
            className="border-0 p-0 bg-transparent hover:bg-transparent shadow-none focus-visible:shadow-none text-inherit text-xs font-medium inline-flex items-center gap-1.25 hover:text-dim focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 rounded-[3px]"
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
          className={cx(SRV, "grid-cols-[14px_minmax(0,1fr)] gap-x-1 mt-1.5", !S.sel && !S.map && !S.pipeline && SRV_ON)}
          aria-current={S.sel || S.map || S.pipeline ? undefined : "page"}
          onClick={() => go(null)}
        >
          <LayoutGrid className={cx("size-3.5", S.sel || S.map || S.pipeline ? "text-faint" : "text-accent")} aria-hidden="true" />
          <div className="col-start-2 font-[550]">Overview</div>
        </button>
        <button
          type="button"
          className={cx(SRV, "grid-cols-[14px_minmax(0,1fr)] gap-x-1 mb-0.5", S.map && SRV_ON)}
          aria-current={S.map ? "page" : undefined}
          onClick={goMap}
          title="Every server, site, container and domain, and how they connect"
        >
          <Network className={cx("size-3.5", S.map ? "text-accent" : "text-faint")} aria-hidden="true" />
          <div className="col-start-2 font-[550]">Map</div>
        </button>
        {pipelineProjects().map((p) => (
          <a
            key={p.path}
            href={`#git/${encodeURIComponent(p.path)}`}
            className={cx(SRV, "grid-cols-[14px_minmax(0,1fr)] gap-x-1 mb-0.5 no-underline text-fg", S.pipeline === p.path && SRV_ON)}
            aria-current={S.pipeline === p.path ? "page" : undefined}
            title={`${tilde(p.path)}: each environment's git rule, what runs there and what is newer`}
          >
            <GitBranch className={cx("size-3.5", S.pipeline === p.path ? "text-accent" : "text-faint")} aria-hidden="true" />
            <div className="col-start-2 font-[550] truncate">{p.name}</div>
          </a>
        ))}
        {group("own", "Servers", own)}
        {group("ssh", "From ~/.ssh/config", aliases)}
        {group("down", "Unreachable", down)}
        {waiting > 0 && <NavBones n={waiting} head={!list.length} />}
        {!all.length && <div className={NONE}>No servers yet.</div>}
      </div>
      {all.length > 0 && (
        <div className="sticky bottom-0 mt-auto flex items-center gap-2 pt-2.5 pr-3 pb-3 pl-4.5 border-t border-line bg-bg text-sm">
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
        <Dot kind={REACH_KIND[k]} className="mr-1.25" />
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
export function Pick() {
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
