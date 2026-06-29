import { describe, expect, it } from "vitest";
import { parseWithZod } from "@conform-to/zod";
import { billingAlertsSchema } from "~/components/billing/BillingAlertsSection";
import {
  billingLimitFormSchema,
  getBillingLimitFormLastSubmission,
  isBillingLimitFormDirty,
} from "~/components/billing/BillingLimitConfigSection";
import { billingLimitRecoveryFormSchema } from "~/components/billing/BillingLimitRecoveryPanel";
import { isBillingLimitSettingsFormSubmission } from "~/routes/_app.orgs.$organizationSlug.settings.billing-limits/billingLimitsRevalidation";
import { getSuggestedRecoveryLimitDollars } from "~/components/billing/billingLimitFormat";
import {
  getAlertsResetRequested,
  getEffectiveLimitCentsAfterLimitSave,
  getResolveSubmitted,
  getSubmittedResumeMode,
  isEnforcementActive,
} from "~/routes/_app.orgs.$organizationSlug.settings.billing-limits/billingLimitsRoute.server";
import { loader as billingAlertsRedirectLoader } from "~/routes/_app.orgs.$organizationSlug.settings.billing-alerts/route";

function billingLimitsRequest(search = ""): Request {
  return new Request(`http://localhost:3030/orgs/acme/settings/billing-limits${search}`);
}

describe("billingLimitsRoute.server", () => {
  describe("isEnforcementActive", () => {
    it("returns true in grace", () => {
      expect(
        isEnforcementActive({
          isConfigured: true,
          mode: "plan",
          cancelInProgressRuns: false,
          limitState: { status: "grace", hitAt: "t", graceEndsAt: "t" },
          effectiveAmountCents: 5000,
          gracePeriodMs: 86_400_000,
        })
      ).toBe(true);
    });

    it("returns true when rejected", () => {
      expect(
        isEnforcementActive({
          isConfigured: true,
          mode: "custom",
          amountCents: 2500,
          cancelInProgressRuns: false,
          limitState: { status: "rejected", hitAt: "t", graceEndsAt: "t" },
          effectiveAmountCents: 2500,
          gracePeriodMs: 86_400_000,
        })
      ).toBe(true);
    });

    it("returns false when unconfigured", () => {
      expect(
        isEnforcementActive({
          isConfigured: false,
          gracePeriodMs: 86_400_000,
        })
      ).toBe(false);
    });

    it("returns false when configured and ok", () => {
      expect(
        isEnforcementActive({
          isConfigured: true,
          mode: "none",
          cancelInProgressRuns: false,
          limitState: { status: "ok" },
          effectiveAmountCents: null,
          gracePeriodMs: 86_400_000,
        })
      ).toBe(false);
    });
  });

  describe("getAlertsResetRequested", () => {
    it("returns true when alertsReset=1 is present", () => {
      expect(getAlertsResetRequested(billingLimitsRequest("?alertsReset=1"))).toBe(true);
    });

    it("returns false when the param is absent", () => {
      expect(getAlertsResetRequested(billingLimitsRequest())).toBe(false);
    });

    it("returns false for other param values", () => {
      expect(getAlertsResetRequested(billingLimitsRequest("?alertsReset=true"))).toBe(false);
    });
  });

  describe("getResolveSubmitted", () => {
    it("returns true when resolved=1 is present", () => {
      expect(getResolveSubmitted(billingLimitsRequest("?resolved=1"))).toBe(true);
    });

    it("returns false when the param is absent", () => {
      expect(getResolveSubmitted(billingLimitsRequest())).toBe(false);
    });
  });

  describe("getSubmittedResumeMode", () => {
    it("parses resumeMode from the query string", () => {
      expect(getSubmittedResumeMode(billingLimitsRequest("?resumeMode=new_only"))).toBe("new_only");
    });

    it("returns null for invalid values", () => {
      expect(getSubmittedResumeMode(billingLimitsRequest("?resumeMode=invalid"))).toBeNull();
    });
  });

  describe("getSuggestedRecoveryLimitDollars", () => {
    it("uses max(limit + $50, limit × 1.25, spend × 1.25) rounded up to $50", () => {
      expect(getSuggestedRecoveryLimitDollars(5_000, 4_500)).toBe(100);
      expect(getSuggestedRecoveryLimitDollars(50_000, 48_000)).toBe(650);
      expect(getSuggestedRecoveryLimitDollars(50_000, 60_000)).toBe(750);
      expect(getSuggestedRecoveryLimitDollars(1_000_000, 950_000)).toBe(12_500);
    });

    it("falls back to spend × 1.25 when there is no effective limit", () => {
      expect(getSuggestedRecoveryLimitDollars(null, 4_500)).toBe(100);
    });
  });

  describe("isBillingLimitSettingsFormSubmission", () => {
    it("returns true for billing-limit POST", () => {
      const formData = new FormData();
      formData.set("intent", "billing-limit");
      expect(isBillingLimitSettingsFormSubmission("post", formData)).toBe(true);
    });

    it("returns true for billing-alerts POST", () => {
      const formData = new FormData();
      formData.set("intent", "billing-alerts");
      expect(isBillingLimitSettingsFormSubmission("POST", formData)).toBe(true);
    });

    it("returns true for billing-limit-resolve POST", () => {
      const formData = new FormData();
      formData.set("intent", "billing-limit-resolve");
      expect(isBillingLimitSettingsFormSubmission("post", formData)).toBe(true);
    });

    it("returns false for unrelated POST", () => {
      const formData = new FormData();
      formData.set("intent", "other");
      expect(isBillingLimitSettingsFormSubmission("post", formData)).toBe(false);
    });

    it("returns false without form data", () => {
      expect(isBillingLimitSettingsFormSubmission("post", undefined)).toBe(false);
    });
  });

  describe("getEffectiveLimitCentsAfterLimitSave", () => {
    it("uses custom amount in cents for custom mode", () => {
      expect(getEffectiveLimitCentsAfterLimitSave("custom", 5000, 42.5)).toBe(4250);
    });

    it("uses plan limit cents for plan mode", () => {
      expect(getEffectiveLimitCentsAfterLimitSave("plan", 5000)).toBe(5000);
    });

    it("uses plan limit cents for none mode", () => {
      expect(getEffectiveLimitCentsAfterLimitSave("none", 5000)).toBe(5000);
    });
  });
});

