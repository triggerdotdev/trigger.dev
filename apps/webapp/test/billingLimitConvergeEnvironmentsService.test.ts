import { describe, expect, it } from "vitest";
import { reconcileBillingLimitTarget } from "~/v3/services/billingLimit/billingLimitReconcileTarget.server";

describe("reconcileBillingLimitTarget", () => {
  it("busts billing limit caches for rejected targets before enqueueing converge", async () => {
    const bustedOrgIds: string[] = [];
    const enqueued: Array<{ organizationId: string; targetState: string }> = [];

    await reconcileBillingLimitTarget(
      { organizationId: "org_123", targetState: "rejected" },
      {
        bustCaches: (organizationId) => {
          bustedOrgIds.push(organizationId);
        },
        enqueueConverge: async (organizationId, targetState) => {
          enqueued.push({ organizationId, targetState });
        },
      }
    );

    expect(bustedOrgIds).toEqual(["org_123"]);
    expect(enqueued).toEqual([{ organizationId: "org_123", targetState: "rejected" }]);
  });

  it("busts billing limit caches for ok targets before enqueueing converge", async () => {
    const bustedOrgIds: string[] = [];
    const enqueued: Array<{ organizationId: string; targetState: string }> = [];

    await reconcileBillingLimitTarget(
      { organizationId: "org_123", targetState: "ok" },
      {
        bustCaches: (organizationId) => {
          bustedOrgIds.push(organizationId);
        },
        enqueueConverge: async (organizationId, targetState) => {
          enqueued.push({ organizationId, targetState });
        },
      }
    );

    expect(bustedOrgIds).toEqual(["org_123"]);
    expect(enqueued).toEqual([{ organizationId: "org_123", targetState: "ok" }]);
  });

  it("does not bust caches for grace targets", async () => {
    const bustedOrgIds: string[] = [];

    await reconcileBillingLimitTarget(
      { organizationId: "org_123", targetState: "grace" },
      {
        bustCaches: (organizationId) => {
          bustedOrgIds.push(organizationId);
        },
        enqueueConverge: async () => undefined,
      }
    );

    expect(bustedOrgIds).toEqual([]);
  });
});
