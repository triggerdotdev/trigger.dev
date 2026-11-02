import { okAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { clearCachesAfterPlanCheckout } from "~/services/planCheckoutCaches.server";

function deps(member: boolean) {
  return {
    isMember: vi.fn(async () => member),
    invalidatePlanCaches: vi.fn(),
    usage: { clearCurrentMonthUsage: vi.fn(() => okAsync<void, never>(undefined)) },
  };
}

describe("clearCachesAfterPlanCheckout", () => {
  it("clears the plan caches and the usage page's current month for a member", async () => {
    const d = deps(true);

    expect(await clearCachesAfterPlanCheckout("org_1", "user_1", d)).toBe(true);
    expect(d.isMember).toHaveBeenCalledWith("user_1", "org_1");
    expect(d.invalidatePlanCaches).toHaveBeenCalledWith("org_1");
    expect(d.usage.clearCurrentMonthUsage).toHaveBeenCalledWith("org_1");
  });

  it("clears nothing for a user who isn't a member of the org", async () => {
    const d = deps(false);

    expect(await clearCachesAfterPlanCheckout("org_1", "user_2", d)).toBe(false);
    expect(d.invalidatePlanCaches).not.toHaveBeenCalled();
    expect(d.usage.clearCurrentMonthUsage).not.toHaveBeenCalled();
  });
});
