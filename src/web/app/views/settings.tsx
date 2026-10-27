import type { ReactNode } from "react";
import { S, sv, type Any } from "../lib/store";
import { load, refreshState } from "../lib/api";
import { TunnelBtn, ifOk, run } from "../lib/jobs";
import { toast } from "../ui/toast";
import { Actions, Badge, Body, Btn, Card, CardHead, Kv, MONO, Note, Sub, cx, pending } from "../ui/kit";
import { MenuBtn } from "../ui/menu";
import { confirmDlg, dialog, domainOk, passwordError, promptDlg, userError } from "../ui/dialog";

// ---- traefik & settings --------------------------------------------------------

/** A row of the main domains list: text on the left, its buttons on the right. */
const DROW = "flex flex-wrap items-start gap-x-4 gap-y-2 py-3 border-b border-line first:pt-0 last:border-b-0 last:pb-0";
const P = "my-[1em]";

/** Traefik on server n: its dashboard (domain and tunnel) and how landfall runs it. */
export function TraefikView({ n }: { n: string }) {
  const st = S.settings[n];
  const wait = pending(st, "reading the settings…");
  if (wait) return wait;
  const x = st!.data;
  const reload = { server: n, after: ifOk(() => load(n, "traefik", true)) };
  const paths = S.state.paths;
  const dashboard = () =>
    dialog({
      title: `Traefik dashboard on ${n}`,
      text: "Serves the dashboard on a domain behind a login. Without one it stays reachable through an SSH tunnel only (Open via tunnel).\nRuns lf traefik setup, which reconfigures landfall's Traefik.",
      fields: [
        {
          name: "domain", label: "Domain", value: x.traefik.dashboard ?? "", mono: true, placeholder: x.domains[0] ? `traefik.${x.domains[0]}` : "traefik.example.com",
          hint: x.traefik.dashboard ? "Empty: take the dashboard off its domain." : "Needs an A record pointing at the server.",
          required: !x.traefik.dashboard && "Give a domain, or use the tunnel", check: (d) => d && !domainOk(d) && "Not a domain",
        },
        {
          legend: "Login", when: (v) => v.domain.trim(),
          fields: [
            {
              row: [
                { name: "user", label: "User", value: "admin", placeholder: "admin", check: (u) => userError(u || "admin") },
                {
                  name: "password", label: `Password (${S.state.rules.minPassword}+ characters)`, type: "password", check: (pw) => pw && passwordError(pw),
                  hint: x.traefik.dashboard ? "Empty: keeps the current one." : "Empty: a generated one, shown in the output.",
                },
              ],
            },
          ],
        },
      ],
      ok: "Apply",
      onOk: (v) => {
        const d = v.domain.trim();
        const user = v.user.trim() || "admin";
        const argv = ["traefik", "setup", ...sv(n), "--dashboard", d || "off"];
        if (d) argv.push("--dashboard-user", user, ...(v.password ? ["--dashboard-password", v.password] : []));
        run(argv, reload);
      },
    });
  const traefikDialog = () =>
    dialog({
      title: `Traefik on ${n}`,
      text: "Runs lf traefik setup, which reconfigures landfall's Traefik and restarts it (a few seconds without traffic). The settings are remembered.",
      fields: [
        { name: "http3", label: "HTTP/3 (QUIC on 443/udp)", type: "check", value: x.traefik.http3, hint: "Faster on lossy and mobile connections; browsers that can't use it fall back to HTTP/2." },
        {
          name: "mode", label: "Ports", type: "select", value: x.traefik.hostNetwork ? "host" : "docker",
          options: [
            { value: "docker", label: "Published by Docker (default)" },
            { value: "host", label: "Host network: real client IPs, ufw guards 80/443" },
          ],
        },
        { name: "image", label: "Image", value: x.traefik.image, placeholder: S.state.defaultImage },
        { name: "email", label: "Let's Encrypt e-mail (optional)", value: x.traefik.email ?? "", hint: "Only the account contact; Let's Encrypt no longer mails expiry warnings." },
        { name: "staging", label: "Let's Encrypt staging CA (test certificates, browsers warn)", type: "check", value: x.traefik.staging },
      ],
      ok: "Apply",
      onOk: (v) => {
        const argv = ["traefik", "setup", ...sv(n), v.http3 ? "--http3" : "--no-http3", v.mode === "host" ? "--host-network" : "--no-host-network", v.staging ? "--staging" : "--no-staging"];
        if (v.image.trim()) argv.push("--image", v.image.trim());
        if (v.email.trim()) argv.push("--email", v.email.trim());
        run(argv, reload);
      },
    });
  // lf traefik setup refuses to touch a Traefik the server already had.
  const o = S.overview[n]?.data;
  const foreign: string = o?.adopted ? o.proxy : "";
  const dash = o?.dashboard ?? { hosts: x.traefik.dashboard ? [x.traefik.dashboard] : [], tunnel: false };
  const dashArgv = ["traefik", "dashboard", ...sv(n)];
  return (
    <>
      <Card>
        <CardHead>Dashboard <Actions>{!foreign && <Btn cls="sm" on={dashboard}>{dash.hosts.length ? "Domain & login" : "Put on a domain"}</Btn>}</Actions></CardHead>
        <Body>
          <Kv pairs={[
            ["domain", dash.hosts.length
              ? <>{dash.hosts.map((h: string, k: number) => <span key={h}>{k > 0 && ", "}<a href={`https://${h}`} target="_blank" rel="noopener">{h}</a></span>)} <span className="dim">(with its login)</span></>
              : <span className="dim">none{foreign ? "" : ": only through the tunnel"}</span>],
            ["tunnel", dash.tunnel
              ? <><TunnelBtn n={n} argv={dashArgv} label="Open via tunnel" /> <span className={cx("dim", MONO)}>lf traefik dashboard</span></>
              : foreign ? <span className="dim">route its dashboard (api@internal) to a domain, or run <span className={MONO}>lf traefik dashboard --port &lt;its api port&gt;</span></span>
              : <><span className="dim">set up by an older landfall</span> <Btn cls="sm" title="Re-runs lf traefik setup, which adds it" on={() => run(["traefik", "setup", ...sv(n)], reload)}>Enable tunnel</Btn></>],
          ]} />
        </Body>
      </Card>
      <Card>
        <CardHead>
          Traefik
          <Actions>
            <Btn cls="sm" title="lf traefik status" on={() => run(["traefik", "status", ...sv(n)])}>Status</Btn>
            {!foreign && <Btn cls="sm" on={traefikDialog}>Settings</Btn>}
          </Actions>
        </CardHead>
        <Body>
          {foreign && <Note>Sites go through <b className={MONO}>{foreign}</b>, a Traefik landfall did not install and never changes: it is configured in its own files.</Note>}
          <Kv pairs={[
            ["image", x.traefik.summary],
            ["e-mail", x.traefik.email ?? "none"],
            ["HTTP/3", x.traefik.http3 ? <>on <span className="dim">(443/udp)</span></> : <span className="dim">off</span>],
            ["files", <span className={MONO}>{paths.traefik}/docker-compose.yml</span>],
            ["certificates", <><span className={MONO}>{paths.traefik}/letsencrypt/</span> <span className="dim">(kept on reinstall)</span></>],
          ]} />
          <p className={cx("faint", P)}>Used when landfall installs or reconfigures its own Traefik. With a Traefik that was already there, landfall only writes <span className={MONO}>{paths.proxy}</span>.</p>
        </Body>
      </Card>
    </>
  );
}

