import { type PrismaClientOrTransaction } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { engine } from "./runEngine.server";

/** Updates the RunQueue env concurrency limits */
export async function updateEnvConcurrencyLimits(
  environment: AuthenticatedEnvironment,
  maximumConcurrencyLimit?: number,
  db: PrismaClientOrTransaction = prisma
) {
  let limit = maximumConcurrencyLimit;

  if (limit === undefined) {
    // A paused env is only enforced by a 0 limit in the RunQueue, so a push without an explicit
    // limit must not resurrect the real limit. Callers hold an environment read at auth time, so
    // resolve both values here instead of trusting it: a stale `paused: false` silently resumes a
    // paused env, and a stale `paused: true` strands a resumed one at 0 with nothing to restore it.
    const current = await db.runtimeEnvironment.findFirst({
      where: { id: environment.id },
      select: { paused: true, maximumConcurrencyLimit: true },
    });

    const resolved = current ?? environment;
    limit = resolved.paused ? 0 : resolved.maximumConcurrencyLimit;
  }

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

/** Updates the RunQueue total concurrency limit for a queue (the cap across all concurrency-key values) */
export async function updateQueueTotalConcurrencyLimits(
  environment: AuthenticatedEnvironment,
  queueName: string,
  totalConcurrency: number
) {
  await engine.runQueue.updateQueueTotalConcurrencyLimits(environment, queueName, totalConcurrency);
}

/** Removes the RunQueue total concurrency limit for a queue */
export async function removeQueueTotalConcurrencyLimits(
  environment: AuthenticatedEnvironment,
  queueName: string
) {
  await engine.runQueue.removeQueueTotalConcurrencyLimits(environment, queueName);
}

/** Removes the RunQueue limits for a queue */
export async function removeQueueConcurrencyLimits(
  environment: AuthenticatedEnvironment,
  queueName: string
) {
  await engine.runQueue.removeQueueConcurrencyLimits(environment, queueName);
}

/** Sets a temporary per-key override of a queue's perKey for one concurrencyKey, expiring after ttlSeconds */
export async function updateQueueConcurrencyKeyLimit(
  environment: AuthenticatedEnvironment,
  queueName: string,
  concurrencyKey: string,
  concurrency: number,
  ttlSeconds: number
) {
  await engine.runQueue.updateQueueConcurrencyKeyLimit(
    environment,
    queueName,
    concurrencyKey,
    concurrency,
    ttlSeconds
  );
}

/** Removes a per-key override of a queue's perKey */
export async function removeQueueConcurrencyKeyLimit(
  environment: AuthenticatedEnvironment,
  queueName: string,
  concurrencyKey: string
) {
  await engine.runQueue.removeQueueConcurrencyKeyLimit(environment, queueName, concurrencyKey);
}

/** Reads a per-key override of a queue's perKey, with when it expires */
export async function getQueueConcurrencyKeyLimit(
  environment: AuthenticatedEnvironment,
  queueName: string,
  concurrencyKey: string
) {
  return engine.runQueue.getQueueConcurrencyKeyLimit(environment, queueName, concurrencyKey);
}
