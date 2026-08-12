import { tryCatch } from "@trigger.dev/core/utils";
import { EnvironmentPauseSource } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { countBillableQueuedRunsForOrganization } from "./billingLimitQueuedRuns.server";

/**
 * Display-only count for the billing-limits page. Falls back to 0 on failure (the page hides
 * the count label at 0) — the recovery panel must stay reachable even when the count errors,
 * because it is the customer's only self-serve path out of an enforced limit.
 */
export async function getBillingLimitQueuedRunCount(organizationId: string): Promise<number> {
  const [error, count] = await tryCatch(countBillableQueuedRunsForOrganization(organizationId));

  if (error) {
    logger.error("getBillingLimitQueuedRunCount failed, returning 0", {
      organizationId,
      error,
    });
    return 0;
  }

  return count ?? 0;
}

export async function countBillingLimitPausedEnvironments(organizationId: string): Promise<number> {
  return prisma.runtimeEnvironment.count({
    where: {
      organizationId,
      pauseSource: EnvironmentPauseSource.BILLING_LIMIT,
    },
  });
}
