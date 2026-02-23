import { RuntimeEnvironmentType } from "@trigger.dev/database";
import { env } from "~/env.server";

/**
 * Organization fields needed for queue limit calculation.
 */
export type QueueLimitOrganization = {
  maximumDevQueueSize: number | null;
  maximumDeployedQueueSize: number | null;
};

/**
 * Calculates the queue size limit for an environment based on its type and organization settings.
 *
 * Resolution order:
 * 1. Organization-level override (set by billing sync or admin)
 * 2. Environment variable fallback
 * 3. null if neither is set
 *
 * @param environmentType - The type of the runtime environment
 * @param organization - Organization with queue limit fields
 * @returns The queue size limit, or null if unlimited
 */
export function getQueueSizeLimit(
  environmentType: RuntimeEnvironmentType,
  organization: QueueLimitOrganization
): number | null {
  if (environmentType === "DEVELOPMENT") {
    return organization.maximumDevQueueSize ?? env.MAXIMUM_DEV_QUEUE_SIZE ?? null;
  }

  return organization.maximumDeployedQueueSize ?? env.MAXIMUM_DEPLOYED_QUEUE_SIZE ?? null;
}

/**
 * Determines the source of the queue size limit for display purposes.
 *
 * @param environmentType - The type of the runtime environment
 * @param organization - Organization with queue limit fields
 * @returns "plan" if org has a value (typically set by billing), "default" if using env var fallback
 */
export function getQueueSizeLimitSource(
  environmentType: RuntimeEnvironmentType,
  organization: QueueLimitOrganization
): "plan" | "default" {
  if (environmentType === "DEVELOPMENT") {
    return organization.maximumDevQueueSize !== null ? "plan" : "default";
  }

  return organization.maximumDeployedQueueSize !== null ? "plan" : "default";
}
