import { S, serverNamed, sv } from "../lib/store";
import type { TenantRow, Tenants } from "../lib/types";
import { fetchInto, load } from "../lib/api";
import { ifOk, run } from "../lib/jobs";
import { ACTS, Actions, Badge, Btn, Card, CardHead, Empty, HIDE, MONO, Note, PRE, SR, Sub, cx, pending, Table } from "../ui/kit";
import { MenuBtn } from "../ui/menu";
import { closeDialog, confirmDlg, DBTNS, DFORM, dialog, DTEXT, DTITLE, domainOk, keyError, openDialog, userNameError, words, type Values } from "../ui/dialog";
import { bytes } from "../../../core/lib/format";
import { copy, toast } from "../ui/toast";
import { LIMIT_RULES, publicPortError, rightsText, tenantInvite } from "../../../core/server/tenant-policy";

// Every change is an lf tenant command: the page checks what the CLI would refuse, the CLI decides.

const lf = (n: string, argv: string[]) => run([...argv, ...sv(n)], { server: n, after: ifOk(() => load(n, "tenants", true)) });
const domainsError = (x: string) => {
  const bad = words(x).find((d) => !domainOk(d));
  return bad && `${bad} is not a domain`;
};

const LIMITS = { memory: ["Memory", "2G", ""], cpu: ["CPU", "200%", "100% is one core."], tasks: ["Processes and threads", "2000", ""] } as const;
const LIMIT_KEYS = Object.keys(LIMIT_RULES) as (keyof typeof LIMIT_RULES)[];
const limitFields = (l: TenantRow["limits"] = {}) =>
  LIMIT_KEYS.map((k) => ({
    name: k,
    label: LIMITS[k][0],
    value: l[k] ?? "",
    placeholder: LIMITS[k][1],
    hint: LIMITS[k][2] || undefined,
    mono: true,
    check: (x: unknown) => !!x && !LIMIT_RULES[k].re.test(String(x)) && `Use ${LIMIT_RULES[k].hint}`,
  }));
const limitArgs = (v: Values) => LIMIT_KEYS.flatMap((k) => (String(v[k]).trim() ? [`--${k}`, String(v[k]).trim()] : []));
const limitText = (l: TenantRow["limits"]) => [l?.memory, l?.cpu && `${l.cpu} CPU`, l?.tasks && `${l.tasks} tasks`].filter(Boolean).join(", ") || "none";

