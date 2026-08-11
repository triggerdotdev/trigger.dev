import { describe, expect, it } from "vitest";
import { buildDefaultBillingAlerts } from "~/services/billingAlertsDefaults.server";
import {
  ABSOLUTE_ALERT_BASE_CENTS,
  getAlertPreviewLimitCents,
  storedAlertsToThresholds,
  type BillingAlertsFormData,
} from "~/components/billing/billingAlertsFormat";

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

  it("does not treat the default absolute-dollar payload as percentages of the limit", () => {
    const defaults = buildDefaultBillingAlerts();
    const alerts: BillingAlertsFormData = {
      amount: defaults.amount / 100, // API cents -> stored dollars ($1 base)
      emails: defaults.emails ?? [],
      alertLevels: [...(defaults.alertLevels ?? [])],
    };

    // Absolute (none) mode: levels stay dollar thresholds, not percentages of the limit.
    expect(storedAlertsToThresholds(alerts, "none", 50_000, 50_000)).toEqual([
      5, 100, 500, 1000, 2500,
    ]);

    // With the real percentage mode (false for absolute alerts) the preview must not fall
    // into the percentage branch, even though a level like 100 looks like a percent. Here a
    // limit matches the $1 base, so inferring percentages would wrongly return the limit
    // (50000) instead of the absolute base (100).
    expect(getAlertPreviewLimitCents(alerts, 50_000, ABSOLUTE_ALERT_BASE_CENTS, false)).toBe(
      ABSOLUTE_ALERT_BASE_CENTS
    );
  });
});
