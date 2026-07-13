import { describe, expect, it } from "vitest";
import type { BillingLimitResult } from "~/services/billingLimit.schemas";
import {
  collectOrgIdsNeedingBillingLimitLookup,
  resolveConvergeTargetFromBillingLimit,
  resolveReconcileTargetFromBillingLimit,
  resolveReconcileTargetsForOrgLookups,
} from "~/v3/services/billingLimit/billingLimitReconciliation.server";

const graceLimit: BillingLimitResult = {
  isConfigured: true,
  mode: "custom",
  amountCents: 10_000,
  cancelInProgressRuns: false,
  limitState: {
    status: "grace",
    hitAt: "2026-01-01T00:00:00.000Z",
    graceEndsAt: "2026-01-02T00:00:00.000Z",
  },
  effectiveAmountCents: 10_000,
  gracePeriodMs: 86_400_000,
};

describe("billingLimitReconciliation", () => {
  it("maps grace and rejected limits to converge targets", () => {
    expect(resolveConvergeTargetFromBillingLimit(graceLimit)).toBe("grace");
    expect(
      resolveConvergeTargetFromBillingLimit({
        ...graceLimit,
        limitState: {
          status: "rejected",
          hitAt: "2026-01-01T00:00:00.000Z",
          graceEndsAt: "2026-01-02T00:00:00.000Z",
        },
      })
    ).toBe("rejected");
    expect(
      resolveConvergeTargetFromBillingLimit({
        ...graceLimit,
        limitState: { status: "ok" },
      })
    ).toBe("ok");
    expect(resolveConvergeTargetFromBillingLimit(undefined)).toBe("ok");
    expect(
      resolveConvergeTargetFromBillingLimit({ isConfigured: false, gracePeriodMs: 86_400_000 })
    ).toBe("ok");
  });

  it("skips reconcile target when platform lookup returns undefined", () => {
    expect(resolveReconcileTargetFromBillingLimit(undefined)).toBeUndefined();
    expect(
      resolveReconcileTargetFromBillingLimit({ isConfigured: false, gracePeriodMs: 86_400_000 })
    ).toBe("ok");
    expect(resolveReconcileTargetFromBillingLimit(graceLimit)).toBe("grace");
  });

  it("dedupes stale and queued org ids and skips excluded or already-covered orgs", () => {
    expect(
      collectOrgIdsNeedingBillingLimitLookup({
        staleOrgIds: ["org_a", "org_b", "org_c"],
        queuedOrgIds: ["org_b", "org_d", "org_a"],
        excludeOrgIds: new Set(["org_c"]),
        coveredOrgIds: new Set(["org_d"]),
      })
    ).toEqual(["org_a", "org_b"]);
  });

  it("resolves reconcile targets with bounded concurrency and isolates lookup failures", async () => {
    const lookedUpOrgIds: string[] = [];

    const targets = await resolveReconcileTargetsForOrgLookups(
      ["org_ok", "org_fail", "org_grace"],
      {
        concurrency: 2,
        getBillingLimit: async (organizationId) => {
          lookedUpOrgIds.push(organizationId);

          if (organizationId === "org_fail") {
            throw new Error("platform unavailable");
          }

          if (organizationId === "org_grace") {
            return graceLimit;
          }

          return { isConfigured: false, gracePeriodMs: 86_400_000 };
        },
      }
    );

    expect(targets).toEqual(
      new Map([
        ["org_ok", "ok"],
        ["org_grace", "grace"],
      ])
    );
    expect(new Set(lookedUpOrgIds)).toEqual(new Set(["org_ok", "org_fail", "org_grace"]));
  });
});
