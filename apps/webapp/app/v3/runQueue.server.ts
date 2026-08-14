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

/** Removes the RunQueue limits for a queue */
export async function removeQueueConcurrencyLimits(
  environment: AuthenticatedEnvironment,
  queueName: string
) {
  await engine.runQueue.removeQueueConcurrencyLimits(environment, queueName);
}
