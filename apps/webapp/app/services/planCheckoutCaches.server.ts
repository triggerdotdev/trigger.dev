import type { BillingController } from "@trigger.dev/billing";

export type PlanCheckoutCacheDependencies = {
  isMember(userId: string, organizationId: string): Promise<boolean>;
  invalidatePlanCaches(organizationId: string): void;
  usage: Pick<BillingController, "clearCurrentMonthUsage">;
};

/**
 * After a card checkout changes the plan, so the first page after paying shows it. Only for a member
 * of the org; returns false and clears nothing otherwise.
 */
export async function clearCachesAfterPlanCheckout(
  organizationId: string,
  userId: string,
  deps: PlanCheckoutCacheDependencies
): Promise<boolean> {
  if (!(await deps.isMember(userId, organizationId))) return false;

  deps.invalidatePlanCaches(organizationId);
  await deps.usage.clearCurrentMonthUsage(organizationId);
  return true;
}
