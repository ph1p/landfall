import { sv } from "../../lib/store";
import type { External, Overview } from "../../lib/types";
import { run } from "../../lib/jobs";
import { ACTS, Badge, Btn, Card, CardHead, HIDE, Lede, MONO, NAME, SHOW, SR, cx, Table } from "../../ui/kit";
import { dialog, siteNameError } from "../../ui/dialog";
import { StatusDot } from "../shared";
import { CHIPS, CHIP } from "./panel";

export function OthersCard({ n, o }: { n: string; o: Overview }) {
  if (!o.others?.length) return null;
  const links = (e: External) =>
    e.domains.map((d) => (
      <span key={d} className={CHIP}>
        <a href={`https://${d}`} target="_blank" rel="noopener">
          {d}
        </a>
      </span>
    ));
  return (
    <Card>
      <CardHead>
        Not deployed by landfall <Badge>{o.others.length}</Badge>
      </CardHead>
      <Lede>
        Containers your Traefik routes, e.g. your own compose projects. Adopting one lists it as a site with logs, restart and stop; it keeps running from its
        folder.
      </Lede>
      <Table
        head={
          <>
            <th>Name</th>
            <th className={HIDE}>Domains</th>
            <th className={HIDE}>Folder</th>
            <th>
              <span className={SR}>Actions</span>
            </th>
          </>
        }
      >
        {o.others.map((e) => (
          <tr key={e.name}>
            <td>
              <div className={NAME}>
                <StatusDot status={e.status} />
                <b>{e.name}</b>&nbsp;<span className="faint">{e.status.toLowerCase()}</span>
              </div>
              <div className={cx(CHIPS, SHOW, "mt-1")}>{links(e)}</div>
            </td>
            <td className={HIDE}>
              <div className={CHIPS}>{links(e)}</div>
            </td>
            <td className={cx(HIDE, MONO, "dim")}>{e.dir ?? e.containers.join(", ")}</td>
            <td className={ACTS}>
              <Btn
                cls="sm"
                title="lf tunnel: an SSH tunnel straight to the container, until you stop it"
                on={() => run(["tunnel", e.name, ...sv(n)], { server: n })}
              >
                Tunnel
              </Btn>
              {e.dir && (
                <Btn cls="sm" title="lf adopt" on={() => adoptDialog(n, e)}>
                  Adopt
                </Btn>
              )}
            </td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}

function adoptDialog(n: string, e: External) {
  dialog({
    title: `Adopt ${e.name}?`,
    text: `${e.name} keeps running from ${e.dir} with its own files and Traefik labels. landfall lists it as a site with logs, restart, stop and start; it does not deploy it or change its domains.`,
    fields: [
      {
        name: "name",
        label: "Site name",
        value: e.name
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, "-")
          .replace(/^-+/, ""),
        required: true,
        check: siteNameError,
      },
    ],
    ok: "Adopt",
    onOk: (v) => run(["adopt", e.name, ...sv(n), "--name", v.name.trim()], { server: n }),
  });
}
