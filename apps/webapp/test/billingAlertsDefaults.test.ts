import { describe, expect, it } from "vitest";
import { buildDefaultBillingAlerts } from "~/services/billingAlertsDefaults.server";
import { ABSOLUTE_ALERT_BASE_CENTS } from "~/components/billing/billingAlertsFormat";

describe("buildDefaultBillingAlerts", () => {
  it("uses the absolute dollar base so alert levels read as dollar thresholds", () => {
    expect(buildDefaultBillingAlerts().amount).toBe(ABSOLUTE_ALERT_BASE_CENTS);
    expect(buildDefaultBillingAlerts().amount).toBe(100);
  });

  it("starts with no recipients so the platform falls back to org members", () => {
    expect(buildDefaultBillingAlerts().emails).toEqual([]);
  });

  it("seeds the default dollar alert thresholds", () => {
    expect(buildDefaultBillingAlerts().alertLevels).toEqual([5, 100, 500, 1000, 2500]);
  });

  it("returns a fresh alertLevels array each call (no shared mutable state)", () => {
    const first = buildDefaultBillingAlerts();
    const second = buildDefaultBillingAlerts();
    expect(first.alertLevels).not.toBe(second.alertLevels);
    first.alertLevels.push(9999);
    expect(second.alertLevels).toEqual([5, 100, 500, 1000, 2500]);
  });
});
