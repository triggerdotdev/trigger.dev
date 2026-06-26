import { EnvironmentPauseSource } from "@trigger.dev/database";
import { describe, expect, it } from "vitest";
import type { BillingLimitResult } from "~/services/billingLimit.schemas";
import { getInitialEnvPauseStateForBillingLimit } from "~/v3/services/billingLimit/getInitialEnvPauseStateForBillingLimit.server";

function configuredLimit(status: "grace" | "rejected" | "ok"): BillingLimitResult {
  const hitAt = "2026-06-16T12:00:00.000Z";
  const graceEndsAt = "2026-06-17T12:00:00.000Z";

  return {
    isConfigured: true,
    mode: "custom",
    amountCents: 50_000,
    cancelInProgressRuns: false,
    effectiveAmountCents: 50_000,
    gracePeriodMs: 86_400_000,
    limitState: status === "ok" ? { status: "ok" } : { status, hitAt, graceEndsAt },
  };
}

describe("getInitialEnvPauseStateForBillingLimit", () => {
  it("pauses billable environments when org is in grace", async () => {
    const result = await getInitialEnvPauseStateForBillingLimit("org_123", "PRODUCTION", {
      getBillingLimit: async () => configuredLimit("grace"),
    });

    expect(result).toEqual({
      paused: true,
      pauseSource: EnvironmentPauseSource.BILLING_LIMIT,
    });
  });

  it("pauses billable environments when org is rejected", async () => {
    const result = await getInitialEnvPauseStateForBillingLimit("org_123", "STAGING", {
      getBillingLimit: async () => configuredLimit("rejected"),
    });

    expect(result).toEqual({
      paused: true,
      pauseSource: EnvironmentPauseSource.BILLING_LIMIT,
    });
  });

  it("does not pause development environments", async () => {
    const result = await getInitialEnvPauseStateForBillingLimit("org_123", "DEVELOPMENT", {
      getBillingLimit: async () => configuredLimit("rejected"),
    });

    expect(result).toEqual({
      paused: false,
      pauseSource: null,
    });
  });

  it("does not pause when billing limit lookup fails", async () => {
    const result = await getInitialEnvPauseStateForBillingLimit("org_123", "PRODUCTION", {
      getBillingLimit: async () => {
        throw new Error("billing platform unavailable");
      },
    });

    expect(result).toEqual({
      paused: false,
      pauseSource: null,
    });
  });

  it("does not pause when billing limit is ok", async () => {
    const result = await getInitialEnvPauseStateForBillingLimit("org_123", "PRODUCTION", {
      getBillingLimit: async () => configuredLimit("ok"),
    });

    expect(result).toEqual({
      paused: false,
      pauseSource: null,
    });
  });
});
