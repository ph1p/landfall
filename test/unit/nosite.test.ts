import { describe, expect, test } from "vitest";
import { noSiteMessage } from "../../src/core/site/site";

describe("a site the server does not have", () => {
  test("lists the server's sites", () => {
    expect(noSiteMessage("shop", "vps", ["bla", "blog"])).toBe("no site shop on vps. Sites: bla, blog");
    expect(noSiteMessage("shop", "vps", [])).toBe("no site shop on vps. It has no sites yet (lf deploy)");
  });

  test("names the site ./.landfall.json deploys, with the command to run", () => {
    expect(noSiteMessage("analogue15", "vps", ["bla", "blog"], "bla", ["tunnel", "analogue15", "admin"])).toBe(
      "no site analogue15 on vps. Sites: bla, blog\nthis folder deploys as bla: lf tunnel bla admin",
    );
    // From lf ui (the name is not on its command line), the folder lf runs in says nothing.
    expect(noSiteMessage("analogue15", "vps", ["bla"], "bla", ["ui"])).toBe("no site analogue15 on vps. Sites: bla");
  });

  test("suggests a close name", () => {
    expect(noSiteMessage("blgo", "vps", ["blog", "shop"], undefined, ["logs", "blgo", "-n", "40"])).toBe(
      "no site blgo on vps. Sites: blog, shop\ndid you mean blog? lf logs blog -n 40",
    );
    expect(noSiteMessage("blog", "vps", ["blog-staging", "shop"])).toBe("no site blog on vps. Sites: blog-staging, shop\ndid you mean blog-staging?");
    // Two close names: no guess.
    expect(noSiteMessage("blo", "vps", ["blog", "blob"])).toBe("no site blo on vps. Sites: blog, blob");
  });
});
