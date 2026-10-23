import { spawn } from "node:child_process";
import { basename } from "node:path";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import stringWidth from "string-width";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import pkg from "../../package.json";
import { firewallState, type FirewallState } from "../commands/firewall";
import { loadConfig, loadProject, resolveServer, saveConfig } from "../config";
import { isDone, isUp } from "../compose";
import { newestFirst, overview, siteDir, type Overview, type SiteStatus } from "../remote";
import { pending, readJournal, type Run } from "../journal";
import { effectiveSsh, sshAliases } from "../sshconfig";
import { DEFAULT_TRAEFIK_IMAGE } from "../templates";
import { ago } from "../ui";
import { changes, listServers, target, type Entry } from "../dashboard";
import { startJob, type Job } from "../job";

export type Load = { kind: "loading" } | { kind: "ok"; data: Overview } | { kind: "error"; error: string };

/** Survives the round trips through actions. */
export interface UiState {
  server: number;
  site: number;
  focus: "servers" | "sites";
  cache: Map<string, Load>;
  /** Servers the user chose to connect to; only these are ever contacted. */
  connect: Set<string>;
}

/** A command that needs the real terminal (an interactive shell); `server` gets reloaded afterwards. */
export interface Action {
  argv: string[];
  server?: string;
}

interface Choice {
  label: string;
  hint?: string;
  pick: () => void;
}

/** A follow-up offered when a command finishes, e.g. "y apply 3 changes" after `setup --check`. */
interface Next {
  key: string;
  label: string;
  run: () => void;
}

type Mode =
  | { kind: "browse" }
  /** `top` = first shown output row; undefined follows the tail. */
  | { kind: "run"; job: Job; top?: number; next?: Next[] }
  | { kind: "detail" }
  | { kind: "help"; top: number }
  | { kind: "firewall"; server: string; data?: FirewallState; error?: string; index: number }
  /** `runs` newest first. */
  | { kind: "history"; server: string; runs?: Run[]; error?: string; index: number }
  | { kind: "choose"; title: string; body?: string; options: Choice[]; index: number }
  | { kind: "prompt"; title: string; hint: string; value: string; secret?: boolean; submit: (v: string) => void };

// Aliases that only exist for git pushes, never deploy targets.

/** What to do about a failed connection, in plain words. */
function errorHint(error: string): string {
  if (/permission denied/i.test(error)) return "No key login yet. Press u to set it up: landfall asks for the password once and installs a key.";
  if (/resolve|not known|nodename/i.test(error)) return "Host name not found. Check the entry in ~/.ssh/config.";
  if (/timed out|refused|no route|unreachable/i.test(error)) return "Server not reachable. Is it running, and is the ssh port right?";
  return "Press R to retry.";
}


function Dot({ load }: { load?: Load }) {
  if (!load) return <Text dimColor>○</Text>;
  if (load.kind === "loading") return <Spinner />;
  if (load.kind === "error") return <Text color="red">●</Text>;
  return load.data.ready ? <Text color="green">●</Text> : <Text color="yellow">●</Text>;
}

function Spinner() {
  const frames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % frames.length), 80);
    return () => clearInterval(t);
  }, []);
  return <Text color="cyan">{frames[i]}</Text>;
}

function useSize() {
  const stdout = useStdout().stdout as NodeJS.WriteStream;
  const [size, setSize] = useState({ cols: stdout.columns || 80, rows: stdout.rows || 24 });
  useEffect(() => {
    const onResize = () => setSize({ cols: stdout.columns, rows: stdout.rows });
    stdout.on("resize", onResize);
    return () => void stdout.off("resize", onResize);
  }, [stdout]);
  return size;
}

/** The slice of `items` that fits `height` rows and keeps `index` visible. `top` remembers the
 * offset between renders, so the list only scrolls once the selection reaches an edge. */
function windowed<T>(items: T[], index: number, height: number, top: RefObject<number>): { items: T[]; offset: number } {
  let offset = top.current;
  if (index < offset) offset = index;
  if (index >= offset + height) offset = index - height + 1;
  offset = Math.max(0, Math.min(offset, items.length - height));
  top.current = offset;
  return { items: items.slice(offset, offset + height), offset };
}

function Panel({ title, focused, width, height, children }: { title: ReactNode; focused?: boolean; width?: number; height: number; children: ReactNode }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={focused ? "cyan" : "gray"} width={width} flexGrow={width ? 0 : 1} height={height} paddingX={1} overflow="hidden">
      <Box marginBottom={1}>{title}</Box>
      {children}
    </Box>
  );
}

/** Packs the key hints into lines of at most `width` columns, in order; at most `max` lines, the last one truncated. */
function keyLines(keys: [string, string][], width: number, max: number): [string, string][][] {
  const lines: [string, string][][] = [[]];
  let used = 0;
  for (const kv of keys) {
    const w = stringWidth(`${kv[0]} ${kv[1]}`) + 3;
    if (used && used + w - 3 > width && lines.length < max) {
      lines.push([]);
      used = 0;
    }
    lines[lines.length - 1].push(kv);
    used += w;
  }
  return lines;
}

function Keys({ lines }: { lines: [string, string][][] }) {
  return lines.map((keys, i) => (
    <Text key={i} wrap="truncate">
      {keys.map(([k, label], j) => (
        <Text key={k}>
          {j ? "   " : " "}
          <Text color="cyan" bold>
            {k}
          </Text>{" "}
          {label}
        </Text>
      ))}
    </Text>
  ));
}