export function TenantsView({ n }: { n: string }) {
  const st = S.tenants[n];
  const wait = pending(st, `reading the tenants of ${n}…`);
  if (wait) return wait;
  const v = st!.data!;
  const sized = v.tenants.some((t) => t.disk !== undefined);
  const active = v.tenants.filter((t) => t.active);
  const left = !v.on && (v.tenants.length > 0 || !!v.offState);
  const dash = <span className="faint">–</span>;

  const row = (t: TenantRow) => {
    const rm = () =>
      confirmDlg({
        title: `Remove tenant ${t.user} from ${n}?`,
        text: "Its logins, Docker and routes stop, its open ports close. Its user, sites and volumes stay: Restore brings it back.",
        ok: "Remove tenant",
        danger: true,
        onOk: () => lf(n, ["tenant", "rm", t.user, "-y"]),
      });
    const purge = () =>
      confirmDlg({
        title: `Delete tenant ${t.user} and all its data?`,
        text: `The user goes, with its sites, volumes, images and everything under ${t.user}'s home. This cannot be undone.`,
        ok: "Delete everything",
        danger: true,
        typeToConfirm: t.user,
        onOk: () => lf(n, ["tenant", "rm", t.user, "--purge", "-y"]),
      });
    const stop = () =>
      confirmDlg({
        title: `Stop ${t.user}'s Docker?`,
        text: "All its sites go offline until it starts again.",
        ok: "Stop",
        danger: true,
        onOk: () => lf(n, ["tenant", "stop", t.user, "-y"]),
      });
    return (
      <tr key={t.user}>
        <td>
          <span className={MONO}>{t.user}</span>{" "}
          {!t.active ? <Badge kind="warn">removed</Badge> : t.running ? <Badge kind="ok">running</Badge> : <Badge kind="err">stopped</Badge>}
        </td>
        <td className={MONO}>
          {t.domains.map((d) => (
            <div key={d}>{d}</div>
          ))}
        </td>
        <td>{t.sites ?? dash}</td>
        <td className={HIDE}>{t.containers ?? dash}</td>
        <td className={HIDE}>{t.memory !== undefined ? bytes(t.memory) : dash}</td>
        {sized && <td className={HIDE}>{t.disk !== undefined ? bytes(t.disk) : dash}</td>}
        <td className={cx(MONO, "faint", HIDE)}>{limitText(t.limits)}</td>
        <td className={cx(MONO, "faint", HIDE)}>{rightsText(t.rights)}</td>
        <td className={ACTS}>
          <MenuBtn
            title={`Actions for ${t.user}`}
            items={[
              t.active && { label: "Invite…", hint: "lf tenant invite", run: () => inviteDlg(n, t) },
              t.active && "-",
              t.active && { label: "Domains…", hint: "lf tenant domains", run: () => domainsDlg(n, t) },
              t.active && { label: "Limits…", hint: "lf tenant limits", run: () => limitsDlg(n, t) },
              t.active && { label: "Rights…", hint: "lf tenant rights", run: () => rightsDlg(n, v, t) },
              t.active && "-",
              t.active && t.running && { label: "Stop Docker", cls: "danger", hint: "lf tenant stop", run: stop },
              t.active && !t.running && { label: "Start Docker", hint: "lf tenant start", run: () => lf(n, ["tenant", "start", t.user]) },
              t.active && { label: "Remove tenant", cls: "danger", hint: "lf tenant rm", run: rm },
              !t.active && { label: "Restore", hint: "lf tenant restore", run: () => lf(n, ["tenant", "restore", t.user]) },
              { label: "Delete with its data…", cls: "danger", hint: "lf tenant rm --purge", run: purge },
            ]}
          />
        </td>
      </tr>
    );
  };

  return (
    <>
      <Card>
        <CardHead>
          Tenants <Badge>{v.tenants.length}</Badge>{" "}
          <Sub>
            users with their own rootless Docker, sites and Traefik, as <code>lf tenant ls</code>
          </Sub>
          <Actions>
            {v.tenants.length > 0 && (
              <Btn cls="sm" title="lf tenant ls --sizes: du over every tenant's files" on={() => void fetchInto("tenants", n, "/tenants?sizes=1")}>
                Measure disk
              </Btn>
            )}
            {v.tenants.length > 0 && (
              <Btn cls="sm" on={() => addDlg(n, v)}>
                Add tenant
              </Btn>
            )}
            {(v.on || left) && (
              <MenuBtn
                title="Tenant mode"
                items={[
                  v.on && {
                    label: "Turn tenants off…",
                    cls: "danger",
                    hint: "lf tenant off",
                    title: active.length ? `Remove ${active.map((t) => t.user).join(", ")} first` : undefined,
                    run: () => (active.length ? toast(`Remove ${active.map((t) => t.user).join(", ")} first`) : offDlg(n)),
                  },
                  { label: "Delete all tenants…", cls: "danger", hint: "lf tenant off --purge", run: () => purgeAllDlg(n, v) },
                ]}
              />
            )}
          </Actions>
        </CardHead>
        {v.tenants.length ? (
          <Table
            head={
              <>
                <th>Tenant</th>
                <th>Domains</th>
                <th>Sites</th>
                <th className={HIDE}>Containers</th>
                <th className={HIDE}>Memory</th>
                {sized && <th className={HIDE}>Disk</th>}
                <th className={HIDE}>Limits</th>
                <th className={HIDE}>Rights</th>
                <th>
                  <span className={SR}>Actions</span>
                </th>
              </>
            }
          >
            {v.tenants.map(row)}
          </Table>
        ) : (
          <NoTenants n={n} v={v} />
        )}
      </Card>
      {left && (
        <Note>
          Tenants are off on {n}, but{" "}
          {v.tenants.length ? `${v.tenants.map((t) => t.user).join(", ")} still have their users and data` : "their files are still there"}
          {v.offState?.packages.length ? `, and the packages ${v.offState.packages.join(" ")} are installed` : ""}.{" "}
          <Btn cls="sm danger" on={() => purgeAllDlg(n, v)}>
            Delete all of it…
          </Btn>
        </Note>
      )}
      {v.on && (
        <Note>
          The central Traefik on {n} runs on the host network and passes each tenant's domains, still encrypted, to that tenant's own Traefik.{" "}
          {v.ufw
            ? "ufw keeps the tenants' ports closed, except the ports you give them."
            : "The provider's firewall must keep ports other than 22, 80 and 443 closed."}
        </Note>
      )}
    </>
  );
}

