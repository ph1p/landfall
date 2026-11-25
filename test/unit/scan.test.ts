import { describe, expect, it } from "vitest";
import { otherHint, parseContainers, parseReport, parseScan, scanHint, scanScript, TRIVY } from "../../src/core/server/scan";
import type { ImageStatus } from "../../src/core/server/updates";

const report = JSON.stringify({
  Metadata: { OS: { Family: "debian", Name: "10.13", EOSL: true } },
  Results: [
    {
      Vulnerabilities: [
        { VulnerabilityID: "CVE-2024-2", PkgName: "zlib", InstalledVersion: "1.2", Severity: "HIGH" },
        { VulnerabilityID: "CVE-2024-1", PkgName: "openssl", InstalledVersion: "3.0.1", FixedVersion: "3.0.2", Severity: "CRITICAL", Title: "bad" },
        { VulnerabilityID: "CVE-2024-3", PkgName: "zlib", InstalledVersion: "1.2", FixedVersion: "1.3", Severity: "HIGH" },
      ],
    },
    // The same package again from another layer counts once.
    { Vulnerabilities: [{ VulnerabilityID: "CVE-2024-1", PkgName: "openssl", InstalledVersion: "3.0.1", FixedVersion: "3.0.2", Severity: "CRITICAL" }] },
    { Target: "app", Vulnerabilities: null },
  ],
});

const img = (o: Partial<ImageStatus>): ImageStatus => ({ name: "blog", kind: "site", container: "c", dir: "/d", ref: "postgres:16", state: "current", ...o });

describe("scan", () => {
  it("counts a report's vulnerabilities, worst and fixable first", () => {
    const r = parseReport(report);
    expect(r.os).toBe("debian 10.13");
    expect(r.eol).toBe(true);
    expect(r.counts).toEqual({ CRITICAL: 1, HIGH: 2, MEDIUM: 0, LOW: 0, UNKNOWN: 0 });
    expect(r.fixable).toBe(2);
    expect(r.vulns.map((v) => v.id)).toEqual(["CVE-2024-1", "CVE-2024-3", "CVE-2024-2"]);
    expect(r.vulns[0]).toEqual({ id: "CVE-2024-1", pkg: "openssl", installed: "3.0.1", fixed: "3.0.2", severity: "CRITICAL", title: "bad" });
    expect(parseReport("{}").vulns).toEqual([]);
  });

  it("splits the script's output per image", () => {
    const out = parseScan(`SCAN\tsha256:a\n${report}\nSCAN\tsha256:b\n\nERR\tno space left on device\n`);
    expect(out.get("sha256:a")?.json).toBe(report);
    expect(out.get("sha256:b")).toEqual({ error: "no space left on device" });
  });

  it("hands the image in on stdin, no docker socket", () => {
    const s = scanScript(["sha256:a"]);
    expect(s).toContain(`docker save "$id" | docker run --rm -i`);
    expect(s).toContain(TRIVY);
    expect(s).not.toContain("docker.sock");
  });

  it("says what fixes them", () => {
    expect(scanHint({ fixable: 2 }, img({ state: "rebuild" }))).toMatch(/redeploy/);
    expect(scanHint({ fixable: 0 }, img({ state: "rebuild" }))).toBeUndefined();
    expect(scanHint({ fixable: 2 }, img({ state: "update" }))).toBe("a newer postgres:16 is out: lf update blog --images");
    expect(scanHint({ fixable: 2 }, img({ newer: "postgres:17" }))).toMatch(/postgres:17/);
    expect(scanHint({ fixable: 2, eol: true }, img({}))).toMatch(/^its OS no longer gets security fixes.*a newer tag or another image/);
    expect(scanHint({ fixable: 0 }, img({}))).toBeUndefined();
    expect(scanHint({ fixable: 1 }, img({ kind: "proxy", state: "foreign" }))).toMatch(/where it was set up/);
  });

  it("reads every running container, named by compose project when it has one", () => {
    const out = "/mail-1\tsha256:a\tghcr.io/mailcow/sogo:5\tmailcow\tsogo\n/solo\tsha256:b\tnginx:latest\t\t\n\n";
    expect(parseContainers(out)).toEqual([
      { name: "mail-1", id: "sha256:a", ref: "ghcr.io/mailcow/sogo:5", project: "mailcow", service: "sogo" },
      { name: "solo", id: "sha256:b", ref: "nginx:latest" },
    ]);
  });

  it("tells where to fix an image landfall did not deploy", () => {
    expect(otherHint({ fixable: 2 }, "nginx:latest")).toContain("where it was set up");
    expect(otherHint({ fixable: 0, eol: true }, "x")).toContain("newer base image");
    expect(otherHint({ fixable: 0 }, "x")).toBeUndefined();
  });
});
