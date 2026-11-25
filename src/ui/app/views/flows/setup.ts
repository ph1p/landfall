import { S, plural, serverNamed } from "../../lib/store";
import type { SavedServer } from "../../lib/types";
import { go } from "../../lib/api";
import { run, rep, ifOk, type Job, type JobAction } from "../../lib/jobs";
import { dialog, promptDlg, domainOk, portError } from "../../ui/dialog";
import { full, providerOptions } from "./server-dialogs";

export function setupFlow(args: string[], base = args) {
  run(["setup", ...args, "--check"], {
    server: args[0],
    after: (j) => {
      if (j.info.code !== 0) return;
      // Synology and other systems without a package manager: nothing for setup to apply.
      if (rep(j).refuse) return [{ label: "Back to the server", run: () => ((S.job = null), go(args[0], "sites")) }];
      if (rep(j).needsKey) {
        return [{ label: "Enter the password to install a key", run: () => passwordFor(args, base) }];
      }
      const todo = (rep(j).checks ?? []).filter((ch) => ch.status === "todo").length;
      return [
        {
          label: todo ? `Apply ${plural(todo, "change")}` : "Finish setup (nothing to install)",
          run: () => run(["setup", ...args, "-y"], { server: args[0], after: securityAfter(args[0]) }),
        },
        { label: "Change options", run: () => setupWizard(base) },
      ];
    },
  });
}

/** After a job that ends with security advice: a way to its fixes. */
export const securityAfter =
  (n: string) =>
  (j: Job): JobAction[] | undefined =>
    j.info.code === 0 && rep(j).advice?.length
      ? [{ label: `Security: ${plural(rep(j).advice!.length, "thing")} to look at`, run: () => go(n, "system") }]
      : undefined;

export function setupWizard(base: string[]) {
  const saved = serverNamed(base[0])?.saved ?? ({} as Partial<SavedServer>);
  dialog({
    title: `Set up ${base[0]}`,
    text: "landfall first shows what it finds and what it would change. Nothing is applied before you confirm.",
    ok: "Check",
    fields: [
      {
        name: "minimal",
        label: "Minimal: only Docker and landfall's folder",
        type: "check",
        value: base.includes("--minimal"),
        hint: "No Traefik, deploy user, packages, firewall or ssh change. Sites serve no domain: reach them through a tunnel.",
      },
      {
        legend: "Traefik (reverse proxy, automatic HTTPS)",
        when: full,
        fields: [
          {
            name: "traefik",
            label: "Mode",
            type: "select",
            value: saved.hostNetwork ? "host" : "docker",
            options: [
              { value: "docker", label: "Own Traefik, ports published by Docker" },
              { value: "host", label: "Own Traefik on the host network (real client IPs, ufw guards 80/443)" },
              { value: "none", label: "No Traefik (add later with traefik setup)" },
            ],
            hint: "If the server already runs a Traefik on 80/443, setup routes sites through it instead.",
          },
          {
            name: "email",
            label: "Let's Encrypt e-mail (optional)",
            value: saved.email ?? "",
            when: (v) => v.traefik !== "none",
            check: (x) => x && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x) && "An e-mail address",
          },
          {
            name: "dashboard",
            label: "Dashboard domain (optional)",
            value: "",
            placeholder: "traefik.example.com",
            mono: true,
            hint: "Behind basic auth; the password is shown after setup.",
            when: (v) => v.traefik !== "none",
            check: (x) => x && !domainOk(x) && "Not a domain",
          },
          {
            name: "http3",
            label: "HTTP/3 (QUIC on 443/udp)",
            type: "check",
            value: saved.http3 !== false,
            hint: "Browsers that can't use it fall back to HTTP/2.",
            when: (v) => v.traefik !== "none",
          },
          { name: "image", label: "Image", value: saved.traefikImage ?? S.state.defaultImage, mono: true, when: (v) => v.traefik !== "none" },
        ],
      },
      {
        name: "firewall",
        label: "Enable ufw: deny incoming except ssh, 80 and 443",
        type: "check",
        value: true,
        hint: "Skipped automatically if it would block ports in use, or if the provider's firewall is always in front (AWS, Google Cloud, Azure, …).",
        when: full,
      },
      {
        name: "cloud",
        label: "Provider",
        type: "select",
        value: saved.cloud ?? "auto",
        options: providerOptions(),
        hint: "Set it only where detection is wrong. landfall remembers it for this server.",
        when: full,
      },
      {
        name: "harden",
        label: "Key login only (turn off ssh passwords)",
        type: "check",
        value: true,
        hint: "Skipped automatically if other users still log in with a password.",
        when: full,
      },
      {
        name: "user",
        label: "Deploy user",
        value: "deploy",
        hint: "landfall deploys as this user (docker group, your key). Empty keeps the login user.",
        when: full,
      },
    ],
    onOk: (v) => {
      const args = base.filter((a) => a !== "--minimal");
      if (v.minimal) return setupFlow([...args, "--minimal"], args);
      const f: string[] = [];
      if (v.traefik === "none") f.push("--no-traefik");
      else {
        f.push(v.traefik === "host" ? "--host-network" : "--no-host-network");
        if (v.image.trim()) f.push(`--image=${v.image.trim()}`);
        if (v.email.trim()) f.push(`--email=${v.email.trim()}`);
        if (v.dashboard.trim()) f.push(`--dashboard=${v.dashboard.trim()}`);
        f.push(v.http3 ? "--http3" : "--no-http3");
      }
      if (!v.firewall) f.push("--no-firewall");
      // "auto" also forgets a provider set earlier.
      if (v.cloud !== "auto" || saved.cloud) f.push(`--cloud=${v.cloud}`);
      if (!v.harden) f.push("--no-harden");
      f.push(`--deploy-user=${v.user.trim()}`);
      setupFlow([...args, ...f], args);
    },
  });
}

