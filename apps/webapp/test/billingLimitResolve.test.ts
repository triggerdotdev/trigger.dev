import { describe, expect, it } from "vitest";
import { processBillingLimitResolve } from "~/v3/services/billingLimit/billingLimitResolve.server";
import type { PendingBillingLimitResolve } from "~/v3/services/billingLimit/billingLimitPendingResolve.types";

describe("processBillingLimitResolve", () => {
  const pending: PendingBillingLimitResolve = {
    organizationId: "org_123",
    resumeMode: "queue",
    resolvedAt: "2026-06-17T12:00:00.000Z",
  };

  it("busts caches and enqueues resolve work", async () => {
    const busted: string[] = [];
    const enqueued: PendingBillingLimitResolve[] = [];

    await processBillingLimitResolve(pending, {
      bustCaches: (organizationId) => {
        busted.push(organizationId);
      },
      enqueueResolve: async (payload) => {
        enqueued.push(payload);
      },
    });

    expect(busted).toEqual(["org_123"]);
    expect(enqueued).toEqual([pending]);
  });
});
