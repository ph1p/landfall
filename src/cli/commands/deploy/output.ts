import { type Release } from "../../../core/site/meta";
import { routePlan } from "../../../core/site/routing";
import { c, info, ok, warn } from "../../../core/lib/term";

/** What goes where, port by port; a route the live release did not have is marked new. */
export function showRoutes(services: Release["services"], domains: string[], live?: Release) {
  const plan = routePlan(services, domains);
  const before = new Set(live ? routePlan(live.services, domains).map((r) => r.key) : []);
  const isNew = (r: (typeof plan)[number]) => !!live && !before.has(r.key);
  const hidden = services.some((s) => s.private);
  if (plan.length <= 1 && !plan.some(isNew) && !hidden && !plan.some((r) => r.allow || r.members)) return;
  info("routes:");
  for (const r of plan) {
    const fresh = isNew(r) ? c.yellow(" new") : "";
    const only = r.allow ? c.dim(` only from ${r.allow.join(", ")}`) : "";
    const split = r.members ? c.dim(` split: ${r.members.join(", ")}`) : "";
    console.error(
      `  ${r.key.padEnd(18)} ${r.domains.length ? r.domains.map((d) => c.cyan(d)).join(", ") : c.dim("no domain: lf tunnel")}${only}${split}${fresh}`,
    );
  }
  for (const s of services)
    for (const [k, p] of Object.entries(s.private ?? {}))
      console.error(`  ${`${s.name}:${p}`.padEnd(18)} ${c.dim(`private: lf tunnel <site> ${k}${s.paths?.[k] ? ` opens ${s.paths[k]}` : ""}`)}`);
}

export async function checkLive(domain: string) {
  info(c.dim(`checking https://${domain}`));
  try {
    const get = () => fetch(`https://${domain}`, { signal: AbortSignal.timeout(15000), redirect: "manual" });
    let res = await get();
    // Traefik answers 404 until its Docker provider has seen the recreated container: give it a few seconds.
    for (let i = 0; res.status === 404 && i < 10; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      res = await get();
    }
    if (res.status < 400) ok(`https://${domain} responded ${res.status}`);
    else if (res.status === 401) ok(`https://${domain} responded 401: it asks for its login`);
    else warn(`https://${domain} responded ${res.status}`);
  } catch (e: any) {
    const msg = e?.cause?.code ?? e?.code ?? e?.message ?? String(e);
    warn(`could not reach https://${domain} yet (${msg}). DNS or the first certificate may still be pending.`);
  }
}
