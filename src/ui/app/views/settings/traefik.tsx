import { useEffect } from "react";
import { S, sv } from "../../lib/store";
import { expandHost, redirectTarget, type ServerRedirect } from "../../../../core/traefik/redirects";
import { ensure, fetchInto, load } from "../../lib/api";
import { TunnelBtn, ifOk, run } from "../../lib/jobs";
import { Actions, Badge, Body, Btn, Card, CardHead, HIDE, Kv, MONO, Note, Sub, Table, cx, pending } from "../../ui/kit";
import { MenuBtn } from "../../ui/menu";
import { mainDomain } from "../flows/server-dialogs";
import { confirmDlg, dialog, domainOk, passwordError, userError } from "../../ui/dialog";
import { DomainChip, ensureDns } from "../domains";
import { P } from "./settings";

/** Traefik on server n: its dashboard (domain and tunnel) and how landfall runs it. */
export function TraefikView({ n }: { n: string }) {
  const st = S.settings[n];
  useEffect(() => ensure("proxy", n, "/traefik"));
  const wait = pending(st, "reading the settings…");
  if (wait) return wait;
  const x = st!.data!;
  const reloadAll = () => (load(n, "traefik", true), load(n, "sites", true), fetchInto("proxy", n, "/traefik"));
  const reload = { server: n, after: ifOk(reloadAll) };
  const paths = S.state.paths;
  const dashboard = () =>
    dialog({
      title: `Traefik dashboard on ${n}`,
      text: "Serves the dashboard on a domain behind a login. Without one it stays reachable through an SSH tunnel only (Open via tunnel).\nRuns lf traefik setup, which reconfigures landfall's Traefik.",
      fields: [
        {
          name: "domain",
          label: "Domain",
          value: x.traefik.dashboard ?? "",
          mono: true,
          placeholder: x.domains[0] ? `traefik.${x.domains[0]}` : "traefik.example.com",
          hint: x.traefik.dashboard ? "Empty: take the dashboard off its domain." : "Needs an A record pointing at the server.",
          required: !x.traefik.dashboard && "Give a domain, or use the tunnel",
          check: (d) => d && !domainOk(d) && "Not a domain",
        },
        {
          legend: "Login",
          when: (v) => v.domain.trim(),
          fields: [
            {
              row: [
                { name: "user", label: "User", value: "admin", placeholder: "admin", check: (u) => userError(u || "admin") },
                {
                  name: "password",
                  label: `Password (${S.state.rules.minPassword}+ characters)`,
                  type: "password",
                  check: (pw) => pw && passwordError(pw),
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
        {
          name: "http3",
          label: "HTTP/3 (QUIC on 443/udp)",
          type: "check",
          value: x.traefik.http3,
          hint: "Faster on lossy and mobile connections; browsers that can't use it fall back to HTTP/2.",
        },
        {
          name: "accessLog",
          label: "Access log (JSON)",
          type: "check",
          value: x.traefik.accessLog,
          hint: "One line per request in Traefik's output: the Traffic tab counts them.",
        },
        {
          name: "mode",
          label: "Ports",
          type: "select",
          value: x.traefik.hostNetwork ? "host" : "docker",
          options: [
            { value: "docker", label: "Published by Docker (default)" },
            { value: "host", label: "Host network: real client IPs, ufw guards 80/443" },
          ],
        },
        { name: "image", label: "Image", value: x.traefik.image, placeholder: S.state.defaultImage },
        {
          name: "email",
          label: "Let's Encrypt e-mail (optional)",
          value: x.traefik.email ?? "",
          hint: "Only the account contact; Let's Encrypt no longer mails expiry warnings.",
        },
        { name: "staging", label: "Let's Encrypt staging CA (test certificates, browsers warn)", type: "check", value: x.traefik.staging },
      ],
      ok: "Apply",
      onOk: (v) => {
        const argv = [
          "traefik",
          "setup",
          ...sv(n),
          v.http3 ? "--http3" : "--no-http3",
          v.accessLog ? "--access-log" : "--no-access-log",
          v.mode === "host" ? "--host-network" : "--no-host-network",
          v.staging ? "--staging" : "--no-staging",
        ];
        if (v.image.trim()) argv.push("--image", v.image.trim());
        if (v.email.trim()) argv.push("--email", v.email.trim());
        run(argv, reload);
      },
    });
  // lf traefik setup refuses to touch a Traefik the server already had.
  const o = S.overview[n]?.data;
  const foreign = o?.adopted ? o.proxy : "";
  const ts = S.proxy[n]?.data;
  const ctr = ts ? ts.container : o?.traefik ? { name: o.proxy } : null;
  const sites = o?.sites.length ?? 0;
  const removeDlg = () =>
    dialog({
      title: `Remove Traefik from ${n}?`,
      text: `Stops it and removes its config.${sites ? ` ${sites === 1 ? "The site" : `All ${sites} sites`} will be unreachable until it is set up again.` : ""} lf undo puts it back.`,
      fields: [
        {
          name: "certs",
          type: "check",
          label: "Also delete the Let's Encrypt certificates",
          value: false,
          hint: "They come back from Let's Encrypt on the next install, within its rate limits.",
        },
      ],
      ok: "Remove it",
      danger: true,
      onOk: (v) => run(["traefik", "rm", ...sv(n), "-y", ...(v.certs ? ["--certs"] : [])], reload),
    });
  const useDlg = (name: string) =>
    dialog({
      title: `Route sites on ${n} through ${name}?`,
      text: "landfall reads its network, entrypoint and certificate resolver from its flags. Fill them in only when it is configured by a file. That Traefik is never changed.",
      fields: [
        { name: "network", label: "Docker network (optional)", value: "", mono: true, placeholder: "read from its flags" },
        { name: "entrypoint", label: "HTTPS entrypoint (optional)", value: "", mono: true, placeholder: "the one on :443" },
        { name: "resolver", label: "Certificate resolver (optional)", value: "", mono: true, placeholder: "read from its flags" },
      ],
      ok: "Use it",
      onOk: (v) =>
        run(
          ["traefik", "use", name, ...sv(n), ...(["network", "entrypoint", "resolver"] as const).flatMap((k) => (v[k].trim() ? [`--${k}`, v[k].trim()] : []))],
          reload,
        ),
    });
  const dash = o?.dashboard ?? { hosts: x.traefik.dashboard ? [x.traefik.dashboard] : [], tunnel: false };
  const dashArgv = ["traefik", "dashboard", ...sv(n)];
  return (
    <>
      <Card>
        <CardHead>
          Dashboard{" "}
          <Actions>
            {!foreign && (
              <Btn cls="sm" on={dashboard}>
                {dash.hosts.length ? "Domain & login" : "Put on a domain"}
              </Btn>
            )}
          </Actions>
        </CardHead>
        <Body>
          <Kv
            pairs={[
              [
                "domain",
                dash.hosts.length ? (
                  <>
                    {dash.hosts.map((h, k) => (
                      <span key={h}>
                        {k > 0 && ", "}
                        <a href={`https://${h}`} target="_blank" rel="noopener">
                          {h}
                        </a>
                      </span>
                    ))}{" "}
                    <span className="dim">(with its login)</span>
                  </>
                ) : (
                  <span className="dim">none{foreign ? "" : ": only through the tunnel"}</span>
                ),
              ],
              [
                "tunnel",
                dash.tunnel ? (
                  <>
                    <TunnelBtn n={n} argv={dashArgv} label="Open via tunnel" /> <span className={cx("dim", MONO)}>lf traefik dashboard</span>
                  </>
                ) : foreign ? (
                  <span className="dim">
                    route its dashboard (api@internal) to a domain, or run <span className={MONO}>lf traefik dashboard --port &lt;its api port&gt;</span>
                  </span>
                ) : (
                  <span className="dim">
                    none: <span className={MONO}>lf traefik setup</span> adds it
                  </span>
                ),
              ],
            ]}
          />
        </Body>
      </Card>
      <Card>
        <CardHead>
          Traefik
          <Actions>
            {ctr && (
              <Btn cls="sm" title="lf traefik logs -f: certificate errors show up here" on={() => run(["traefik", "logs", ...sv(n), "-f"], { server: n })}>
                Logs
              </Btn>
            )}
            {!foreign && (
              <Btn cls="sm" on={traefikDialog}>
                Settings
              </Btn>
            )}
            <MenuBtn
              title="More for Traefik"
              items={[
                ctr && !foreign
                  ? {
                      label: "Restart",
                      hint: "lf traefik restart",
                      run: () =>
                        confirmDlg({
                          title: `Restart Traefik on ${n}?`,
                          text: "Every site is unreachable for a few seconds.",
                          ok: "Restart",
                          danger: true,
                          onOk: () => run(["traefik", "restart", ...sv(n)], reload),
                        }),
                    }
                  : null,
                ctr || foreign ? "-" : null,
                foreign
                  ? {
                      label: `Stop using ${foreign}`,
                      cls: "danger",
                      hint: "lf traefik rm",
                      run: () =>
                        confirmDlg({
                          title: `Stop routing sites on ${n} through ${foreign}?`,
                          text: "It keeps running and keeps routing the sites until they are redeployed. lf traefik setup installs landfall's own afterwards.",
                          ok: "Stop using it",
                          danger: true,
                          onOk: () => run(["traefik", "rm", ...sv(n), "-y"], reload),
                        }),
                    }
                  : ctr
                    ? { label: "Remove Traefik", cls: "danger", hint: "lf traefik rm", run: removeDlg }
                    : null,
              ]}
            />
          </Actions>
        </CardHead>
        <Body>
          {foreign && (
            <Note>
              Sites go through <b className={MONO}>{foreign}</b>, a Traefik landfall did not install: it is configured in its own files. landfall changes it
              only when you turn its access log on or off.
            </Note>
          )}
          <Kv
            pairs={[
              ["image", x.traefik.summary],
              ["e-mail", x.traefik.email ?? "none"],
              [
                "HTTP/3",
                x.traefik.http3 ? (
                  <>
                    on <span className="dim">(443/udp)</span>
                  </>
                ) : (
                  <span className="dim">off</span>
                ),
              ],
              ["access log", x.traefik.accessLog ? "on (JSON)" : <span className="dim">off</span>],
              ["files", <span className={MONO}>{paths.traefik}/docker-compose.yml</span>],
              [
                "certificates",
                <>
                  <span className={MONO}>{paths.traefik}/letsencrypt/</span> <span className="dim">(kept on reinstall)</span>
                </>,
              ],
            ]}
          />
          <p className={cx("faint", P)}>
            Used when landfall installs or reconfigures its own Traefik. With a Traefik that was already there, landfall only writes{" "}
            <span className={MONO}>{paths.proxy}</span>.
          </p>
        </Body>
      </Card>
      <RoutesCard n={n} useDlg={useDlg} />
      {!foreign && ts?.container && <RedirectsCard n={n} reload={reload} />}
    </>
  );
}

/** lf redirects: hosts the server's Traefik answers with a redirect, with no site behind them. */
function RedirectsCard({ n, reload }: { n: string; reload: { server: string; after: ReturnType<typeof ifOk> } }) {
  const o = S.overview[n]?.data;
  const list = o?.redirects.list ?? [];
  const error = o?.redirects.error;
  const dns = S.dns[n]?.data;
  const main = mainDomain(n);
  /** The host as `lf redirect add` expands it. */
  const hostOf = (v: unknown) => expandHost(String(v ?? "").trim(), main);
  // Checks hosts added since the last check too: each host shows its DNS and HTTPS state.
  useEffect(() => ensureDns(n, o), [n, o]);
  const edit = (r?: ServerRedirect) =>
    dialog({
      title: r ? `Change the redirect of ${r.host}` : `Redirect a host on ${n}`,
      text: "Traefik answers every request for the host with a redirect. No site runs behind it.",
      fields: [
        ...(r
          ? []
          : [
              {
                name: "host",
                label: "Host",
                mono: true,
                placeholder: "old.example.com",
                required: "Which host? For example old.example.com",
                check: (v: unknown) => {
                  const h = hostOf(v);
                  return !h ? "@ means the main domain, and this server has none" : domainOk(h) ? undefined : "not a domain";
                },
                hint: main ? `A bare name is a subdomain of ${main}. Point its DNS at this server.` : "Point its DNS at this server.",
              },
            ]),
        {
          name: "to",
          label: "To",
          mono: true,
          value: r?.to ?? "",
          placeholder: "https://example.com",
          required: "Where to? For example https://example.com",
          preview: (v) => {
            const to = String(v.to ?? "").trim();
            if (!to) return null;
            const host = r?.host ?? (hostOf(v.host) || "old.example.com");
            try {
              const url = redirectTarget(host, to, !!v.path);
              return `${host}/a?b=1 → ${url}${v.path ? "/a?b=1" : ""}`;
            } catch (e) {
              return (e as Error).message;
            }
          },
        },
        { name: "path", label: "Keep the path and query", type: "check", value: r?.path ?? true },
        { name: "temporary", label: "Temporary (302/307: browsers do not remember it)", type: "check", value: r ? !r.permanent : false },
      ],
      ok: r ? "Change" : "Add",
      onOk: (v) =>
        run(
          [
            "redirect",
            "add",
            r?.host ?? String(v.host).trim(),
            String(v.to).trim(),
            ...sv(n),
            ...(v.path ? [] : ["--no-path"]),
            ...(v.temporary ? ["--temporary"] : []),
            "-y",
          ],
          reload,
        ),
    });
  const remove = (r: ServerRedirect) =>
    confirmDlg({
      title: `Remove the redirect of ${r.host}?`,
      text: `${r.host} stops redirecting to ${r.to}. Requests for it fail until a site or redirect takes it again.`,
      ok: "Remove",
      onOk: () => run(["redirect", "rm", r.host, ...sv(n), "-y"], reload),
    });
  const offDns = list.filter((r) => dns?.domains.some((d) => d.domain === r.host && !d.ok));
  return (
    <Card>
      <CardHead>
        Redirects <Sub>hosts sent elsewhere, no site behind them</Sub>
        <Actions>
          <Btn cls="sm" title="lf redirect add" disabled={!!error} on={() => edit()}>
            Add…
          </Btn>
        </Actions>
      </CardHead>
      {error && (
        <Body>
          <Note>{error}. Change it by hand, or remove it, to manage redirects here.</Note>
        </Body>
      )}
      {list.length ? (
        <>
          <Table cols={[["host"], ["to"], ["kind", HIDE], [""]]}>
            {list.map((r) => (
              <tr key={r.host}>
                <td className={MONO}>
                  <DomainChip n={n} d={r.host} />
                </td>
                <td className={cx(MONO, "break-all")}>
                  <a href={r.to} target="_blank" rel="noopener">
                    {r.to}
                  </a>
                  {r.path && <span className="faint">/…</span>}
                </td>
                <td className={cx(HIDE, "whitespace-nowrap")}>
                  <Badge kind={r.permanent ? "ok" : "warn"}>{r.permanent ? "permanent" : "temporary"}</Badge>{" "}
                  {!r.path && (
                    <span className="dim" title="Every request goes to the URL as given">
                      path dropped
                    </span>
                  )}
                </td>
                <td className="text-right whitespace-nowrap">
                  <Btn cls="sm" title="lf redirect add" disabled={!!error} on={() => edit(r)}>
                    Change…
                  </Btn>{" "}
                  <Btn cls="sm" title="lf redirect rm" disabled={!!error} on={() => remove(r)}>
                    Remove…
                  </Btn>
                </td>
              </tr>
            ))}
          </Table>
          {offDns.length > 0 && dns && (
            <Body>
              <Note>
                Point an A record for <b className={MONO}>{offDns.map((r) => r.host).join(", ")}</b> at <b className={MONO}>{dns.ips.join(" or ")}</b>. HTTPS
                waits for it.
              </Note>
            </Body>
          )}
        </>
      ) : (
        !error && (
          <Body className="dim">
            No redirects. Add one to send an old domain to a new one, path and query kept. A site&apos;s own redirects (like www) are in its domain settings.
          </Body>
        )
      )}
    </Card>
  );
}

/** lf traefik status: the container and what it routes; offers a Traefik landfall does not use yet. */
function RoutesCard({ n, useDlg }: { n: string; useDlg: (name: string) => void }) {
  const st = S.proxy[n];
  const wait = pending(st, "reading Traefik's routes…", () => fetchInto("proxy", n, "/traefik"));
  const t = st?.data;
  return (
    <Card>
      <CardHead>
        Routes {t?.container && <Badge kind={t.container.status.startsWith("Up") ? "ok" : "bad"}>{t.container.status}</Badge>}{" "}
        <Sub className={MONO}>lf traefik status</Sub>
      </CardHead>
      {wait ? (
        <Body>{wait}</Body>
      ) : (
        <>
          {t!.foreign && (
            <Body>
              <Note>
                <b className={MONO}>{t!.foreign}</b> is a Traefik on port 443 that landfall does not use.{" "}
                <Btn cls="sm" on={() => useDlg(t!.foreign!)}>
                  Route sites through it
                </Btn>
              </Note>
            </Body>
          )}
          {!t!.container ? (
            <Body className="dim">
              Traefik is not installed.{" "}
              <Btn
                cls="sm"
                title="lf traefik setup"
                on={() =>
                  run(["traefik", "setup", ...sv(n)], {
                    server: n,
                    after: ifOk(() => (load(n, "traefik", true), load(n, "sites", true), fetchInto("proxy", n, "/traefik"))),
                  })
                }
              >
                Install it
              </Btn>
            </Body>
          ) : t!.routes.length ? (
            <Table cols={[["container"], ["rule"], ["entrypoints", HIDE]]}>
              {t!.routes.map((r) => (
                <tr key={`${r.container} ${r.rule}`}>
                  <td>{r.container}</td>
                  <td className={MONO}>{r.rule}</td>
                  <td className={cx(HIDE, "dim")}>{r.entrypoints.join(", ")}</td>
                </tr>
              ))}
            </Table>
          ) : (
            <Body className="dim">{t!.container.name} routes nothing yet.</Body>
          )}
        </>
      )}
    </Card>
  );
}
