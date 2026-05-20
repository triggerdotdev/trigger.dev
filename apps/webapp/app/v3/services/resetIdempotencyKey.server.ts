import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { BaseService, ServiceValidationError } from "./baseService.server";
import { logger } from "~/services/logger.server";
import { getMollifierBuffer } from "~/v3/mollifier/mollifierBuffer.server";

export class ResetIdempotencyKeyService extends BaseService {
  public async call(
    idempotencyKey: string,
    taskIdentifier: string,
    authenticatedEnv: AuthenticatedEnvironment
  ): Promise<{ id: string }> {
    const { count: pgCount } = await this._prisma.taskRun.updateMany({
      where: {
        idempotencyKey,
        taskIdentifier,
        runtimeEnvironmentId: authenticatedEnv.id,
      },
      data: {
        idempotencyKey: null,
        idempotencyKeyExpiresAt: null,
      },
    });

    // Buffer-side reset (Q5): the key may belong to a buffered run that
    // hasn't materialised yet. The PG updateMany above can't see it.
    // resetIdempotency clears both the snapshot fields and the Redis
    // lookup atomically. Returns null when nothing was bound there.
    const buffer = getMollifierBuffer();
    const bufferResult = buffer
      ? await buffer
          .resetIdempotency({
            envId: authenticatedEnv.id,
            taskIdentifier,
            idempotencyKey,
          })
          .catch((err) => {
            // Buffer outage shouldn't 500 the reset endpoint if PG
            // already cleared something. Log and treat as a miss.
            logger.error("ResetIdempotencyKeyService: buffer reset failed", {
              idempotencyKey,
              taskIdentifier,
              err: err instanceof Error ? err.message : String(err),
            });
            return { clearedRunId: null };
          })
      : { clearedRunId: null };

    const totalCount = pgCount + (bufferResult.clearedRunId ? 1 : 0);

    if (totalCount === 0) {
      throw new ServiceValidationError(
        `No runs found with idempotency key: ${idempotencyKey} and task: ${taskIdentifier}`,
        404
      );
    }

    logger.info(
      `Reset idempotency key: ${idempotencyKey} for task: ${taskIdentifier} in env: ${authenticatedEnv.id}, affected ${totalCount} run(s) (pg=${pgCount}, buffered=${bufferResult.clearedRunId ? 1 : 0})`
    );

    return { id: idempotencyKey };
  }
}
