import { X509Certificate } from "node:crypto";
import https from "node:https";
import type { Server } from "../lib/config";
import { SITE_LINES } from "../site/meta";
import { REDIRECTS_LINE, redirectsOf } from "./server-redirects";
import { hostSites } from "./traffic";
import { rootLogin } from "../ssh/privilege";
import { runScript } from "../ssh/ssh";
import { PROXY_PRELUDE } from "../ssh/templates";

/**
 * Certificates of the proxy, found in what it mounts: acme.json (Let's Encrypt) and certificate files
 * (dynamic/). Only certificates leave the server, never keys: from acme.json the "certificate" fields,
 * from files the first CERTIFICATE block. Plus the proxy's ACME errors in the span.
 */
const CERTS = (secs: number) => String.raw`
${PROXY_PRELUDE}
${SITE_LINES}
${REDIRECTS_LINE}
readf() { cat "$1" 2>/dev/null || sudo -n cat "$1" 2>/dev/null; }
for d in $(docker inspect -f '{{range .Mounts}}{{.Source}} {{end}}' "$P"); do
  case "$d" in */docker.sock) continue ;; esac
  # A mount under /root is invisible to a deploy login: look through passwordless sudo, else say it needs root.
  if [ -d "$d" ] || [ -f "$d" ]; then as=""
  elif sudo -n test -e "$d" 2>/dev/null; then as="sudo -n"
  else [ -e "$d" ] || printf 'DENIED\t%s\n' "$d"; continue; fi
  # Directories in letsencrypt/ belong to root and may not be listable: name acme.json directly too.
  { $as find "$d" -maxdepth 2 \( -name '*.json' -o -name '*.crt' -o -name '*.pem' -o -name '*.cert' \) 2>/dev/null; $as test -d "$d" && echo "$d/acme.json"; } | sort -u | while read -r f; do
    case "$f" in
      *.json)
        [ -e "$f" ] || sudo -n test -e "$f" 2>/dev/null || continue
        j=$(readf "$f") || { printf 'DENIED\t%s\n' "$f"; continue; }
        # Not grep -q: it quits on the first match, and under pipefail the SIGPIPE to a large printf reads as no match.
        case "$j" in *'"Certificates"'*) ;; *) continue ;; esac
        printf 'ACME\t%s\n' "$f"
        printf '%s' "$j" | grep -o '"certificate": *"[^"]*"' | awk -F'"' '{ print "CERT\tacme\t" $(NF - 1) }' ;;
      *)
        b=$(readf "$f" | awk '/-----BEGIN CERTIFICATE-----/ { p = 1 } p { print } /-----END CERTIFICATE-----/ { exit }' | base64 | tr -d '\n')
        [ -n "$b" ] && printf 'CERT\t%s\t%s\n' "$f" "$b" ;;
    esac
  done
done
docker logs --since ${secs}s "$P" 2>&1 | grep -v '^{' | grep -i acme | grep -E ' ERR |level=error' | tail -n 100 | sed 's/^/LOG\t/'
exit 0
`;

export interface Cert {
  domains: string[];
  expires: string;
  days: number;
  issuer: string;
  /** Let's Encrypt's staging CA: browsers do not trust it. */
  staging: boolean;
  source: "acme" | "file";
  path?: string;
}

export interface CertError {
  at?: string;
  domains: string[];
  error: string;
}

export interface Certs {
  at: string;
  proxy: boolean;
  /** acme.json files found; denied ones need root. */
  acme: string[];
  denied: string[];
  certs: Cert[];
  errors: CertError[];
  /**
   * Each site domain, then each server redirect's host (`redirect`: where it points),
   * with the certificate that covers it (by expiry, latest first) and its last error.
   */
  domains: { domain: string; site?: string; redirect?: string; cert?: Cert; error?: CertError }[];
}

const ANSI = /\x1b\[[0-9;]*m/g;

/** A traefik log line about an ACME failure: when, for which domains, why. */
export function parseCertError(raw: string): CertError | null {
  const line = raw.replace(ANSI, "");
  const at = /^(\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:?\d\d))/.exec(line)?.[1] ?? /time="([^"]+)"/.exec(line)?.[1];
  let domains: string[] = [];
  const list = /domains=(\[[^\]]*\])/.exec(line)?.[1];
  if (list) {
    try {
      domains = JSON.parse(list);
    } catch {}
  }
  if (!domains.length) domains = (/domains \[([^\]]*)\]/.exec(line)?.[1] ?? "").split(/[\s,]+/).filter(Boolean);
  const error =
    /error="((?:[^"\\]|\\.)*)"/.exec(line)?.[1]?.replace(/\\"/g, '"') ?? /msg="((?:[^"\\]|\\.)*)"/.exec(line)?.[1] ?? line.replace(/^\S+\s+(ERR\s+)?/, "");
  return domains.length || error ? { ...(at && { at }), domains, error: error.trim() } : null;
}

/** Leaf certificate of a PEM chain (base64-wrapped, as acme.json and the probe carry it). */
export function readCert(b64: string, source: Cert["source"], path?: string, now = new Date()): Cert | null {
  try {
    const x = new X509Certificate(Buffer.from(b64, "base64"));
    const domains = (x.subjectAltName ?? "")
      .split(/,\s*/)
      .filter((d) => d.startsWith("DNS:"))
      .map((d) => d.slice(4).toLowerCase());
    const cn = /CN=([^\n,]+)/.exec(x.subject)?.[1];
    const expires = new Date(x.validTo);
    const issuer = [/O=([^\n]+)/.exec(x.issuer)?.[1], /CN=([^\n]+)/.exec(x.issuer)?.[1]].filter(Boolean).join(" · ");
    return {
      domains: domains.length ? domains : cn ? [cn.toLowerCase()] : [],
      expires: expires.toISOString(),
      days: Math.floor((expires.getTime() - now.getTime()) / 86_400_000),
      issuer,
      staging: /staging|fake|\(STAGING\)/i.test(x.issuer),
      source,
      ...(path && { path }),
    };
  } catch {
    return null;
  }
}