describe("billing-alerts redirect route", () => {
  it("redirects to billing-limits", async () => {
    const response = await billingAlertsRedirectLoader({
      params: { organizationSlug: "acme" },
      request: new Request("http://localhost:3030/orgs/acme/settings/billing-alerts"),
      context: {},
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/orgs/acme/settings/billing-limits");
  });
});

describe("billing-limits form validation", () => {
  it("rejects duplicate alert thresholds", () => {
    const formData = new FormData();
    formData.set("intent", "billing-alerts");
    formData.append("emails", "a@example.com");
    formData.append("alertLevels", "75");
    formData.append("alertLevels", "75");

    const submission = parseWithZod(formData, { schema: billingAlertsSchema });
    expect(submission.error?.alertLevels).toBeTruthy();
  });

  it("rejects non-numeric alert thresholds", () => {
    const formData = new FormData();
    formData.set("intent", "billing-alerts");
    formData.append("emails", "a@example.com");
    formData.append("alertLevels", "75");
    formData.append("alertLevels", "not-a-number");

    const submission = parseWithZod(formData, { schema: billingAlertsSchema });
    expect(submission.error?.["alertLevels[1]"]).toBeTruthy();
  });

  it("accepts a valid billing limit custom submission", () => {
    const formData = new FormData();
    formData.set("intent", "billing-limit");
    formData.set("mode", "custom");
    formData.set("amount", "100");
    formData.set("cancelInProgressRuns", "on");

    const submission = parseWithZod(formData, { schema: billingLimitFormSchema });
    expect(submission.value).toEqual({
      mode: "custom",
      amount: 100,
      cancelInProgressRuns: true,
    });
  });

  it("parses none mode with cancelInProgressRuns from the form", () => {
    const formData = new FormData();
    formData.set("mode", "none");
    formData.set("cancelInProgressRuns", "on");

    const submission = parseWithZod(formData, { schema: billingLimitFormSchema });
    expect(submission.value?.mode).toBe("none");
    expect(submission.value?.cancelInProgressRuns).toBe(true);
  });

  it("accepts a valid billing limit resolve submission", () => {
    const formData = new FormData();
    formData.set("intent", "billing-limit-resolve");
    formData.set("action", "increase");
    formData.set("newAmount", "1500");
    formData.set("resumeMode", "queue");

    const submission = parseWithZod(formData, { schema: billingLimitRecoveryFormSchema });
    expect(submission.value).toEqual({
      action: "increase",
      newAmount: 1500,
      resumeMode: "queue",
    });
  });

  it("accepts remove resolve with new_only resume mode", () => {
    const formData = new FormData();
    formData.set("action", "remove");
    formData.set("resumeMode", "new_only");

    const submission = parseWithZod(formData, { schema: billingLimitRecoveryFormSchema });
    expect(submission.value).toEqual({
      action: "remove",
      resumeMode: "new_only",
    });
  });
});

describe("isBillingLimitFormDirty", () => {
  const unconfiguredLimit = { isConfigured: false as const, gracePeriodMs: 86_400_000 };
  const configuredPlanLimit = {
    isConfigured: true as const,
    mode: "plan" as const,
    cancelInProgressRuns: false,
    limitState: { status: "ok" as const },
    effectiveAmountCents: 5000,
    gracePeriodMs: 86_400_000,
  };

  it("is dirty when billing limit has never been saved", () => {
    expect(
      isBillingLimitFormDirty({
        billingLimit: unconfiguredLimit,
        mode: "none",
        customAmount: "",
        cancelInProgressRuns: false,
      })
    ).toBe(true);
  });

  it("is clean when configured values match saved state", () => {
    expect(
      isBillingLimitFormDirty({
        billingLimit: configuredPlanLimit,
        mode: "plan",
        customAmount: "",
        cancelInProgressRuns: false,
      })
    ).toBe(false);
  });

  it("is dirty when configured mode changes", () => {
    expect(
      isBillingLimitFormDirty({
        billingLimit: configuredPlanLimit,
        mode: "none",
        customAmount: "",
        cancelInProgressRuns: false,
      })
    ).toBe(true);
  });
});

describe("getBillingLimitFormLastSubmission", () => {
  it("drops amount errors when the selected mode is not custom", () => {
    const submission = parseWithZod(
      (() => {
        const formData = new FormData();
        formData.set("mode", "custom");
        formData.set("amount", "0");
        return formData;
      })(),
      { schema: billingLimitFormSchema }
    ).reply();

    expect(
      getBillingLimitFormLastSubmission(submission, "plan", true)?.error?.amount
    ).toBeUndefined();
  });

  it("keeps amount errors while custom mode is selected", () => {
    const submission = parseWithZod(
      (() => {
        const formData = new FormData();
        formData.set("mode", "custom");
        formData.set("amount", "0");
        return formData;
      })(),
      { schema: billingLimitFormSchema }
    ).reply();

    expect(
      getBillingLimitFormLastSubmission(submission, "custom", true)?.error?.amount
    ).toBeTruthy();
  });

  it("returns undefined when the form is clean", () => {
    const submission = parseWithZod(
      (() => {
        const formData = new FormData();
        formData.set("mode", "custom");
        formData.set("amount", "0");
        return formData;
      })(),
      { schema: billingLimitFormSchema }
    ).reply();

    expect(getBillingLimitFormLastSubmission(submission, "custom", false)).toBeUndefined();
  });
});
