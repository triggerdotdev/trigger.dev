import { describe, expect, it } from "vitest";
import { OrgBannerKind, selectOrgBanner } from "~/components/billing/selectOrgBanner";

describe("selectOrgBanner", () => {
  it("prioritizes limit-rejected over grace and no-limit", () => {
    expect(
      selectOrgBanner({
        billingLimit: {
          isConfigured: true,
          mode: "plan",
          cancelInProgressRuns: false,
          limitState: { status: "rejected", hitAt: "t", graceEndsAt: "t" },
          effectiveAmountCents: 1000,
          gracePeriodMs: 86_400_000,
        },
        hasExceededFreeTier: true,
        showEnvironmentWarning: true,
      })
    ).toBe(OrgBannerKind.LimitRejected);
  });

  it("prioritizes upgrade over no-limit when free tier is exceeded", () => {
    expect(
      selectOrgBanner({
        billingLimit: { isConfigured: false, gracePeriodMs: 86_400_000 },
        hasExceededFreeTier: true,
        showSelfServe: true,
      })
    ).toBe(OrgBannerKind.Upgrade);
  });

  it("shows no-limit when unconfigured and self-serve", () => {
    expect(
      selectOrgBanner({
        billingLimit: { isConfigured: false, gracePeriodMs: 86_400_000 },
        hasExceededFreeTier: false,
        showSelfServe: true,
      })
    ).toBe(OrgBannerKind.NoLimitConfigured);
  });

  it("hides no-limit when unconfigured but not self-serve", () => {
    expect(
      selectOrgBanner({
        billingLimit: { isConfigured: false, gracePeriodMs: 86_400_000 },
        hasExceededFreeTier: true,
        showSelfServe: false,
      })
    ).toBe(OrgBannerKind.Upgrade);
  });

  it("hides no-limit prompt when configured with mode none", () => {
    expect(
      selectOrgBanner({
        billingLimit: {
          isConfigured: true,
          mode: "none",
          cancelInProgressRuns: false,
          limitState: { status: "ok" },
          effectiveAmountCents: null,
          gracePeriodMs: 86_400_000,
        },
      })
    ).toBe(OrgBannerKind.None);
  });
});
