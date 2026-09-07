import { describe, expect, it } from "vitest";
import { faviconUrl } from "./favicon";
import {
  appendImageOrigin,
  BASE_IMG_SRC_SOURCES,
  buildImgSrcDirective,
  imageOriginFromUrl,
  parseCspImageOrigins,
  withImgSrc,
} from "./cspImageOrigins";

/** True if a source expression in the directive would match the given image URL. */
function directivePermits(directive: string, imageUrl: string): boolean {
  const url = new URL(imageUrl);
  return directive
    .split(" ")
    .slice(1)
    .some((source) => {
      if (!source.startsWith("http")) return false;
      const parsed = new URL(source);
      if (parsed.protocol !== url.protocol || parsed.host !== url.host) return false;
      // CSP path matching: a source path ending in "/" matches by prefix, otherwise it
      // must match exactly. The query string is never part of the match.
      return parsed.pathname.endsWith("/")
        ? url.pathname.startsWith(parsed.pathname)
        : parsed.pathname === url.pathname;
    });
}

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
    ["https://a.com;script-src", "must not contain ';' or ',' — these delimit CSP directives"],
  ])("rejects %s and says why", (value, reason) => {
    const { origins, rejected } = parseCspImageOrigins(value);
    expect(origins).toEqual([]);
    expect(rejected).toEqual([{ value, reason }]);
  });

  it("does not let a ';' smuggle a second directive into img-src", () => {
    const { origins } = parseCspImageOrigins("https://a.com;script-src");
    expect(origins).toEqual([]);
    expect(buildImgSrcDirective(origins)).not.toContain("script-src");
  });

  it("splits on ',' so a comma can never ride inside a single origin", () => {
    // "https://a.com" is valid; the "x" fragment after the comma is rejected on its own.
    const { origins } = parseCspImageOrigins("https://a.com,x");
    expect(origins).toEqual(["https://a.com"]);
    expect(origins.some((origin) => origin.includes(","))).toBe(false);
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
  it("is self, data, blob, the SSO avatar hosts, the favicon endpoints and the changelog by default", () => {
    expect(buildImgSrcDirective()).toBe(
      "img-src 'self' data: blob: https://avatars.githubusercontent.com https://lh3.googleusercontent.com https://www.google.com/s2/favicons https://t0.gstatic.com/faviconV2 https://t1.gstatic.com/faviconV2 https://t2.gstatic.com/faviconV2 https://t3.gstatic.com/faviconV2 https://trigger.dev/changelog/"
    );
  });

  it("permits the org avatar URL the app actually stores", () => {
    expect(directivePermits(buildImgSrcDirective(), faviconUrl("example.com"))).toBe(true);
  });

  it("permits nothing else on the favicon host", () => {
    expect(directivePermits(buildImgSrcDirective(), "https://www.google.com/beacon.png")).toBe(
      false
    );
  });

  it("permits the gstatic shard the favicon endpoint redirects to", () => {
    expect(
      directivePermits(
        buildImgSrcDirective(),
        "https://t2.gstatic.com/faviconV2?url=https://example.com&size=128"
      )
    ).toBe(true);
  });

  it("permits nothing else on a gstatic shard, and no shard we did not list", () => {
    const directive = buildImgSrcDirective();
    expect(directivePermits(directive, "https://t2.gstatic.com/beacon.png")).toBe(false);
    expect(directivePermits(directive, "https://t9.gstatic.com/faviconV2")).toBe(false);
  });

  it("permits changelog images by path prefix, and nothing else on our domain", () => {
    const directive = buildImgSrcDirective();
    expect(directivePermits(directive, "https://trigger.dev/changelog/some-post/image.png")).toBe(
      true
    );
    expect(directivePermits(directive, "https://trigger.dev/anything.png")).toBe(false);
  });

  it("permits both OAuth avatar hosts", () => {
    const directive = buildImgSrcDirective();
    expect(directivePermits(directive, "https://avatars.githubusercontent.com/u/1?v=4")).toBe(true);
    expect(directivePermits(directive, "https://lh3.googleusercontent.com/a/abc=s96-c")).toBe(true);
  });

  it("has no wildcard host and no bare scheme host", () => {
    const directive = buildImgSrcDirective(parseCspImageOrigins("https://sso.example.com").origins);
    expect(directive).not.toContain("*");
    // The avatar hosts are exact origins; a wildcard over them would not be.
    expect(directive).not.toContain("*.googleusercontent.com");
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

describe("imageOriginFromUrl", () => {
  it("keeps a plain http object store, which local and self-hosted setups run", () => {
    expect(imageOriginFromUrl("http://localhost:9005")).toBe("http://localhost:9005");
  });

  it("drops the path and query a presigned URL carries", () => {
    expect(imageOriginFromUrl("https://s3.example.com/bucket/key.png?X-Amz-Signature=abc")).toBe(
      "https://s3.example.com"
    );
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["not a URL", "s3.example.com"],
    ["a non-http scheme", "s3://bucket"],
    ["a wildcard host", "http://*.evil.com"],
    ["a host carrying a directive separator", "http://evil.com;script-src"],
    ["a host carrying a source separator", "http://evil.com,https://other.test"],
    ["a host with whitespace", "http://evil.com script-src"],
  ])("is undefined when the base URL is %s", (_case, value) => {
    expect(imageOriginFromUrl(value)).toBeUndefined();
  });

  it("permits a presigned image once it is in the directive", () => {
    const origin = imageOriginFromUrl("http://localhost:9005");
    const directive = buildImgSrcDirective(origin ? [origin] : []);

    expect(
      directivePermits(
        directive,
        "http://localhost:9005/avatars-local/avatars/usr_1/abc.png?X-Amz-Expires=300"
      )
    ).toBe(true);
    expect(
      directivePermits(buildImgSrcDirective(), "http://localhost:9005/avatars-local/a.png")
    ).toBe(false);
  });
});

describe("appendImageOrigin", () => {
  it("leaves the directive unchanged when no origin is configured", () => {
    expect(buildImgSrcDirective(appendImageOrigin([], undefined))).toBe(buildImgSrcDirective());
  });

  it("does not list an origin twice", () => {
    expect(appendImageOrigin(["http://localhost:9005"], "http://localhost:9005")).toEqual([
      "http://localhost:9005",
    ]);
  });

  it("appends a new origin after the configured ones", () => {
    expect(appendImageOrigin(["https://sso.example.com"], "http://localhost:9005")).toEqual([
      "https://sso.example.com",
      "http://localhost:9005",
    ]);
  });
});
