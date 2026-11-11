import type { BillingLimitResult } from "~/services/billingLimit.schemas";

export enum OrgBannerKind {
  LimitRejected = "limit-rejected",
  LimitGrace = "limit-grace",
  NoLimitConfigured = "no-limit",
  Upgrade = "upgrade",
  EnvironmentWarning = "env-warning",
  CardVerification = "card-verification",
  None = "none",
}

export function selectOrgBanner(input: {
  billingLimit?: BillingLimitResult;
  hasExceededFreeTier?: boolean;
  showEnvironmentWarning?: boolean;
  deploysAwaitCardVerification?: boolean;
  /** Self-serve billing UI — hide configure-limit prompt for managed customers. */
  showSelfServe?: boolean;
}): OrgBannerKind {
  const {
    billingLimit,
    hasExceededFreeTier,
    showEnvironmentWarning,
    deploysAwaitCardVerification,
    showSelfServe = true,
  } = input;

  if (billingLimit?.isConfigured) {
    const status = billingLimit.limitState.status;
    if (status === "rejected") {
      return OrgBannerKind.LimitRejected;
    }
    if (status === "grace") {
      return OrgBannerKind.LimitGrace;
    }
  }

  if (hasExceededFreeTier) {
    return OrgBannerKind.Upgrade;
  }

  // Above the billing-limit prompt, which every new Free org gets. A paused or archived environment still wins.
  if (deploysAwaitCardVerification && !showEnvironmentWarning) {
    return OrgBannerKind.CardVerification;
  }

  if (billingLimit && !billingLimit.isConfigured && showSelfServe) {
    return OrgBannerKind.NoLimitConfigured;
  }

  if (showEnvironmentWarning) {
    return OrgBannerKind.EnvironmentWarning;
  }

  return OrgBannerKind.None;
}
