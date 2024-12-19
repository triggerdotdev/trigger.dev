import { logger } from "~/services/logger.server";
import { BaseService } from "./baseService.server";
import { eventRepository } from "../eventRepository.server";
import { FinalizeTaskRunService } from "./finalizeTaskRun.server";
import { workerQueue } from "~/services/worker.server";
import { PrismaClientOrTransaction } from "~/db.server";

export class ExpireEnqueuedRunService extends BaseService {
  public static async dequeue(runId: string, tx?: PrismaClientOrTransaction) {
    return await workerQueue.dequeue(`v3.expireRun:${runId}`, { tx });
  }

  public static async enqueue(runId: string, runAt?: Date, tx?: PrismaClientOrTransaction) {
    return await workerQueue.enqueue(
      "v3.expireRun",
      { runId },
      { runAt, jobKey: `v3.expireRun:${runId}`, tx }
    );
  }

  public async call(runId: string) {
    const run = await this._prisma.taskRun.findUnique({
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

    await eventRepository.completeEvent(run.spanId, {
      endTime: new Date(),
      attributes: {
        isError: true,
      },
      events: [
        {
          name: "exception",
          time: new Date(),
          properties: {
            exception: {
              message: `Run expired because the TTL (${run.ttl}) was reached`,
            },
          },
        },
      ],
    });
  }
}
