import { S, sv, type Any } from "../lib/store";
import { run } from "../lib/jobs";
import { ACTS, Actions, Badge, Body, Btn, Card, CardHead, HIDE, MONO, Note, SR, Sub, cx, pending, Table } from "../ui/kit";
import { confirmDlg, dialog } from "../ui/dialog";

// ---- firewall --------------------------------------------------------------

const REACH: Record<string, string> = { open: "ok", limited: "accent", blocked: "bad", local: "" };
const portOf = (r: Any) => (r.port ? `${r.port}${r.proto ? `/${r.proto}` : ""}` : "");

export function FirewallView({ n }: { n: string }) {
  const st = S.firewall[n];
  const wait = pending(st, "reading the firewall…");
  if (wait) return wait;
  const fw = st!.data;
  const s = sv(n);
  const fwRun = (argv: string[]) => run(argv, { server: n });
  const active = fw.ufw === "active";
  const toggle =
    fw.ufw === "missing" ? <Btn cls="primary" on={() => fwRun(["firewall", "enable", ...s])}>Install &amp; enable ufw</Btn>
    : active ? (
      <Btn cls="danger" on={() => confirmDlg({ title: `Turn the firewall on ${n} off?`, text: "Every listening port becomes reachable from anywhere.", ok: "Turn it off", danger: true, onOk: () => fwRun(["firewall", "disable", ...s, "-y"]) })}>Turn off</Btn>
    ) : <Btn cls="primary" on={() => fwRun(["firewall", "enable", ...s])}>Turn on</Btn>;
  const badge = active ? <Badge kind="ok">on</Badge> : fw.ufw === "missing" ? <Badge kind="warn">ufw not installed</Badge> : <Badge kind="bad">off</Badge>;
  const addRule = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = form.elements as unknown as Record<"port" | "from" | "action", HTMLInputElement>;
    const port = f.port.value.trim();
    if (!port) return;
    const from = f.from.value.trim();
    const action = f.action.value;
    form.reset();
    run(["firewall", action, port, ...s, ...(from && from !== "anywhere" ? ["--from", from] : [])], { server: n });
  };
  return (
    <>
      {!active && fw.blocked.length > 0 && (
        <Note>Turning it on would cut off {fw.blocked.join(", ")}: add rules for them first, or landfall refuses (with a way to do it anyway).</Note>
      )}
      <Card>
        <CardHead>
          ufw {badge} <Sub>incoming default: {fw.policy.toLowerCase()} · ssh on {fw.sshPort}{fw.asRoot ? " · as root" : ""}</Sub>
          <Actions>{toggle}</Actions>
        </CardHead>
        <Table head={<><th>#</th><th>Action</th><th>Port</th><th>From</th><th className={HIDE}>Comment</th><th><span className={SR}>Actions</span></th></>}>
          {fw.rules.length ? fw.rules.map((r: Any, i: number) => {
            const num = String(i + 1);
            const flip = r.action === "deny" || r.action === "reject" ? "allow" : "deny";
            const kind = r.action === "allow" ? "ok" : r.action === "limit" ? "accent" : "bad";
            return (
              <tr key={`${num}${r.spec}`}>
                <td className="faint">{num}</td>
                <td>
                  <Btn cls="ghost sm" title={`Switch to ${flip}`} on={() => confirmDlg({ title: `Switch rule ${num} to ${flip}?`, text: `${r.spec}${r.from ? ` from ${r.from}` : ""}`, ok: `Switch to ${flip}`, danger: flip === "deny", onOk: () => fwRun(["firewall", "update", r.spec, "--action", flip, ...s]) })}>
                    <Badge kind={kind}>{r.action}{r.out ? " out" : ""}</Badge>
                  </Btn>
                </td>
                <td className={MONO}>{portOf(r) || r.spec}</td>
                <td>{r.from ? <span className={MONO}>{r.from}</span> : <span className="dim">anywhere</span>}</td>
                <td className={cx("dim", HIDE)}>{r.comment ?? ""}</td>
                <td className={ACTS}>
                  <Btn cls="sm" on={() => editRule(n, num, r)}>Edit</Btn>
                  <Btn cls="sm danger" on={() => confirmDlg({ title: `Remove rule ${num}?`, text: r.spec, ok: "Remove it", danger: true, onOk: () => fwRun(["firewall", "rm", r.spec, ...s, "-y"]) })}>Remove</Btn>
                </td>
              </tr>
            );
          }) : <tr><td colSpan={6} className="dim">no rules</td></tr>}
        </Table>
        <Body className="border-t border-line">
          <form className="flex gap-2.5 flex-wrap items-end" onSubmit={addRule}>
            <label className="flex-[1_1_140px]">Port <input name="port" placeholder="5432, 51820/udp, 6000:6007/tcp" required /></label>
            <label className="flex-[1_1_140px]">From <input name="from" placeholder="anywhere, or 10.0.0.0/8" /></label>
            <label className="flex-[0_0_110px]">Action <select name="action"><option value="allow">allow</option><option value="deny">deny</option></select></label>
            <Btn type="submit" cls="primary">Add rule</Btn>
          </form>
        </Body>
      </Card>
      <Card>
        <CardHead>Listening ports <Sub>and whether the internet reaches them</Sub></CardHead>
        <Table head={<><th>Port</th><th>Process</th><th>Reach</th><th>Why</th></>}>
          {fw.ports.length ? fw.ports.map((p: Any) => (
            <tr key={`${p.port}${p.proc}`}>
              <td className={MONO}>{p.port}</td>
              <td>{p.proc}</td>
              <td><Badge kind={REACH[p.state] ?? ""}>{p.state}</Badge></td>
              <td className="dim">{p.why}</td>
            </tr>
          )) : <tr><td colSpan={4} className="dim">nothing listening</td></tr>}
        </Table>
      </Card>
    </>
  );
}

export function editRule(n: string, num: string, r: Any) {
  const port = portOf(r);
  dialog({
    title: `Edit rule ${num}`,
    text: r.spec,
    fields: [
      { name: "port", label: "Port", value: port, placeholder: "port[/proto]" },
      { name: "from", label: "From", value: r.from ?? "", placeholder: "anywhere", hint: "An address or network like 10.0.0.0/8. Empty = anyone." },
      { name: "action", label: "Action", type: "select", value: r.action, options: ["allow", "deny", "reject", "limit"].map((a) => ({ value: a, label: a })) },
    ],
    ok: "Save",
    onOk: (v) => {
      // By its text, not its number: numbers shift when another firewall command lands first.
      const argv = ["firewall", "update", r.spec, ...sv(n)];
      if (v.port.trim() && v.port.trim() !== port) argv.push("--port", v.port.trim());
      argv.push("--from", v.from.trim() || "any");
      if (v.action !== r.action) argv.push("--action", v.action);
      run(argv, { server: n });
    },
  });
}
