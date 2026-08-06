// Source-level: importing `entry.server.tsx` boots the whole server graph, and the
// claim here is about the header the document handler always sets.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../app/entry.server.tsx", import.meta.url), "utf8");

/** The `img-src ...` directive as written in the source. */
function imgSrcDirective(): string {
  const match = source.match(/"img-src [^"]*"/);
  return match ? match[0].slice(1, -1) : "";
}

describe("document image CSP", () => {
  it("declares an img-src directive", () => {
    expect(imgSrcDirective()).toMatch(/^img-src /);
  });

  it("does not allow images from an arbitrary host", () => {
    const directive = imgSrcDirective();
    expect(directive).not.toMatch(/(^|\s)\*(\s|$)/);
    // A bare scheme would allow every host on it, which is the beacon channel.
    expect(directive).not.toMatch(/(^|\s)https?:(\s|$)/);
  });

  it("sets the header on every document response, not only on /login", () => {
    // The set() call must sit outside the /login branch.
    const loginBranch = source.slice(
      source.indexOf('url.pathname.startsWith("/login")'),
      source.indexOf('"Content-Security-Policy",\n    withImgSrc')
    );
    expect(loginBranch).toContain("}");
    expect(source).toContain("withImgSrc(responseHeaders.get(");
  });
});
