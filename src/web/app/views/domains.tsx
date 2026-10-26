import { S, plural, sv, type Any } from "../lib/store";
import { fetchInto, go, refreshState } from "../lib/api";
import { run, ifOk } from "../lib/jobs";
import { toast } from "../ui/toast";
import { Btn, Dot } from "../ui/kit";
import { confirmDlg, dialog, domainOk, passwordError, promptDlg, userError, words } from "../ui/dialog";
import { autoDomain, mainDomain } from "./flows";

// ---- domains & login ---------------------------------------------------------

export function copy(text: string) {
  navigator.clipboard?.writeText(text).then(() => toast(`Copied ${text}`), () => toast(text)) ?? toast(text);
}

const servedByOther = (n: string, site: string, d: string): string | undefined =>
  S.overview[n]?.data?.sites.find((s: Any) => s.meta.name !== site && s.domains.includes(d))?.meta.name;

export function domainsDialog(n: string, m: Any) {
  const main = mainDomain(n);
  const free = autoDomain(n, m.name);
  const ips: string[] = S.dns[n]?.data?.ips ?? [];
  dialog({
    title: `Domains of ${m.name}`,
    text: `Each domain needs an A record pointing at ${ips.join(", ") || "the server"}. Traefik fetches the certificate once it resolves.`,
    fields: [
      {
        name: "domains", label: "Domains (space separated)", value: m.domains.join(" "), mono: true, off: (v) => v.noDomain,
        check: (x) => words(x).filter((d) => !domainOk(d)).map((d) => `Not a domain: ${d}`)[0],
      },
      { name: "noDomain", label: "No domain: reach it through a tunnel only", type: "check", value: !m.domains.length, hint: "Nothing is served on the internet; the site keeps running. Open via tunnel reaches it." },
      ...(main && !m.domains.includes(main)
        ? [{ name: "apex", label: `Also serve ${main}`, type: "check" as const, value: false, when: (v: Any) => !v.noDomain, hint: servedByOther(n, m.name, main) ? `${servedByOther(n, m.name, main)} serves it now and hands it over.` : "The main domain itself." }]
        : []),
      ...(free && !m.domains.includes(free)
        ? [{ name: "free", label: main ? `Also add ${free}` : `Also add the free address ${free}`, type: "check" as const, value: false, when: (v: Any) => !v.noDomain, hint: main ? `Under the main domain: works once *.${main} points at the server.` : "Works right away, no DNS setup." }]
        : []),
    ],
    ok: "Save",
    onOk: (v) => {
      const domains: string[] = v.noDomain ? [] : v.domains.split(/[\s,]+/).filter(Boolean);
      if (v.free && !v.noDomain) domains.push(free!);
      if (v.apex && !v.noDomain) domains.push(main!);
      // None left: the site keeps running, unrouted.
      const args = domains.length ? domains.flatMap((d) => ["--set", d]) : m.domains.flatMap((d: string) => ["--rm", d]);
      if (!args.length) return;
      run(["domains", m.name, ...sv(n), ...args, "-y"], { server: n });
    },
  });
}

export function authDialog(n: string, m: Any) {
  const users: string[] = (m.auth ?? []).map((a: string) => a.split(":")[0]);
  dialog({
    title: `Password for ${m.name}`,
    text: users.length
      ? `Visitors log in as ${users.join(", ")}. Saving an existing user changes their password.`
      : "Visitors have to log in (HTTP basic auth) before they see the site.",
    fields: [
      { name: "off", label: "Remove the login: the site is public again", type: "check", value: false, when: () => users.length },
      {
        row: [
          { name: "user", label: "User", value: users[0] ?? "admin", off: (v) => v.off, check: (x) => userError(x || "admin") },
          { name: "password", label: `Password (${S.state.rules.minPassword}+ characters)`, type: "password", off: (v) => v.off, required: "Pick a password", check: passwordError },
        ],
      },
    ],
    ok: "Save",
    onOk: (v) => {
      if (v.off) return void run(["auth", m.name, ...sv(n), "--off", "-y"], { server: n });
      run(["auth", m.name, ...sv(n), "-u", v.user.trim() || "admin", "--password", v.password], { server: n });
    },
  });
}

/** Check the sites' domains (DNS and HTTPS) once, again when forced. Call it from an effect. */
export function ensureDns(n: string, o: Any, force = false) {
  if ((S.dns[n] && !force) || S.dns[n]?.loading || !o?.sites.length) return;
  const domains = [...new Set(o.sites.flatMap((x: Any) => x.domains))];
  fetchInto("dns", n, `/dns?domains=${encodeURIComponent(domains.join(","))}`);
}

/** A site's domain as a link, with a dot for its DNS and HTTPS check and a copy button. */
export function DomainChip({ n, d }: { n: string; d: string }) {
  const c = S.dns[n]?.data?.domains.find((x: Any) => x.domain === d);
  const url = `https://${d}`;
  let dot = "", title = "checking…";
  if (c) {
    const { status: st, ms, tls } = c.https;
    const cert = tls ? (tls.valid ? ` · certificate ${plural(tls.days, "day")} left` : ` · certificate: ${tls.error}`) : "";
    if (!c.ips.length) (dot = "down"), (title = "DNS: does not resolve");
    else if (!c.ok) (dot = "warn"), (title = `DNS points at ${c.ips.join(", ")}, not this server`);
    else if (st && st < 500 && tls && (!tls.valid || tls.days < 7)) (dot = "warn"), (title = `HTTPS ${st}${cert}`);
    else if (st && st < 500) (dot = "up"), (title = `HTTPS ${st}${st === 401 ? " (login required)" : ""} in ${ms} ms${cert}`);
    else (dot = "down"), (title = `HTTPS: ${st ?? c.https.error}`);
  }
  return (
    <span className="group inline-flex items-center gap-0.5 max-w-full">
      <Dot kind={dot} title={title} />
      <a href={url} target="_blank" rel="noopener" title={title} className="overflow-hidden text-ellipsis whitespace-nowrap" onClick={(e) => e.stopPropagation()}>{d}</a>
      <Btn cls="ghost px-[5px]! py-0! text-sm! min-w-6 min-h-6 text-faint! group-hover:text-fg! focus-visible:text-fg!" title="Copy the address" on={() => copy(url)}>⧉</Btn>
    </span>
  );
}

export function runCommand(n: string) {
  promptDlg(`Run a command on ${n}`, "Runs through ssh as the server's login; output shows on the right.", { label: "Command", placeholder: "df -h", type: "text" }, (cmd) => {
    if (cmd) run(["ssh", n, "--", cmd], { server: n });
  }, "Run");
}

export function forget(n: string) {
  confirmDlg({
    title: `Forget ${n}?`,
    text: "Removes it from landfall (and the Host block landfall wrote to ~/.ssh/config).\nNothing on the server is changed.",
    ok: `Forget ${n}`,
    danger: true,
    typeToConfirm: n,
    onOk: () => run(["server", "rm", n, "-y"], { server: n, after: ifOk(() => go(null)) }),
  });
}

export function makeDefault(n: string) {
  run(["server", "use", n], { server: n, after: ifOk(refreshState) });
}
