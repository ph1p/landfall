import { useEffect } from "react";
import { S, plural } from "../../lib/store";
import type { Overview } from "../../lib/types";
import { go } from "../../lib/api";
import { Btn, Card, Empty, HIDE, Note, SR, Table } from "../../ui/kit";
import { ensureDns } from "../domains";
import { ErrorsCard } from "../traffic";
import { can } from "../shared";
import { setupFlow } from "../flows/setup";
import { deployImage, deployRepo } from "../flows/sources";
import { folderDialog } from "../flows/folder";
import { SiteRows } from "./site-rows";
import { OthersCard } from "./others";

/** One way to set a server up: what it installs, and the button that checks it first. */
const SetupChoice = ({ title, text, label, primary, on }: { title: string; text: string; label: string; primary?: boolean; on: () => void }) => (
  <div className="flex flex-col gap-2 rounded-lg border border-line p-4">
    <h3 className="m-0 text-fg text-[14px] font-semibold">{title}</h3>
    <p className="m-0 text-[13px] leading-snug grow">{text}</p>
    <div className="mt-1">
      <Btn cls={primary ? "primary" : undefined} on={on}>
        {label}
      </Btn>
    </div>
  </div>
);

/** On a server landfall has not set up: the containers it runs already, which a tunnel reaches as they are. */
function Running({ n, o }: { n: string; o: Overview }) {
  const count = o.others.length + o.unrouted.length;
  if (!count) return null;
  return (
    <p>
      {plural(count, "container")} already run{count === 1 ? "s" : ""} here. A tunnel reaches {count === 1 ? "it" : "them"} without any setup.{" "}
      <Btn on={() => go(n, "tunnels")}>Open Tunnels</Btn>
    </p>
  );
}

/** The admin does not see tenants' sites: they run in each tenant's own Docker. */
const TenantSites = ({ n, o }: { n: string; o: Overview }) =>
  o.tenants?.length ? (
    <Note className="my-3.5">
      {plural(o.tenants.length, "tenant")} {o.tenants.length === 1 ? "runs its" : "run their"} own sites here ({o.tenants.map((t) => t.user).join(", ")}).{" "}
      <Btn on={() => go(n, "tenants")}>Open Tenants</Btn>
    </Note>
  ) : null;

export function SitesView({ n, o }: { n: string; o: Overview }) {
  useEffect(() => ensureDns(n, o), [n, o]);
  const k = can(n);
  if (!o.ready && k && !k.setup) {
    return (
      <Card>
        <Empty title="Not ready for sites">
          <p>{S.facts[n]?.data?.why?.setup ?? ""}, so landfall cannot set it up: sites need Docker and /opt/landfall, which setup creates.</p>
          <Running n={n} o={o} />
        </Empty>
      </Card>
    );
  }
  if (!o.ready) {
    return (
      <Card>
        <Empty title="Not set up for landfall yet">
          <p>Setup shows what it finds and what it would change. Nothing is applied before you confirm.</p>
          <div className="grid gap-3 sm:grid-cols-2 w-full max-w-155 text-left mt-2">
            <SetupChoice
              title="Full setup"
              text="Docker, Traefik with automatic HTTPS, a deploy user, a firewall and key-only ssh. Sites get domains."
              label="Check & set up"
              primary
              on={() => setupFlow([n])}
            />
            <SetupChoice
              title="Minimal"
              text="Docker and landfall's folder, nothing else. Run containers and reach them through a tunnel. Traefik can follow later."
              label="Check minimal setup"
              on={() => setupFlow([n, "--minimal"], [n])}
            />
          </div>
          <Running n={n} o={o} />
        </Empty>
      </Card>
    );
  }
  if (!o.sites.length) {
    const routed = o.traefik || o.adopted;
    return (
      <>
        <Card>
          <Empty title="No sites yet">
            <p>
              Deploy a folder with a compose.yaml, a Dockerfile, static files, or an image.{" "}
              {routed ? "It gets HTTPS automatically." : "This server has no Traefik: sites serve no domain, a tunnel reaches them."}
            </p>
            <p>
              <Btn cls="primary" on={() => folderDialog(S.state.cwd)}>
                Choose a folder…
              </Btn>{" "}
              <Btn on={() => deployImage()}>Deploy an image…</Btn> <Btn on={() => deployRepo({ server: n })}>Deploy from git…</Btn>{" "}
              <span className="dim">or drop a folder here</span>
            </p>
            <p className="faint mono">{routed ? `lf deploy ./dist -d example.com -s ${n}` : `lf deploy ./dist -s ${n}`}</p>
          </Empty>
        </Card>
        <TenantSites n={n} o={o} />
        <OthersCard n={n} o={o} />
      </>
    );
  }
  return (
    <>
      <Card>
        <Table
          head={
            <>
              <th>Site</th>
              <th className={HIDE}>Domains</th>
              <th className={HIDE}>Kind</th>
              <th className={HIDE}>Deployed</th>
              <th className={HIDE}>
                <span className={SR}>Actions</span>
              </th>
            </>
          }
        >
          {o.sites.map((site) => (
            <SiteRows key={site.meta.name} n={n} site={site} />
          ))}
        </Table>
      </Card>
      <TenantSites n={n} o={o} />
      <ErrorsCard n={n} />
      <OthersCard n={n} o={o} />
    </>
  );
}
