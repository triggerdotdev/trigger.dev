import type { BillingLimitResult } from "~/services/billingLimit.schemas";

export enum OrgBannerKind {
  LimitRejected = "limit-rejected",
  LimitGrace = "limit-grace",
  NoLimitConfigured = "no-limit",
  Upgrade = "upgrade",
  EnvironmentWarning = "env-warning",
  None = "none",
}

export function selectOrgBanner(input: {
  billingLimit?: BillingLimitResult;
  hasExceededFreeTier?: boolean;
  showEnvironmentWarning?: boolean;
  /** Self-serve billing UI — hide configure-limit prompt for managed customers. */
  showSelfServe?: boolean;
}): OrgBannerKind {
  const { billingLimit, hasExceededFreeTier, showEnvironmentWarning, showSelfServe = true } = input;

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

  if (billingLimit && !billingLimit.isConfigured && showSelfServe) {
    return OrgBannerKind.NoLimitConfigured;
  }

  if (showEnvironmentWarning) {
    return OrgBannerKind.EnvironmentWarning;
  }

  return OrgBannerKind.None;
}
