import type { ReactNode } from "react";
import { S, plural, render, sv } from "../lib/store";
import type { Advice, SystemInfo, SystemService } from "../lib/types";
import { run } from "../lib/jobs";
import { ACTS, Actions, cmds, Badge, Body, Btn, Card, CardHead, HIDE, Kv, MONO, Note, SR, Scroll, Sub, cx, pending, Table } from "../ui/kit";
import { MenuBtn } from "../ui/menu";
import { confirmDlg, dialog, keyError } from "../ui/dialog";
import { size } from "./shared";
import { KEY_SERVICES, serviceName } from "../../../core/status";

// ---- system ----------------------------------------------------------------

const SVC_FAILED = (s: SystemService) => s.active === "failed" || s.active === "crashed";
const SVC_UP = (s: SystemService) => s.active === "active" || s.active === "started";
// What keeps the server and its sites running: shown first, the rest behind "all".
const isKey = (x: SystemService) => KEY_SERVICES.includes(serviceName(x.unit));

export function SystemView({ n }: { n: string }) {
  const st = S.system[n];
  const wait = pending(st, `reading ${n}…`);
  if (wait) return wait;
  const i = st!.data!;
  const s = sv(n);
  const go_ = (argv: string[]) => run([...argv, ...s], { server: n });

  const swapTotal = i.swap.reduce((t, x) => t + x.size, 0);
  const d = i.docker;
  // Change buttons only where the CLI would do it: as admin, and not on a system that keeps it itself.
  const adm = i.root,
    set = adm && !i.managed;
  const may = (ok: unknown, node: ReactNode) => (ok ? node : null);
  const basics = (
    <Card>
      <CardHead>Basics</CardHead>
      <Body>
        <Kv
          pairs={[
            [
              "Host name",
              <>
                <span className={MONO}>{i.hostname}</span>{" "}
                {may(
                  set,
                  <Btn cls="ghost sm" on={() => renameHost(n, i.hostname)}>
                    Change
                  </Btn>,
                )}
              </>,
            ],
            [
              "Time zone",
              <>
                {i.timezone} <span className="faint">· {i.time}</span>{" "}
                {may(
                  set,
                  <Btn cls="ghost sm" on={() => changeTz(n, i.timezone)}>
                    Change
                  </Btn>,
                )}
              </>,
            ],
            [
              "Clock",
              i.ntp === true ? (
                <Badge kind="ok">synced</Badge>
              ) : i.ntp === false ? (
                <Badge kind="warn">not synced</Badge>
              ) : (
                <span className="faint">unknown</span>
              ),
            ],
            [
              "Swap",
              <>
                {swapTotal ? (
                  <>
                    {size(swapTotal)} <span className="faint">{i.swap.map((x) => `${x.file} · ${size(x.used)} used`).join(", ")}</span>
                  </>
                ) : (
                  <>
                    <Badge kind={i.mem < 4 * 1024 ** 3 ? "warn" : ""}>none</Badge> <span className="faint">{size(i.mem)} memory</span>
                  </>
                )}{" "}
                {!set ? null : i.swap.some((x) => x.file === "/swapfile") ? (
                  <Btn
                    cls="ghost sm danger"
                    on={() =>
                      confirmDlg({
                        title: `Remove the swap file on ${n}?`,
                        text: "What is swapped out moves back to memory first.",
                        ok: "Remove it",
                        danger: true,
                        onOk: () => go_(["swap", "off", "-y"]),
                      })
                    }
                  >
                    Remove
                  </Btn>
                ) : swapTotal ? null : (
                  <Btn cls="ghost sm" on={() => addSwapDlg(n, i)}>
                    Add
                  </Btn>
                )}
              </>,
            ],
            [
              "Docker logs",
              !d ? (
                <span className="faint">no docker</span>
              ) : (
                <>
                  {d.maxSize ? `${d.maxSize} × ${d.maxFile ?? 1} per container` : d.driver === "json-file" ? <Badge kind="warn">unlimited</Badge> : ""}{" "}
                  <span className="faint">{d.driver}</span>{" "}
                  {d.daemonError || !set ? null : (
                    <Btn cls="ghost sm" on={() => logLimitDlg(n, d)}>
                      {d.maxSize ? "Change" : "Limit"}
                    </Btn>
                  )}
                </>
              ),
            ],
          ]}
        />
        {d?.daemonError && (
          <Note kind="bad" className="mt-3 mb-0">
            {d.daemonError}
          </Note>
        )}
        {i.managed && <p className="faint mt-3 mb-0">{i.managed}.</p>}
        {!i.root && (
          <p className="faint mt-3 mb-0">
            {i.user} has no passwordless sudo and root's key does not work: other users' keys and Docker's settings may be missing.
          </p>
        )}
      </Body>
    </Card>
  );

  let services: ReactNode = null;
  if (i.init !== "other") {
    const all = S.allSvcs[n];
    const shown = i.services
      .filter((x) => all || SVC_FAILED(x) || isKey(x) || (i.init === "openrc" && SVC_UP(x)))
      .sort((a, b) => +SVC_FAILED(b) - +SVC_FAILED(a) || +isKey(b) - +isKey(a) || a.unit.localeCompare(b.unit));
    const nFailed = i.services.filter(SVC_FAILED).length;
    const row = (x: SystemService) => {
      const u = serviceName(x.unit);
      const ssh = /^sshd?$/.test(u),
        core = /^(docker|containerd)$/.test(u);
      const stop = () =>
        confirmDlg({
          title: `Stop ${u} on ${n}?`,
          text: ssh
            ? "New ssh logins fail until it is started again (from the provider's console)."
            : core
              ? "Every site goes down until it is started again."
              : "It stays stopped until started again, or until the next boot if it is enabled.",
          ok: "Stop it",
          danger: true,
          onOk: () => go_(["services", "stop", u, "-y", ...(ssh ? ["--force"] : [])]),
        });
      const restart = () =>
        core
          ? confirmDlg({
              title: `Restart ${u} on ${n}?`,
              text: "Every site goes down for a moment.",
              ok: "Restart",
              danger: true,
              onOk: () => go_(["services", "restart", u, "-y"]),
            })
          : void go_(["services", "restart", u]);
      const kind = SVC_FAILED(x) ? "bad" : SVC_UP(x) ? "ok" : "";
      return (
        <tr key={x.unit}>
          <td className={MONO}>{u}</td>
          <td>
            <Badge kind={kind}>{x.sub || x.active}</Badge>
          </td>
          {i.init === "systemd" && <td className={cx("faint", HIDE)}>{x.enabled ?? ""}</td>}
          <td className={cx("dim", HIDE)}>{x.description}</td>
          <td className={ACTS}>
            <Btn cls="sm" on={() => run(["services", "logs", u, "-n", "200", ...s], { server: n })}>
              Logs
            </Btn>
            {may(
              adm,
              <MenuBtn
                title={`Actions for ${u}`}
                items={[
                  { label: "Restart", run: restart },
                  SVC_UP(x) ? { label: "Stop", cls: "danger", run: stop } : { label: "Start", run: () => void go_(["services", "start", u]) },
                ]}
              />,
            )}
          </td>
        </tr>
      );
    };
    services = (
      <Card>
        <CardHead>
          Services {nFailed > 0 && <Badge kind="bad">{nFailed} failed</Badge>} <Sub>{i.init}</Sub>
          <Actions>
            <Btn cls="sm" on={() => ((S.allSvcs = { ...S.allSvcs, [n]: !all }), render())}>
              {all ? "Fewer" : `All ${i.services.length}`}
            </Btn>
          </Actions>
        </CardHead>
        <Table
          head={
            <>
              <th>Service</th>
              <th>State</th>
              {i.init === "systemd" && <th className={HIDE}>Boot</th>}
              <th className={HIDE}>Description</th>
              <th>
                <span className={SR}>Actions</span>
              </th>
            </>
          }
        >
          {shown.length ? (
            shown.map(row)
          ) : (
            <tr>
              <td colSpan={5} className="dim">
                none
              </td>
            </tr>
          )}
        </Table>
      </Card>
    );
  }

  const keys = (
    <Card>
      <CardHead>
        SSH keys <Badge>{i.keys.length}</Badge> <Sub>who may log in</Sub>
        <Actions>
          <Btn cls="sm" on={() => addKeyDlg(n)}>
            Add key
          </Btn>
        </Actions>
      </CardHead>
      <Table
        head={
          <>
            <th>User</th>
            <th>Comment</th>
            <th className={HIDE}>Key</th>
            <th>
              <span className={SR}>Actions</span>
            </th>
          </>
        }
      >
        {i.keys.length ? (
          i.keys.map((k) => {
            const label = k.comment || k.fingerprint.slice(7, 19);
            const rm = () =>
              confirmDlg({
                title: `Remove ${label} from ${k.user}?`,
                text: k.mine ? "This is the key this machine logs in with: removing it can lock you out." : `${k.type} ${k.fingerprint}`,
                ok: "Remove it",
                danger: true,
                onOk: () => go_(["keys", "rm", k.fingerprint, "--user", k.user, "-y", ...(k.mine ? ["--force"] : [])]),
              });
            return (
              <tr key={`${k.user}${k.fingerprint}`}>
                <td>{k.user}</td>
                <td>
                  {k.mine && (
                    <>
                      <Badge kind="ok" title="This machine logs in with it">
                        this machine
                      </Badge>{" "}
                    </>
                  )}
                  {k.comment || ""}
                  {k.options && <div className={cx("faint", MONO)}>{k.options}</div>}
                </td>
                <td className={cx(MONO, "faint", HIDE)}>
                  {k.type.replace(/^ssh-/, "")} {k.fingerprint.slice(7, 23)}…
                </td>
                <td className={ACTS}>
                  {may(
                    adm || k.user === i.user,
                    <Btn cls="sm danger" on={rm}>
                      Remove
                    </Btn>,
                  )}
                </td>
              </tr>
            );
          })
        ) : (
          <tr>
            <td colSpan={4} className="dim">
              no keys found
            </td>
          </tr>
        )}
      </Table>
    </Card>
  );

  return (
    <>
      {securityCard(n, i)}
      {basics}
      {services}
      {keys}
    </>
  );
}

