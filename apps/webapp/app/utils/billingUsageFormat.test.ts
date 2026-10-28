import type { BillingCreditType } from "@trigger.dev/billing";
import { describe, expect, it } from "vitest";
import {
  billingDisplayName,
  billingUsageErrorState,
  formatAddOnQuantity,
  formatComputeTime,
  formatCreditAmount,
  formatDurationTick,
  formatUnitPrice,
  formatUsageDollars,
  formatUsageQuantity,
  sharePercent,
  usageEnvironmentType,
  usageRegionLocation,
  usageTypeLabel,
} from "./billingUsageFormat";

const usd: BillingCreditType = {
  id: "usd",
  name: "USD (cents)",
  currency: { code: "USD", minorUnitsPerUnit: 100 },
};

const customUnit: BillingCreditType = { id: "credits", name: "credits", currency: null };

describe("formatCreditAmount", () => {
  it("converts minor units to the currency", () => {
    expect(formatCreditAmount(12345, usd)).toBe("$123.45");
  });

  it("keeps fractional cents", () => {
    expect(formatCreditAmount(0.5, usd)).toBe("$0.005");
  });

  it("renders negative credit lines", () => {
    expect(formatCreditAmount(-500, usd)).toBe("-$5.00");
  });

  it("never shows a currency symbol for a custom unit", () => {
    expect(formatCreditAmount(1500.25, customUnit)).toBe("1,500.25 credits");
  });

  it("does not divide currencies whose minor unit is the unit", () => {
    const jpy: BillingCreditType = {
      id: "jpy",
      name: "JPY",
      currency: { code: "JPY", minorUnitsPerUnit: 1 },
    };
    expect(formatCreditAmount(500, jpy)).toBe("¥500");
  });
});

describe("billingUsageErrorState", () => {
  it("shows an empty state when the org has no billing customer", () => {
    expect(billingUsageErrorState("customer_not_found").kind).toBe("empty");
  });

  it("shows an empty state when the feature is off", () => {
    expect(billingUsageErrorState("feature_disabled").kind).toBe("empty");
  });

  it("asks to try again shortly when rate limited", () => {
    const state = billingUsageErrorState("rate_limited");
    expect(state.kind).toBe("retry");
    expect(state.message).toContain("Try again shortly");
  });

  it("treats internal failures as errors", () => {
    expect(billingUsageErrorState("internal").kind).toBe("error");
  });
});

describe("formatComputeTime", () => {
  it("shows total milliseconds by default", () => {
    expect(formatComputeTime(26_054_812_345, "ms")).toBe("26,054,812,345 ms");
  });

  it("spells out every non-zero unit in the readable form", () => {
    expect(formatComputeTime(624_004_120, "readable")).toBe("7d 5h 20m 4s 120ms");
    expect(formatComputeTime(3_600_005, "readable")).toBe("1h 5ms");
    expect(formatComputeTime(0, "readable")).toBe("0ms");
  });
});

describe("formatDurationTick", () => {
  it("labels chart ticks in whole hours, or minutes below an hour", () => {
    expect(formatDurationTick(0)).toBe("0");
    expect(formatDurationTick(1_800_000)).toBe("30m");
    expect(formatDurationTick(43_200_000)).toBe("12h");
    expect(formatDurationTick(360_000_000)).toBe("100h");
    expect(formatDurationTick(20_000)).toBe("20s");
    expect(formatDurationTick(400)).toBe("400ms");
  });
});

describe("formatUsageQuantity", () => {
  it("shows compute time as hours and minutes and runs as a count", () => {
    expect(formatUsageQuantity("compute", 150_912_000)).toBe("41h 55m");
    expect(formatUsageQuantity("compute", 90_000)).toBe("2m");
    expect(formatUsageQuantity("compute", 1_000)).toBe("1s");
    expect(formatUsageQuantity("compute", 45_250)).toBe("45s 250ms");
    expect(formatUsageQuantity("runs", 41_920)).toBe("41,920 runs");
  });
});

describe("formatUnitPrice", () => {
  it("prices compute per second and runs per 10k", () => {
    expect(formatUnitPrice("compute", 3.375e-6, usd)).toBe("$0.0000338 / sec");
    expect(formatUnitPrice("compute", 3.4e-3, usd)).toBe("$0.034 / sec");
    expect(formatUnitPrice("runs", 0.0025, usd)).toBe("$0.25 / 10k runs");
  });
});

describe("usage labels", () => {
  it("names usage types, environments and regions", () => {
    expect(usageTypeLabel("compute")).toBe("Compute time");
    expect(usageTypeLabel("runs")).toBe("Runs");
    expect(usageEnvironmentType("staging")).toBe("STAGING");
    expect(usageEnvironmentType("unknown")).toBeUndefined();
    expect(usageRegionLocation("us-west-2")).toBe("usa");
    expect(usageRegionLocation("eu-central-1")).toBe("europe");
    expect(usageRegionLocation("local")).toBeUndefined();
  });

  it("computes a share without dividing by zero", () => {
    expect(sharePercent(1, 4)).toBe(25);
    expect(sharePercent(1, 0)).toBe(0);
  });
});

describe("formatUsageDollars", () => {
  it("shows a positive amount under a cent as <$0.01", () => {
    expect(formatUsageDollars(0.0047)).toBe("<$0.01");
    expect(formatUsageDollars(0.00001)).toBe("<$0.01");
  });

  it("formats zero, a cent and up as currency", () => {
    expect(formatUsageDollars(0)).toBe("$0.00");
    expect(formatUsageDollars(0.01)).toBe("$0.01");
    expect(formatUsageDollars(8.15)).toBe("$8.15");
  });
});

describe("billingDisplayName", () => {
  it("shows a plan's name instead of its code", () => {
    expect(billingDisplayName("Unused v3_hobby_1 fee")).toBe("Unused Hobby fee");
    expect(billingDisplayName("Unused v3_pro_1 fee applied")).toBe("Unused Pro fee applied");
  });

  it("leaves other names alone", () => {
    expect(billingDisplayName("Free monthly credit")).toBe("Free monthly credit");
  });
});

describe("formatAddOnQuantity", () => {
  it("shows the amount bought with the packs it came in", () => {
    expect(formatAddOnQuantity("Additional Concurrency (dev)", 2)).toBe(
      "100 concurrent runs (2 × 50)"
    );
    expect(formatAddOnQuantity("Additional Schedules", 3)).toBe("3,000 schedules (3 × 1,000)");
  });

  it("shows add-ons sold one at a time as a count", () => {
    expect(formatAddOnQuantity("Additional Seats", 1)).toBe("1 seat");
    expect(formatAddOnQuantity("Additional Preview Branches", 5)).toBe("5 preview branches");
  });

  it("falls back to the bare quantity for an unknown add-on", () => {
    expect(formatAddOnQuantity("Priority support", 2)).toBe("2");
  });
});