function passwordFor(args: string[], base: string[]) {
  const host = args.includes("--host") ? `root@${args[args.indexOf("--host") + 1]}` : (serverNamed(args[0])?.target ?? args[0]);
  promptDlg(
    `Password for ${host}`,
    "Used once to install landfall's ssh key (ssh-copy-id). It is not stored; afterwards only the key is used.",
    { type: "password", label: "Password" },
    (pw) => {
      if (!pw) return;
      run(["setup", ...args, "--key-only", "-y"], {
        password: pw,
        server: args[0],
        after: (j) => {
          if (j.info.code === 0) return void setTimeout(() => setupFlow(args, base));
          return [{ label: "Try the password again", run: () => passwordFor(args, base) }];
        },
      });
    },
    "Install key",
  );
}

export function addServer() {
  const known = (name: string) => !!serverNamed(name);
  dialog({
    title: "Add a server",
    text: "An alias from ~/.ssh/config (like vps) needs only its name. A new machine needs a name and its address, fresh or already in use: landfall writes its ssh config entry.",
    fields: [
      {
        row: [
          {
            name: "name",
            label: "Name",
            placeholder: "vps",
            required: "Give the server a name",
            preview: (v) => known(v.name.trim()) && "✓ in your ssh config: no address needed",
          },
          {
            name: "host",
            label: "Address (IP or hostname)",
            placeholder: "203.0.113.7",
            mono: true,
            check: (h, v) => !h && !known(v.name.trim()) && `${v.name.trim()} is not in your ssh config: give its IP or hostname`,
          },
        ],
      },
      {
        // Only a new address needs a login; an alias brings its own.
        legend: "Login",
        when: (v) => String(v.host ?? "").trim(),
        fields: [
          {
            row: [
              { name: "user", label: "User", placeholder: "root" },
              { name: "port", label: "SSH port", type: "number", placeholder: "22", check: portError },
            ],
          },
          {
            name: "key",
            label: "Private key file (optional)",
            placeholder: "~/.ssh/id_ed25519",
            mono: true,
            hint: "Empty: landfall makes ~/.ssh/landfall_<name> and installs it with the password.",
          },
          {
            name: "password",
            label: "Password (optional)",
            type: "password",
            hint: "Used once to install the key, never stored. Empty when the key already works.",
          },
        ],
      },
      { name: "setup", label: "Set it up now", hint: "Shows what it would change first.", type: "check", value: true },
    ],
    ok: "Add",
    onOk: (v) => {
      const [name, host, user, port, key] = [v.name, v.host, v.user, v.port, v.key].map((x: string) => x.trim());
      const args = [name, ...(host ? ["--host", host] : []), ...(user ? ["-u", user] : []), ...(port ? ["-p", port] : []), ...(key ? ["-i", key] : [])];
      // With a password: install the key now, then the setup wizard needs nothing but the alias.
      const then = ifOk(() => (v.setup ? setupWizard([name]) : go(name)));
      if (v.password) run(["server", "add", ...args], { server: name, password: v.password, after: then });
      else if (v.setup) setupWizard(args);
      else run(["server", "add", ...args], { server: name, after: (j) => void go(name, rep(j).advice?.length ? "system" : S.tab) });
    },
  });
}