function NoTenants({ n, v }: { n: string; v: Tenants }) {
  const f = S.facts[n]?.data;
  const why = f?.why?.tenants;
  const fw = v.ufw ? "ufw is active" : `no ufw: ${f?.cloud?.firewall ?? "the provider's firewall"} must keep ports closed`;
  const facts = [
    ["Rootless Docker", "its own daemon, containers, images and volumes, as its own user"],
    ["Its own Traefik", "certificates for the domains you give it, nothing else"],
    ["Its own lf", "deploy, logs, rollback, volumes, autodeploy from the tenant's machine"],
    ["Limits and rights", "memory, CPU and processes; cron and public ports, set by you"],
  ];
  return (
    <Empty title="Share this server">
      <p>A tenant is a user who deploys its own sites with lf, under domains you give it. It cannot see your sites or the other tenants.</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-left text-md m-0 max-w-[58ch]">
        {facts.map(([k, x]) => (
          <div key={k} className="contents">
            <dt className="text-fg font-medium">{k}</dt>
            <dd className="m-0">{x}</dd>
          </div>
        ))}
      </dl>
      <p className="text-md">
        {why ? (
          <>
            Not on {n}: {why}.
          </>
        ) : (
          <>
            The first tenant moves the central Traefik to the host network: {n}'s sites are offline for a few seconds. {fw}.
          </>
        )}
      </p>
      {!why && (
        <Btn cls="primary" on={() => addDlg(n, v)}>
          Add tenant
        </Btn>
      )}
    </Empty>
  );
}

