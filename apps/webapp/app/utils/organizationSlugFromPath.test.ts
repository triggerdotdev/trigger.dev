import { describe, expect, it } from "vitest";
import { organizationSlugFromPath } from "./organizationSlugFromPath";

describe("organizationSlugFromPath", () => {
  it("returns the slug of an org page", () => {
    expect(organizationSlugFromPath("/orgs/acme-1a2b")).toBe("acme-1a2b");
    expect(organizationSlugFromPath("/orgs/acme-1a2b/projects/web-x9/env/dev/runs")).toBe(
      "acme-1a2b"
    );
    expect(organizationSlugFromPath("/orgs/acme-1a2b?tab=usage")).toBe("acme-1a2b");
  });

  it("returns undefined outside an org", () => {
    expect(organizationSlugFromPath("/")).toBeUndefined();
    expect(organizationSlugFromPath("/account")).toBeUndefined();
    expect(organizationSlugFromPath("/orgs")).toBeUndefined();
    expect(organizationSlugFromPath("/orgs/")).toBeUndefined();
    expect(organizationSlugFromPath("/orgs/new")).toBeUndefined();
    expect(organizationSlugFromPath("/admin/orgs/acme-1a2b")).toBeUndefined();
  });
});
