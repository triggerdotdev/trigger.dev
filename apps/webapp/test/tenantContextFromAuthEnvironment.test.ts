import { describe, it, expect } from "vitest";
import { tenantContextFromAuthEnvironment } from "../app/services/tenantContext.server";
import type { AuthenticatedEnvironment } from "../app/services/apiAuth.server";

const baseEnv = {
  id: "env_1",
  slug: "prod",
  type: "PRODUCTION" as const,
  organization: { id: "org_1", slug: "acme" },
  project: { id: "proj_1", slug: "web", externalRef: "proj_abc" },
};

const envWithOrgMember = {
  ...baseEnv,
  orgMember: { userId: "usr_42" },
} as unknown as AuthenticatedEnvironment;

const envWithoutOrgMember = {
  ...baseEnv,
  orgMember: null,
} as unknown as AuthenticatedEnvironment;

describe("tenantContextFromAuthEnvironment", () => {
  it("returns the full tenant context (slugs + IDs + env type + userId) when orgMember is present", () => {
    expect(tenantContextFromAuthEnvironment(envWithOrgMember)).toEqual({
      userId: "usr_42",
      orgSlug: "acme",
      projectSlug: "web",
      envSlug: "prod",
      orgId: "org_1",
      projectId: "proj_1",
      projectRef: "proj_abc",
      envId: "env_1",
      envType: "PRODUCTION",
    });
  });

  it("omits userId when there is no orgMember on the environment", () => {
    const ctx = tenantContextFromAuthEnvironment(envWithoutOrgMember);
    expect(ctx.userId).toBeUndefined();
    expect(ctx.orgSlug).toBe("acme");
    expect(ctx.envSlug).toBe("prod");
  });

  it("does not propagate impersonating (auth environments are real, not impersonated)", () => {
    expect(tenantContextFromAuthEnvironment(envWithOrgMember).impersonating).toBeUndefined();
  });
});
