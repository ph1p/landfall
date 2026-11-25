import { describe, expect, test } from "vitest";
import {
  commitUrl,
  compareUrl,
  detectForge,
  envsForRef,
  gitParts,
  globMatch,
  latestTag,
  overlaps,
  parseRefName,
  refMatches,
  sameRule,
  ruleText,
  sortTags,
  webUrl,
  type Ref,
} from "../../src/core/refs";

const tag = (name: string, date?: string): Ref => ({ name, kind: "tag", sha: name, ...(date && { date }) });

describe("globs", () => {
  test("* stays within a /, ** crosses it", () => {
    expect(globMatch("release/*", "release/1.2")).toBe(true);
    expect(globMatch("release/*", "release/1/2")).toBe(false);
    expect(globMatch("release/**", "release/1/2")).toBe(true);
    expect(globMatch("v*", "v1.2.0")).toBe(true);
    expect(globMatch("v1.?.0", "v1.2.0")).toBe(true);
  });

  test("dots and brackets are literal", () => {
    expect(globMatch("v1.2", "v1x2")).toBe(false);
    expect(globMatch("a(b)", "a(b)")).toBe(true);
  });
});

describe("rules", () => {
  test("without a rule, anything deploys", () => {
    expect(refMatches(undefined, { name: "feature/x", kind: "branch" })).toBe(true);
    expect(refMatches({}, { name: "v1", kind: "tag" })).toBe(true);
  });

  test("a branch rule matches branches, not tags of the same name", () => {
    const rule = { branch: ["main", "release/*"] };
    expect(refMatches(rule, { name: "main", kind: "branch" })).toBe(true);
    expect(refMatches(rule, { name: "release/2", kind: "branch" })).toBe(true);
    expect(refMatches(rule, { name: "feature/x", kind: "branch" })).toBe(false);
    expect(refMatches(rule, { name: "main", kind: "tag" })).toBe(false);
  });

  test("pre-release tags match only with prerelease", () => {
    expect(refMatches({ tag: "v*" }, { name: "v1.2.0", kind: "tag" })).toBe(true);
    expect(refMatches({ tag: "v*" }, { name: "v1.2.0-rc.1", kind: "tag" })).toBe(false);
    expect(refMatches({ tag: "v*", prerelease: true }, { name: "v1.2.0-rc.1", kind: "tag" })).toBe(true);
  });

  test("ruleText says it in words", () => {
    expect(ruleText(undefined)).toBe("any ref");
    expect(ruleText({ branch: "main" })).toBe("branch main");
    expect(ruleText({ branch: ["main", "release/*"] })).toBe("branches main, release/*");
    expect(ruleText({ tag: "v*", prerelease: true, requireClean: true })).toBe("tags v* (pre-releases too), clean tree only");
  });

  test("parseRefName reads what CI hands over", () => {
    expect(parseRefName("refs/heads/main")).toEqual({ name: "main", kind: "branch" });
    expect(parseRefName("refs/tags/v1.0.0")).toEqual({ name: "v1.0.0", kind: "tag" });
    expect(parseRefName("refs/remotes/origin/dev")).toEqual({ name: "dev", kind: "branch" });
    expect(parseRefName("main")).toEqual({ name: "main" });
  });
});

describe("versions", () => {
  test("tags sort newest first by semver, a release above its pre-releases", () => {
    const names = sortTags(["v1.2.0", "v1.10.0", "v1.10.0-rc.2", "v1.10.0-rc.10", "v1.9.9", "v2.0.0-beta"].map((n) => tag(n))).map((t) => t.name);
    expect(names).toEqual(["v2.0.0-beta", "v1.10.0", "v1.10.0-rc.10", "v1.10.0-rc.2", "v1.9.9", "v1.2.0"]);
  });

  test("tags without a version come after, newest date first", () => {
    const names = sortTags([tag("old", "2024-01-01"), tag("v0.1.0"), tag("new", "2025-01-01")]).map((t) => t.name);
    expect(names).toEqual(["v0.1.0", "new", "old"]);
  });

  test("latestTag picks the newest the rule allows", () => {
    const refs = ["v1.0.0", "v1.1.0", "v1.2.0-rc.1", "other-3.0.0"].map((n) => tag(n));
    expect(latestTag({ tag: "v*" }, refs)?.name).toBe("v1.1.0");
    expect(latestTag({ tag: "v*", prerelease: true }, refs)?.name).toBe("v1.2.0-rc.1");
    // No tag glob: any tag, newest version first.
    expect(latestTag({ branch: "main" }, refs)?.name).toBe("other-3.0.0");
    expect(latestTag({ tag: "nope-*" }, refs)).toBeUndefined();
  });
});