function addDlg(n: string, v: Tenants) {
  const first = !v.on;
  const cloud = S.facts[n]?.data?.cloud?.firewall;
  dialog({
    title: `Add a tenant to ${n}`,
    text: [
      "A user with its own rootless Docker, sites and Traefik. It deploys with lf like you do, only under the domains you give it.",
      first ? `This is the first tenant: the central Traefik moves to the host network, and ${n}'s sites are offline for a few seconds.` : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    fields: [
      {
        name: "name",
        label: "User",
        value: "",
        placeholder: "anna",
        mono: true,
        required: true,
        check: (x) => userNameError(String(x)) || (v.tenants.some((t) => t.user === x) && `${x} is a tenant already`),
      },
      {
        name: "key",
        label: "Public key",
        type: "textarea",
        value: "",
        placeholder: "ssh-ed25519 AAAA… anna@laptop",
        required: true,
        hint: "The tenant's own key: it logs in with it. lf keygen makes one.",
        check: (x) => keyError(String(x)),
      },
      {
        name: "domains",
        label: "Domains",
        value: "",
        placeholder: "anna.dev *.anna.dev",
        mono: true,
        required: true,
        hint: "Separated by spaces. *.anna.dev covers every subdomain.",
        check: (x) => domainsError(String(x)),
      },
      ...limitFields(),
      ...(v.ufw
        ? []
        : [
            {
              name: "provider",
              label: `${cloud ?? "The provider's firewall"} keeps every port but 22, 80 and 443 closed`,
              type: "check" as const,
              value: false,
              hint: "ufw is not active. Tenants can open ports of their own: something must keep them closed.",
              check: (x: unknown) => !x && "Enable ufw first (Firewall), or confirm the provider's firewall",
            },
          ]),
    ],
    ok: "Add tenant",
    danger: first,
    onOk: (x) => {
      const user = String(x.name).trim();
      const domains = words(String(x.domains));
      run(
        [
          "tenant",
          "add",
          user,
          "--key",
          String(x.key).trim().split("\n")[0],
          ...domains.flatMap((d) => ["--domain", d]),
          ...limitArgs(x),
          ...(x.provider ? ["--provider-firewall"] : []),
          ...(first ? ["--force"] : []),
          ...sv(n),
        ],
        {
          server: n,
          after: ifOk(() => {
            void load(n, "tenants", true);
            inviteDlg(n, { user, domains });
          }),
        },
      );
    },
  });
}

function inviteDlg(n: string, t: Pick<TenantRow, "user" | "domains" | "rights">) {
  const saved = serverNamed(n)?.saved;
  const text = tenantInvite({ user: t.user, host: saved?.host ?? n, port: saved?.port, domains: t.domains, rights: t.rights });
  openDialog(
    <form method="dialog" className={DFORM} onSubmit={(e) => (e.preventDefault(), closeDialog())}>
      <h2 id="dlg-title" className={DTITLE}>
        Invite {t.user}
      </h2>
      <div className={DTEXT}>
        Send this to {t.user}: installing lf, the login, ssh config, Traefik, DNS and the first deploy. <code>lf tenant invite {t.user}</code> prints the same.
      </div>
      <pre className={cx(PRE, "max-h-[50vh] text-sm")}>{text}</pre>
      <div className={DBTNS}>
        <Btn on={() => copy(text, "the invite")}>Copy</Btn>
        <Btn type="submit" cls="primary">
          Done
        </Btn>
      </div>
    </form>,
    "wide",
  );
}

function domainsDlg(n: string, t: TenantRow) {
  dialog({
    title: `Domains of ${t.user}`,
    text: "The central Traefik passes these to the tenant's own Traefik. Removing one takes it offline for the tenant.",
    fields: [{ name: "domains", label: "Domains", value: t.domains.join(" "), mono: true, required: true, check: (x) => domainsError(String(x)) }],
    ok: "Save",
    onOk: (x) => {
      const want = words(String(x.domains));
      const add = want.filter((d) => !t.domains.includes(d));
      const rm = t.domains.filter((d) => !want.includes(d));
      if (add.length || rm.length) lf(n, ["tenant", "domains", t.user, ...add.flatMap((d) => ["--add", d]), ...rm.flatMap((d) => ["--rm", d])]);
    },
  });
}

function limitsDlg(n: string, t: TenantRow) {
  dialog({
    title: `Limits of ${t.user}`,
    text: "What all of the tenant's processes may use together. Empty keeps a limit as it is; none removes it.",
    fields: limitFields(t.limits),
    ok: "Save",
    onOk: (x) => {
      const args = limitArgs(x);
      if (args.length) lf(n, ["tenant", "limits", t.user, ...args]);
    },
  });
}

function rightsDlg(n: string, v: Tenants, t: TenantRow) {
  const cron = t.rights?.cron !== false;
  const had = t.rights?.ports ?? [];
  const taken = (p: string) => v.tenants.find((o) => o.user !== t.user && o.rights?.ports?.includes(p))?.user;
  dialog({
    title: `Rights of ${t.user}`,
    text: "What the tenant may do beyond its domains and limits.",
    fields: [
      {
        name: "cron",
        label: "Cron",
        type: "check",
        value: cron,
        hint: "Off: no crontab for the tenant, so no lf autodeploy and no scheduled volume backups.",
      },
      {
        name: "ports",
        label: "Public ports",
        value: had.join(" "),
        placeholder: "25565/tcp",
        mono: true,
        hint: v.ufw
          ? "ufw opens these for the tenant's own containers, published as 0.0.0.0:PORT:PORT. 80 and 443 go through Traefik."
          : "ufw is not active: open these in the provider's firewall too.",
        check: (x) =>
          words(String(x))
            .map((p) => publicPortError(p) ?? (taken(p) && `${p} is open for ${taken(p)}`))
            .find(Boolean),
      },
    ],
    ok: "Save",
    onOk: (x) => {
      const want = words(String(x.ports));
      const args = [
        ...(!!x.cron !== cron ? [x.cron ? "--cron" : "--no-cron"] : []),
        ...want.filter((p) => !had.includes(p)).flatMap((p) => ["--open", p]),
        ...had.filter((p) => !want.includes(p)).flatMap((p) => ["--close", p]),
      ];
      if (args.length) lf(n, ["tenant", "rights", t.user, ...args]);
    },
  });
}

function offDlg(n: string) {
  confirmDlg({
    title: `Turn tenants off on ${n}?`,
    text: "Undoes what the first tenant changed: the central Traefik leaves the host network (a short outage), the ufw rules, systemd and AppArmor files go. Removed tenants keep their users and data: Delete all tenants removes them too.",
    ok: "Turn off",
    danger: true,
    onOk: () => lf(n, ["tenant", "off", "-y"]),
  });
}

function purgeAllDlg(n: string, v: Tenants) {
  const users = v.tenants.map((t) => t.user);
  confirmDlg({
    title: `Delete all tenants on ${n}?`,
    text: [
      users.length ? `Deletes ${users.join(", ")} with their users, sites, volumes and images.` : "Deletes what is left of the tenants.",
      v.on ? "Undoes what the first tenant changed: the central Traefik leaves the host network (a short outage)." : "",
      "Removes the packages the first tenant installed, unless other packages need them, and /opt/landfall/tenants. This cannot be undone.",
    ]
      .filter(Boolean)
      .join(" "),
    ok: "Delete everything",
    danger: true,
    typeToConfirm: n,
    onOk: () => lf(n, ["tenant", "off", "--purge", "-y"]),
  });
}
