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
});