const DnsRow = ({ d }: { d: Any }) => (
  <>{d.domain} {d.ok ? <Badge kind="ok">dns ok</Badge> : d.ips.length ? <Badge kind="warn">dns → {d.ips.join(", ")}</Badge> : <Badge kind="bad">no dns</Badge>}</>
);

export function SettingsView({ n }: { n: string }) {
  const st = S.settings[n];
  const wait = pending(st, "reading the settings…");
  if (wait) return wait;
  const x = st!.data;
  const reload = { server: n, after: ifOk(() => load(n, "settings", true)) };
  const addDomain = () =>
    promptDlg(`Add a main domain to ${n}`, `${x.domains.length ? "The first main domain stays the primary." : "The first main domain is the primary: new sites get <site>.<domain>, and a bare name like blog means blog.<domain>."}\nPoint <domain> and *.<domain> (A records) at the server once.`, { label: "Domain", placeholder: "example.com", type: "text", value: "" }, (d) => {
      if (d) run(["server", "domain", n, "--add", d], reload);
    }, "Add");
  const sites: Any[] = S.overview[n]?.data?.sites ?? [];
  const external = (d: string): string | undefined => S.overview[n]?.data?.others?.find((e: Any) => e.domains.includes(d))?.name;
  const servedBy = (d: string): string | undefined => sites.find((s) => s.domains.includes(d))?.meta.name;
  const serve = (d: string) => {
    const cur = servedBy(d);
    // Only sites whose domains landfall sets; the others name theirs in compose.yaml.
    const pick = sites.filter((s) => s.main && s.meta.name !== cur);
    if (!pick.length) return void toast(cur ? `${cur} is the only site on ${n}` : `No sites on ${n} yet: deploy one with @ as its domain`);
    dialog({
      title: `Serve a site on ${d}`,
      text: cur ? `${cur} serves ${d} now; it moves to the site you pick, which keeps its other domains.` : `The site keeps its other domains. ${d} needs an A record pointing at the server.`,
      fields: [{ name: "site", label: "Site", type: "select", options: pick.map((s) => ({ value: s.meta.name, label: `${s.meta.name} (${s.domains.join(", ")})` })), value: pick[0].meta.name }],
      ok: "Serve it",
      onOk: (v) => run(["domains", v.site, ...sv(n), "--add", d, "-y"], { server: n, after: ifOk(() => (load(n, "settings", true), load(n, "sites", true))) }),
    });
  };
  const paths = S.state.paths;
  const ip = x.dns[0]?.ips[0] ?? "<server ip>";
  const records: string[] = x.dns.flatMap((r: Any) => [r.apex, r.wildcard]).filter((d: Any) => !d.ok).map((d: Any) => `${d.domain}  A  ${ip}`);
  const tunnel = x.tunnelOnly;
  const setTunnel = () =>
    run(["server", "domain", n, tunnel ? "--no-tunnel-only" : "--tunnel-only"], { server: n, after: ifOk(() => (load(n, "settings", true), refreshState())) });
  const saved: [string, ReactNode][] = x.saved
    ? Object.entries(x.saved).filter(([k, v]) => v !== undefined && k !== "dashboard").map(([k, v]) => [k, <span className={MONO}>{String(v)}</span>])
    : [];
  const primary = x.domains[0];
  return (
    <>
      <Card>
        <CardHead>Main domains <Actions><Btn cls="sm" on={addDomain}>Add domain</Btn></Actions></CardHead>
        <Body>
          {x.domains.length ? (
            <>
              {x.domains.map((d: string, i: number) => (
                <div key={d} className={DROW}>
                  <div className="flex-[1_1_260px] min-w-0">
                    <DnsRow d={x.dns[i].apex} />{i === 0 && <> <Badge kind="accent">primary</Badge></>}
                    <div className="dim">sites: <DnsRow d={x.dns[i].wildcard} /></div>
                    <div className="faint">{servedBy(d) ? <>served by <b>{servedBy(d)}</b></> : external(d) ? <>served by <b>{external(d)}</b> (not landfall)</> : "no site serves it"}</div>
                  </div>
                  <Actions className="flex-none">
                    <Btn cls="sm" on={() => serve(d)}>{servedBy(d) ? "Serve another site" : "Serve a site"}</Btn>
                    <MenuBtn title={`More for ${d}`} items={[
                      i ? { label: "Make primary", hint: "--primary", run: () => void run(["server", "domain", n, "--primary", d], reload) } : null,
                      { label: `Remove ${d}`, cls: "danger", hint: "--rm", run: () => confirmDlg({ title: `Remove ${d} from ${n}?`, text: "New sites stop getting names under it. Sites keep their domains.", ok: "Remove it", danger: true, onOk: () => run(["server", "domain", n, "--rm", d, "-y"], reload) }) },
                    ]} />
                  </Actions>
                </div>
              ))}
              <p className={cx("faint", P)}>
                New sites get <span className={MONO}>&lt;site&gt;.{primary}</span>; a bare name like <span className={MONO}>blog</span> means <span className={MONO}>blog.{primary}</span>, and <span className={MONO}>@</span> means <span className={MONO}>{primary}</span> itself.
              </p>
              {records.length > 0 && <Note>Add at your DNS provider:<div className={MONO}>{records.map((r) => <div key={r}>{r}</div>)}</div></Note>}
            </>
          ) : (
            <p className={cx("dim", P)}>No main domain set in landfall. New sites get a free <span className={MONO}>&lt;site&gt;.&lt;ip&gt;.sslip.io</span> address until you set one.</p>
          )}
          <div className={DROW}>
            <div className="flex-[1_1_260px] min-w-0">
              New sites: {tunnel
                ? <><b>no domain</b> <span className="dim">· tunnel only until you give one (Edit on the site, or deploy with a domain)</span></>
                : <><b>get a domain</b> <span className="dim">· unless you tick “No domain” when deploying</span></>}
              {!x.tunnelOnlyOwn && <> <span className="faint">(landfall default)</span></>}
            </div>
            <Actions className="flex-none">
              <Btn cls="sm" title={tunnel ? "lf server domain --no-tunnel-only" : "lf server domain --tunnel-only"} on={setTunnel}>{tunnel ? "Give them a domain" : "Make them tunnel only"}</Btn>
            </Actions>
          </div>
          {x.suggest.length > 0 && (
            <Note>
              {x.domains.length ? "Other domains" : "Domains"} your sites on this server already use:{" "}
              {x.suggest.map((g: Any) => (
                <span key={g.domain}><b>{g.domain}</b> <span className="faint">({g.hosts})</span> <Btn cls="sm" on={() => run(["server", "domain", n, "--add", g.domain], reload)}>Add</Btn> </span>
              ))}
            </Note>
          )}
        </Body>
      </Card>
      <Card>
        <CardHead>On the server <Sub className={MONO}>{paths.root}</Sub></CardHead>
        <Body>
          <Kv pairs={[
            ["sites", <><span className={MONO}>{paths.sites}/&lt;site&gt;/</span> <span className="dim">one folder per site: releases, compose file, .env</span></>],
            ["traefik", <span className={MONO}>{paths.traefik}/</span>],
            ["history", <><span className={MONO}>{paths.journal}</span> <span className="dim">every change with its undo</span></>],
          ]} />
        </Body>
      </Card>
      <Card>
        <CardHead>landfall config <Sub className={MONO}>{x.configFile}</Sub></CardHead>
        <Body>{saved.length ? <Kv pairs={saved} /> : <p className={cx("dim", P)}>Not registered — an ssh alias landfall reads from ~/.ssh/config.</p>}</Body>
      </Card>
      <Card>
        <CardHead>SSH <Sub className={MONO}>ssh -G {x.saved?.host ?? n}</Sub></CardHead>
        <Body>
          <Kv pairs={[
            ["login", <span className={MONO}>{`${x.ssh.user}@${x.ssh.hostname}:${x.ssh.port}`}</span>],
            // One row for every key: Kv keys its rows by label.
            ...(x.ssh.keys.length
              ? [["key", <>{x.ssh.keys.map((k: Any) => <div key={k.file}><span className={MONO}>{k.file}</span>{!k.exists && <> <Badge kind="bad">missing</Badge></>}</div>)}</>] as [string, ReactNode]]
              : []),
          ]} />
          {x.ssh.block ? (
            <>
              <p className={cx("dim", P)}>{x.ssh.block.file}:{x.ssh.block.line} · {x.ssh.block.managed ? "written by landfall" : "your own"}</p>
              <pre className={cx(MONO, "bg-hover border border-line px-3 py-2.5 rounded-sm overflow-x-auto mt-1.5 mb-0")}>{x.ssh.block.text}</pre>
            </>
          ) : <p className={cx("dim", P)}>No Host block; ssh uses its defaults.</p>}
        </Body>
      </Card>
    </>
  );
}
