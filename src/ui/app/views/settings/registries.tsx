import { useEffect } from "react";
import { S, sv } from "../../lib/store";
import { ensure, fetchInto } from "../../lib/api";
import { ifOk, run } from "../../lib/jobs";
import { Actions, Body, Btn, Card, CardHead, Kv, Sub, pending } from "../../ui/kit";
import { confirmDlg, dialog } from "../../ui/dialog";

/** The registries the server's docker is logged in to: lf deploy --image pulls private images from them. */
export function RegistriesCard({ n }: { n: string }) {
  useEffect(() => ensure("registries", n, "/registries"));
  const st = S.registries[n];
  const reload = { server: n, after: ifOk(() => fetchInto("registries", n, "/registries")) };
  const login = () =>
    dialog({
      title: `Log docker on ${n} in to a registry`,
      text: "Deploys of private images pull with it. The token is sent to the server's docker login, not kept here.",
      fields: [
        { name: "host", label: "Registry", value: "ghcr.io", mono: true, required: "Which registry? For example ghcr.io", hint: "docker.io for Docker Hub" },
        { name: "user", label: "User", required: "The registry user (for ghcr.io, your GitHub name)" },
        { name: "pw", label: "Password or token", type: "password", required: "The password or token", hint: "For ghcr.io a token with read:packages." },
      ],
      ok: "Log in",
      // The job's argv travels to lf on stdin and the UI masks --password: it reaches neither ps nor the job list.
      onOk: (v) => run(["registry", "login", v.host.trim(), ...sv(n), "-u", v.user.trim(), "--password", String(v.pw)], reload),
    });
  const logout = (r: string) =>
    confirmDlg({
      title: `Log docker on ${n} out of ${r}?`,
      text: "Deploys can no longer pull private images from it.",
      ok: "Log out",
      onOk: () => run(["registry", "logout", r, ...sv(n)], reload),
    });
  return (
    <Card>
      <CardHead>
        Registries <Sub>private images lf deploy --image pulls</Sub>
        <Actions>
          <Btn cls="sm" on={login}>
            Log in
          </Btn>
        </Actions>
      </CardHead>
      <Body>
        {pending(st, "reading docker's logins…") ??
          (st!.data!.length ? (
            <Kv
              pairs={st!.data!.map((r) => [
                r,
                <Btn cls="sm" on={() => logout(r)}>
                  Log out
                </Btn>,
              ])}
            />
          ) : (
            <p className="dim">Logged in to no registry: public images and images sent from this machine need none.</p>
          ))}
      </Body>
    </Card>
  );
}
