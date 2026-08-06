import { describe, expect, it } from "vitest";
import {
  BASE_IMG_SRC_SOURCES,
  buildImgSrcDirective,
  parseCspImageOrigins,
  withImgSrc,
} from "./cspImageOrigins";

describe("parseCspImageOrigins", () => {
  it("accepts exact https origins, with or without a port", () => {
    const { origins, rejected } = parseCspImageOrigins(
      "https://sso.example.com, https://images.example.com:8443"
    );
    expect(origins).toEqual(["https://sso.example.com", "https://images.example.com:8443"]);
    expect(rejected).toEqual([]);
  });

  it("returns nothing when unset or empty", () => {
    expect(parseCspImageOrigins(undefined).origins).toEqual([]);
    expect(parseCspImageOrigins("  , ,").origins).toEqual([]);
  });

  it("deduplicates repeated origins", () => {
    const { origins } = parseCspImageOrigins(
      "https://sso.example.com,https://sso.example.com/,https://sso.example.com"
    );
    expect(origins).toEqual(["https://sso.example.com"]);
  });

  it.each([
    ["*", "wildcards are not allowed, list each origin exactly"],
    ["https://*.example.com", "wildcards are not allowed, list each origin exactly"],
    ["https://example.com/avatars", "must be an origin only, with no path, query or hash"],
    ["https://example.com?x=1", "must be an origin only, with no path, query or hash"],
    ["https://example.com#frag", "must be an origin only, with no path, query or hash"],
    ["example.com", "is not a valid absolute URL"],
    ["https://user:pw@example.com", "must not contain credentials"],
  ])("rejects %s and says why", (value, reason) => {
    const { origins, rejected } = parseCspImageOrigins(value);
    expect(origins).toEqual([]);
    expect(rejected).toEqual([{ value, reason }]);
  });

  it("keeps the valid entries when a sibling entry is rejected", () => {
    const { origins, rejected } = parseCspImageOrigins(
      "https://*.evil.com,https://sso.example.com"
    );
    expect(origins).toEqual(["https://sso.example.com"]);
    expect(rejected.map((entry) => entry.value)).toEqual(["https://*.evil.com"]);
  });

  it("rejects http outside development", () => {
    const { origins, rejected } = parseCspImageOrigins("http://sso.example.com");
    expect(origins).toEqual([]);
    expect(rejected).toEqual([
      { value: "http://sso.example.com", reason: 'scheme "http:" is not https:' },
    ]);
  });

  it("allows http only when allowHttp is set", () => {
    const { origins, rejected } = parseCspImageOrigins("http://localhost:4000", {
      allowHttp: true,
    });
    expect(origins).toEqual(["http://localhost:4000"]);
    expect(rejected).toEqual([]);
  });

  it("rejects a non-http scheme even when allowHttp is set", () => {
    const { origins, rejected } = parseCspImageOrigins("ftp://example.com", { allowHttp: true });
    expect(origins).toEqual([]);
    expect(rejected).toEqual([
      { value: "ftp://example.com", reason: 'scheme "ftp:" is not http: or https:' },
    ]);
  });
});

describe("buildImgSrcDirective", () => {
  it("is self, data, blob and the GitHub avatar host by default", () => {
    expect(buildImgSrcDirective()).toBe(
      "img-src 'self' data: blob: https://avatars.githubusercontent.com"
    );
  });

  it("has no wildcard host and no bare scheme host", () => {
    const directive = buildImgSrcDirective(parseCspImageOrigins("https://sso.example.com").origins);
    expect(directive).not.toContain("*");
    expect(directive).not.toContain("googleusercontent.com");
    expect(directive).not.toMatch(/(^|\s)https?:(\s|$)/);
  });

  it("appends configured origins after the base sources", () => {
    expect(buildImgSrcDirective(["https://sso.example.com"])).toBe(
      `img-src ${BASE_IMG_SRC_SOURCES.join(" ")} https://sso.example.com`
    );
  });
});

describe("withImgSrc", () => {
  const directive = buildImgSrcDirective();

  it("is the whole policy when a route set nothing", () => {
    expect(withImgSrc(null, directive)).toBe(directive);
  });

  it("appends to a policy that has other directives", () => {
    expect(withImgSrc("frame-ancestors 'self';", directive)).toBe(
      `frame-ancestors 'self'; ${directive}`
    );
  });

  it("leaves a route's own img-src untouched", () => {
    const routePolicy = "img-src 'none'";
    expect(withImgSrc(routePolicy, directive)).toBe(routePolicy);
    expect(withImgSrc("default-src 'self'; img-src 'none'", directive)).toBe(
      "default-src 'self'; img-src 'none'"
    );
  });
});
