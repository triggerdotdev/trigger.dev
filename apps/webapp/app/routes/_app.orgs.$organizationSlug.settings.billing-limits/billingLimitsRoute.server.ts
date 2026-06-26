import type { BillingLimitResult } from "~/services/billingLimit.schemas";
import type { ResolveBillingLimitRequest } from "~/services/billingLimit.schemas";

export function isEnforcementActive(billingLimit: BillingLimitResult): boolean {
  return (
    billingLimit.isConfigured &&
    (billingLimit.limitState.status === "grace" || billingLimit.limitState.status === "rejected")
  );
}

export function getAlertsResetRequested(request: Request): boolean {
  return new URL(request.url).searchParams.get("alertsReset") === "1";
}

export function getEffectiveLimitCentsAfterLimitSave(
  mode: "plan" | "custom" | "none",
  planLimitCents: number,
  customAmountDollars?: number
): number {
  if (mode === "custom") {
    return Math.round((customAmountDollars ?? 0) * 100);
  }

  return planLimitCents;
}

export function getResolveSubmitted(request: Request): boolean {
  return new URL(request.url).searchParams.get("resolved") === "1";
}

export function getSubmittedResumeMode(
  request: Request
): ResolveBillingLimitRequest["resumeMode"] | null {
  const value = new URL(request.url).searchParams.get("resumeMode");
  if (value === "queue" || value === "new_only") {
    return value;
  }
  return null;
}
