import { describe, it, expect } from "vitest";
import { sanitizeVercelNextUrl } from "../app/v3/vercel/vercelUrls.server";

describe("sanitizeVercelNextUrl", () => {
  it("returns undefined for null/undefined/empty", () => {
    expect(sanitizeVercelNextUrl(null)).toBeUndefined();
    expect(sanitizeVercelNextUrl(undefined)).toBeUndefined();
    expect(sanitizeVercelNextUrl("")).toBeUndefined();
  });

  it("allows relative paths", () => {
    expect(sanitizeVercelNextUrl("/dashboard")).toBe("/dashboard");
    expect(sanitizeVercelNextUrl("/some/path?query=1")).toBe("/some/path?query=1");
  });

  it("rejects protocol-relative URLs", () => {
    expect(sanitizeVercelNextUrl("//evil.com/path")).toBeUndefined();
  });

  it("allows vercel.com URLs", () => {
    expect(sanitizeVercelNextUrl("https://vercel.com/dashboard")).toBe(
      "https://vercel.com/dashboard"
    );
    expect(sanitizeVercelNextUrl("https://app.vercel.com/settings")).toBe(
      "https://app.vercel.com/settings"
    );
  });

  it("allows vercel.com subdomains", () => {
    expect(sanitizeVercelNextUrl("https://my-team.vercel.com/project")).toBe(
      "https://my-team.vercel.com/project"
    );
  });

  it("rejects non-vercel HTTPS URLs", () => {
    expect(sanitizeVercelNextUrl("https://evil.com/path")).toBeUndefined();
    expect(sanitizeVercelNextUrl("https://not-vercel.com")).toBeUndefined();
    expect(sanitizeVercelNextUrl("https://vercel.com.evil.com")).toBeUndefined();
  });

  it("rejects HTTP vercel.com URLs", () => {
    expect(sanitizeVercelNextUrl("http://vercel.com/dashboard")).toBeUndefined();
  });

  it("rejects javascript: URLs", () => {
    expect(sanitizeVercelNextUrl("javascript:alert(1)")).toBeUndefined();
  });

  it("rejects data: URLs", () => {
    expect(sanitizeVercelNextUrl("data:text/html,<script>alert(1)</script>")).toBeUndefined();
  });

  it("rejects invalid URLs", () => {
    expect(sanitizeVercelNextUrl("not a url at all")).toBeUndefined();
  });
});
