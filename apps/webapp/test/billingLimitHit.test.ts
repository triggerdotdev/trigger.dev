import { describe, expect, it } from "vitest";
import { BillingLimitHitWebhookBodySchema } from "~/services/billingLimit.schemas";
import {
  type BillingLimitHitDeps,
  processBillingLimitHit,
} from "~/v3/services/billingLimit/billingLimitHit.server";

describe("billingLimitHit", () => {
  it("busts caches, seeds reconcile, and enqueues grace converge", async () => {
    const calls: string[] = [];

    const deps: BillingLimitHitDeps = {
      bustCaches: (organizationId) => {
        calls.push(`bust:${organizationId}`);
      },
      seedReconcileQueue: async (organizationId) => {
        calls.push(`seed:${organizationId}`);
      },
      enqueueConverge: async (organizationId, targetState) => {
        calls.push(`converge:${organizationId}:${targetState}`);
      },
      enqueueCancelInProgressRuns: async () => {
        calls.push("cancel");
      },
    };

    await processBillingLimitHit(
      {
        organizationId: "org_123",
        hitAt: "2026-06-16T12:00:00.000Z",
        cancelInProgressRuns: false,
      },
      deps
    );

    expect(calls).toEqual(["bust:org_123", "seed:org_123", "converge:org_123:grace"]);
  });

  it("enqueues in-progress cancel when cancelInProgressRuns is true", async () => {
    const cancelCalls: Array<{ organizationId: string; hitAt: string }> = [];

    const deps: BillingLimitHitDeps = {
      bustCaches: () => {},
      seedReconcileQueue: async () => {},
      enqueueConverge: async () => {},
      enqueueCancelInProgressRuns: async (organizationId, hitAt) => {
        cancelCalls.push({ organizationId, hitAt });
      },
    };

    await processBillingLimitHit(
      {
        organizationId: "org_123",
        hitAt: "2026-06-16T12:00:00.000Z",
        cancelInProgressRuns: true,
      },
      deps
    );

    expect(cancelCalls).toEqual([{ organizationId: "org_123", hitAt: "2026-06-16T12:00:00.000Z" }]);
  });
});

describe("BillingLimitHitWebhookBodySchema", () => {
  it("parses the hit webhook body", () => {
    expect(
      BillingLimitHitWebhookBodySchema.parse({
        hitAt: "2026-06-16T12:00:00.000Z",
        cancelInProgressRuns: true,
        limitState: "grace",
      })
    ).toEqual({
      hitAt: "2026-06-16T12:00:00.000Z",
      cancelInProgressRuns: true,
      limitState: "grace",
    });
  });
});
