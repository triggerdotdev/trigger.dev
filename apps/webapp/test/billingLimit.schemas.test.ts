import { describe, expect, it } from "vitest";
import {
  BillingLimitResultSchema,
  BillingLimitsPendingResolvesResultSchema,
  EntitlementResultSchema,
  ResolveBillingLimitRequestSchema,
} from "~/services/billingLimit.schemas";

describe("billingLimit.schemas", () => {
  it("parses unconfigured billing limit", () => {
    const result = BillingLimitResultSchema.parse({
      isConfigured: false,
      gracePeriodMs: 86_400_000,
    });

    expect(result.isConfigured).toBe(false);
    expect(result.gracePeriodMs).toBe(86_400_000);
  });

  it("parses configured mode none with limitState ok — not the same as unconfigured", () => {
    const result = BillingLimitResultSchema.parse({
      isConfigured: true,
      mode: "none",
      cancelInProgressRuns: false,
      effectiveAmountCents: null,
      gracePeriodMs: 86_400_000,
      limitState: { status: "ok" },
    });

    expect(result.isConfigured).toBe(true);
    if (result.isConfigured) {
      expect(result.mode).toBe("none");
      expect(result.limitState.status).toBe("ok");
      expect(result.effectiveAmountCents).toBeNull();
    }

    // UI must use !isConfigured for the no-limit org banner — not mode === "none".
    const unconfigured = BillingLimitResultSchema.parse({
      isConfigured: false,
      gracePeriodMs: 86_400_000,
    });
    expect(unconfigured.isConfigured).toBe(false);
    expect(result.isConfigured).not.toBe(unconfigured.isConfigured);
  });

  it("parses configured billing limit in grace", () => {
    const result = BillingLimitResultSchema.parse({
      isConfigured: true,
      mode: "custom",
      amountCents: 50_000,
      cancelInProgressRuns: false,
      effectiveAmountCents: 50_000,
      gracePeriodMs: 86_400_000,
      limitState: {
        status: "grace",
        hitAt: "2026-06-14T12:00:00.000Z",
        graceEndsAt: "2026-06-15T12:00:00.000Z",
      },
    });

    expect(result.isConfigured).toBe(true);
    if (result.isConfigured) {
      expect(result.mode).toBe("custom");
      expect(result.limitState.status).toBe("grace");
    }
  });

  it("parses entitlement with billing_limit reason", () => {
    const result = EntitlementResultSchema.parse({
      hasAccess: false,
      reason: "billing_limit",
    });

    expect(result.hasAccess).toBe(false);
    expect(result.reason).toBe("billing_limit");
  });

  it("parses entitlement with free_tier_exceeded reason", () => {
    const result = EntitlementResultSchema.parse({
      hasAccess: false,
      reason: "free_tier_exceeded",
      balance: 0,
      usage: 100,
      overage: 10,
    });

    expect(result.hasAccess).toBe(false);
    expect(result.reason).toBe("free_tier_exceeded");
  });

  it("parses entitlement with grace limit state", () => {
    const result = EntitlementResultSchema.parse({
      hasAccess: true,
      limitState: "grace",
    });

    expect(result.hasAccess).toBe(true);
    expect(result.limitState).toBe("grace");
  });

  it("parses resolve payload", () => {
    const result = ResolveBillingLimitRequestSchema.parse({
      action: "increase",
      newAmountCents: 150_000,
      resumeMode: "queue",
    });

    expect(result.action).toBe("increase");
    expect(result.newAmountCents).toBe(150_000);
  });

  it("parses pending billing limit resolves from billing platform", () => {
    const result = BillingLimitsPendingResolvesResultSchema.parse({
      orgs: [
        {
          organizationId: "org_123",
          resumeMode: "new_only",
          resolvedAt: "2026-06-17T12:00:00.000Z",
        },
      ],
    });

    expect(result.orgs).toHaveLength(1);
    expect(result.orgs[0]?.resumeMode).toBe("new_only");
  });
});
