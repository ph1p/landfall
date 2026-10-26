import { S, ago, plural, tilde, type Any } from "../lib/store";
import { go } from "../lib/api";
import { Badge, Btn, Card, CardHead, Actions, Body, Kv, Spin, Dot, Sub, cx } from "../ui/kit";
import { addServer, defaultsDialog, deployFrom, folderDialog } from "./flows";
import { ReachDot, REACH_KIND, REACH_WORD, Star, reachCount, reachRank } from "./shared";

const H3 = "m-0 mb-2 text-xs font-medium text-faint uppercase tracking-[.04em]";

export function HomeView() {
  const st = S.state;
  const list: Any[] = st.servers;
  const own = list.filter((s) => s.registered).sort((a, b) => reachRank(a.name) - reachRank(b.name));
  const d = st.defaults;
  const def: string | undefined = d.default;
  const count = reachCount(list);
  const stat = (k: keyof typeof count, word: string) => (count[k] ? <span><Dot kind={REACH_KIND[k]} />{count[k]} {word}</span> : null);
  const status = S.reaching ? <span><Spin className="size-2.5!" /> checking ssh login…</span> : S.reachedAt ? <>{stat("ok", "reachable")}{stat("login", "login refused")}{stat("down", "unreachable")}</> : null;
  const projects: Any[] = st.projects ?? [];
  const recent = projects.slice(0, 6);
  const paths = (l: { path: string; what: string }[]) => (
    <dl className="m-0 text-sm">
      {l.map((x, i) => [
        <dt key={`t${x.path}`} className={cx("mono wrap-anywhere text-fg", i ? "mt-2" : "mt-0")}>{x.path}</dt>,
        <dd key={`d${x.path}`} className="mt-px mx-0 mb-0 text-dim">{x.what}</dd>,
      ])}
    </dl>
  );
  const cols = "grid grid-cols-[repeat(auto-fit,minmax(320px,1fr))]";
  return (
    <div className="max-w-[880px] mx-auto pt-6">
      <h1 className="m-0 mb-1.5 text-[28px] font-[650] tracking-[-.025em] max-[760px]:text-[24px]">Overview</h1>
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-dim text-md mb-5">
        {plural(own.length, "server")}
        {own.length < list.length && <span className="faint">+ {list.length - own.length} from ~/.ssh/config</span>}
        {status && <><span className="w-px h-3.5 bg-line-strong" />{status}</>}
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-3">
        {own.map((s) => {
          const r = S.reach[s.name];
          return (
            <button
              key={s.name}
              type="button"
              className="block text-left px-[18px] py-4 rounded-lg bg-panel border border-line shadow-xs w-full transition-[border-color,box-shadow,transform] hover:bg-panel hover:border-line-strong hover:shadow-lg hover:-translate-y-px"
              onClick={() => go(s.name, "sites")}
            >
              <div className="font-semibold text-[15px] flex items-center gap-1.5"><ReachDot n={s.name} className="mr-0" />{s.name}{s.isDefault && <Star />}</div>
              <div className="text-faint text-sm mt-0.5 overflow-hidden text-ellipsis">{s.target}</div>
              {r && r.state !== "ok" && <div className={cx("text-xs mt-1", r.state === "login" ? "text-warn" : "text-bad")}>{REACH_WORD[r.state as "login"]}</div>}
            </button>
          );
        })}
        <button
          type="button"
          className="grid place-items-center min-h-[68px] w-full rounded-lg border-[1.5px] border-dashed border-line-strong bg-transparent shadow-none text-dim hover:text-accent hover:border-accent hover:bg-accent-bg"
          onClick={addServer}
        >
          + Add server
        </button>
      </div>
      <p className="faint text-sm mt-2.5">
        The dot shows whether landfall's ssh login works (hover for why not); nothing else connects until you open a server. Any ~/.ssh/config alias works as a server.
      </p>
      <div className={cx(cols, "gap-5 mt-7 mb-5 items-start [&>.card]:mt-0!")}>
        <Card>
          <CardHead>
            Recent deploys {recent.length > 0 && <Badge>{projects.length}</Badge>}
            <Actions><Btn cls="sm" on={() => folderDialog(st.cwd)} title="Pick a folder, a recent project, or drop one here">Deploy folder…</Btn></Actions>
          </CardHead>
          {recent.length ? (
            <ul className="list-none m-0 p-0">
              {recent.map((r) => (
                <li key={r.path} className="flex items-center gap-3 px-[18px] py-2.5 border-b border-line last:border-b-0">
                  <div className="flex-1 min-w-0">
                    <b>{r.name}</b> <span className="dim">→ {r.server}{r.domains[0] ? ` · ${r.domains[0]}` : " · tunnel only"}</span>
                    <div className="faint mono text-xs! overflow-hidden text-ellipsis whitespace-nowrap" title={r.path}>{tilde(r.path)} · {ago(r.at)}</div>
                  </div>
                  <Btn cls="sm" title={`lf deploy from ${r.path}`} on={() => deployFrom(r.path)}>Deploy again</Btn>
                </li>
              ))}
            </ul>
          ) : (
            <Body className="dim">Nothing deployed from this machine yet. Folders you deploy show up here to deploy again.</Body>
          )}
        </Card>
        <Card>
          <CardHead>
            Defaults <Sub>for every server, unless it sets its own</Sub>
            <Actions><Btn cls="sm" on={defaultsDialog} title="lf config">Edit…</Btn></Actions>
          </CardHead>
          <Body>
            <Kv
              pairs={[
                ["Default server", def ? <a href={`#/${encodeURIComponent(def)}`}>{def}</a> : <span className="dim">none: commands need -s</span>],
                ["New sites", d.tunnelOnly ? "no domain, tunnel only" : "get a domain"],
                ["Let's Encrypt e-mail", d.email ? <span className="mono">{d.email}</span> : <span className="dim">none</span>],
                ["Releases kept", String(d.keep)],
                ["Saved in", <span className="mono">{d.configFile}</span>],
              ]}
            />
          </Body>
        </Card>
      </div>
      <Card>
        <CardHead>Where landfall puts things <Sub>nothing it installs is hidden</Sub></CardHead>
        <div className={cols}>
          <div className="pt-3.5 px-[18px] pb-4"><h3 className={H3}>On this machine</h3>{paths(d.locations.local)}</div>
          <div className="pt-3.5 px-[18px] pb-4 border-l border-line narrow:border-l-0 narrow:border-t"><h3 className={H3}>On each server</h3>{paths(d.locations.server)}</div>
        </div>
      </Card>
      <div className="mt-5 px-[18px] py-4 rounded-lg border border-line bg-hover text-md text-dim">
        Everything here runs an <span className="mono">lf</span> command, shown above its output, so you can do the same in a terminal:
        <pre className="mt-2.5 mb-0 font-mono text-[12.5px] leading-[1.7] text-fg whitespace-pre-wrap [&_span]:text-faint">
          lf deploy ./dist -d blog <span># a folder, Dockerfile project or image, with HTTPS</span>{"\n"}
          lf ls{def ? "" : " -s <server>"}{"               "}<span># sites, and what else Traefik routes</span>{"\n"}
          lf logs blog -f{"          "}<span># follow a site's logs</span>{"\n"}
          lf undo{"                  "}<span># revert the last change</span>{"\n"}
          lf config{"                "}<span># these defaults, and where landfall puts things</span>{"\n"}
          lf help{"                  "}<span># every command</span>
        </pre>
      </div>
    </div>
  );
}
