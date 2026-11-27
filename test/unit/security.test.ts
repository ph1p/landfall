import { describe, expect, test } from "vitest";
import { advise, lockedOut } from "../../src/core/server/security";
import { parseSystem } from "../../src/core/server/system";

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl me@laptop";
const out = (...lines: string[]) => ["root=1", "user=root", ...lines].join("\n");
const ids = (o: string) => advise(parseSystem(o), { name: "web", loginUser: "deploy" }).map((a) => a.id);

describe("security", () => {
  test("parses what sshd and the system allow", () => {
    const i = parseSystem(
      out(
        "sshd_passwordauthentication=no",
        "sshd_kbdinteractiveauthentication=yes",
        "sshd_permitrootlogin=prohibit-password",
        "password_users=alice deploy ",
        "pkg=apt-get",
        "ufw=active",
        "auto_updates=on",
        "reboot=1",
      ),
    );
    expect(i.security).toEqual({
      passwordLogin: true,
      rootLogin: "prohibit-password",
      passwordUsers: ["alice", "deploy"],
      pkg: "apt-get",
      firewall: "active",
      autoUpdates: true,
      reboot: true,
      openEnv: [],
      releaseFiles: [],
    });
  });

  test("parses accounts, kernel settings, open .env files and files in releases", () => {
    const i = parseSystem(
      [
        out("sshd_permitemptypasswords=yes", "sshd_x11forwarding=yes", "empty_password_users=guest ", "uid0=toor ", "security_updates=3"),
        "SYSCTL\tnet.ipv4.tcp_syncookies\t1",
        "SYSCTL\tnet.ipv4.conf.all.accept_redirects\t1",
        "SYSCTL\tkernel.kptr_restrict\t2",
        "OPENENV\t/opt/landfall/sites/blog/.env",
        "REL\tblog\t/opt/landfall/sites/blog/releases/1",
        "RF\td\t0\t/opt/landfall/sites/blog/releases/1/.git",
        "RF\tf\t0\t/opt/landfall/sites/blog/releases/1/public/.DS_Store",
        "RF\tf\t0\t/opt/landfall/sites/blog/releases/1/ca.pem",
        "RF\tf\t1\t/opt/landfall/sites/blog/releases/1/key.pem",
        "REL\tshop\t/opt/landfall/sites/shop/releases/2",
        "RF\tf\t0\t/opt/landfall/sites/shop/releases/2/dump.sql",
      ].join("\n"),
    );
    const s = i.security;
    expect([s.emptyPasswords, s.x11Forwarding, s.emptyPasswordUsers, s.uid0, s.securityUpdates]).toEqual([true, true, ["guest"], ["toor"], 3]);
    expect(s.kernel).toEqual({ "net.ipv4.tcp_syncookies": "1", "net.ipv4.conf.all.accept_redirects": "1", "kernel.kptr_restrict": "2" });
    expect(s.openEnv).toEqual(["/opt/landfall/sites/blog/.env"]);
    expect(s.releaseFiles?.map((f) => `${f.severity} ${f.site} ${f.path}`)).toEqual([
      "high blog .git/",
      "low blog public/.DS_Store",
      "high blog key.pem",
      "medium shop dump.sql",
    ]);
    const l = advise(i, { name: "web", loginUser: "deploy" });
    expect(l.map((a) => [a.id, a.level])).toEqual([
      ["empty-passwords", "risk"],
      ["uid0", "risk"],
      ["ssh-options", "risk"],
      ["release-files:blog", "risk"],
      ["kernel", "warn"],
      ["security-updates", "warn"],
      ["open-env", "warn"],
      ["release-files:shop", "warn"],
    ]);
    const by = Object.fromEntries(l.map((a) => [a.id, a]));
    // Only the redirect setting is loose: kptr_restrict=2 is stricter than wanted, not looser.
    expect(by.kernel.why).toMatch(/^net\.ipv4\.conf\.all\.accept_redirects is 1\./);
    expect(by["release-files:blog"].title).toBe("blog has 3 files it should not: .git/ …");
    expect(by["release-files:blog"].fix).toBeUndefined();
    expect(by["security-updates"].fix).toMatchObject({ argv: ["update", "--security", "-s", "web"], confirm: "Package upgrades cannot be undone." });
    expect(by["empty-passwords"].fix?.argv).toEqual(["harden", "accounts", "-s", "web"]);
    // Unique titles: the web UI keys the list by them.
    expect(new Set(l.map((a) => a.title)).size).toBe(l.length);
  });

  test("with automatic updates, waiting security updates are only a note", () => {
    const l = advise(parseSystem(out("auto_updates=on", "security_updates=1")), { name: "web", loginUser: "deploy" });
    expect(l.find((a) => a.id === "security-updates")).toMatchObject({ level: "info", title: "1 security update waiting" });
  });

  test("without root nothing is guessed", () => {
    const i = parseSystem("root=0\nuser=bob\nfail2ban=stopped\nreboot=");
    expect(i.security).toEqual({ reboot: false });
    expect(advise(i, { name: "web", loginUser: "bob" })).toEqual([]);
  });

  test("Synology: points to DSM's own firewall and bans", () => {
    const l = advise(parseSystem(out("platform=synology", "pkg=none", "ufw=missing", "fail2ban=missing")), { name: "nas", loginUser: "deploy" });
    expect(l.map((a) => [a.id, a.level, a.fix])).toEqual([
      ["firewall", "info", undefined],
      ["fail2ban", "info", undefined],
    ]);
    expect(l[0].why).toContain("Control Panel → Security → Firewall");
    expect(l[1].why).toContain("Auto Block");
  });

  test("a hardened server has nothing to fix", () => {
    expect(
      ids(out("sshd_passwordauthentication=no", "sshd_kbdinteractiveauthentication=no", "pkg=apt-get", "ufw=active", "fail2ban=running", "auto_updates=on")),
    ).toEqual([]);
  });

  test("keys only: missing fail2ban is not worth a hint, a stopped one is", () => {
    const keys = (f2b: string) =>
      ids(out("sshd_passwordauthentication=no", "sshd_kbdinteractiveauthentication=no", "pkg=apt-get", "ufw=active", `fail2ban=${f2b}`, "auto_updates=on"));
    expect(keys("missing")).toEqual([]);
    expect(keys("stopped")).toEqual(["fail2ban"]);
  });

  test("password login: keys only, unless someone would be locked out", () => {
    const open = out("sshd_passwordauthentication=yes", "fail2ban=running", "ufw=active", "password_users=root alice deploy");
    const [a] = advise(parseSystem(open), { name: "web", loginUser: "deploy" });
    expect(a).toMatchObject({ id: "password-login", level: "risk", fix: { argv: ["keys", "add", "--generate", "-u", "alice", "-s", "web"] } });
    expect(a.why).toContain("alice has no key");
    // root and landfall's own login do not count; a user with a key does not either.
    expect(lockedOut(parseSystem(`${open}\nKEY\talice\t${KEY}`), "deploy")).toEqual([]);
    const [b] = advise(parseSystem(`${open}\nKEY\talice\t${KEY}`), { name: "web", loginUser: "deploy" });
    expect(b.fix).toMatchObject({ argv: ["harden", "ssh", "-s", "web"], confirm: expect.any(String) });
  });

  test("firewall, fail2ban, updates and reboot, worst first", () => {
    const l = advise(parseSystem(out("reboot=1", "pkg=apt-get", "ufw=inactive", "fail2ban=missing", "auto_updates=off", "sshd_passwordauthentication=yes")), {
      name: "web",
      loginUser: "root",
    });
    expect(l.map((a) => [a.id, a.level])).toEqual([
      ["password-login", "risk"],
      ["firewall", "warn"],
      ["fail2ban", "warn"],
      ["auto-updates", "warn"],
      ["reboot", "info"],
    ]);
    expect(l.find((a) => a.id === "firewall")!.fix!.argv).toEqual(["firewall", "enable", "-s", "web"]);
  });

  test("behind a provider firewall, ufw being off is no warning", () => {
    const aws = (ufw: string) => advise(parseSystem(out("cloud=aws", "pkg=apt-get", `ufw=${ufw}`, "fail2ban=running")), { name: "web", loginUser: "deploy" });
    for (const ufw of ["missing", "inactive"]) {
      expect(aws(ufw).find((a) => a.id === "firewall")).toMatchObject({ level: "info", title: "Firewall: the AWS security group" });
    }
    expect(aws("active").find((a) => a.id === "firewall")).toBeUndefined();
    // Hetzner's firewall is optional, so ufw still counts there.
    const hetzner = advise(parseSystem(out("cloud=hetzner", "pkg=apt-get", "ufw=inactive", "fail2ban=running")), { name: "web", loginUser: "deploy" });
    expect(hetzner.find((a) => a.id === "firewall")!.level).toBe("warn");
  });

  test("no ufw where landfall cannot install it: a hint, no fix", () => {
    const l = advise(parseSystem(out("pkg=dnf", "ufw=missing", "fail2ban=missing")), { name: "web", loginUser: "root" });
    expect(l.map((a) => [a.id, a.level, a.fix])).toEqual([["firewall", "info", undefined]]);
  });
});
