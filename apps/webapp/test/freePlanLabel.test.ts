import type { SubscriptionResult } from "@trigger.dev/platform";
import { describe, expect, it } from "vitest";
import { downgradeTakesEffectAt, freePlanButtonLabel } from "~/components/billing/freePlanLabel";

const NOW = new Date("2026-10-31T22:30:00Z");

const subscription = (plan: "free" | "pro", canceledAt?: string) =>
  ({
    freeTierStatus: "approved",
    isPaying: plan !== "free",
    showSelfServe: true,
    canceledAt,
    plan: { type: plan === "free" ? "free" : "paid", code: plan === "free" ? "free" : "v3_pro_1" },
  }) as unknown as SubscriptionResult;

describe("freePlanButtonLabel", () => {
  it("doesn't mark Free current while a downgrade to it is scheduled", () => {
    // Stripe sets canceledAt to when the cancel was asked for, Metronome to the switch itself.
    for (const canceledAt of ["2026-10-20T09:00:00.000Z", "2026-11-01T00:00:00.000Z"]) {
      expect(freePlanButtonLabel(subscription("pro", canceledAt), NOW)).toBe("Starts Nov 1");
    }
  });

  it("marks Free current for an org on Free", () => {
    expect(freePlanButtonLabel(subscription("free"), NOW)).toBe("Current plan");
  });

  it("offers Free to a paying org", () => {
    expect(freePlanButtonLabel(subscription("pro"), NOW)).toBe("Select plan");
  });
});

describe("downgradeTakesEffectAt", () => {
  it("is the 1st of next month in UTC, not the last day of this one", () => {
    expect(downgradeTakesEffectAt(NOW)).toEqual(new Date("2026-11-01T00:00:00Z"));
  });
});
