import { S, sv } from "../lib/store";
import type { Account, Users } from "../lib/types";
import { rep, run, type Job } from "../lib/jobs";
import { ACTS, Actions, Badge, Btn, Card, CardHead, HIDE, MONO, Note, SR, Sub, cx, pending, Table } from "../ui/kit";
import { MenuBtn } from "../ui/menu";
import { confirmDlg, dialog, keyError, passwordError, userNameError, type Values } from "../ui/dialog";
import { addKeyDlg } from "./system";

// ---- users -------------------------------------------------------------------
// Every change is an lf users command: the page checks what the CLI would refuse, the CLI decides.

/** An lf command for server n, as a job. */
const lf = (n: string, argv: string[], o: Omit<Parameters<typeof run>[1], "server"> = {}) => run([...argv, ...sv(n)], { ...o, server: n });

export function UsersView({ n }: { n: string }) {
  const st = S.users[n];
  const wait = pending(st, `reading the users of ${n}…`);
  if (wait) return wait;
  const u = st!.data!;
  const go_ = (argv: string[]) => lf(n, argv);
  // What lf refuses to take away (checkTakeable) comes marked as keep.
  const takeable = (a: Account) => !a.keep && !a.tenant;

  const row = (a: Account) => {
    const rm = () =>
      confirmDlg({
        title: `Remove ${a.name} from ${n}?`,
        text: `The account goes, with ${a.home} and everything in it. This cannot be undone.`,
        ok: "Remove user",
        danger: true,
        typeToConfirm: a.name,
        onOk: () => go_(["users", "rm", a.name, "-y"]),
      });
    const rmPw = () =>
      confirmDlg({
        title: `Remove the password of ${a.name}?`,
        text: [
          "They log in with an SSH key only.",
          !a.keys && a.login ? `${a.name} has no SSH key: without a password they cannot log in at all.` : "",
          a.sudo && !a.nopasswd && a.uid !== 0 ? "sudo asks for this password: without it they cannot sudo." : "",
        ]
          .filter(Boolean)
          .join(" "),
        ok: "Remove password",
        danger: true,
        onOk: () => go_(["users", "passwd", a.name, "--remove", "-y"]),
      });
    const noSudo = () =>
      confirmDlg({
        title: `Take sudo from ${a.name}?`,
        text: `Removes landfall's rule for ${a.name} and their membership of the sudo and wheel groups.`,
        ok: "Take sudo",
        danger: true,
        onOk: () => go_(["users", "sudo", a.name, "--off"]),
      });
    return (
      <tr key={a.name}>
        <td>
          <span className={MONO}>{a.name}</span>
          {a.me && (
            <>
              {" "}
              <Badge kind="ok" title="landfall logs in as this user">
                landfall
              </Badge>
            </>
          )}
          {a.tenant && (
            <>
              {" "}
              <Badge title="lf tenant rm removes it, in the Tenants section">tenant</Badge>
            </>
          )}
          {!a.login && (
            <>
              {" "}
              <Badge title={a.shell}>no shell</Badge>
            </>
          )}
        </td>
        <td>
          {a.sudo ? (
            <Badge kind={a.nopasswd ? "warn" : "ok"} title={a.nopasswd ? "sudo without a password" : undefined}>
              {a.uid === 0 ? "root" : a.nopasswd ? "sudo, no password" : "sudo"}
            </Badge>
          ) : (
            <span className="faint">no</span>
          )}
        </td>
        <td>
          {a.password === "set" ? (
            <Badge kind="ok">set</Badge>
          ) : a.password === "locked" ? (
            <Badge kind="warn">locked</Badge>
          ) : (
            <span className="faint">none</span>
          )}
        </td>
        <td>{a.keys ? <Badge>{a.keys}</Badge> : <span className="faint">0</span>}</td>
        <td className={cx(MONO, "faint", HIDE)}>{a.uid}</td>
        <td className={cx(MONO, "faint", HIDE)}>{a.home}</td>
        <td className={ACTS}>
          <Btn cls="sm" on={() => addKeyDlg(n, a.name)}>
            Add key
          </Btn>
          <MenuBtn
            title={`Actions for ${a.name}`}
            items={[
              { label: a.password === "none" ? "Set password" : "Change password", run: () => passwordDlg(n, a.name) },
              a.password !== "none" && { label: "Remove password", run: rmPw },
              "-",
              u.sudo && a.uid !== 0 && !a.sudo && { label: "Grant sudo", run: () => sudoDlg(n, a) },
              u.sudo &&
                a.uid !== 0 &&
                a.sudo &&
                !a.nopasswd && { label: "Sudo without password", run: () => void go_(["users", "sudo", a.name, "--nopasswd"]) },
              u.sudo && a.sudo && takeable(a) && { label: "Take sudo", cls: "danger", run: noSudo },
              takeable(a) && { label: "Remove user", cls: "danger", run: rm },
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
          Users <Badge>{u.accounts.length}</Badge>{" "}
          <Sub>
            root and uid 1000+, as <code>lf users</code>
          </Sub>
          <Actions>
            <Btn cls="sm" on={() => addUserDlg(n, u)}>
              Add user
            </Btn>
          </Actions>
        </CardHead>
        <Table
          head={
            <>
              <th>User</th>
              <th>Sudo</th>
              <th>Password</th>
              <th>Keys</th>
              <th className={HIDE}>UID</th>
              <th className={HIDE}>Home</th>
              <th>
                <span className={SR}>Actions</span>
              </th>
            </>
          }
        >
          {u.accounts.map(row)}
        </Table>
      </Card>
      {!u.sudo && <Note>sudo is not installed on {n}: nobody but root can administer it.</Note>}
      {u.passwordLogin === false && <p className="faint">SSH takes keys only here: a password is for sudo and the console, not for logging in.</p>}
    </>
  );
}

function addUserDlg(n: string, u: Users) {
  dialog({
    title: `Add a user to ${n}`,
    text: "An account of its own, with its own home: for a person or a deploy job. It logs in with an SSH key, a password, or both.",
    fields: [
      {
        name: "name",
        label: "Name",
        value: "",
        placeholder: "anna",
        mono: true,
        required: true,
        check: (x) => userNameError(x) || (u.accounts.some((a) => a.name === x) && `${x} already exists`),
      },
      {
        name: "generate",
        label: "Make a new key pair",
        type: "check",
        value: false,
        hint: `Saved on this computer as ~/.ssh/${n}_<name>. Hand it to whoever logs in as that user.`,
      },
      {
        name: "key",
        label: "Public key",
        type: "textarea",
        value: "",
        placeholder: "ssh-ed25519 AAAA… anna@laptop",
        when: (v) => !v.generate,
        check: keyError,
      },
      { name: "password", label: "Password", type: "password", value: "", hint: "Optional with a key.", check: (x) => x && passwordError(x) },
      ...(u.sudo
        ? [
            { name: "sudo", label: "May administer the server (sudo)", type: "check" as const, value: false },
            {
              name: "nopasswd",
              label: "sudo without a password",
              type: "check" as const,
              value: false,
              when: (v: Values) => v.sudo,
              hint: "Needed when the user has no password.",
            },
          ]
        : []),
    ],
    ok: "Add user",
    onOk: (v) => {
      const key = v.key?.trim().split("\n")[0] ?? "";
      if (!v.generate && !key && !v.password) return { field: "key", error: "Give the user a way in: a key, a new key pair or a password" };
      if (v.sudo && !v.nopasswd && !v.password)
        return { field: "nopasswd", error: "Without a password, sudo has nothing to ask for: tick this or set a password" };
      lf(n, [
        "users",
        "add",
        v.name.trim(),
        ...(v.generate ? ["--generate-key"] : key ? ["--key", key] : []),
        ...(v.password ? ["--password", v.password] : []),
        ...(v.sudo ? ["--sudo"] : []),
        ...(v.sudo && v.nopasswd ? ["--nopasswd"] : []),
      ]);
    },
  });
}

function passwordDlg(n: string, user: string) {
  dialog({
    title: `Password of ${user} on ${n}`,
    text: "For logging in (where SSH takes passwords), sudo and the console. landfall keeps no copy.",
    fields: [
      { name: "generate", label: "Make one up", type: "check", value: false, hint: "Shown once when it is set." },
      { name: "password", label: "New password", type: "password", value: "", when: (v) => !v.generate, required: true, check: passwordError },
    ],
    ok: "Set password",
    onOk: (v) => {
      if (!v.generate) return void lf(n, ["users", "passwd", user, "--password", v.password]);
      lf(n, ["users", "passwd", user, "--generate"], {
        after: (j: Job) => {
          const pw = j.info.code === 0 && rep(j).password;
          if (pw)
            confirmDlg({
              title: `New password of ${user}`,
              text: "Copy it now: it is not shown again.",
              extra: <code className={cx(MONO, "select-all block p-3 rounded bg-hover")}>{pw}</code>,
              ok: "Done",
              onOk: () => {},
            });
        },
      });
    },
  });
}

function sudoDlg(n: string, a: Account) {
  dialog({
    title: `Let ${a.name} sudo on ${n}?`,
    text: `They can do anything on the server. landfall writes /etc/sudoers.d/landfall-${a.name}, checked with visudo first.`,
    fields: [
      {
        name: "nopasswd",
        label: "Without a password",
        type: "check",
        value: a.password !== "set",
        hint: a.password === "set" ? "Otherwise sudo asks for their password." : `${a.name} has no password: sudo would have nothing to ask for.`,
      },
    ],
    ok: "Grant sudo",
    onOk: (v) => {
      lf(n, ["users", "sudo", a.name, ...(v.nopasswd ? ["--nopasswd"] : [])]);
    },
  });
}
