import { describe, expect, it } from "vitest";
import { redirectHosts } from "../../src/core/traefik/redirects";

describe("redirectHosts", () => {
  it("lowercases, drops blanks and repeats, and puts a bare name under the first domain", () => {
    expect(redirectHosts([" WWW ", "", "old.org", "www"], "example.com")).toEqual(["www.example.com", "old.org"]);
  });
  it("leaves a bare name bare without a first domain", () => {
    expect(redirectHosts(["www"])).toEqual(["www"]);
  });
});
