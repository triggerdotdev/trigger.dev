import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { env } from "~/env.server";
import { MarQS } from "./marqs/index.server";

export type QueueSizeGuardResult = {
  isWithinLimits: boolean;
  maximumSize?: number;
  queueSize?: number;
};

export async function guardQueueSizeLimitsForEnv(
  environment: AuthenticatedEnvironment,
  marqs?: MarQS,
  itemsToAdd: number = 1
): Promise<QueueSizeGuardResult> {
  const maximumSize = getMaximumSizeForEnvironment(environment);

  if (typeof maximumSize === "undefined") {
    return { isWithinLimits: true };
  }

  if (!marqs) {
    return { isWithinLimits: true, maximumSize };
  }

  const queueSize = await marqs.lengthOfEnvQueue(environment);
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
