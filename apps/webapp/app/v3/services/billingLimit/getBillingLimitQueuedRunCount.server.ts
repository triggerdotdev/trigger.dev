import { EnvironmentPauseSource } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { countBillableQueuedRunsForOrganization } from "./billingLimitQueuedRuns.server";

export async function getBillingLimitQueuedRunCount(organizationId: string): Promise<number> {
  return countBillableQueuedRunsForOrganization(organizationId);
}

export async function countBillingLimitPausedEnvironments(organizationId: string): Promise<number> {
  return prisma.runtimeEnvironment.count({
    where: {
      organizationId,
      pauseSource: EnvironmentPauseSource.BILLING_LIMIT,
    },
  });
}
