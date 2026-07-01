import { describe, expect, it } from "vitest";
import {
  clearedAlertsPayload,
  emailsMatchSaved,
  getAlertPreviewLimitCents,
  getBillingLimitMode,
  getConfiguredBillingLimitCents,
  getUsageBarBillingLimitDollars,
  hadSavedAlertsToClearOnLimitChange,
  hasConfiguredAlerts,
  hasLegacySpikeAlertLevels,
  isLegacyDollarAmountField,
  normalizeBillingAlertsFromApi,
  percentageAlertLevelsToUiThresholds,
  previewDollarAmountForPercent,
  shouldClearAlertsOnLimitChange,
  shouldResetAlertsOnLimitChange,
  storedAlertsToThresholds,
  thresholdsMatchSaved,
  thresholdsToAlertPayload,
  thresholdValuesAreUnique,
  ABSOLUTE_ALERT_BASE_CENTS,
} from "~/components/billing/billingAlertsFormat";

const legacyDefaultLevels = [0.75, 0.9, 1.0, 2.0, 5.0, 10.0, 20.0, 50.0, 100.0];

const hundredDollarLimitContext = {
  planLimitCents: 10_000,
  effectiveLimitCents: 10_000,
};

const fiveDollarLimitContext = {
  planLimitCents: 500,
  effectiveLimitCents: 500,
};

