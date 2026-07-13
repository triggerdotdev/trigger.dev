import { describe, expect, it } from "vitest";
import { buildBillingLimitResolveDedupeKey } from "~/v3/services/billingLimit/billingLimitConstants";
import { classifyPendingBillingLimitResolveConvergeFailure } from "~/v3/services/billingLimit/billingLimitPendingResolveFailure.server";
import { runPendingBillingLimitResolves } from "~/v3/services/billingLimit/billingLimitPendingResolveCoordinator.server";
import type { PendingBillingLimitResolve } from "~/v3/services/billingLimit/billingLimitPendingResolve.types";

describe("billingLimitConvergeResolve", () => {
  it("builds a stable dedupe key from org id and resolvedAt", () => {
    expect(buildBillingLimitResolveDedupeKey("org_123", "2026-06-16T12:00:00.000Z")).toBe(
      "billing-limit-resolve:org_123:2026-06-16T12:00:00.000Z"
    );
  });

  it("classifies converge failures for ops triage", () => {
    expect(classifyPendingBillingLimitResolveConvergeFailure("new_only")).toBe("cancel-failing");
    expect(classifyPendingBillingLimitResolveConvergeFailure("queue")).toBe("converge-failing");
  });
});

describe("runPendingBillingLimitResolves", () => {
  const pending: PendingBillingLimitResolve = {
    organizationId: "org_123",
    resumeMode: "new_only",
    resolvedAt: "2026-06-17T12:00:00.000Z",
  };

  it("keeps org pending and skips ack when converge throws (cancel-failing path)", async () => {
    const completeCalls: string[] = [];

    const stillPending = await runPendingBillingLimitResolves([pending], {
      converge: async () => {
        throw new Error("bulk cancel failed");
      },
      complete: async (organizationId) => {
        completeCalls.push(organizationId);
        return { completed: true };
      },
    });

    expect(stillPending).toEqual(new Set(["org_123"]));
    expect(completeCalls).toEqual([]);
  });

  it("keeps org pending when converge succeeds but ack throws (ack-only path)", async () => {
    let convergeCalls = 0;
    let completeCalls = 0;

    const stillPending = await runPendingBillingLimitResolves(
      [{ ...pending, resumeMode: "queue" }],
      {
        converge: async () => {
          convergeCalls += 1;
        },
        complete: async () => {
          completeCalls += 1;
          throw new Error("resolve-complete unavailable");
        },
      }
    );

    expect(stillPending).toEqual(new Set(["org_123"]));
    expect(convergeCalls).toBe(1);
    expect(completeCalls).toBe(1);
  });

  it("keeps org pending when ack returns completed: false", async () => {
    const stillPending = await runPendingBillingLimitResolves([pending], {
      converge: async () => undefined,
      complete: async () => ({ completed: false }),
    });

    expect(stillPending).toEqual(new Set(["org_123"]));
  });

  it("clears org from pending set when converge and ack both succeed", async () => {
    const stillPending = await runPendingBillingLimitResolves([pending], {
      converge: async () => undefined,
      complete: async () => ({ completed: true }),
    });

    expect(stillPending).toEqual(new Set());
  });

  it("retries ack on a later tick after a transient ack failure", async () => {
    let ackAttempts = 0;

    const deps = {
      converge: async () => undefined,
      complete: async () => {
        ackAttempts += 1;
        if (ackAttempts === 1) {
          throw new Error("resolve-complete unavailable");
        }
        return { completed: true };
      },
    };

    expect(await runPendingBillingLimitResolves([pending], deps)).toEqual(new Set(["org_123"]));
    expect(await runPendingBillingLimitResolves([pending], deps)).toEqual(new Set());
    expect(ackAttempts).toBe(2);
  });
});