describe("environments for a ref", () => {
  const rules = { "": undefined, dev: { branch: "develop" }, test: { branch: ["main", "release/*"] }, prod: { tag: "v*" } };

  test("each ref finds its environment; one without a rule is never picked", () => {
    expect(envsForRef(rules, [{ name: "develop", kind: "branch" }])).toEqual(["dev"]);
    expect(envsForRef(rules, [{ name: "release/1", kind: "branch" }])).toEqual(["test"]);
    expect(envsForRef(rules, [{ name: "v1.0.0", kind: "tag" }])).toEqual(["prod"]);
    expect(envsForRef(rules, [{ name: "feature/x", kind: "branch" }])).toEqual([]);
  });

  test("overlapping rules are found", () => {
    const both = { ...rules, staging: { branch: "main" } };
    expect(overlaps(both, [{ name: "main", kind: "branch" }])).toEqual([["test", "staging"]]);
    expect(overlaps(rules, [{ name: "main", kind: "branch" }])).toEqual([]);
  });
});

describe("forges", () => {
  test("remotes become web addresses", () => {
    expect(webUrl("git@github.com:acme/shop.git")).toBe("https://github.com/acme/shop");
    expect(webUrl("ssh://git@gitlab.example.com:2222/g/sub/r.git")).toBe("https://gitlab.example.com/g/sub/r");
    expect(webUrl("https://user@github.com/acme/shop.git")).toBe("https://github.com/acme/shop");
    expect(webUrl("gh:acme/shop")).toBe("https://github.com/acme/shop");
    expect(webUrl(undefined)).toBeUndefined();
  });

  test("commit and compare links per forge, none for an unknown host", () => {
    expect(detectForge("git@gitlab.com:g/r.git")).toBe("gitlab");
    expect(commitUrl("git@github.com:a/b.git", "abc")).toBe("https://github.com/a/b/commit/abc");
    expect(commitUrl("git@gitlab.com:g/r.git", "abc")).toBe("https://gitlab.com/g/r/-/commit/abc");
    expect(compareUrl("git@github.com:a/b.git", "x", "y")).toBe("https://github.com/a/b/compare/x...y");
    expect(commitUrl("git@git.example.org:a/b.git", "abc")).toBeUndefined();
  });
});

describe("release git", () => {
  test("gitParts: a tag with its commit, a branch alone, dirty, the source", () => {
    expect(gitParts({ commit: "abc123def456", tag: "v1.2.0", branch: "main", source: "ci" })).toEqual({
      name: "v1.2.0",
      beside: "abc123def456",
      dirty: false,
      source: "CI",
    });
    expect(gitParts({ commit: "abc123def456", branch: "main", dirty: true, source: "local" }, 7)).toEqual({
      name: "abc123d",
      beside: "main",
      dirty: true,
      source: undefined,
    });
  });

  test("sameRule: glob order and a single glob do not count, flags do", () => {
    expect(sameRule({ branch: ["main", "release/*"] }, { branch: ["release/*", "main"] })).toBe(true);
    expect(sameRule({ tag: "v*" }, { tag: ["v*"] })).toBe(true);
    expect(sameRule({ tag: "v*" }, { tag: "v*", prerelease: true })).toBe(false);
    expect(sameRule({ tag: "v*", requireClean: false }, { tag: "v*" })).toBe(true);
    expect(sameRule(undefined, {})).toBe(true);
    expect(sameRule(undefined, { branch: "main" })).toBe(false);
  });
});
