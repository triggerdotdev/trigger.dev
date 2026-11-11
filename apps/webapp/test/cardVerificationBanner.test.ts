import { describe, expect, it } from "vitest";
import { OrgBannerKind, selectOrgBanner } from "~/components/billing/selectOrgBanner";

describe("selectOrgBanner: card verification", () => {
  // Catches: the billing-limit prompt, which every new Free org gets, hiding the card banner.
  it("outranks the prompt to add a billing limit", () => {
    expect(
      selectOrgBanner({
        deploysAwaitCardVerification: true,
        billingLimit: { isConfigured: false } as never,
      })
    ).toBe(OrgBannerKind.CardVerification);
  });

  // Catches: the card banner hiding an exceeded free tier or a paused or archived environment.
  it("gives way to billing and environment banners", () => {
    expect(selectOrgBanner({ deploysAwaitCardVerification: true, hasExceededFreeTier: true })).toBe(
      OrgBannerKind.Upgrade
    );
    expect(
      selectOrgBanner({ deploysAwaitCardVerification: true, showEnvironmentWarning: true })
    ).toBe(OrgBannerKind.EnvironmentWarning);
  });
});