describe("billingAlertsFormat", () => {
  it("uses percentage thresholds saved in the new format", () => {
    expect(
      storedAlertsToThresholds(
        { amount: 50, emails: [], alertLevels: [0.75, 0.9, 1.0] },
        "plan",
        5000,
        5000
      )
    ).toEqual([75, 90, 100]);
  });

  it("filters legacy spike multipliers above 100%", () => {
    expect(
      storedAlertsToThresholds(
        { amount: 50, emails: [], alertLevels: legacyDefaultLevels },
        "plan",
        5000,
        5000
      )
    ).toEqual([75, 90, 100]);

    expect(
      storedAlertsToThresholds(
        { amount: 50, emails: [], alertLevels: legacyDefaultLevels },
        "none",
        5000,
        5000
      )
    ).toEqual([]);
  });

  it("reads legacy alerts saved against plan included usage", () => {
    expect(
      storedAlertsToThresholds(
        { amount: 100, emails: [], alertLevels: [0.1, 0.5, 0.8, 2.0] },
        "plan",
        25_000,
        10_000
      )
    ).toEqual([10, 50, 80]);

    expect(
      storedAlertsToThresholds(
        { amount: 100, emails: [], alertLevels: [10, 50, 80, 200] },
        "plan",
        25_000,
        10_000
      )
    ).toEqual([10, 50, 80]);

    expect(
      getAlertPreviewLimitCents({ amount: 100, emails: [], alertLevels: [] }, 25_000, 10_000)
    ).toBe(10_000);
  });

  it("normalizes legacy API alerts with dollar amount field and whole percents", () => {
    expect(
      normalizeBillingAlertsFromApi(
        {
          amount: 10_000,
          emails: ["a@example.com"],
          alertLevels: [10, 50, 80, 200],
        },
        hundredDollarLimitContext
      )
    ).toEqual({
      amount: 100,
      emails: ["a@example.com"],
      alertLevels: [10, 50, 80, 200],
    });

    expect(percentageAlertLevelsToUiThresholds([10, 50, 80, 200])).toEqual([10, 50, 80]);
  });

  it("normalizes platform API alerts stored in cents", () => {
    expect(
      normalizeBillingAlertsFromApi(
        {
          amount: 10_000,
          emails: [],
          alertLevels: [0.75, 0.9],
        },
        hundredDollarLimitContext
      )
    ).toEqual({
      amount: 100,
      emails: [],
      alertLevels: [0.75, 0.9],
    });
  });

  it("normalizes cents-based alerts for billing limits under $10", () => {
    const normalized = normalizeBillingAlertsFromApi(
      {
        amount: 500,
        emails: [],
        alertLevels: [0.75, 0.9],
      },
      fiveDollarLimitContext
    );

    expect(normalized).toEqual({
      amount: 5,
      emails: [],
      alertLevels: [0.75, 0.9],
    });

    expect(storedAlertsToThresholds(normalized, "plan", 500, 500)).toEqual([75, 90]);

    expect(getAlertPreviewLimitCents(normalized, 500, 500)).toBe(500);
    expect(previewDollarAmountForPercent(75, getAlertPreviewLimitCents(normalized, 500, 500))).toBe(
      3.75
    );
  });

  it("normalizes cents-based alerts with whole-number levels when amount matches limit", () => {
    const normalized = normalizeBillingAlertsFromApi(
      {
        amount: 500,
        emails: [],
        alertLevels: [50, 75],
      },
      { planLimitCents: 500, effectiveLimitCents: 500 }
    );

    expect(normalized).toEqual({
      amount: 5,
      emails: [],
      alertLevels: [50, 75],
    });

    expect(storedAlertsToThresholds(normalized, "custom", 500, 500)).toEqual([50, 75]);
  });

  it("still normalizes legacy dollar alerts when amount matches plan dollars", () => {
    expect(
      normalizeBillingAlertsFromApi(
        {
          amount: 100,
          emails: [],
          alertLevels: [10, 50, 80],
        },
        { planLimitCents: 10_000, effectiveLimitCents: 10_000 }
      )
    ).toEqual({
      amount: 100,
      emails: [],
      alertLevels: [10, 50, 80],
    });

    expect(
      isLegacyDollarAmountField(500, [50, 75], {
        planLimitCents: 50_000,
        effectiveLimitCents: 50_000,
      })
    ).toBe(true);

    expect(
      isLegacyDollarAmountField(250, [10, 50, 80], {
        planLimitCents: 25_000,
        effectiveLimitCents: 25_000,
      })
    ).toBe(true);

    expect(isLegacyDollarAmountField(250, [10, 50, 80], hundredDollarLimitContext)).toBe(false);
  });

  it("returns no default thresholds when alerts are empty", () => {
    expect(
      storedAlertsToThresholds({ amount: 50, emails: [], alertLevels: [] }, "plan", 5000, 5000)
    ).toEqual([]);
    expect(
      storedAlertsToThresholds({ amount: 1, emails: [], alertLevels: [] }, "none", 5000, 5000)
    ).toEqual([]);
  });

  it("uses dollar thresholds for none mode with absolute base", () => {
    expect(
      storedAlertsToThresholds(
        { amount: 1, emails: [], alertLevels: [100, 250] },
        "none",
        5000,
        5000
      )
    ).toEqual([100, 250]);
  });

  it("loads absolute dollar alerts after save with unlimited billing limit", () => {
    const normalized = normalizeBillingAlertsFromApi(
      {
        amount: ABSOLUTE_ALERT_BASE_CENTS,
        emails: ["a@example.com"],
        alertLevels: [100],
      },
      { planLimitCents: 5000, effectiveLimitCents: 5000 }
    );

    expect(normalized).toEqual({
      amount: 1,
      emails: ["a@example.com"],
      alertLevels: [100],
    });

    expect(storedAlertsToThresholds(normalized, "none", 5000, 5000)).toEqual([100]);
  });

  it("converts percentage UI values to API payload", () => {
    expect(thresholdsToAlertPayload([75, 90], "plan", 5000)).toEqual({
      amount: 5000,
      alertLevels: [0.75, 0.9],
    });
  });

  it("converts absolute UI values to API payload", () => {
    expect(thresholdsToAlertPayload([100, 250], "none", 5000)).toEqual({
      amount: 100,
      alertLevels: [100, 250],
    });
  });

  it("previews dollar amount from percentage and limit", () => {
    expect(previewDollarAmountForPercent(75, 5000)).toBe(37.5);
    expect(previewDollarAmountForPercent(10, 10_000)).toBe(10);
  });

  it("defaults unconfigured billing limit to none mode", () => {
    expect(getBillingLimitMode({ isConfigured: false, gracePeriodMs: 86_400_000 })).toBe("none");
  });

  it("detects configured alerts for the current billing limit mode", () => {
    const billingLimit = {
      isConfigured: true,
      mode: "plan" as const,
      effectiveAmountCents: 5000,
      gracePeriodMs: 86_400_000,
    };

    expect(
      hasConfiguredAlerts({ amount: 50, emails: [], alertLevels: [0.75, 0.9] }, billingLimit, 5000)
    ).toBe(true);

    expect(
      hasConfiguredAlerts({ amount: 50, emails: [], alertLevels: [] }, billingLimit, 5000)
    ).toBe(false);
  });

  it("clears percentage alerts when switching from plan or custom to none", () => {
    expect(shouldClearAlertsOnLimitChange("plan", "none")).toBe(true);
    expect(shouldClearAlertsOnLimitChange("custom", "none")).toBe(true);
    expect(shouldClearAlertsOnLimitChange("none", "none")).toBe(false);
    expect(shouldClearAlertsOnLimitChange("plan", "custom")).toBe(false);
  });

  it("resets alerts when switching between percentage and dollar alert modes", () => {
    expect(shouldResetAlertsOnLimitChange("none", "plan")).toBe(true);
    expect(shouldResetAlertsOnLimitChange("none", "custom")).toBe(true);
    expect(shouldResetAlertsOnLimitChange("plan", "none")).toBe(true);
    expect(shouldResetAlertsOnLimitChange("plan", "custom")).toBe(false);
  });

  it("builds a cleared alerts payload for none mode", () => {
    expect(clearedAlertsPayload(["a@example.com"])).toEqual({
      amount: 100,
      alertLevels: [],
      emails: ["a@example.com"],
    });
  });

  it("detects legacy spike alert levels above 100%", () => {
    expect(
      hasLegacySpikeAlertLevels(
        { amount: 50, emails: [], alertLevels: [0.75, 0.9, 1.0, 2.0] },
        "plan",
        5000,
        5000
      )
    ).toBe(true);

    expect(
      hasLegacySpikeAlertLevels(
        { amount: 100, emails: [], alertLevels: [0.1, 0.5, 0.8, 2.0] },
        "plan",
        25_000,
        10_000
      )
    ).toBe(true);

    expect(
      hasLegacySpikeAlertLevels(
        { amount: 50, emails: [], alertLevels: [0.75, 0.9] },
        "plan",
        5000,
        5000
      )
    ).toBe(false);

    expect(
      hasLegacySpikeAlertLevels(
        { amount: 1, emails: [], alertLevels: [100, 250] },
        "none",
        5000,
        5000
      )
    ).toBe(false);
  });

  it("detects when saved alerts should be cleared on a limit format change", () => {
    const billingLimit = {
      isConfigured: true,
      mode: "plan" as const,
      effectiveAmountCents: 5000,
      gracePeriodMs: 86_400_000,
    };

    expect(
      hadSavedAlertsToClearOnLimitChange(
        { amount: 50, emails: [], alertLevels: [0.75, 0.9] },
        billingLimit,
        5000
      )
    ).toBe(true);

    expect(
      hadSavedAlertsToClearOnLimitChange(
        { amount: 50, emails: ["a@example.com"], alertLevels: [] },
        billingLimit,
        5000
      )
    ).toBe(false);
  });

  it("compares threshold and email values for dirty form state", () => {
    expect(thresholdsMatchSaved([90, 75], [75, 90])).toBe(true);
    expect(thresholdsMatchSaved([75], [75, 90])).toBe(false);
    expect(emailsMatchSaved(["a@example.com", ""], ["a@example.com"])).toBe(true);
    expect(emailsMatchSaved(["b@example.com"], ["a@example.com"])).toBe(false);
  });

  it("detects duplicate alert thresholds", () => {
    expect(thresholdValuesAreUnique([75, 90, 100])).toBe(true);
    expect(thresholdValuesAreUnique([75, 75])).toBe(false);
    expect(thresholdValuesAreUnique([100, 250, 100])).toBe(false);
  });

  it("returns configured billing limit cents for plan and custom modes", () => {
    expect(
      getConfiguredBillingLimitCents(
        {
          isConfigured: true,
          mode: "custom",
          amountCents: 25_000,
          cancelInProgressRuns: false,
          limitState: { status: "ok" },
          effectiveAmountCents: 25_000,
          gracePeriodMs: 86_400_000,
        },
        5_000
      )
    ).toBe(25_000);

    expect(
      getConfiguredBillingLimitCents(
        {
          isConfigured: true,
          mode: "none",
          cancelInProgressRuns: false,
          limitState: { status: "ok" },
          effectiveAmountCents: null,
          gracePeriodMs: 86_400_000,
        },
        5_000
      )
    ).toBeUndefined();
  });

  it("maps usage bar billing limit dollars and hides when same as plan limit", () => {
    const customLimit = {
      isConfigured: true as const,
      mode: "custom" as const,
      amountCents: 25_000,
      cancelInProgressRuns: false,
      limitState: { status: "ok" as const },
      effectiveAmountCents: 25_000,
      gracePeriodMs: 86_400_000,
    };

    expect(getUsageBarBillingLimitDollars(customLimit, 5_000)).toBe(250);
    expect(getUsageBarBillingLimitDollars(customLimit, 25_000)).toBeUndefined();
    expect(getUsageBarBillingLimitDollars(undefined, 5_000)).toBeUndefined();
  });
});
