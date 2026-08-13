// Source-level for the wiring: importing `entry.server.tsx` boots the whole server
// graph. The directive itself is asserted through the module it is built from.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildImgSrcDirective,
  parseCspImageOrigins,
  withImgSrc,
} from "../app/utils/cspImageOrigins";

const source = readFileSync(new URL("../app/entry.server.tsx", import.meta.url), "utf8");

describe("document image CSP", () => {
  it("declares an img-src directive", () => {
    expect(buildImgSrcDirective()).toMatch(/^img-src /);
  });

  it("does not allow images from an arbitrary host", () => {
    const directive = buildImgSrcDirective(parseCspImageOrigins("https://sso.example.com").origins);
    expect(directive).not.toMatch(/(^|\s)\*(\s|$)/);
    // A wildcard host on a provider with public write access is the beacon channel.
    expect(directive).not.toContain("*");
    // A bare scheme would allow every host on it, same channel.
    expect(directive).not.toMatch(/(^|\s)https?:(\s|$)/);
  });

  it("allows changelog images", () => {
    expect(buildImgSrcDirective().split(" ")).toContain("https://trigger.dev/changelog/");
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

  it("builds the directive from the configured allowlist, not a wildcard literal", () => {
    expect(source).toContain("parseCspImageOrigins(env.CSP_IMG_SRC_ALLOWLIST");
    expect(source).not.toContain("*.googleusercontent.com");
  });

  it("keeps a route's own img-src", () => {
    expect(withImgSrc("img-src 'none'", buildImgSrcDirective())).toBe("img-src 'none'");
  });
});
