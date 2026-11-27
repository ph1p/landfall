import { S, serverNamed, sv } from "../lib/store";
import type { TenantRow, Tenants } from "../lib/types";
import { fetchInto, load } from "../lib/api";
import { ifOk, run } from "../lib/jobs";
import { ACTS, Actions, Badge, Btn, Card, CardHead, HIDE, MONO, Note, SR, Sub, cx, pending, Table } from "../ui/kit";
import { MenuBtn } from "../ui/menu";
import { confirmDlg, dialog, domainOk, keyError, type Values } from "../ui/dialog";
import { bytes } from "../../../core/lib/format";
import { copy } from "./domains";
import { toast } from "../ui/toast";
import { LIMIT_RULES } from "../../../core/server/tenant-policy";

// Every change is an lf tenant command: the page checks what the CLI would refuse, the CLI decides.

const lf = (n: string, argv: string[]) => run([...argv, ...sv(n)], { server: n, after: ifOk(() => load(n, "tenants", true)) });
const nameError = (x: string) => !new RegExp(S.state.rules.userName).test(x) && "Lowercase letters, digits, _ and -, starting with a letter";
const domainsOf = (x: string) => x.split(/[\s,]+/).filter(Boolean);
const domainsError = (x: string) => {
  const bad = domainsOf(x).find((d) => !domainOk(d));
  return bad && `${bad} is not a domain`;
};
const limitError = (k: keyof typeof LIMIT_RULES) => (x: string) => x && !LIMIT_RULES[k].re.test(x) && `Use ${LIMIT_RULES[k].hint}`;
const limitFields = (l: TenantRow["limits"] = {}) => [
  {
    name: "memory",
    label: "Memory",
    value: l.memory ?? "",
    placeholder: "2G",
    mono: true,
    check: limitError("memory"),
  },
  {
    name: "cpu",
    label: "CPU",
    value: l.cpu ?? "",
    placeholder: "200%",
    mono: true,
    hint: "100% is one core.",
    check: limitError("cpu"),
  },
  {
    name: "tasks",
    label: "Processes and threads",
    value: l.tasks ?? "",
    placeholder: "2000",
    mono: true,
    check: limitError("tasks"),
  },
];
const limitArgs = (v: Values) => (["memory", "cpu", "tasks"] as const).flatMap((k) => (String(v[k]).trim() ? [`--${k}`, String(v[k]).trim()] : []));

export function TenantsView({ n }: { n: string }) {
  const st = S.tenants[n];
  const wait = pending(st, `reading the tenants of ${n}…`);
  if (wait) return wait;
  const v = st!.data!;
  const host = serverNamed(n)?.saved?.host ?? n;
  const sized = v.tenants.some((t) => t.disk !== undefined);
  const active = v.tenants.filter((t) => t.active);

  const row = (t: TenantRow) => {
    const rm = () =>
      confirmDlg({
        title: `Remove tenant ${t.user} from ${n}?`,
        text: "Its logins, Docker and routes stop. Its user, sites and volumes stay: Restore brings it back.",
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
        onOk: () => lf(n, ["tenant", "stop", t.user]),
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
        <td>{t.sites ?? <span className="faint">–</span>}</td>
        <td className={HIDE}>{t.containers ?? <span className="faint">–</span>}</td>
        <td className={HIDE}>{t.memory !== undefined ? bytes(t.memory) : <span className="faint">–</span>}</td>
        {sized && <td className={HIDE}>{t.disk !== undefined ? bytes(t.disk) : <span className="faint">–</span>}</td>}
        <td className={cx(MONO, "faint", HIDE)}>
          {[t.limits?.memory, t.limits?.cpu && `${t.limits.cpu} CPU`, t.limits?.tasks && `${t.limits.tasks} tasks`].filter(Boolean).join(", ") || "none"}
        </td>
        <td className={cx(MONO, "faint", HIDE)}>{t.port}</td>
        <td className={ACTS}>
          <MenuBtn
            title={`Actions for ${t.user}`}
            items={[
              t.active && { label: "Domains…", hint: "lf tenant domains", run: () => domainsDlg(n, t) },
              t.active && { label: "Limits…", hint: "lf tenant limits", run: () => limitsDlg(n, t) },
              t.active && { label: `Copy: lf server add ${t.user}@${host}`, run: () => copy(`lf server add ${t.user}@${host}`) },
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
            <Btn cls="sm" on={() => addDlg(n, v)}>
              Add tenant
            </Btn>
            {v.on && (
              <MenuBtn
                title="Tenant mode"
                items={[
                  {
                    label: "Turn tenants off…",
                    cls: "danger",
                    hint: "lf tenant off",
                    title: active.length ? `Remove ${active.map((t) => t.user).join(", ")} first` : undefined,
                    run: () => (active.length ? toast(`Remove ${active.map((t) => t.user).join(", ")} first`) : offDlg(n)),
                  },
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
                <th className={HIDE}>Port</th>
                <th>
                  <span className={SR}>Actions</span>
                </th>
              </>
            }
          >
            {v.tenants.map(row)}
          </Table>
        ) : (
          <p className="faint px-4 pb-4">
            No tenants. A tenant is a user who deploys its own sites with its own Docker, under domains you give it, and cannot see the others.
          </p>
        )}
      </Card>
      {v.on && (
        <Note>
          The central Traefik on {n} runs on the host network and passes each tenant's domains, still encrypted, to that tenant's own Traefik.{" "}
          {v.ufw ? "ufw keeps the tenants' ports closed." : "The provider's firewall must keep ports other than 22, 80 and 443 closed."}
        </Note>
      )}
    </>
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
        check: (x) => nameError(String(x)) || (v.tenants.some((t) => t.user === x) && `${x} is a tenant already`),
      },
      {
        name: "key",
        label: "Public key",
        type: "textarea",
        value: "",
        placeholder: "ssh-ed25519 AAAA… anna@laptop",
        required: true,
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
    onOk: (x) =>
      lf(n, [
        "tenant",
        "add",
        String(x.name).trim(),
        "--key",
        String(x.key).trim().split("\n")[0],
        ...domainsOf(String(x.domains)).flatMap((d) => ["--domain", d]),
        ...limitArgs(x),
        ...(x.provider ? ["--provider-firewall"] : []),
        ...(first ? ["--force"] : []),
      ]),
  });
}

function domainsDlg(n: string, t: TenantRow) {
  dialog({
    title: `Domains of ${t.user}`,
    text: "The central Traefik passes these to the tenant's own Traefik. Removing one takes it offline for the tenant.",
    fields: [{ name: "domains", label: "Domains", value: t.domains.join(" "), mono: true, required: true, check: (x) => domainsError(String(x)) }],
    ok: "Save",
    onOk: (x) => {
      const want = domainsOf(String(x.domains));
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

function offDlg(n: string) {
  confirmDlg({
    title: `Turn tenants off on ${n}?`,
    text: "Undoes what the first tenant changed: the central Traefik leaves the host network (a short outage), the ufw rules, systemd and AppArmor files go. Removed tenants keep their users and data.",
    ok: "Turn off",
    danger: true,
    onOk: () => lf(n, ["tenant", "off", "-y"]),
  });
}
