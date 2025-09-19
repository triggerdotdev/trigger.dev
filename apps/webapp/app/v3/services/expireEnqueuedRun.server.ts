import { PrismaClientOrTransaction } from "~/db.server";
import { logger } from "~/services/logger.server";
import { commonWorker } from "../commonWorker.server";
import { eventRepository } from "../eventRepository.server";
import { BaseService } from "./baseService.server";
import { FinalizeTaskRunService } from "./finalizeTaskRun.server";
import { getTaskEventStoreTableForRun } from "../taskEventStore.server";
import { tryCatch } from "@trigger.dev/core/utils";

export class ExpireEnqueuedRunService extends BaseService {
  public static async ack(runId: string, tx?: PrismaClientOrTransaction) {
    // We don't "dequeue" from the workerQueue here because it would be redundant and if this service
    // is called for a run that has already started, nothing happens
    await commonWorker.ack(`v3.expireRun:${runId}`);
  }

  public static async enqueue(runId: string, runAt?: Date) {
    return await commonWorker.enqueue({
      job: "v3.expireRun",
      payload: { runId },
      availableAt: runAt,
      id: `v3.expireRun:${runId}`,
    });
  }

  public async call(runId: string) {
    const run = await this._prisma.taskRun.findFirst({
      where: {
        id: runId,
      },
      include: {
        runtimeEnvironment: {
          include: {
            organization: true,
            project: true,
          },
        },
      },
    });

    if (!run) {
      logger.debug("Could not find enqueued run to expire", {
        runId,
      });

      return;
    }

    if (run.status !== "PENDING") {
      logger.debug("Run cannot be expired because it's not in PENDING status", {
        run,
      });

      return;
    }

    if (run.lockedAt) {
      logger.debug("Run cannot be expired because it's locked", {
        run,
      });

      return;
    }

    logger.debug("Expiring enqueued run", {
      run,
    });

    const finalizeService = new FinalizeTaskRunService();
    await finalizeService.call({
      id: run.id,
      status: "EXPIRED",
      expiredAt: new Date(),
      completedAt: new Date(),
      attemptStatus: "FAILED",
      error: {
        type: "STRING_ERROR",
        raw: `Run expired because the TTL (${run.ttl}) was reached`,
      },
    });

    if (run.ttl) {
      const [completeExpiredRunEventError] = await tryCatch(
        eventRepository.completeExpiredRunEvent({
          run,
          endTime: new Date(),
          ttl: run.ttl,
        })
      );

      if (completeExpiredRunEventError) {
        logger.error("[ExpireEnqueuedRunService] Failed to complete expired run event", {
          error: completeExpiredRunEventError,
          runId: run.id,
        });
      }
    }
  }
}
