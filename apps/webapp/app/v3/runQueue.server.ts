import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { engine } from "./runEngine.server";

/** Updates the RunQueue env concurrency limits */
export async function updateEnvConcurrencyLimits(
  environment: AuthenticatedEnvironment,
  maximumConcurrencyLimit?: number
) {
  // A paused env is only enforced by a 0 limit in the RunQueue, so a push without an explicit
  // limit has to stay 0 — otherwise it silently resumes an env the dashboard still shows as paused.
  const limit =
    maximumConcurrencyLimit ?? (environment.paused ? 0 : environment.maximumConcurrencyLimit);

  await engine.runQueue.updateEnvConcurrencyLimits({
    ...environment,
    maximumConcurrencyLimit: limit,
  });
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