export function App({ state, onAction }: { state: UiState; onAction: (a: Action) => void }) {
  const { exit } = useApp();
  const { cols, rows } = useSize();
  const [servers, setServers] = useState(listServers);
  const [serverIdx, setServerIdx] = useState(Math.min(state.server, servers.length));
  const [siteIdx, setSiteIdx] = useState(state.site);
  const [focus, setFocus] = useState(state.focus);
  const [mode, setMode] = useState<Mode>({ kind: "browse" });
  const [flash, setFlash] = useState("");
  const [, setTick] = useState(0);
  const serverTop = useRef(0);
  const siteTop = useRef(0);
  const ruleTop = useRef(0);
  const runTop = useRef(0);
  /** While set, finished actions return to this view of a server (firewall or history) instead of the lists. */
  const home = useRef<{ kind: "firewall" | "history"; server: string; index: number; id?: string } | undefined>(undefined);
  const project = loadProject(process.cwd());

  const entry: Entry | undefined = servers[serverIdx]; // undefined = the "add a server" row
  const load = entry && state.cache.get(entry.name);
  const sites: SiteStatus[] = load?.kind === "ok" ? load.data.sites : [];
  const site: SiteStatus | undefined = sites[Math.min(siteIdx, sites.length - 1)];

  useEffect(() => {
    Object.assign(state, { server: serverIdx, site: siteIdx, focus });
  }, [serverIdx, siteIdx, focus]);

  // Selecting a server never connects; ↵ does. Once connected, R or an action reloads it.
  useEffect(() => {
    if (!entry || !state.connect.has(entry.name) || state.cache.has(entry.name)) return;
    const name = entry.name;
    state.cache.set(name, { kind: "loading" });
    setTick((n) => n + 1);
    overview(resolveServer(name).server)
      .then(
        (data) => state.cache.set(name, { kind: "ok", data }),
        (e) => state.cache.set(name, { kind: "error", error: e.message ?? String(e) }),
      )
      .finally(() => setTick((n) => n + 1));
  }, [entry?.name, load, state.connect.has(entry?.name ?? "")]);

  /** Run `lf <argv>` inside the dashboard; `after` may offer follow-ups or chain another run. */
  const run = (argv: string[], opts: { password?: string; server?: string; after?: (job: Job) => Next[] | void } = {}) => {
    const server = opts.server ?? entry?.name;
    // The journal credits what the job changes to this id, so it can be undone as one.
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    let finished = false;
    const job = startJob(
      argv,
      () => {
        if (job.code !== undefined && !finished) {
          finished = true;
          if (server) state.cache.delete(server); // reloads it if connected
          setServers(listServers());
          const next = opts.after?.(job) || (server && changes(argv) ? undoNext(id, server, argv) : undefined);
          setMode((m) => (m.kind === "run" && m.job === job ? { ...m, next } : m));
        }
        setTick((t) => t + 1);
      },
      { password: opts.password, env: { LANDFALL_RUN: id } },
    );
    setMode({ kind: "run", job });
  };
  /** Only for what needs the real terminal: leaves the dashboard and comes back. */
  const leave = (argv: string[]) => {
    onAction({ argv, server: entry?.name });
    exit();
  };
  const back = () => {
    const h = home.current;
    if (!h) return setMode({ kind: "browse" });
    if (h.kind === "firewall") openFirewall(h.server, h.index);
    else openHistory(h.server, h.index, h.id);
  };
  /** Offered when a command that changed the server finished: revert exactly what it did. */
  const undoNext = (id: string, server: string, argv: string[]): Next[] => [
    {
      key: "z",
      label: "undo this",
      run: () => confirm(`Undo \`lf ${argv.join(" ")}\` on ${server}?`, "Reverts the changes this command recorded in the server's journal.", "Undo it", () => run(["undo", id, "-s", server, "-y"], { server, after: () => [] })),
    },
  ];
  const confirm = (title: string, body: string, label: string, pick: () => void) =>
    setMode({ kind: "choose", title, body, index: 0, options: [{ label, pick }, { label: "Cancel", pick: back }] });
  const prompt = (title: string, hint: string, submit: (v: string) => void, secret = false, value = "") =>
    setMode({ kind: "prompt", title, hint, value, secret, submit });

  /**
   * setup = look first (`--check`), then apply on y. Asks for a password if no key works yet.
   * `base` is the server (+ --host) without wizard flags, so `o` starts the wizard over.
   */
  function setupFlow(args: string[], base = args) {
    run(["setup", ...args, "--check"], {
      server: args[0],
      after: (job) => {
        if (job.code !== 0) return;
        if (job.lines.some((l) => l.includes("no key login yet"))) {
          return [{ key: "p", label: "enter the password to install a key", run: () => passwordFor(args, base) }];
        }
        const todo = job.lines.filter((l) => /^\s+→ /.test(l)).length;
        const label = todo ? `apply ${todo} change${todo === 1 ? "" : "s"}` : "finish setup (nothing to install)";
        return [
          { key: "y", label, run: () => run(["setup", ...args, "-y"], { server: args[0] }) },
          { key: "o", label: "change options (traefik, firewall, ssh, deploy user)", run: () => setupWizard(base) },
        ];
      },
    });
  }

  /** Collects setup's flags one screen at a time, then shows the `--check` report for them. */
  function setupWizard(base: string[]) {
    const remembered = loadConfig().servers[base[0]] ?? { host: base[0] };
    const flags: string[] = [];
    const set = (...f: string[]) => flags.push(...f);
    const step = (title: string, body: string, options: Choice[], index = 0) => setMode({ kind: "choose", title, body, options, index });
    const ask = (title: string, hint: string, value: string, flag: string, then: () => void) =>
      prompt(title, hint, (v) => (v.trim() && set(`--${flag}=${v.trim()}`), then()), false, value);

    const traefik = () =>
      step(
        "Setup 1/4 · Traefik",
        "Reverse proxy with automatic HTTPS for your sites.\nIf the server already runs a Traefik on 80/443, setup routes sites through it instead.",
        [
          { label: "Own Traefik, ports published by Docker", hint: "default; Docker forwards 80/443 to the container", pick: () => (set("--no-host-network"), image()) },
          { label: "Own Traefik on the host network", hint: "sees real client IPs (also IPv6); ufw guards 80/443", pick: () => (set("--host-network"), image()) },
          { label: "No Traefik", hint: "add it later with lf traefik setup", pick: () => (set("--no-traefik"), firewall()) },
        ],
        remembered.hostNetwork ? 1 : 0,
      );
    const image = () => ask("Setup · Traefik image", "Docker image to run. Enter keeps it.", remembered.traefikImage ?? DEFAULT_TRAEFIK_IMAGE, "image", email);
    const email = () => ask("Setup · Let's Encrypt e-mail", "Optional contact for the certificate account. Empty skips.", remembered.email ?? "", "email", dashboard);
    const dashboard = () =>
      ask("Setup · Traefik dashboard", "Optional domain for the dashboard behind basic auth; the password is shown after setup. Empty skips.", "", "dashboard", firewall);
    const firewall = () =>
      step("Setup 2/4 · Firewall", "ufw: deny incoming except ssh, 80 and 443.\nSkipped automatically if it would block ports in use.", [
        { label: "Enable ufw", pick: harden },
        { label: "Leave the firewall alone", hint: "manage it later with f", pick: () => (set("--no-firewall"), harden()) },
      ]);
    const harden = () =>
      step("Setup 3/4 · SSH", "Turn off password login so only keys work.\nSkipped automatically if other users still log in with a password.", [
        { label: "Key login only", pick: user },
        { label: "Leave sshd alone", pick: () => (set("--no-harden"), user()) },
      ]);
    const user = () =>
      prompt(
        "Setup 4/4 · Deploy user",
        "landfall deploys as this user (docker group, your key). Empty keeps the login user.",
        (v) => (set(`--deploy-user=${v.trim()}`), review()),
        false,
        "deploy",
      );
    const review = () => setupFlow([...base, ...flags], base);
    traefik();
  }

  function passwordFor(args: string[], base = args) {
    const host = args.includes("--host") ? `root@${args[args.indexOf("--host") + 1]}` : target(args[0]);
    prompt(
      `Password for ${host}`,
      "Used once to install landfall's ssh key (ssh-copy-id). It is not stored; afterwards only the key is used.",
      (pw) => {
        if (!pw) return back();
        run(["setup", ...args, "--key-only", "-y"], {
          password: pw,
          server: args[0],
          after: (job) => (job.code === 0 ? setupFlow(args, base) : [{ key: "p", label: "try the password again", run: () => passwordFor(args, base) }]),
        });
      },
      true,
    );
  }

  function addServer() {
    prompt("Add a server", "Its name. Use an alias from ~/.ssh/config (like vps), or pick a new name for a fresh machine.", (name) => {
      name = name.trim();
      if (!name) return back();
      if (sshAliases().includes(name) || loadConfig().servers[name]) {
        setMode({
          kind: "choose",
          title: `${name} is in your ssh config`,
          index: 0,
          options: [
            { label: "Set it up now", hint: "choose options, see what it would change, then apply", pick: () => setupWizard([name]) },
            { label: "Only add it to landfall", hint: "no changes on the server", pick: () => run(["server", "add", name], { server: name }) },
            { label: "Cancel", pick: back },
          ],
        });
      } else {
        prompt(`Add ${name}`, "IP address or hostname. lf logs in as root once with its password and installs an ssh key.", (host) =>
          host.trim() ? setupWizard([name, "--host", host.trim()]) : back(),
        );
      }
    });
  }

  function deployHere() {
    const server = project?.server ?? entry?.name;
    if (!server) return setFlash("Pick a server on the left first.");
    if (project) {
      return confirm(
        `Deploy ${project.name} to ${server}?`,
        `From ${process.cwd()}\nServed on ${project.domains.join(", ")} (settings from .landfall.json)`,
        "Deploy",
        () => run(["deploy", "-y", ...(project.server ? [] : ["-s", server])], { server }),
      );
    }
    prompt(
      `Deploy ${basename(process.cwd())} to ${server}`,
      "Domain(s) to serve it on, e.g. example.com www.example.com. Their DNS must point at the server.",
      (v) => {
        const domains = v.split(/[\s,]+/).filter(Boolean);
        if (!domains.length) return back();
        run(["deploy", "-y", "-s", server, ...domains.flatMap((d) => ["-d", d])], { server });
      },
    );
  }

  /** Loaded fresh each time, so it always shows what ufw has now. */
  function openFirewall(name: string, index = 0) {
    home.current = { kind: "firewall", server: name, index };
    setMode({ kind: "firewall", server: name, index });
    const set = (patch: { data?: FirewallState; error?: string }) =>
      setMode((m) => (m.kind === "firewall" && m.server === name ? { ...m, ...patch, index: Math.min(m.index, patch.data?.rules.length ?? 0) } : m));
    firewallState(resolveServer(name).server).then(
      (data) => set({ data }),
      (e) => set({ error: e.message ?? String(e) }),
    );
  }

  function firewallKey(input: string, key: { escape?: boolean; leftArrow?: boolean; upArrow?: boolean; downArrow?: boolean; return?: boolean; delete?: boolean; backspace?: boolean }) {
    if (mode.kind !== "firewall") return;
    const { server: n, data: fw, index } = mode;
    if (key.escape || key.leftArrow) {
      home.current = undefined;
      return back();
    }
    if (input === "R") return openFirewall(n, index);
    if (!fw) return;
    const s = ["-s", n];
    const rule = fw.rules[index]; // undefined = the "add a rule" row
    const num = String(index + 1);
    // Safety checks in the commands refuse what would lock out ssh or block ports in use; f overrides after reading why.
    const fwRun = (argv: string[]) =>
      run(argv, {
        server: n,
        after: (job) =>
          job.code !== 0 && !argv.includes("--force") && job.lines.some((l) => l.includes("--force"))
            ? [{ key: "f", label: "do it anyway", run: () => fwRun([...argv, "--force"]) }]
            : undefined,
      });
    const add = () =>
      prompt("Open a port", "port[/proto], e.g. 5432, 51820/udp or 6000:6007/tcp", (port) => {
        if (!port.trim()) return back();
        prompt(`Who may reach ${port.trim()}?`, "An address or network like 10.0.0.0/8. Leave empty for anyone.", (from) =>
          fwRun(["firewall", "allow", port.trim(), ...s, ...(from.trim() ? ["--from", from.trim()] : [])]),
        );
      });
    const select = (i: number) => {
      home.current = { kind: "firewall", server: n, index: i };
      setMode({ ...mode, index: i });
    };
    if (key.upArrow || input === "k") return select(Math.max(0, index - 1));
    if (key.downArrow || input === "j") return select(Math.min(fw.rules.length, index + 1));
    if (input === "t") {
      if (fw.ufw !== "active") return fwRun(["firewall", "enable", ...s]);
      return confirm(`Turn the firewall on ${n} off?`, "Every listening port becomes reachable from anywhere.", "Turn it off", () =>
        fwRun(["firewall", "disable", ...s, "-y"]),
      );
    }
    if (input === "a" || (!rule && key.return)) return add();
    if (!rule) return;
    if (input === " ") {
      const action = rule.action === "deny" || rule.action === "reject" ? "allow" : "deny";
      return fwRun(["firewall", "update", num, "--action", action, ...s]);
    }
    if (input === "e" || key.return) {
      const port = rule.port ? `${rule.port}${rule.proto ? `/${rule.proto}` : ""}` : "";
      return prompt(
        `Edit rule ${num}: ${rule.spec}`,
        "port[/proto]",
        (p) =>
          prompt(
            `Who may reach ${p.trim() || port}?`,
            "An address or network like 10.0.0.0/8. Leave empty for anyone.",
            (from) => fwRun(["firewall", "update", num, ...s, ...(p.trim() && p.trim() !== port ? ["--port", p.trim()] : []), "--from", from.trim() || "any"]),
            false,
            rule.from ?? "",
          ),
        false,
        port,
      );
    }
    if (key.delete || key.backspace) {
      return confirm(`Remove rule ${num}?`, rule.spec, "Remove it", () => fwRun(["firewall", "rm", num, ...s, "-y"]));
    }
  }

  /** Read fresh each time from the server's journal. */
  /** `id` keeps the selected run selected: an undo or reload puts new runs on top. */
  function openHistory(name: string, index = 0, id?: string) {
    home.current = { kind: "history", server: name, index, id };
    setMode({ kind: "history", server: name, index });
    const set = (patch: { runs?: Run[]; error?: string }) =>
      setMode((m) => {
        if (m.kind !== "history" || m.server !== name) return m;
        const at = id ? (patch.runs?.findIndex((r) => r.id === id) ?? -1) : -1;
        return { ...m, ...patch, index: at >= 0 ? at : Math.min(m.index, Math.max(0, (patch.runs?.length ?? 1) - 1)) };
      });
    readJournal(resolveServer(name).server).then(
      (runs) => set({ runs: runs.reverse() }),
      (e) => set({ error: e.message ?? String(e) }),
    );
  }

  function historyKey(input: string, key: { escape?: boolean; leftArrow?: boolean; upArrow?: boolean; downArrow?: boolean; return?: boolean }) {
    if (mode.kind !== "history") return;
    const { server: n, runs, index } = mode;
    if (key.escape || key.leftArrow) {
      home.current = undefined;
      return back();
    }
    if (input === "R") return openHistory(n, index, runs?.[index]?.id);
    if (!runs?.length) return;
    const select = (i: number) => {
      home.current = { kind: "history", server: n, index: i, id: runs[i].id };
      setMode({ ...mode, index: i });
    };
    if (key.upArrow || input === "k") return select(Math.max(0, index - 1));
    if (key.downArrow || input === "j") return select(Math.min(runs.length - 1, index + 1));
    const r = runs[index];
    const undo = (argv: string[]) => run(["undo", ...argv, "-s", n, "-y"], { server: n, after: () => [] });
    if (input === "z" || key.return) {
      const todo = pending(r);
      if (!todo.length) return setFlash(`#${r.n} has nothing left to undo`);
      const later = runs.filter((x) => x.n > r.n && pending(x).length);
      const body = [
        ...todo.map((x) => `↺ ${x.what}`).reverse(),
        ...(later.length ? ["", `Later runs build on it and stay: ${later.map((x) => `#${x.n}`).join(", ")}`] : []),
      ].join("\n");
      return confirm(`Undo #${r.n} ${r.cmd} on ${n}?`, body, `Revert ${todo.length} change${todo.length > 1 ? "s" : ""}`, () => undo([String(r.n)]));
    }
    if (input === "U") {
      const todo = runs.flatMap(pending);
      if (!todo.length) return setFlash("nothing left to undo");
      return confirm(`Undo everything landfall did on ${n}?`, `${todo.length} changes, newest first. Sites, Traefik, the deploy user and landfall's firewall rules go away.`, "Revert everything", () => undo(["--all"]));
    }
  }

  function serverKey(input: string, key: { return?: boolean; rightArrow?: boolean; tab?: boolean; delete?: boolean; backspace?: boolean }) {
    if (!entry) {
      if (key.return || input === "a") addServer();
      return;
    }
    const n = entry.name;
    if (key.return || key.rightArrow || key.tab) {
      if (!state.connect.has(n)) {
        state.connect.add(n);
        return setTick((t) => t + 1);
      }
      if (sites.length) setFocus("sites");
      return;
    }
    if ((key.delete || key.backspace) && entry.registered) {
      return confirm(`Forget ${n}?`, "Removes it from landfall (and the Host block landfall wrote to ~/.ssh/config).\nNothing on the server is changed.", `Forget ${n}`, () =>
        run(["server", "rm", n, "-y"]),
      );
    }
    switch (input) {
      case "c":
      case "u":
        return setupFlow([n]);
      case "i":
        return run(["server", "info", n]);
      case "t":
        return run(["traefik", "status", "-s", n]);
      case "f":
        return openFirewall(n);
      case "h":
        return openHistory(n);
      case "x":
        return leave(["ssh", n]);
      case "a":
        return addServer();
      case "*": {
        const cfg = loadConfig();
        cfg.servers[n] ??= { host: n };
        cfg.default = n;
        saveConfig(cfg);
        setServers(listServers());
        return setFlash(`${n} is now the default server`);
      }
    }
  }

  function siteKey(input: string, key: { return?: boolean; delete?: boolean; backspace?: boolean }) {
    if (!entry || !site) return;
    const s = ["-s", entry.name];
    const name = site.meta.name;
    if (key.return) return setMode({ kind: "detail" });
    if (key.delete || key.backspace) {
      return confirm(`Delete ${name} from ${entry.name}?`, `Stops it and removes all its files and releases.\nThis cannot be undone.`, `Delete ${name}`, () =>
        run(["sites", "rm", name, ...s, "-y"]),
      );
    }
    switch (input) {
      case "l":
        return run(["logs", name, ...s, "-f"]);
      case "r":
        return run(["restart", name, ...s]);
      case "s":
        return run([isUp(site.status) ? "stop" : "start", name, ...s]);
      case "b": {
        const older = newestFirst(site.meta).filter((r) => r.at < (site.meta.releases.find((x) => x.id === site.meta.current)?.at ?? ""));
        if (!older.length) return setFlash(`${name} has no older release to go back to`);
        return confirm(`Roll back ${name}?`, `From ${site.meta.current} to ${older[0].id} (${ago(older[0].at)})`, "Roll back", () =>
          run(["rollback", name, ...s, "-y"]),
        );
      }
      case "e":
        if (site.meta.kind === "static") return setFlash("static sites have no environment variables");
        return prompt(`Environment of ${name}`, "KEY=VALUE pairs to set (the container restarts). Leave empty to just show them.", (v) =>
          run(["env", name, ...s, ...v.split(/\s+/).filter(Boolean)]),
        );
      case "o": {
        const url = `https://${site.domains[0]}`;
        spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore", detached: true }).unref();
        return setFlash(`opened ${url}`);
      }
    }
  }

  const keys: [string, string][] =
    mode.kind === "run"
      ? mode.job.code === undefined
        ? [["esc", "stop"], ["↑↓ space", "scroll"], ["g G", "top / end"]]
        : [...(mode.next ?? []).map((n): [string, string] => [n.key, n.label]), ["esc", "back"], ["↑↓ space", "scroll"], ["g G", "top / end"]]
      : mode.kind === "firewall"
      ? [["esc", "back"], ["↑↓", "rule"], ["t", mode.data?.ufw === "active" ? "turn off" : "turn on"], ["a", "add"], ["e", "edit"], ["space", "allow ↔ deny"], ["⌫", "remove"], ["R", "reload"]]
      : mode.kind === "history"
      ? [["esc", "back"], ["↑↓", "run"], ["z ↵", "undo run"], ["U", "undo everything"], ["R", "reload"]]
      : mode.kind === "choose"
      ? [["↑↓", "choose"], ["↵", "ok"], ["esc", "back"]]
      : mode.kind === "prompt"
        ? [["↵", "ok"], ["esc", "cancel"]]
        : mode.kind === "help"
          ? [["↑↓ space", "scroll"], ["any key", "close"]]
          : !entry
            ? [["↵", "add a server"], ["d", "deploy this folder"], ["?", "help"], ["q", "quit"]]
            : focus === "servers" && mode.kind === "browse"
              ? [["?", "help"], ["q", "quit"], ["↑↓", "server"], ["↵", entry && state.connect.has(entry.name) ? "sites" : "connect"], ["u", "check & set up"], ["d", "deploy here"], ["i", "info"], ["t", "traefik"], ["f", "firewall"], ["h", "history"], ["x", "shell ↗"], ["*", "default"], ["a", "add"], ...(entry.registered ? [["⌫", "forget"] as [string, string]] : [])]
              : [["?", "help"], ["←", "servers"], ["↑↓", "site"], ["↵", "details"], ["l", "logs"], ["r", "restart"], ["s", site && isUp(site.status) ? "stop" : "start"], ["b", "roll back"], ["e", "env"], ["o", "open"], ["⌫", "delete"]];

  // Narrow terminals stack the panels; short ones get fewer lines of key hints.
  const narrow = cols < 72;
  const keyRows = keyLines(keys, cols - 1, rows < 16 ? 2 : 3);
  const bodyHeight = Math.max(6, rows - 3 - keyRows.length);
  const leftWidth = Math.min(36, Math.floor(cols * 0.4), Math.max(26, ...servers.map((s) => s.name.length + 14)));
  // Too short to stack as well: only the focused panel shows.
  const single = narrow && bodyHeight < 16;
  const serversHeight = narrow && !single ? Math.max(5, Math.min(servers.length + 5, Math.floor(bodyHeight * 0.4))) : bodyHeight;
  const rightHeight = narrow && !single ? bodyHeight - serversHeight : bodyHeight;
  const rightWidth = narrow ? cols : cols - leftWidth;

  useInput((input, key) => {
    setFlash("");
    const running = mode.kind === "run" && mode.job.code === undefined;
    if (key.ctrl && input === "c") return running ? mode.job.stop() : exit();
    if (mode.kind === "run") {
      const view = runHeight(bodyHeight);
      const last = Math.max(0, runRows(mode.job, cols).length - view);
      // Clamped, so scrolling past either end does nothing; reaching the bottom follows new output again.
      const scrollTo = (t: number) => setMode({ ...mode, top: t >= last ? undefined : Math.max(0, t) });
      const at = Math.min(mode.top ?? last, last);
      if (key.escape || input === "q" || key.leftArrow) return running ? mode.job.stop() : back();
      if (key.upArrow || input === "k") return scrollTo(at - 1);
      if (key.downArrow || input === "j") return scrollTo(at + 1);
      if (key.pageUp) return scrollTo(at - view);
      if (key.pageDown || input === " ") return scrollTo(at + view);
      if (input === "g" || key.home) return scrollTo(0);
      if (input === "G" || key.end) return scrollTo(last);
      return mode.next?.find((n) => n.key === input)?.run();
    }
    if (mode.kind === "prompt") {
      if (key.escape) return back();
      if (key.return) return mode.submit(mode.value);
      if (key.backspace || key.delete) return setMode({ ...mode, value: mode.value.slice(0, -1) });
      if (input && !key.ctrl && !key.meta) setMode({ ...mode, value: mode.value + input });
      return;
    }
    if (mode.kind === "choose") {
      if (key.escape) return back();
      if (key.upArrow || key.downArrow) {
        const d = key.upArrow ? -1 : 1;
        return setMode({ ...mode, index: (mode.index + d + mode.options.length) % mode.options.length });
      }
      if (key.return) return mode.options[mode.index].pick();
      return;
    }
    if (mode.kind === "help") {
      const last = Math.max(0, helpRows(cols).length - (bodyHeight - 4));
      const scrollTo = (t: number) => setMode({ ...mode, top: Math.max(0, Math.min(last, t)) });
      if (key.upArrow || input === "k") return scrollTo(mode.top - 1);
      if (key.downArrow || input === "j") return scrollTo(mode.top + 1);
      if (input === " " || key.pageDown) return scrollTo(mode.top + bodyHeight - 4);
      if (key.pageUp) return scrollTo(mode.top - (bodyHeight - 4));
      return back();
    }
    if (mode.kind === "firewall" && input !== "q" && input !== "?") return firewallKey(input, key);
    if (mode.kind === "history" && input !== "q" && input !== "?") return historyKey(input, key);
    if (input === "q") return exit();
    if (input === "?") return setMode({ kind: "help", top: 0 });
    if (input === "d") return deployHere();
    if (input === "R") {
      state.cache.clear();
      setServers(listServers());
      return setTick((t) => t + 1);
    }
    if (mode.kind === "detail") {
      if (key.escape || key.leftArrow) return back();
      return siteKey(input, key);
    }
    if (focus === "servers") {
      if (key.upArrow || input === "k") {
        setSiteIdx(0);
        return setServerIdx((i) => Math.max(0, i - 1));
      }
      if (key.downArrow || input === "j") {
        setSiteIdx(0);
        return setServerIdx((i) => Math.min(servers.length, i + 1));
      }
      if (key.escape) return exit();
      return serverKey(input, key);
    }
    if (key.escape || key.leftArrow) return setFocus("servers");
    if (key.upArrow || input === "k") return setSiteIdx((i) => Math.max(0, i - 1));
    if (key.downArrow || input === "j") return setSiteIdx((i) => Math.min(sites.length - 1, i + 1));
    siteKey(input, key);
  });

  const header = (
    <Box justifyContent="space-between">
      <Box flexShrink={0}>
        <Text>
          <Text bold color="cyan">
            landfall
          </Text>{" "}
          <Text dimColor>{pkg.version}</Text>
        </Text>
      </Box>
      <Box flexShrink={1} flexGrow={0} marginLeft={2} overflow="hidden">
        <Text dimColor wrap="truncate">
          {project
          ? `this folder: ${project.name} → ${project.server ?? "?"} · ${project.domains.join(", ")}`
          : `this folder: ${basename(process.cwd())} (not deployed yet · d to deploy)`}
        </Text>
      </Box>
    </Box>
  );

  let body: ReactNode;
  if (cols < 40 || rows < 12) body = <Text color="yellow">Make the terminal bigger: {cols}×{rows}, landfall needs 40×12.</Text>;
  else if (mode.kind === "help") body = <Help height={bodyHeight} width={cols} top={mode.top} />;
  else if (mode.kind === "firewall") body = <FirewallView mode={mode} height={bodyHeight} top={ruleTop} />;
  else if (mode.kind === "history") body = <HistoryView mode={mode} height={bodyHeight} top={runTop} />;
  else if (mode.kind === "run") body = <RunView job={mode.job} top={mode.top} height={bodyHeight} width={cols} />;
  else if (mode.kind === "choose" || mode.kind === "prompt") {
    body = (
      <Panel title={<Text bold>{mode.title}</Text>} focused height={bodyHeight}>
        {mode.kind === "choose" ? (
          <Box flexDirection="column">
            {mode.body && (
              <Box marginBottom={1}>
                <Text>{mode.body}</Text>
              </Box>
            )}
            {mode.options.map((o, i) => (
              <Text key={o.label} color={i === mode.index ? "cyan" : undefined}>
                {i === mode.index ? "› " : "  "}
                <Text bold={i === mode.index}>{o.label}</Text>
                {o.hint && <Text dimColor>  {o.hint}</Text>}
              </Text>
            ))}
          </Box>
        ) : (
          <Box flexDirection="column">
            <Text dimColor>{mode.hint}</Text>
            <Box marginTop={1} borderStyle="single" borderColor="cyan" paddingX={1}>
              <Text>
                {mode.secret ? "•".repeat(mode.value.length) : mode.value}
                <Text inverse> </Text>
              </Text>
            </Box>
          </Box>
        )}
      </Panel>
    );
  } else {
    const rowsServers: (Entry | undefined)[] = [...servers, undefined];
    const win = windowed(rowsServers, serverIdx, serversHeight - 4, serverTop);
    const firstAlias = servers.findIndex((s) => !s.registered);
    body = (
      <Box flexDirection={narrow ? "column" : "row"}>
        {!(single && focus === "sites") && <Panel title={<Text bold>Servers</Text>} focused={focus === "servers"} width={narrow ? undefined : leftWidth} height={serversHeight}>
          {win.items.map((e, i) => {
            const idx = win.offset + i;
            const sel = idx === serverIdx;
            const label = e ? (
              <>
                <Dot load={state.cache.get(e.name)} /> <Text bold={sel}>{e.name}</Text>
                {e.isDefault && <Text dimColor> default</Text>}
                {!e.registered && idx === firstAlias && <Text dimColor> ssh config</Text>}
              </>
            ) : (
              <Text color="green">+ add a server</Text>
            );
            return (
              <Text key={e?.name ?? "+"} wrap="truncate" color={sel && focus === "servers" ? "cyan" : undefined}>
                {sel ? "› " : "  "}
                {label}
              </Text>
            );
          })}
        </Panel>}
        {!(single && focus === "servers") && <Right entry={entry} load={load} sites={sites} siteIdx={siteIdx} detail={mode.kind === "detail"} focused={focus === "sites"} height={rightHeight} width={rightWidth} top={siteTop} />}
      </Box>
    );
  }

  const status =
    flash ||
    (mode.kind === "run"
      ? mode.job.code === undefined
        ? "running… esc stops it"
        : "finished · esc goes back"
      : entry
        ? describeServer(entry, load)
        : "Servers are machines you reach with ssh. Sites run on them behind Traefik with HTTPS.");

  return (
    <Box flexDirection="column" width={cols} height={rows - 1}>
      {header}
      {body}
      <Text dimColor={!flash} color={flash ? "yellow" : undefined} wrap="truncate">
        {" " + status}
      </Text>
      <Keys lines={keyRows} />
    </Box>
  );
}

function describeServer(e: Entry, load?: Load): string {
  const parts = [target(e.name)];
  if (!e.registered) parts.push("from ~/.ssh/config");
  if (load?.kind === "ok") {
    parts.push(load.data.ready ? `${load.data.sites.length} site${load.data.sites.length === 1 ? "" : "s"}` : "not set up for landfall yet");
    if (load.data.others.length) parts.push(`${load.data.others.length} not by landfall`);
  }
  return parts.join(" · ");
}

function Right(p: {
  entry?: Entry;
  load?: Load;
  sites: SiteStatus[];
  siteIdx: number;
  detail: boolean;
  focused: boolean;
  height: number;
  /** Outer width, for which columns fit. */
  width: number;
  top: RefObject<number>;
}) {
  if (!p.entry) {
    return (
      <Panel title={<Text bold>Add a server</Text>} height={p.height}>
        <Text>Press ↵ to add one. Two ways:</Text>
        <Text> </Text>
        <Text>
          <Text bold>A server you already reach with ssh</Text> (e.g. <Text color="cyan">ssh vps</Text>): enter its alias.
        </Text>
        <Text>
          <Text bold>A fresh machine</Text>: enter a new name and its IP. landfall asks for the root password once and installs a key.
        </Text>
        <Text> </Text>
        <Text dimColor>Setup installs Docker and Traefik (HTTPS). It checks the server first and never touches what already runs there.</Text>
      </Panel>
    );
  }
  const name = p.entry.name;
  const load = p.load;
  if (!load) {
    return (
      <Panel title={<Text bold>{name}</Text>} height={p.height}>
        <Text dimColor>{target(name)}</Text>
        <Text> </Text>
        <Text>
          Not connected. Press{" "}
          <Text color="cyan" bold>
            ↵
          </Text>{" "}
          to connect and show its sites.
        </Text>
      </Panel>
    );
  }
  if (load.kind === "loading") {
    return (
      <Panel title={<Text bold>{name}</Text>} height={p.height}>
        <Text>
          <Spinner /> connecting…
        </Text>
      </Panel>
    );
  }
  if (load.kind === "error") {
    return (
      <Panel title={<Text bold>{name}</Text>} height={p.height}>
        <Text color="red">{load.error}</Text>
        <Text> </Text>
        <Text>{errorHint(load.error)}</Text>
      </Panel>
    );
  }
  const { ready, traefik, proxy, sites } = load.data;
  const title = (
    <Text wrap="truncate">
      <Text bold>Sites on {name}</Text>
      <Text dimColor>  {proxy} </Text>
      {traefik ? <Text color={isUp(traefik) ? "green" : "red"}>{traefik}</Text> : <Text color="yellow">not installed</Text>}
    </Text>
  );
  if (!ready) {
    return (
      <Panel title={title} height={p.height}>
        <Text>{name} is reachable, but landfall has not set it up yet.</Text>
        <Text> </Text>
        <Text>
          Press{" "}
          <Text color="cyan" bold>
            u
          </Text>{" "}
          to check what is installed. Nothing changes until you confirm the list (Docker, firewall, deploy user, Traefik).
        </Text>
      </Panel>
    );
  }
  if (!sites.length) {
    return (
      <Panel title={title} height={p.height}>
        <Text>No sites yet.</Text>
        <Text> </Text>
        <Text>
          Start landfall inside a project folder and press{" "}
          <Text color="cyan" bold>
            d
          </Text>{" "}
          to deploy it here. A folder with index.html, dist/ or build/ is served as a static site; a Dockerfile is built on the server.
        </Text>
      </Panel>
    );
  }
  const idx = Math.min(p.siteIdx, sites.length - 1);
  if (p.detail) return <SiteDetail s={sites[idx]} height={p.height} />;

  const win = windowed(sites, idx, p.height - 4, p.top);
  const avail = p.width - 8; // border, padding, marker, dot
  const nameW = Math.min(Math.max(...sites.map((s) => s.meta.name.length)) + 2, Math.max(8, Math.floor(avail * 0.4)));
  // Kind and age go first when it gets tight; the domains always get the rest.
  const inner = avail - nameW;
  const showKind = inner >= 40;
  const showAge = inner >= 24;
  return (
    <Panel title={title} focused={p.focused} height={p.height}>
      {win.items.map((s, i) => {
        const sel = win.offset + i === idx && p.focused;
        return (
          <Box key={s.meta.name}>
            <Box width={2} flexShrink={0}>
              <Text color={sel ? "cyan" : undefined}>{sel ? "›" : " "}</Text>
            </Box>
            <Box width={2} flexShrink={0}>
              <Text color={isUp(s.status) ? "green" : "red"}>{isUp(s.status) ? "●" : "○"}</Text>
            </Box>
            <Box width={nameW} flexShrink={0} paddingRight={1}>
              <Text bold={sel} color={sel ? "cyan" : undefined} wrap="truncate">
                {s.meta.name}
              </Text>
            </Box>
            {showKind && (
              <Box width={12}>
                <Text dimColor>{s.kind}</Text>
              </Box>
            )}
            <Box flexGrow={1} flexShrink={1}>
              <Text wrap="truncate">{s.domains.join(" ")}</Text>
            </Box>
            {showAge && (
              <Box width={10} flexShrink={0} justifyContent="flex-end">
                <Text dimColor>{ago(s.meta.updatedAt)}</Text>
              </Box>
            )}
          </Box>
        );
      })}
    </Panel>
  );
}

const REACH_COLOR = { open: "green", limited: "cyan", blocked: "red", local: undefined } as const;

function FirewallView({ mode, height, top }: { mode: Extract<Mode, { kind: "firewall" }>; height: number; top: RefObject<number> }) {
  const fw = mode.data;
  const title = (
    <Text bold>
      Firewall <Text dimColor>on</Text> {mode.server}
    </Text>
  );
  if (!fw) {
    return (
      <Panel title={title} focused height={height}>
        {mode.error ? <Text color="red">{mode.error}</Text> : <Text><Spinner /> reading ufw…</Text>}
      </Panel>
    );
  }
  const inner = height - 4;
  const rows: (FirewallState["rules"][number] | undefined)[] = [...fw.rules, undefined];
  // Rules get up to half the room, the ports the rest.
  const win = windowed(rows, mode.index, Math.max(2, Math.min(rows.length, Math.floor((inner - 4) / 2))), top);
  const portRows = Math.max(0, inner - win.items.length - 5);
  const ports = fw.ports.slice(0, portRows);
  const state = fw.ufw === "active" ? <Text color="green">on</Text> : <Text color="yellow">{fw.ufw === "missing" ? "not installed" : "off"}</Text>;
  return (
    <Panel title={title} focused height={height}>
      <Text wrap="truncate">
        ufw {state}
        <Text dimColor>
          {"  ·  "}incoming without a rule: {fw.policy === "ACCEPT" ? "allowed" : "blocked"}
          {"  ·  "}ssh port {fw.sshPort}
          {effectiveSsh(fw.login).user === "root" ? "  ·  as root" : ""}
        </Text>
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text bold>Rules</Text>
        {win.items.map((r, i) => {
          const idx = win.offset + i;
          const sel = idx === mode.index;
          return (
            <Text key={r?.spec ?? "+"} wrap="truncate" color={sel ? "cyan" : undefined}>
              {sel ? "› " : "  "}
              {r ? (
                <>
                  <Text dimColor>{String(idx + 1).padStart(2)} </Text>
                  <Text color={r.action === "deny" || r.action === "reject" ? "red" : "green"}>{r.action.padEnd(6)}</Text>
                  {r.spec.replace(/^\w+\s+/, "")}
                </>
              ) : (
                <Text color="green">+ add a rule</Text>
              )}
            </Text>
          );
        })}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold>Listening ports</Text>
        {ports.map((p) => (
          <Text key={`${p.port} ${p.proc}`} wrap="truncate">
            {"  "}
            {p.port.padEnd(8)}
            {p.proc.padEnd(17)}
            <Text color={REACH_COLOR[p.state]} dimColor={p.state === "local"}>
              {p.why}
            </Text>
          </Text>
        ))}
        {fw.ports.length > ports.length && <Text dimColor>  … {fw.ports.length - ports.length} more (lf firewall status -s {mode.server})</Text>}
      </Box>
    </Panel>
  );
}

function SiteDetail({ s, height }: { s: SiteStatus; height: number }) {
  const m = s.meta;
  const releases = newestFirst(m).slice(0, Math.max(1, height - 10));
  return (
    <Panel
      title={
        <Text>
          <Text bold>{m.name}</Text> <Text dimColor>{s.kind}</Text> <Text color={isUp(s.status) ? "green" : "red"}>{s.status}</Text>
        </Text>
      }
      focused
      height={height}
    >
      {s.domains.map((d) => (
        <Text key={d} color="cyan">
          https://{d}
        </Text>
      ))}
      <Text dimColor>{m.adopted ?? siteDir(m.name)}</Text>
      <Text> </Text>
      <Text bold>Services</Text>
      {s.services.map((v) => (
        <Text key={v.container}>
          {"  "}
          {v.service} <Text color={isUp(v.status) ? "green" : isDone(v.status) ? undefined : "red"} dimColor={isDone(v.status)}>{v.status}</Text>
        </Text>
      ))}
      {!s.services.length && <Text dimColor>  none running</Text>}
      <Text> </Text>
      <Text bold>Releases</Text>
      {releases.map((r) => (
        <Text key={r.id}>
          {r.id === m.current ? <Text color="green">● </Text> : "  "}
          {r.id} <Text dimColor>{ago(r.at)}</Text>
          {r.services?.length ? <Text dimColor> {r.services.map((v) => v.name).join(" ")}</Text> : null}
          {r.id === m.current ? <Text dimColor> (live)</Text> : null}
        </Text>
      ))}
    </Panel>
  );
}

const HELP_SERVERS: [string, string][] = [
  ["u", "check, then set up / repair on y"],
  ["i", "OS, memory, disk, containers"],
  ["t", "traefik status and routes"],
  ["f", "firewall: rules, ports, on / off"],
  ["h", "history: what landfall changed, undo it"],
  ["x", "open a shell (leaves the dashboard)"],
  ["*", "make default server"],
  ["a", "add a server"],
];
const HELP_SITES: [string, string][] = [
  ["↵", "details and releases"],
  ["l", "follow logs (esc stops)"],
  ["r / s", "restart / stop or start"],
  ["b", "roll back to previous release"],
  ["e", "environment variables"],
  ["o", "open in browser"],
  ["⌫", "delete site / forget server"],
];
const HELP_TEXT = [
  "Servers are machines you reach with ssh (anything in ~/.ssh/config works). Set up installs Docker and Traefik there; Traefik gets HTTPS certificates from Let's Encrypt for every site automatically.",
  "Sites are deployed from a project folder: static files, a Dockerfile, or an image. Each deploy is a release you can roll back to. .landfall.json in the folder remembers where it goes.",
  "Every change landfall makes is written to /opt/landfall/journal.log on the server. h shows it; z reverts a run, also right after a command finished.",
];
const HELP_FOOT = "Commands run inside the dashboard and show their output; esc stops or goes back. Each is a normal landfall command, shown as `$ lf …`, so the same thing works without the dashboard.";

/** Splits text at spaces into lines of at most `width` columns. */
function wordWrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && stringWidth(`${line} ${word}`) > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  return [...lines, line];
}

/** The help, one screen row each so it can scroll; the two key columns sit side by side when they fit. */
function helpRows(width: number): ReactNode[] {
  const inner = width - 4;
  const key = (k: string, what: string, w = 10) => (
    <Text wrap="truncate">
      <Text color="cyan" bold>
        {k.padEnd(w)}
      </Text>
      {what}
    </Text>
  );
  const rows: ReactNode[] = [];
  for (const p of HELP_TEXT) rows.push(...wordWrap(p, inner).map((l) => <Text wrap="truncate">{l}</Text>), <Text> </Text>);
  if (inner >= 92) {
    rows.push(
      <Text>
        <Text bold>{"Servers".padEnd(46)}</Text>
        <Text bold>Sites</Text>
      </Text>,
    );
    for (let i = 0; i < Math.max(HELP_SERVERS.length, HELP_SITES.length); i++) {
      const [a, b] = [HELP_SERVERS[i], HELP_SITES[i]];
      rows.push(
        <Box>
          <Box width={46}>{a ? key(...a) : <Text> </Text>}</Box>
          {b ? key(...b) : <Text> </Text>}
        </Box>,
      );
    }
  } else {
    rows.push(<Text bold>Servers</Text>, ...HELP_SERVERS.map((a) => key(...a)), <Text> </Text>, <Text bold>Sites</Text>, ...HELP_SITES.map((b) => key(...b)));
  }
  rows.push(<Text> </Text>, key("d", "deploy the folder landfall was started in"), key("R", "reload"), <Text> </Text>);
  rows.push(...wordWrap(HELP_FOOT, inner).map((l) => <Text dimColor wrap="truncate">{l}</Text>));
  return rows;
}

function Help({ height, width, top }: { height: number; width: number; top: number }) {
  const rows = helpRows(width);
  const view = Math.max(1, height - 4);
  const start = Math.min(top, Math.max(0, rows.length - view));
  const below = rows.length - start - view;
  return (
    <Panel
      title={
        <Text>
          <Text bold>How landfall works</Text>
          {below > 0 && <Text dimColor>  ↓ {below} more</Text>}
        </Text>
      }
      focused
      height={height}
    >
      {rows.slice(start, start + view).map((r, i) => (
        <Box key={start + i}>{r}</Box>
      ))}
    </Panel>
  );
}

function HistoryView({ mode, height, top }: { mode: Extract<Mode, { kind: "history" }>; height: number; top: RefObject<number> }) {
  const title = (
    <Text bold>
      History <Text dimColor>on</Text> {mode.server} <Text dimColor>· /opt/landfall/journal.log</Text>
    </Text>
  );
  const { runs } = mode;
  if (!runs?.length) {
    return (
      <Panel title={title} focused height={height}>
        {mode.error ? <Text color="red">{mode.error}</Text> : runs ? <Text>landfall has not changed anything on {mode.server} yet.</Text> : <Text><Spinner /> reading the journal…</Text>}
      </Panel>
    );
  }
  const inner = height - 4;
  const r = runs[mode.index];
  // Runs get at least half the room, more when the selected run has few steps; the steps get the rest.
  const win = windowed(runs, mode.index, Math.max(1, Math.min(runs.length, Math.max(Math.ceil(inner / 2), inner - r.steps.length - 1))), top);
  const stepRows = Math.max(1, inner - win.items.length - 2);
  const steps = r.steps.slice(0, r.steps.length > stepRows ? stepRows - 1 : stepRows);
  return (
    <Panel title={title} focused height={height}>
      {win.items.map((x, i) => {
        const sel = win.offset + i === mode.index;
        const open = pending(x).length;
        return (
          <Text key={x.id} wrap="truncate" color={sel ? "cyan" : undefined}>
            {sel ? "› " : "  "}
            <Text bold>{`#${x.n}`.padEnd(5)}</Text>
            <Text dimColor>{ago(x.time).padEnd(9)}</Text>
            <Text bold={sel} dimColor={!open}>
              {x.cmd || "?"}
            </Text>
            {open ? <Text color="cyan"> ↺{open}</Text> : null}
            <Text dimColor>  {x.actor}</Text>
          </Text>
        );
      })}
      <Box marginTop={1} flexDirection="column">
        {steps.map((x) => (
          <Text key={x.line} wrap="truncate">
            {"  "}
            {x.reverts ? (
              <Text dimColor>↩ {x.what}</Text>
            ) : x.undone ? (
              <Text dimColor>✓ {x.what} (undone)</Text>
            ) : x.undo ? (
              <>
                <Text color="cyan">↺</Text> {x.what}
              </>
            ) : (
              <Text dimColor>· {x.what}</Text>
            )}
          </Text>
        ))}
        {r.steps.length > steps.length && <Text dimColor>  … {r.steps.length - steps.length} more (lf history -s {mode.server})</Text>}
      </Box>
    </Panel>
  );
}

const lineColor = (l: string) =>
  /^==> /.test(l) ? "cyan" : /^\s*✓/.test(l) ? "green" : /^\s*!/.test(l) ? "yellow" : /^\s*(error|✗)/i.test(l) ? "red" : undefined;

/** Splits a line into rows of at most `width` columns. */
function wrap(line: string, width: number): string[] {
  const rows: string[] = [];
  let row = "";
  for (const ch of line) {
    if (stringWidth(row + ch) > width) {
      rows.push(row);
      row = "";
    }
    row += ch;
  }
  rows.push(row);
  return rows;
}

/** The job's output as screen rows of the run panel (border and padding take 4 columns). */
const runRows = (job: Job, width: number) => job.lines.flatMap((l) => wrap(l, Math.max(10, width - 4)).map((r) => ({ r, color: lineColor(l) })));
const runHeight = (height: number) => Math.max(1, height - 4);

function RunView({ job, top, height, width }: { job: Job; top?: number; height: number; width: number }) {
  const rows = runRows(job, width);
  const view = runHeight(height);
  const last = Math.max(0, rows.length - view);
  const start = Math.min(top ?? last, last);
  const shown = rows.slice(start, start + view);
  const below = rows.length - start - shown.length;
  const state =
    job.code === undefined ? (
      <Spinner />
    ) : job.code === 0 ? (
      <Text color="green">✓ done</Text>
    ) : job.code === null ? (
      <Text color="yellow">stopped</Text>
    ) : (
      <Text color="red">✗ exit {job.code}</Text>
    );
  return (
    <Panel
      title={
        <Text wrap="truncate">
          <Text bold>$ lf {job.argv.join(" ")}</Text> {state}
          {below > 0 && <Text dimColor>  ↓ {below} more line{below === 1 ? "" : "s"}</Text>}
        </Text>
      }
      focused
      height={height}
    >
      {shown.map(({ r, color }, i) => (
        <Text key={i} color={color} wrap="truncate">
          {r || " "}
        </Text>
      ))}
    </Panel>
  );
}