/** Whether a certificate name covers a host: exact, or a wildcard for exactly one label. */
export const covers = (name: string, host: string) =>
  name === host || (name.startsWith("*.") && host.slice(host.indexOf(".") + 1) === name.slice(2) && host.indexOf(".") > 0);

export function parseCerts(out: string, now = new Date()): Certs {
  const r: Certs = { at: now.toISOString(), proxy: true, acme: [], denied: [], certs: [], errors: [], domains: [] };
  for (const line of out.split("\n")) {
    const f = line.split("\t");
    if (f[0] === "NOPROXY") r.proxy = false;
    else if (f[0] === "ACME") r.acme.push(f[1]);
    else if (f[0] === "DENIED") r.denied.push(f[1]);
    else if (f[0] === "CERT") {
      const c = readCert(f[2], f[1] === "acme" ? "acme" : "file", f[1] === "acme" ? undefined : f[1], now);
      if (c) r.certs.push(c);
    } else if (f[0] === "LOG") {
      const e = parseCertError(line.slice(4));
      if (e) r.errors.push(e);
    }
  }
  r.certs.sort((a, b) => (a.domains[0] ?? "").localeCompare(b.domains[0] ?? "") || b.days - a.days);
  const sites = hostSites(out);
  // Server redirects (lf redirect add) get certificates too: their hosts belong to no site.
  const redirects = redirectsOf(out).list.filter((x) => !sites.has(x.host));
  const rows = [
    ...[...sites]
      .filter(([d]) => !d.startsWith("*."))
      .map(([domain, site]) => ({ domain, site }))
      .sort((a, b) => a.site.localeCompare(b.site) || a.domain.localeCompare(b.domain)),
    ...redirects.map((x) => ({ domain: x.host, redirect: x.to })).sort((a, b) => a.domain.localeCompare(b.domain)),
  ];
  r.domains = rows.map((row) => {
    const cert = r.certs.filter((c) => c.domains.some((n) => covers(n, row.domain))).sort((a, b) => b.days - a.days)[0];
    const error = r.errors.filter((e) => e.domains.includes(row.domain)).at(-1);
    return { ...row, ...(cert && { cert }), ...(error && { error }) };
  });
  return r;
}

export async function certs(s: Server, secs = 7 * 86400): Promise<Certs> {
  const { stdout } = await runScript(s, CERTS(secs), { capture: true });
  const r = parseCerts(stdout);
  if (!r.denied.length) return r;
  // Your own Traefik often keeps acme.json under /root: read it through a root key login when one works, without asking.
  const root = await rootLogin(s).catch(() => undefined);
  return root ? parseCerts((await runScript(root, CERTS(secs), { capture: true })).stdout) : r;
}

export interface Check {
  domain: string;
  site?: string;
  ok: boolean;
  status?: number;
  /** Until the response headers arrived, connection and TLS included. */
  ms?: number;
  error?: string;
  tls?: { valid: boolean; error?: string; expires: string; days: number; issuer: string };
}

/** A certificate this close to expiry means renewal fails: Let's Encrypt renews 30 days ahead. */
export const CERT_DAYS_BAD = 7;

/**
 * One HTTPS request from this machine, the way a visitor sees the site: status, time to the response,
 * and the certificate served. `resolve` connects to that address (ip or ip:port) instead of DNS.
 */
export function checkUrl(domain: string, o: { resolve?: string; timeout?: number } = {}): Promise<Check> {
  // ip, ip:port, [ipv6]:port; a bare IPv6 address has more than one colon.
  const [addr, port] = !o.resolve
    ? []
    : /^[^:]*(:[^:]*)?$|^\[/.test(o.resolve)
      ? (/^\[?([^\]]+?)\]?(?::(\d+))?$/.exec(o.resolve)?.slice(1) ?? [])
      : [o.resolve];
  const start = performance.now();
  return new Promise((done) => {
    const req = https.request(
      {
        host: addr || domain,
        port: Number(port) || 443,
        servername: domain,
        path: "/",
        method: "GET",
        headers: { host: domain, "user-agent": "landfall-check" },
        rejectUnauthorized: false,
        agent: false,
        timeout: o.timeout ?? 10_000,
      },
      (res) => {
        const ms = Math.round(performance.now() - start);
        const sock = res.socket as import("node:tls").TLSSocket;
        const peer = sock.getPeerCertificate();
        const tls = peer?.valid_to
          ? {
              valid: sock.authorized,
              ...(!sock.authorized && { error: String(sock.authorizationError ?? "not trusted") }),
              expires: new Date(peer.valid_to).toISOString(),
              days: Math.floor((new Date(peer.valid_to).getTime() - Date.now()) / 86_400_000),
              issuer: [peer.issuer?.O, peer.issuer?.CN].filter(Boolean).join(" · "),
            }
          : undefined;
        res.resume();
        req.destroy();
        const status = res.statusCode ?? 0;
        done({ domain, ok: status < 500 && !!tls?.valid && tls.days >= CERT_DAYS_BAD, status, ms, ...(tls && { tls }) });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", (e: any) => done({ domain, ok: false, error: e?.code ?? e?.message ?? String(e) }));
    req.end();
  });
}
