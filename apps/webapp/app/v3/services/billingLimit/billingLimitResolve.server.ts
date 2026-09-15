import type { PendingBillingLimitResolve } from "./billingLimitPendingResolve.types";

export type BillingLimitResolveDeps = {
  bustCaches: (organizationId: string) => void;
  enqueueResolve: (pending: PendingBillingLimitResolve) => Promise<unknown>;
};

/** Process billing limit resolve from the billing platform webhook. */
export async function processBillingLimitResolve(
  pending: PendingBillingLimitResolve,
  deps: BillingLimitResolveDeps
): Promise<void> {
  deps.bustCaches(pending.organizationId);
  await deps.enqueueResolve(pending);
}
