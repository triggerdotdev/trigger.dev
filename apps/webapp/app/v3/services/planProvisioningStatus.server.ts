import { tryCatch } from "@trigger.dev/core/v3";
import type { Redis } from "ioredis";
import { z } from "zod";
import { logger } from "~/services/logger.server";

const PlanProvisioningStatusSchema = z.enum(["pending", "succeeded", "failed"]);

export type PlanProvisioningStatus = z.infer<typeof PlanProvisioningStatusSchema>;

// Written by billing's apply-plan-limits job; the key and statuses must match billing's
// planProvisioningStatus.server.ts.
export const planProvisioningStatusKey = (organizationId: string) =>
  `billing:plan-provisioning:${organizationId}`;

/** The outcome of the org's latest plan change, or undefined when there is nothing to show. */
export async function readPlanProvisioningStatus(
  redis: Pick<Redis, "hget">,
  organizationId: string
): Promise<PlanProvisioningStatus | undefined> {
  const [error, status] = await tryCatch(
    redis.hget(planProvisioningStatusKey(organizationId), "status")
  );

  if (error) {
    logger.warn("Failed to read plan provisioning status", {
      organizationId,
      error: error.message,
    });
    return undefined;
  }

  const parsed = PlanProvisioningStatusSchema.safeParse(status);
  return parsed.success ? parsed.data : undefined;
}
