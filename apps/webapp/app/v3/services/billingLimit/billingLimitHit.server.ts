export type BillingLimitHitPayload = {
  organizationId: string;
  hitAt: string;
  cancelInProgressRuns: boolean;
};

export type BillingLimitHitDeps = {
  bustCaches: (organizationId: string) => void;
  seedReconcileQueue: (organizationId: string) => Promise<void>;
  enqueueConverge: (organizationId: string, targetState: "grace") => Promise<unknown>;
  enqueueCancelInProgressRuns: (organizationId: string, hitAt: string) => Promise<unknown>;
};

/** Process billing limit grace hit from the billing platform webhook. */
export async function processBillingLimitHit(
  payload: BillingLimitHitPayload,
  deps: BillingLimitHitDeps
): Promise<void> {
  deps.bustCaches(payload.organizationId);
  await deps.seedReconcileQueue(payload.organizationId);
  await deps.enqueueConverge(payload.organizationId, "grace");

  if (payload.cancelInProgressRuns) {
    await deps.enqueueCancelInProgressRuns(payload.organizationId, payload.hitAt);
  }
}
