import type * as Platform from "@trigger.dev/platform";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { currentPlan, failure } = vi.hoisted(() => {
  process.env.BILLING_API_URL = "https://billing.test";
  process.env.BILLING_API_KEY = "key";
  // A request that fails outright, kept out of vi.fn so no spy wrapper holds the rejection.
  return { currentPlan: vi.fn(), failure: { error: undefined as Error | undefined } };
});

vi.mock("~/env.server", () => ({ env: { LOGIN_ORIGIN: "https://cloud.trigger.dev" } }));
vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));

vi.mock("@trigger.dev/platform", async (importOriginal) => {
  const actual = await importOriginal<typeof Platform>();
  return {
    ...actual,
    BillingClient: class {
      currentPlan = (orgId: string) =>
        failure.error ? Promise.reject(failure.error) : currentPlan(orgId);
    },
  };
});

import { getBillingPagePlan, getCurrentPlan } from "~/services/platform.v3.server";

const plan = {
  success: true as const,
  subscription: { isPaying: false },
  v3Subscription: { freeTierStatus: "approved", isPaying: true, showSelfServe: true },
};

beforeEach(() => {
  currentPlan.mockReset();
  failure.error = undefined;
});

describe("getBillingPagePlan", () => {
  it("reports billing as unavailable when billing says it can't read the plan", async () => {
    currentPlan.mockResolvedValue({
      success: false,
      error: "Billing is temporarily unavailable, try again shortly",
      code: "billing_unavailable",
    });

    expect((await getBillingPagePlan("org_1"))._unsafeUnwrapErr()).toBe("billing_unavailable");
  });

  it("returns the plan with its usage period, the same as getCurrentPlan", async () => {
    currentPlan.mockResolvedValue(plan);

    const read = (await getBillingPagePlan("org_1"))._unsafeUnwrap();
    expect(read).toMatchObject(plan);
    expect(read?.usage.periodEnd.getUTCDate()).toBe(1);
  });

  it("reports billing as unavailable on any other error response", async () => {
    currentPlan.mockResolvedValue({ success: false, error: "http_502" });

    expect((await getBillingPagePlan("org_1"))._unsafeUnwrapErr()).toBe("billing_unavailable");
  });

  it("reports billing as unavailable when the request fails outright", async () => {
    failure.error = new TypeError("fetch failed");

    expect((await getBillingPagePlan("org_1"))._unsafeUnwrapErr()).toBe("billing_unavailable");
  });
});

describe("getCurrentPlan, used by every other page and service", () => {
  it("still reads billing being unavailable as no plan", async () => {
    currentPlan.mockResolvedValue({
      success: false,
      error: "unavailable",
      code: "billing_unavailable",
    });

    expect(await getCurrentPlan("org_1")).toBeUndefined();
  });

  it("still returns the plan with its usage period", async () => {
    currentPlan.mockResolvedValue(plan);

    expect(await getCurrentPlan("org_1")).toMatchObject({ ...plan, usage: expect.any(Object) });
  });
});
