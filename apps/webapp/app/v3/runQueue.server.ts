import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { marqs } from "./marqs/index.server";
import { engine } from "./runEngine.server";

//This allows us to update MARQS and the RunQueue

/** Updates MARQS and the RunQueue limits */
export async function updateEnvConcurrencyLimits(environment: AuthenticatedEnvironment) {
  await Promise.allSettled([
    marqs?.updateEnvConcurrencyLimits(environment),
    engine.runQueue.updateEnvConcurrencyLimits(environment),
  ]);
}

/** Updates MARQS and the RunQueue limits for a queue */
export async function updateQueueConcurrencyLimits(
  environment: AuthenticatedEnvironment,
  queueName: string,
  concurrency: number
) {
  await Promise.allSettled([
    marqs?.updateQueueConcurrencyLimits(environment, queueName, concurrency),
    engine.runQueue.updateQueueConcurrencyLimits(environment, queueName, concurrency),
  ]);
}

/** Removes MARQS and the RunQueue limits for a queue */
export async function removeQueueConcurrencyLimits(
  environment: AuthenticatedEnvironment,
  queueName: string
) {
  await Promise.allSettled([
    marqs?.removeQueueConcurrencyLimits(environment, queueName),
    engine.runQueue.removeQueueConcurrencyLimits(environment, queueName),
  ]);
}
