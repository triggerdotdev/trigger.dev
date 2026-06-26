import type { BillingLimitConvergeTargetState } from "./billingLimitConstants";
import type { OrgReconcileTarget } from "./billingLimitReconciliation.server";

export async function reconcileBillingLimitTarget(
  target: OrgReconcileTarget,
  deps: {
    bustCaches: (organizationId: string) => void;
    enqueueConverge: (
      organizationId: string,
      targetState: BillingLimitConvergeTargetState
    ) => Promise<unknown>;
  }
) {
  // Safety net when webhooks are lost: bust stale entitlement after reject or resolve.
  if (target.targetState === "rejected" || target.targetState === "ok") {
    deps.bustCaches(target.organizationId);
  }

  await deps.enqueueConverge(target.organizationId, target.targetState);
}
