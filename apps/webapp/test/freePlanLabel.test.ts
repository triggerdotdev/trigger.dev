import type { PlanDefinition, SubscriptionResult } from "@trigger.dev/platform";
import { describe, expect, it } from "vitest";
import {
  billingMovesToPlanOf,
  downgradeTakesEffectAt,
  pendingPlanOf,
  planButton,
  scheduledPlanOf,
  type ScheduledPlan,
} from "~/components/billing/freePlanLabel";

const NOW = new Date("2026-10-31T22:30:00Z");

const PLANS = {
  free: { type: "free", code: "free", title: "Free" },
  hobby: { type: "paid", code: "v3_hobby_1", title: "Hobby", tierPrice: 10 },
  pro: { type: "paid", code: "v3_pro_1", title: "Pro", tierPrice: 50 },
} as unknown as Record<"free" | "hobby" | "pro", PlanDefinition>;

const on = (plan: "free" | "hobby" | "pro", canceledAt?: string) =>
  ({
    freeTierStatus: "approved",
    isPaying: plan !== "free",
    showSelfServe: true,
    canceledAt,
    plan: PLANS[plan],
  }) as unknown as SubscriptionResult;

const buttons = (subscription: SubscriptionResult, scheduled?: ScheduledPlan) =>
  Object.fromEntries(
    (["free", "hobby", "pro"] as const).map((p) => [
      p,
      planButton(PLANS[p], subscription, scheduled, NOW),
    ])
  );

describe("planButton", () => {
  it("keeps Pro current while Hobby waits for the 1st, offering Pro back and Free", () => {
    const hobbyFromNov = { code: "v3_hobby_1", title: "Hobby", startsAt: new Date("2026-11-01Z") };
    expect(buttons(on("pro"), hobbyFromNov)).toEqual({
      free: { label: "Downgrade to Free", disabled: false, confirm: "downgrade" },
      hobby: { label: "Starts Nov 1", disabled: true },
      pro: { label: "Stay on Pro", disabled: false },
    });
  });

  it("doesn't mark Free current while a downgrade to it is scheduled", () => {
    // Stripe sets canceledAt to when the cancel was asked for, Metronome to the switch itself.
    for (const canceledAt of ["2026-10-20T09:00:00.000Z", "2026-11-01T00:00:00.000Z"]) {
      expect(buttons(on("pro", canceledAt))).toEqual({
        free: { label: "Starts Nov 1", disabled: true },
        hobby: { label: "Downgrade to Hobby", disabled: false, confirm: "downgrade" },
        pro: { label: "Stay on Pro", disabled: false },
      });
    }
  });

  it("upgrades at once and downgrades with a confirmation", () => {
    expect(buttons(on("hobby"))).toEqual({
      free: { label: "Downgrade to Free", disabled: false, confirm: "downgrade" },
      hobby: { label: "Current plan", disabled: true },
      pro: { label: "Upgrade to Pro", disabled: false, confirm: "upgrade" },
    });
    expect(buttons(on("free"))).toEqual({
      free: { label: "Current plan", disabled: true },
      hobby: { label: "Upgrade to Hobby", disabled: false },
      pro: { label: "Upgrade to Pro", disabled: false },
    });
  });
});

describe("scheduledPlanOf", () => {
  it("reads a downgrade waiting for the 1st, and nothing from a malformed value", () => {
    expect(
      scheduledPlanOf({
        scheduledPlan: { code: "v3_hobby_1", title: "Hobby", startsAt: "2026-11-01T00:00:00Z" },
      })
    ).toEqual({ code: "v3_hobby_1", title: "Hobby", startsAt: new Date("2026-11-01Z") });
    for (const subscription of [undefined, {}, { scheduledPlan: { code: "v3_hobby_1" } }]) {
      expect(scheduledPlanOf(subscription)).toBeUndefined();
    }
  });
});

describe("downgradeTakesEffectAt", () => {
  it("is the 1st of next month in UTC, not the last day of this one", () => {
    expect(downgradeTakesEffectAt(NOW)).toEqual(new Date("2026-11-01T00:00:00Z"));
  });
});

describe("billingMovesToPlanOf", () => {
  it("reads the plan an org moves to", () => {
    expect(
      billingMovesToPlanOf({ billingMovesToPlan: { code: "v3_hobby_1", title: "Hobby" } })
    ).toEqual({ code: "v3_hobby_1", title: "Hobby" });
  });

  it("is undefined for an org that isn't moving or a malformed value", () => {
    for (const subscription of [
      undefined,
      null,
      {},
      { billingMovesToPlan: "Hobby" },
      { billingMovesToPlan: { code: "v3_hobby_1" } },
    ]) {
      expect(billingMovesToPlanOf(subscription)).toBeUndefined();
    }
  });
});

describe("pendingPlanOf", () => {
  const movesAt = new Date("2026-12-01Z");
  const hobby = { code: "v3_hobby_1", title: "Hobby" };

  it("shows the plan a waiting org moves onto when it is not its plan today", () => {
    expect(pendingPlanOf(undefined, movesAt, hobby, "v3_pro_1")).toEqual({
      ...hobby,
      startsAt: movesAt,
    });
    expect(buttons(on("pro"), pendingPlanOf(undefined, movesAt, hobby, "v3_pro_1"))).toMatchObject({
      hobby: { label: "Starts Dec 1", disabled: true },
      pro: { label: "Stay on Pro", disabled: false },
    });
  });

  it("has nothing pending when the org moves onto the plan it has, and prefers a scheduled plan", () => {
    expect(pendingPlanOf(undefined, movesAt, hobby, "v3_hobby_1")).toBeUndefined();
    expect(pendingPlanOf(undefined, undefined, hobby, "v3_pro_1")).toBeUndefined();
    const scheduled = { code: "free", title: "Free", startsAt: movesAt };
    expect(pendingPlanOf(scheduled, movesAt, hobby, "v3_pro_1")).toBe(scheduled);
  });

  it("keeps every paid plan closed until a move onto Free, which billing would refuse", () => {
    const free = { code: "free", title: "Free" };
    expect(buttons(on("pro"), pendingPlanOf(undefined, movesAt, free, "v3_pro_1"))).toEqual({
      free: { label: "Starts Dec 1", disabled: true },
      hobby: { label: "Available Dec 1", disabled: true },
      pro: { label: "Current plan", disabled: true },
    });
  });
});
