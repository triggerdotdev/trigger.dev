import type { RuntimeEnvironmentType } from "@trigger.dev/database";

export const BILLABLE_ENVIRONMENT_TYPES = [
  "PRODUCTION",
  "STAGING",
  "PREVIEW",
] as const satisfies RuntimeEnvironmentType[];

export type BillableEnvironmentType = (typeof BILLABLE_ENVIRONMENT_TYPES)[number];

export const BILLING_LIMIT_CONVERGE_BATCH_SIZE = 50;

/** Max concurrent per-org billing limit lookups during reconciliation. */
export const BILLING_LIMIT_RECONCILE_LOOKUP_CONCURRENCY = 10;

/** Inline bulk-cancel budget for billing limit resolve (worker visibility is 10 min). */
export const BILLING_LIMIT_RESOLVE_BULK_CANCEL_BUDGET_MS = 8 * 60_000;

export type BillingLimitConvergeTargetState = "grace" | "rejected" | "ok";

export function isBillableEnvironmentType(type: RuntimeEnvironmentType): boolean {
  return (BILLABLE_ENVIRONMENT_TYPES as readonly RuntimeEnvironmentType[]).includes(type);
}

export function buildBillingLimitResolveDedupeKey(
  organizationId: string,
  resolvedAt: string
): string {
  return `billing-limit-resolve:${organizationId}:${resolvedAt}`;
}

export function buildBillingLimitResolveJobId(organizationId: string, resolvedAt: string): string {
  return `billingLimit.resolve:${organizationId}:${resolvedAt}`;
}

export function buildBillingLimitInProgressCancelJobId(
  organizationId: string,
  hitAt: string
): string {
  return `billingLimit.cancelInProgress:${organizationId}:${hitAt}`;
}
