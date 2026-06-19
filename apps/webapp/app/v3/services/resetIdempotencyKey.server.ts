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
    const { count: pgCount } = await this.runStore.clearIdempotencyKey(
      {
        byPredicate: {
          idempotencyKey,
          taskIdentifier,
          runtimeEnvironmentId: authenticatedEnv.id,
        },
      },
      this._prisma
    );

    // Buffer-side reset: the key may belong to a buffered run that
    // hasn't materialised yet. The PG updateMany above can't see it.
    // resetIdempotency clears both the snapshot fields and the Redis
    // lookup atomically. Returns null when nothing was bound there.
    const buffer = getMollifierBuffer();
    let bufferResetFailed = false;
    const bufferResult = buffer
      ? await buffer
          .resetIdempotency({
            envId: authenticatedEnv.id,
            taskIdentifier,
            idempotencyKey,
          })
          .catch((err) => {
            // Don't drop a buffer outage on the floor. We log + flag so
            // the 404 branch below can distinguish "no record anywhere"
            // (legitimate not-found) from "PG cleared nothing AND we
            // couldn't see the buffer" (partial outage — caller should
            // retry, not be told "doesn't exist").
            bufferResetFailed = true;
            logger.error("ResetIdempotencyKeyService: buffer reset failed", {
              idempotencyKey,
              taskIdentifier,
              err: err instanceof Error ? err.message : String(err),
            });
            return { clearedRunId: null };
          })
      : { clearedRunId: null };

    const totalCount = pgCount + (bufferResult.clearedRunId ? 1 : 0);

    if (pgCount === 0 && bufferResetFailed) {
      // PG saw nothing AND the buffer is unreachable. We can't truthfully
      // say "not found" — there may be a buffered run we can't observe.
      // Surface as 503 so the caller retries instead of being misled.
      throw new ServiceValidationError(
        "Unable to verify buffered idempotency state right now; please retry",
        503
      );
    }

    if (totalCount === 0) {
      // PG↔buffer handoff re-check. Between the initial `pg.updateMany`
      // and the buffer reset above, a buffered run can materialise into
      // PG: the drainer's `engine.trigger` writes the row with the
      // original idempotencyKey, then `buffer.ack` clears the Redis
      // idempotency lookup (per ack's contract on
      // `packages/redis-worker/src/mollifier/buffer.ts`). Both surfaces
      // now report "nothing", but the key still lives on the freshly-
      // materialised PG row. One more conditional updateMany catches
      // that row before we 404 the customer. Cost: a single indexed
      // lookup against the writer when there's nothing to find;
      // otherwise the exact write the customer asked for (i.e., not
      // duplicative — without it the reset is silently lost).
      const { count: handoffPgCount } = await this.runStore.clearIdempotencyKey(
        {
          byPredicate: {
            idempotencyKey,
            taskIdentifier,
            runtimeEnvironmentId: authenticatedEnv.id,
          },
        },
        this._prisma
      );
      if (handoffPgCount > 0) {
        logger.info(
          `Reset idempotency key via handoff re-check: ${idempotencyKey} for task: ${taskIdentifier} in env: ${authenticatedEnv.id}, affected ${handoffPgCount} run(s)`
        );
        return { id: idempotencyKey };
      }
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
