import type { ReactNode } from "react";
import { S, sv } from "../../lib/store";
import type { DnsCheck } from "../../lib/types";
import { load, refreshState } from "../../lib/api";
import { ifOk, run } from "../../lib/jobs";
import { toast } from "../../ui/toast";
import { Actions, Badge, Body, Btn, Card, CardHead, Kv, MONO, Note, Sub, cx, pending } from "../../ui/kit";
import { MenuBtn } from "../../ui/menu";
import { providerDialog, rootLoginDialog } from "../flows/server-dialogs";
import { confirmDlg, dialog, promptDlg } from "../../ui/dialog";
import { RegistriesCard } from "./registries";

/** A row of the main domains list: text on the left, its buttons on the right. */
const DROW = "flex flex-wrap items-start gap-x-4 gap-y-2 py-3 border-b border-line first:pt-0 last:border-b-0 last:pb-0";
export const P = "my-[1em]";

const DnsRow = ({ d }: { d: DnsCheck }) => (
  <>
    {d.domain} {d.ok ? <Badge kind="ok">dns ok</Badge> : d.ips.length ? <Badge kind="warn">dns → {d.ips.join(", ")}</Badge> : <Badge kind="bad">no dns</Badge>}
  </>
);
export function SettingsView({ n }: { n: string }) {
  const st = S.settings[n];
  const wait = pending(st, "reading the settings…");
  if (wait) return wait;
  const x = st!.data!;
  const reload = { server: n, after: ifOk(() => load(n, "settings", true)) };
  const addDomain = () =>
    promptDlg(
      `Add a main domain to ${n}`,
      `${x.domains.length ? "The first main domain stays the primary." : "The first main domain is the primary: new sites get <site>.<domain>, and a bare name like blog means blog.<domain>."}\nPoint <domain> and *.<domain> (A records) at the server once.`,
      { label: "Domain", placeholder: "example.com", type: "text", value: "" },
      (d) => {
        if (d) run(["server", "domain", n, "--add", d], reload);
      },
      "Add",
    );
  const sites = S.overview[n]?.data?.sites ?? [];
  const external = (d: string): string | undefined => S.overview[n]?.data?.others?.find((e) => e.domains.includes(d))?.name;
  const servedBy = (d: string): string | undefined => sites.find((s) => s.domains.includes(d))?.meta.name;
  const serve = (d: string) => {
    const cur = servedBy(d);
    // Only sites whose domains landfall sets; the others name theirs in compose.yaml.
    const pick = sites.filter((s) => s.main && s.meta.name !== cur);
    if (!pick.length) return void toast(cur ? `${cur} is the only site on ${n}` : `No sites on ${n} yet: deploy one with @ as its domain`);
    dialog({
      title: `Serve a site on ${d}`,
      text: cur
        ? `${cur} serves ${d} now; it moves to the site you pick, which keeps its other domains.`
        : `The site keeps its other domains. ${d} needs an A record pointing at the server.`,
      fields: [
        {
          name: "site",
          label: "Site",
          type: "select",
          options: pick.map((s) => ({ value: s.meta.name, label: `${s.meta.name} (${s.domains.join(", ")})` })),
          value: pick[0].meta.name,
        },
      ],
      ok: "Serve it",
      onOk: (v) => run(["domains", v.site, ...sv(n), "--add", d, "-y"], { server: n, after: ifOk(() => (load(n, "settings", true), load(n, "sites", true))) }),
    });
  };
  const paths = S.state.paths;
  const ip = x.dns[0]?.ips[0] ?? "<server ip>";
  const records = x.dns
    .flatMap((r) => [r.apex, r.wildcard])
    .filter((d) => !d.ok)
    .map((d) => `${d.domain}  A  ${ip}`);
  const tunnel = x.tunnelOnly;
  const setTunnel = () =>
    run(["server", "domain", n, tunnel ? "--no-tunnel-only" : "--tunnel-only"], { server: n, after: ifOk(() => (load(n, "settings", true), refreshState())) });
  const saved: [string, ReactNode][] = x.saved
    ? Object.entries(x.saved)
        .filter(([k, v]) => v !== undefined && k !== "dashboard" && k !== "cloud" && k !== "rootAlias")
        .map(([k, v]) => [k, <span className={MONO}>{String(v)}</span>])
    : [];
  const cloud = S.facts[n]?.data?.cloud;
  saved.push([
    "provider",
    <>
      {cloud ? cloud.name : <span className="dim">none</span>}{" "}
      <span className="dim">
        · {x.saved?.cloud ? "set by hand" : "detected"}
        {cloud?.firewall ? ` · ${cloud.firewall} in front` : ""}
      </span>{" "}
      <Btn cls="sm" on={() => providerDialog(n)}>
        Change
      </Btn>
    </>,
  ]);
  const others = x.ssh.sameMachine;
  saved.push([
    "root work",
    <>
      {x.ssh.rootAlias ? (
        <span className={MONO}>{x.ssh.rootAlias}</span>
      ) : (
        <span className="dim">{others.length ? `tries root, then ${others.map((o) => o.alias).join(", ")}` : "tries root's key login"}</span>
      )}{" "}
      <span className="dim">· when {x.ssh.user} has no passwordless sudo</span>{" "}
      <Btn cls="sm" on={() => rootLoginDialog(n, x.ssh.rootAlias, others)}>
        Change
      </Btn>
    </>,
  ]);
  const primary = x.domains[0];
  return (
    <>
      <Card>
        <CardHead>
          Main domains{" "}
          <Actions>
            <Btn cls="sm" on={addDomain}>
              Add domain
            </Btn>
          </Actions>
        </CardHead>
        <Body>
          {x.domains.length ? (
            <>
              {x.domains.map((d, i) => (
                <div key={d} className={DROW}>
                  <div className="flex-[1_1_260px] min-w-0">
                    <DnsRow d={x.dns[i].apex} />
                    {i === 0 && (
                      <>
                        {" "}
                        <Badge kind="accent">primary</Badge>
                      </>
                    )}
                    <div className="dim">
                      sites: <DnsRow d={x.dns[i].wildcard} />
                    </div>
                    <div className="faint">
                      {servedBy(d) ? (
                        <>
                          served by <b>{servedBy(d)}</b>
                        </>
                      ) : external(d) ? (
                        <>
                          served by <b>{external(d)}</b> (not landfall)
                        </>
                      ) : (
                        "no site serves it"
                      )}
                    </div>
                  </div>
                  <Actions className="flex-none">
                    <Btn cls="sm" on={() => serve(d)}>
                      {servedBy(d) ? "Serve another site" : "Serve a site"}
                    </Btn>
                    <MenuBtn
                      title={`More for ${d}`}
                      items={[
                        i ? { label: "Make primary", hint: "--primary", run: () => void run(["server", "domain", n, "--primary", d], reload) } : null,
                        {
                          label: `Remove ${d}`,
                          cls: "danger",
                          hint: "--rm",
                          run: () =>
                            confirmDlg({
                              title: `Remove ${d} from ${n}?`,
                              text: "New sites stop getting names under it. Sites keep their domains.",
                              ok: "Remove it",
                              danger: true,
                              onOk: () => run(["server", "domain", n, "--rm", d, "-y"], reload),
                            }),
                        },
                      ]}
                    />
                  </Actions>
                </div>
              ))}
              <p className={cx("faint", P)}>
                New sites get <span className={MONO}>&lt;site&gt;.{primary}</span>; a bare name like <span className={MONO}>blog</span> means{" "}
                <span className={MONO}>blog.{primary}</span>, and <span className={MONO}>@</span> means <span className={MONO}>{primary}</span> itself.
              </p>
              {records.length > 0 && (
                <Note>
                  Add at your DNS provider:
                  <div className={MONO}>
                    {records.map((r) => (
                      <div key={r}>{r}</div>
                    ))}
                  </div>
                </Note>
              )}
            </>
          ) : (
            <p className={cx("dim", P)}>
              No main domain set in landfall. New sites get a free <span className={MONO}>&lt;site&gt;.&lt;ip&gt;.sslip.io</span> address until you set one.
            </p>
          )}
          <div className={DROW}>
            <div className="flex-[1_1_260px] min-w-0">
              New sites:{" "}
              {tunnel ? (
                <>
                  <b>no domain</b> <span className="dim">· tunnel only until you give one (Edit on the site, or deploy with a domain)</span>
                </>
              ) : (
                <>
                  <b>get a domain</b> <span className="dim">· unless you tick “No domain” when deploying</span>
                </>
              )}
              {!x.tunnelOnlyOwn && (
                <>
                  {" "}
                  <span className="faint">(landfall default)</span>
                </>
              )}
            </div>
            <Actions className="flex-none">
              <Btn cls="sm" title={tunnel ? "lf server domain --no-tunnel-only" : "lf server domain --tunnel-only"} on={setTunnel}>
                {tunnel ? "Give them a domain" : "Make them tunnel only"}
              </Btn>
            </Actions>
          </div>
          {x.suggest.length > 0 && (
            <Note>
              {x.domains.length ? "Other domains" : "Domains"} your sites on this server already use:{" "}
              {x.suggest.map((g) => (
                <span key={g.domain}>
                  <b>{g.domain}</b> <span className="faint">({g.hosts})</span>{" "}
                  <Btn cls="sm" on={() => run(["server", "domain", n, "--add", g.domain], reload)}>
                    Add
                  </Btn>{" "}
                </span>
              ))}
            </Note>
          )}
        </Body>
      </Card>
      <RegistriesCard n={n} />
      <Card>
        <CardHead>
          On the server <Sub className={MONO}>{paths.root}</Sub>
        </CardHead>
        <Body>
          <Kv
            pairs={[
              [
                "sites",
                <>
                  <span className={MONO}>{paths.sites}/&lt;site&gt;/</span> <span className="dim">one folder per site: releases, compose file, .env</span>
                </>,
              ],
              ["traefik", <span className={MONO}>{paths.traefik}/</span>],
              [
                "history",
                <>
                  <span className={MONO}>{paths.journal}</span> <span className="dim">every change with its undo</span>
                </>,
              ],
            ]}
          />
        </Body>
      </Card>
      <Card>
        <CardHead>
          landfall config <Sub className={MONO}>{x.configFile}</Sub>
        </CardHead>
        <Body>
          {!x.saved && <p className={cx("dim", P)}>Not registered — an ssh alias landfall reads from ~/.ssh/config.</p>}
          <Kv pairs={saved} />
        </Body>
      </Card>
      <Card>
        <CardHead>
          SSH <Sub className={MONO}>ssh -G {x.saved?.host ?? n}</Sub>
        </CardHead>
        <Body>
          <Kv
            pairs={[
              ["login", <span className={MONO}>{`${x.ssh.user}@${x.ssh.hostname}:${x.ssh.port}`}</span>],
              // One row for every key: Kv keys its rows by label.
              ...(x.ssh.keys.length
                ? [
                    [
                      "key",
                      <>
                        {x.ssh.keys.map((k) => (
                          <div key={k.file}>
                            <span className={MONO}>{k.file}</span>
                            {!k.exists && (
                              <>
                                {" "}
                                <Badge kind="bad">missing</Badge>
                              </>
                            )}
                          </div>
                        ))}
                      </>,
                    ] as [string, ReactNode],
                  ]
                : []),
            ]}
          />
          {x.ssh.block ? (
            <>
              <p className={cx("dim", P)}>
                {x.ssh.block.file}:{x.ssh.block.line} · {x.ssh.block.managed ? "written by landfall" : "your own"}
              </p>
              <pre className={cx(MONO, "bg-hover border border-line px-3 py-2.5 rounded-sm overflow-x-auto mt-1.5 mb-0")}>{x.ssh.block.text}</pre>
            </>
          ) : (
            <p className={cx("dim", P)}>No Host block; ssh uses its defaults.</p>
          )}
        </Body>
      </Card>
    </>
  );
}
