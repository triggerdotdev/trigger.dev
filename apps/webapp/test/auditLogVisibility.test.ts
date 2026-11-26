import { createLRUMemoryStore } from "@internal/cache";
import { createCache, DefaultStatefulContext, Namespace } from "@unkey/cache";
import { describe, expect, it } from "vitest";
import { readAuditLogVisibility } from "~/services/auditLogs/auditLogVisibility.server";

// How many days of audit log history an org's plan shows, read from billing through a cache like
// the platform cache. Billing's current-plan call is passed in.

function newCache() {
  return createCache({
    days: new Namespace<number>(new DefaultStatefulContext(), {
      stores: [createLRUMemoryStore(100)],
      fresh: 60_000,
      stale: 120_000,
    }),
  }).days;
}

const planWith = (limits: object) => ({
  success: true as const,
  v3Subscription: { plan: { limits } },
});

describe("readAuditLogVisibility", () => {
  it("is the plan's days, 0 included", async () => {
    const cache = newCache();

    expect(
      await readAuditLogVisibility("org_1", {
        currentPlan: async () => planWith({ auditLogVisibilityDays: { number: 30 } }),
        cache,
      })
    ).toEqual({ days: 30 });
    expect(
      await readAuditLogVisibility("org_2", {
        currentPlan: async () => planWith({ auditLogVisibilityDays: { number: 0 } }),
        cache,
      })
    ).toEqual({ days: 0 });
  });

  it("reads a plan without the limit as 0 days", async () => {
    expect(
      await readAuditLogVisibility("org_1", {
        currentPlan: async () => planWith({}),
        cache: newCache(),
      })
    ).toEqual({ days: 0 });
  });

  it("is unlimited without billing", async () => {
    expect(
      await readAuditLogVisibility("org_1", { currentPlan: undefined, cache: newCache() })
    ).toBe("unlimited");
  });

  it("is unknown when billing can't answer", async () => {
    const cache = newCache();

    expect(
      await readAuditLogVisibility("org_1", {
        currentPlan: async () => ({ success: false }),
        cache,
      })
    ).toBe("unknown");
    expect(
      await readAuditLogVisibility("org_2", {
        currentPlan: () => Promise.reject(new TypeError("fetch failed")),
        cache,
      })
    ).toBe("unknown");
  });

  // Catches: a billing failure cached as the org's answer, which would hide audit logs from a
  // paying org until the cache expired.
  it("never caches a failure", async () => {
    const cache = newCache();

    expect(
      await readAuditLogVisibility("org_1", {
        currentPlan: async () => ({ success: false }),
        cache,
      })
    ).toBe("unknown");
    expect(
      await readAuditLogVisibility("org_1", {
        currentPlan: async () => planWith({ auditLogVisibilityDays: { number: 30 } }),
        cache,
      })
    ).toEqual({ days: 30 });
  });
});
