import { describe, expect, it } from "vitest";
import { runBillingLimitReconcileTick } from "~/v3/services/billingLimit/runBillingLimitReconcileTick.server";
import type { PendingBillingLimitResolve } from "~/v3/services/billingLimit/billingLimitPendingResolve.types";

describe("runBillingLimitReconcileTick", () => {
  const pending: PendingBillingLimitResolve = {
    organizationId: "org_pending",
    resumeMode: "queue",
    resolvedAt: "2026-06-17T12:00:00.000Z",
  };

  it("runs pending resolves before collecting orgs and excludes still-pending orgs", async () => {
    const order: string[] = [];

    await runBillingLimitReconcileTick({
      getPendingResolves: async () => ({ orgs: [pending] }),
      runPendingResolves: async (pendingResolves) => {
        order.push(`pending:${pendingResolves.map((row) => row.organizationId).join(",")}`);
        return new Set(["org_pending"]);
      },
      collectOrgs: async (options) => {
        order.push(`collect:${[...(options?.excludeOrgIds ?? [])].join(",")}`);
        return {
          targets: [{ organizationId: "org_active", targetState: "grace" }],
          queuedOrgIds: ["org_active"],
        };
      },
      reconcileTarget: async (target) => {
        order.push(`reconcile:${target.organizationId}:${target.targetState}`);
      },
      clearProcessedQueue: async (queuedOrgIds, processedOrgIds) => {
        order.push(`clear:${queuedOrgIds.join(",")}:${processedOrgIds.join(",")}`);
      },
      bustCaches: () => {},
      enqueueConverge: async () => undefined,
    });

    expect(order).toEqual([
      "pending:org_pending",
      "collect:org_pending",
      "reconcile:org_active:grace",
      "clear:org_active:org_active",
    ]);
  });

  it("reconciles collected targets when no pending resolves remain", async () => {
    const reconciled: Array<{ organizationId: string; targetState: string }> = [];

    await runBillingLimitReconcileTick({
      getPendingResolves: async () => ({ orgs: [] }),
      runPendingResolves: async () => new Set(),
      collectOrgs: async () => ({
        targets: [
          { organizationId: "org_grace", targetState: "grace" },
          { organizationId: "org_ok", targetState: "ok" },
        ],
        queuedOrgIds: ["org_grace", "org_ok"],
      }),
      reconcileTarget: async (target, deps) => {
        reconciled.push(target);
        await deps.enqueueConverge(target.organizationId, target.targetState);
      },
      clearProcessedQueue: async () => undefined,
      bustCaches: () => {},
      enqueueConverge: async (organizationId, targetState) => {
        reconciled.push({ organizationId, targetState: `enqueued:${targetState}` });
      },
    });

    expect(reconciled).toEqual([
      { organizationId: "org_grace", targetState: "grace" },
      { organizationId: "org_grace", targetState: "enqueued:grace" },
      { organizationId: "org_ok", targetState: "ok" },
      { organizationId: "org_ok", targetState: "enqueued:ok" },
    ]);
  });

  it("continues reconciling other targets and only clears successfully processed orgs", async () => {
    const reconciled: string[] = [];
    let clearedProcessedOrgIds: string[] = [];

    await runBillingLimitReconcileTick({
      getPendingResolves: async () => ({ orgs: [] }),
      runPendingResolves: async () => new Set(),
      collectOrgs: async () => ({
        targets: [
          { organizationId: "org_fail", targetState: "grace" },
          { organizationId: "org_ok", targetState: "ok" },
        ],
        queuedOrgIds: ["org_fail", "org_ok"],
      }),
      reconcileTarget: async (target) => {
        if (target.organizationId === "org_fail") {
          throw new Error("reconcile failed");
        }
        reconciled.push(target.organizationId);
      },
      clearProcessedQueue: async (_queuedOrgIds, processedOrgIds) => {
        clearedProcessedOrgIds = processedOrgIds;
      },
      bustCaches: () => {},
      enqueueConverge: async () => undefined,
    });

    expect(reconciled).toEqual(["org_ok"]);
    expect(clearedProcessedOrgIds).toEqual(["org_ok"]);
  });
});
