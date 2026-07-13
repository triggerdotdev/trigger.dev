import { describe, expect, it } from "vitest";
import { validateProductionEntitlement } from "~/runEngine/validators/validateProductionEntitlement.server";

const productionEnv = {
  type: "PRODUCTION" as const,
  organizationId: "org_123",
};

const developmentEnv = {
  type: "DEVELOPMENT" as const,
  organizationId: "org_123",
};

describe("validateProductionEntitlement", () => {
  it("allows development environments without checking entitlement", async () => {
    const result = await validateProductionEntitlement(
      { environment: developmentEnv as never },
      async () => ({ hasAccess: false, reason: "billing_limit" })
    );

    expect(result).toEqual({ ok: true });
  });

  it("rejects production triggers when entitlement has billing_limit denial", async () => {
    const result = await validateProductionEntitlement(
      { environment: productionEnv as never },
      async () => ({
        hasAccess: false,
        reason: "billing_limit",
        plan: { type: "paid", code: "pro", isPaying: true },
      })
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe("OutOfEntitlementError");
    }
  });

  it("allows production triggers when entitlement grants access", async () => {
    const plan = { type: "paid" as const, code: "pro", isPaying: true };

    const result = await validateProductionEntitlement(
      { environment: productionEnv as never },
      async () => ({
        hasAccess: true,
        plan,
      })
    );

    expect(result).toEqual({ ok: true, plan });
  });
});
