import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { engine } from "./runEngine.server";

/** Updates the RunQueue env concurrency limits */
export async function updateEnvConcurrencyLimits(
  environment: AuthenticatedEnvironment,
  maximumConcurrencyLimit?: number
) {
  let updatedEnvironment = environment;
  if (maximumConcurrencyLimit !== undefined) {
    updatedEnvironment.maximumConcurrencyLimit = maximumConcurrencyLimit;
  }

  await engine.runQueue.updateEnvConcurrencyLimits(updatedEnvironment);
}

/** Updates the RunQueue limits for a queue */
export async function updateQueueConcurrencyLimits(
  environment: AuthenticatedEnvironment,
  queueName: string,
  concurrency: number
) {
  await engine.runQueue.updateQueueConcurrencyLimits(environment, queueName, concurrency);
}

/** Removes the RunQueue limits for a queue */
export async function removeQueueConcurrencyLimits(
  environment: AuthenticatedEnvironment,
  queueName: string
) {
  await engine.runQueue.removeQueueConcurrencyLimits(environment, queueName);
}