export function rebootDlg(n: string) {
  confirmDlg({
    title: `Reboot ${n}?`,
    text: "Its sites are offline for a minute or two. Waits until it is back and checks its containers run again.",
    ok: "Reboot",
    danger: true,
    onOk: () => run(["reboot", ...sv(n), "-y"], { server: n }),
  });
}

const LEVEL: Record<string, string> = { risk: "bad", warn: "warn", info: "" };
/** What `lf security` says, with its fixes as buttons. */
function securityCard(n: string, i: SystemInfo) {
  const adv = i.advice ?? [];
  const fix = (a: Advice) => {
    const f = a.fix;
    if (!f) return null;
    // A key pair for someone else: say where it goes before making it.
    if (f.user)
      return (
        <Btn cls="sm" on={() => addKeyDlg(n, f.user, true)}>
          {f.label}
        </Btn>
      );
    if (f.argv[0] === "reboot")
      return (
        <Btn cls="sm" on={() => rebootDlg(n)}>
          {f.label}
        </Btn>
      );
    return (
      <Btn
        cls="sm"
        on={() =>
          f.confirm
            ? confirmDlg({
                title: `${a.title}: ${f.label.toLowerCase()} on ${n}?`,
                text: f.confirm,
                ok: f.label,
                onOk: () => run([...f.argv, "-y"], { server: n }),
              })
            : void run(f.argv, { server: n })
        }
      >
        {f.label}
      </Btn>
    );
  };
  const risks = adv.filter((a) => a.level === "risk").length;
  return (
    <Card>
      <CardHead>
        Security {adv.length ? <Badge kind={risks ? "bad" : "warn"}>{plural(adv.length, "thing")} to look at</Badge> : <Badge kind="ok">nothing to fix</Badge>}{" "}
        <Sub className={MONO}>lf security</Sub>
      </CardHead>
      {adv.length ? (
        <Scroll>
          <table>
            <tbody>
              {adv.map((a) => (
                <tr key={a.title}>
                  <td>
                    <Badge kind={LEVEL[a.level]}>{a.level}</Badge>
                  </td>
                  <td>
                    <b>{a.title}</b>
                    <div className="dim">{cmds(a.why)}</div>
                  </td>
                  <td className={ACTS}>{fix(a)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Scroll>
      ) : (
        <Body className="dim">
          SSH takes keys only{i.security.firewall === "active" ? ", the firewall is on" : ""}
          {i.fail2ban === "running" ? ", fail2ban runs" : ""}
          {i.security.autoUpdates ? " and security updates install themselves" : ""}.
        </Body>
      )}
    </Card>
  );
}

function renameHost(n: string, old: string) {
  dialog({
    title: `Rename ${n}`,
    text: "The server's own host name: what its shell prompt and logs show. Your ssh alias stays as it is.",
    fields: [
      {
        name: "name",
        label: "Host name",
        value: old,
        placeholder: "web-1",
        mono: true,
        required: true,
        check: (x) => !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i.test(x) && "Letters, digits and -, up to 63, no dots",
      },
    ],
    ok: "Rename",
    onOk: (v) => {
      const name = v.name.trim();
      if (name !== old) run(["hostname", name, ...sv(n)], { server: n });
    },
  });
}
function changeTz(n: string, old: string) {
  dialog({
    title: `Time zone of ${n}`,
    text: "Cron jobs, logs and the clock in containers that read it follow it.",
    fields: [
      {
        name: "tz",
        label: "Time zone",
        value: old,
        placeholder: "Europe/Berlin, UTC",
        hint: `Yours is ${Intl.DateTimeFormat().resolvedOptions().timeZone}.`,
        required: true,
        check: (x) => !/^[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+)*$/.test(x) && "A name like Europe/Berlin or UTC",
      },
    ],
    ok: "Change",
    onOk: (v) => {
      const tz = v.tz.trim();
      if (tz !== old) run(["timezone", tz, ...sv(n)], { server: n });
    },
  });
}
function addSwapDlg(n: string, i: SystemInfo) {
  const gb = 1024 ** 3;
  // Rule of thumb: as much as memory up to 2 GB, never more than a tenth of the free disk.
  const pick = Math.max(0.5, Math.min(i.mem > 2 * gb ? 2 : 1, Math.floor((i.diskFree / gb / 10) * 2) / 2));
  dialog({
    title: `Add swap to ${n}`,
    text: `A swap file at /swapfile, on at boot. It keeps the server alive when memory runs out (slowly instead of killing processes). ${size(i.diskFree)} free on the disk.`,
    fields: [
      {
        name: "size",
        label: "Size",
        value: `${pick >= 1 ? pick + "G" : "512M"}`,
        placeholder: "1G, 512M",
        required: true,
        check: (x) => !/^\d+(\.\d+)?\s*[mg]$/i.test(x) && "A size like 1G or 512M",
      },
    ],
    ok: "Add swap",
    onOk: (v) => {
      run(["swap", v.size.trim(), ...sv(n)], { server: n });
    },
  });
}
function logLimitDlg(n: string, d: NonNullable<SystemInfo["docker"]>) {
  dialog({
    title: `Docker log limit on ${n}`,
    text: "Caps the log Docker keeps per container. It applies to containers created afterwards: redeploy or restart sites to apply it to them.",
    fields: [
      {
        row: [
          {
            name: "size",
            label: "Per file",
            value: d.maxSize ?? "10m",
            placeholder: "10m",
            hint: "k, m or g. Empty: no limit.",
            check: (x) => x && !/^\d+[kmg]$/i.test(x) && "A size like 10m",
          },
          {
            name: "files",
            label: "Files kept",
            type: "number",
            value: String(d.maxFile ?? 3),
            placeholder: "3",
            required: true,
            check: (x) => !/^\d+$/.test(x) && "A number",
          },
        ],
      },
      { name: "restart", type: "check", label: "Restart Docker now", hint: "Sites go down for a moment. Otherwise it applies on Docker's next start." },
    ],
    ok: "Save",
    onOk: (v) => {
      const sz = v.size.trim().toLowerCase();
      run(["log-limit", sz || "off", "--files", v.files.trim(), ...(v.restart ? ["--restart", "-y"] : []), ...sv(n)], { server: n });
    },
  });
}
export function addKeyDlg(n: string, user = "", generate = false) {
  dialog({
    title: `Add an SSH key to ${n}`,
    text: "Paste a public key (the .pub file, one line), or make a new pair on this computer. Whoever holds the private key can log in.",
    fields: [
      {
        name: "generate",
        label: "Make a new key pair",
        type: "check",
        value: generate,
        hint: `Saved as ~/.ssh/${n}_<user>, without a passphrase (add one with ssh-keygen -p). Hand it to whoever logs in as that user.`,
      },
      {
        name: "key",
        label: "Public key",
        type: "textarea",
        value: "",
        placeholder: "ssh-ed25519 AAAA… name@laptop",
        when: (v) => !v.generate,
        required: "Paste the public key",
        check: keyError,
      },
      { name: "user", label: "User", value: user, placeholder: "the login user", hint: "Whose account it logs in to. Empty: the user landfall logs in as." },
    ],
    ok: "Add key",
    onOk: (v) => {
      const u = v.user.trim() ? ["--user", v.user.trim()] : [];
      if (v.generate) return void run(["keys", "add", "--generate", ...u, ...sv(n)], { server: n });
      const key = v.key.trim().split("\n")[0];
      run(["keys", "add", key, ...u, ...sv(n)], { server: n });
    },
  });
}
