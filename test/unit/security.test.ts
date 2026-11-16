import { describe, expect, test } from "vitest";
import { advise, lockedOut } from "../../src/core/security";
import { parseSystem } from "../../src/core/system";

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
    });
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
