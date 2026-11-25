import { describe, expect, it } from "vitest";
import { sanitizeRedirectPath } from "../utils";

describe("sanitizeRedirectPath", () => {
  it("preserves a valid dashboard pathname and search", () => {
    expect(sanitizeRedirectPath("/orgs/acme/projects/demo/runs?status=FAILED&page=2")).toBe(
      "/orgs/acme/projects/demo/runs?status=FAILED&page=2"
    );
  });

  it.each([
    "https://example.com/collect",
    "//example.com/collect",
    "/\\example.com/collect",
    "javascript:alert(1)",
  ])("uses the fallback for unsafe destinations", (destination) => {
    expect(sanitizeRedirectPath(destination, "/dashboard")).toBe("/dashboard");
  });

  it.each([
    "/orgs/acme/projects/demo/runs?filter=folder\\name",
    "/orgs/acme/projects/demo/runs#folder\\name",
  ])("preserves literal backslashes outside the pathname", (destination) => {
    expect(sanitizeRedirectPath(destination)).toBe(destination);
  });

  it("uses the fallback for non-navigable resource routes", () => {
    expect(sanitizeRedirectPath("/resources/feedback", "/dashboard")).toBe("/dashboard");
  });

  // Catches: "Sign in" from the docs landing on the dashboard instead of back on the docs page.
  it("keeps the docs sign-in route, which sends the reader back to the docs", () => {
    const path = "/resources/docs/signin?to=https%3A%2F%2Ftrigger.dev%2Fdocs%2Fapikeys";
    expect(sanitizeRedirectPath(path)).toBe(path);
    expect(sanitizeRedirectPath("/resources/docs/me")).toBe("/");
  });
});
