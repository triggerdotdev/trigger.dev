import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { env } from "~/env.server";
import { engine } from "./runEngine.server";

export type QueueSizeGuardResult = {
  isWithinLimits: boolean;
  maximumSize?: number;
  queueSize?: number;
};

export async function guardQueueSizeLimitsForEnv(
  environment: AuthenticatedEnvironment,
  itemsToAdd: number = 1
): Promise<QueueSizeGuardResult> {
  const maximumSize = getMaximumSizeForEnvironment(environment);

  if (typeof maximumSize === "undefined") {
    return { isWithinLimits: true };
  }

  const queueSize = await engine.lengthOfEnvQueue(environment);
  const projectedSize = queueSize + itemsToAdd;

  return {
    isWithinLimits: projectedSize <= maximumSize,
    maximumSize,
    queueSize,
  };
}

function getMaximumSizeForEnvironment(environment: AuthenticatedEnvironment): number | undefined {
  if (environment.type === "DEVELOPMENT") {
    return environment.organization.maximumDevQueueSize ?? env.MAXIMUM_DEV_QUEUE_SIZE;
  } else {
    return environment.organization.maximumDeployedQueueSize ?? env.MAXIMUM_DEPLOYED_QUEUE_SIZE;
  }
}
