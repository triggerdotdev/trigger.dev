import { describe, it, expect } from "vitest";
import { tenantContextFromAuthEnvironment } from "../app/services/tenantContext.server";
import type { AuthenticatedEnvironment } from "../app/services/apiAuth.server";

// Cast through unknown — we only depend on a narrow slice of
// AuthenticatedEnvironment and don't want to enumerate every field.
const env = {
  id: "env_1",
  slug: "prod",
  type: "PRODUCTION" as const,
  organization: { id: "org_1", slug: "acme" },
  project: { id: "proj_1", externalRef: "proj_abc" },
} as unknown as AuthenticatedEnvironment;

describe("tenantContextFromAuthEnvironment", () => {
  it("maps org id/slug, project id and externalRef, env id/slug/type", () => {
    expect(tenantContextFromAuthEnvironment(env)).toEqual({
      org: { id: "org_1", slug: "acme" },
      project: { id: "proj_1", ref: "proj_abc" },
      environment: { id: "env_1", slug: "prod", type: "PRODUCTION" },
    });
  });

  it("maps DEVELOPMENT environment type", () => {
    const dev = { ...env, type: "DEVELOPMENT" as const } as unknown as AuthenticatedEnvironment;
    expect(tenantContextFromAuthEnvironment(dev).environment.type).toBe("DEVELOPMENT");
  });

  it("does not propagate impersonating (auth environments are real, not impersonated)", () => {
    expect(tenantContextFromAuthEnvironment(env).impersonating).toBeUndefined();
  });
});
