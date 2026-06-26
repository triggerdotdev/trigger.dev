import { bustBillingLimitCaches } from "~/services/platform.v3.server";
import { logger } from "~/services/logger.server";
import { BillingLimitBulkCancelService } from "./BillingLimitBulkCancelService.server";
import { buildBillingLimitResolveDedupeKey } from "./billingLimitConstants";
import { convergeBillingLimitEnvironmentsForOrg } from "./billingLimitConvergeEnvironments.server";
import type { PendingBillingLimitResolve } from "./billingLimitPendingResolve.types";

export type { PendingBillingLimitResolve } from "./billingLimitPendingResolve.types";

export async function convergeBillingLimitResolve(
  pending: PendingBillingLimitResolve
): Promise<void> {
  const { organizationId, resumeMode, resolvedAt } = pending;

  bustBillingLimitCaches(organizationId);

  if (resumeMode === "new_only") {
    await BillingLimitBulkCancelService.cancelQueuedRuns(organizationId, {
      dedupeKey: buildBillingLimitResolveDedupeKey(organizationId, resolvedAt),
      waitForCompletion: true,
    });
  }

  await convergeBillingLimitEnvironmentsForOrg(organizationId, "ok");

  logger.info("Converged billing limit resolve", {
    organizationId,
    resumeMode,
    resolvedAt,
  });
}

export { runPendingBillingLimitResolves } from "./billingLimitPendingResolveCoordinator.server";
