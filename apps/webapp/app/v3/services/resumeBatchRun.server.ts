import { PrismaClientOrTransaction } from "~/db.server";
import { workerQueue } from "~/services/worker.server";
import { marqs } from "~/v3/marqs/index.server";
import { BaseService } from "./baseService.server";
import { logger } from "~/services/logger.server";

const finishedBatchRunStatuses = ["COMPLETED", "FAILED", "CANCELED"];

export class ResumeBatchRunService extends BaseService {
  public async call(batchRunId: string) {
    const batchRun = await this._prisma.batchTaskRun.findFirst({
      where: {
        id: batchRunId,
      },
      include: {
        runtimeEnvironment: {
          include: {
            project: true,
            organization: true,
          },
        },
        items: {
          select: {
            status: true,
            taskRunAttemptId: true,
          },
        },
      },
    });

    if (!batchRun) {
      logger.error(
        "ResumeBatchRunService: Batch run doesn't exist or doesn't have a dependent attempt",
        {
          batchRunId,
        }
      );

      return "ERROR";
    }

    if (batchRun.status === "COMPLETED") {
      logger.debug("ResumeBatchRunService: Batch run is already completed", {
        batchRunId: batchRun.id,
        batchRun: {
          id: batchRun.id,
          status: batchRun.status,
        },
      });

      return "ERROR";
    }

    if (batchRun.batchVersion === "v2") {
      // Make sure batchRun.items.length is equal to or greater than batchRun.runCount
      if (batchRun.items.length < batchRun.runCount) {
        logger.debug("ResumeBatchRunService: All items aren't yet completed [v2]", {
          batchRunId: batchRun.id,
          batchRun: {
            id: batchRun.id,
            status: batchRun.status,
            itemsLength: batchRun.items.length,
            runCount: batchRun.runCount,
          },
        });

        return "PENDING";
      }
    }

    if (batchRun.items.some((item) => !finishedBatchRunStatuses.includes(item.status))) {
      logger.debug("ResumeBatchRunService: All items aren't yet completed [v1]", {
        batchRunId: batchRun.id,
        batchRun: {
          id: batchRun.id,
          status: batchRun.status,
        },
      });

      return "PENDING";
    }

    // If we are in development, or there is no dependent attempt, we can just mark the batch as completed and return
    if (batchRun.runtimeEnvironment.type === "DEVELOPMENT" || !batchRun.dependentTaskAttemptId) {
      // We need to update the batchRun status so we don't resume it again
      await this._prisma.batchTaskRun.update({
        where: {
          id: batchRun.id,
        },
        data: {
          status: "COMPLETED",
        },
      });

      return "COMPLETED";
    }

    const dependentTaskAttempt = await this._prisma.taskRunAttempt.findFirst({
      where: {
        id: batchRun.dependentTaskAttemptId,
      },
      select: {
        status: true,
        id: true,
        taskRun: {
          select: {
            id: true,
            queue: true,
            taskIdentifier: true,
            concurrencyKey: true,
          },
        },
      },
    });

    if (!dependentTaskAttempt) {
      logger.error("ResumeBatchRunService: Dependent attempt not found", {
        batchRunId: batchRun.id,
        dependentTaskAttemptId: batchRun.dependentTaskAttemptId,
      });

      return "ERROR";
    }

    // This batch has a dependent attempt and just finalized, we should resume that attempt
    const environment = batchRun.runtimeEnvironment;
    const dependentRun = dependentTaskAttempt.taskRun;

    if (dependentTaskAttempt.status === "PAUSED" && batchRun.checkpointEventId) {
      logger.debug("ResumeBatchRunService: Attempt is paused and has a checkpoint event", {
        batchRunId: batchRun.id,
        dependentTaskAttempt: dependentTaskAttempt,
        checkpointEventId: batchRun.checkpointEventId,
      });

      // We need to update the batchRun status so we don't resume it again
      const wasUpdated = await this.#setBatchToCompletedOnce(batchRun.id);

      if (wasUpdated) {
        logger.debug("ResumeBatchRunService: Resuming dependent run with checkpoint", {
          batchRunId: batchRun.id,
          dependentTaskAttemptId: dependentTaskAttempt.id,
        });

        await marqs?.enqueueMessage(
          environment,
          dependentRun.queue,
          dependentRun.id,
          {
            type: "RESUME",
            completedAttemptIds: [],
            resumableAttemptId: dependentTaskAttempt.id,
            checkpointEventId: batchRun.checkpointEventId,
            taskIdentifier: dependentTaskAttempt.taskRun.taskIdentifier,
            projectId: environment.projectId,
            environmentId: environment.id,
            environmentType: environment.type,
          },
          dependentRun.concurrencyKey ?? undefined
        );

        return "COMPLETED";
      } else {
        logger.debug("ResumeBatchRunService: with checkpoint was already completed", {
          batchRunId: batchRun.id,
          dependentTaskAttempt: dependentTaskAttempt,
          checkpointEventId: batchRun.checkpointEventId,
          hasCheckpointEvent: !!batchRun.checkpointEventId,
        });

        return "ALREADY_COMPLETED";
      }
    } else {
      logger.debug("ResumeBatchRunService: attempt is not paused or there's no checkpoint event", {
        batchRunId: batchRun.id,
        dependentTaskAttempt: dependentTaskAttempt,
        checkpointEventId: batchRun.checkpointEventId,
        hasCheckpointEvent: !!batchRun.checkpointEventId,
      });

      if (dependentTaskAttempt.status === "PAUSED" && !batchRun.checkpointEventId) {
        // In case of race conditions the status can be PAUSED without a checkpoint event
        // When the checkpoint is created, it will continue the run
        logger.error("ResumeBatchRunService: attempt is paused but there's no checkpoint event", {
          batchRunId: batchRun.id,
          dependentTaskAttempt: dependentTaskAttempt,
          checkpointEventId: batchRun.checkpointEventId,
          hasCheckpointEvent: !!batchRun.checkpointEventId,
        });

        return "ERROR";
      }

      // We need to update the batchRun status so we don't resume it again
      const wasUpdated = await this.#setBatchToCompletedOnce(batchRun.id);

      if (wasUpdated) {
        logger.debug("ResumeBatchRunService: Resuming dependent run without checkpoint", {
          batchRunId: batchRun.id,
          dependentTaskAttempt: dependentTaskAttempt,
          checkpointEventId: batchRun.checkpointEventId,
          hasCheckpointEvent: !!batchRun.checkpointEventId,
        });

        await marqs?.replaceMessage(dependentRun.id, {
          type: "RESUME",
          completedAttemptIds: batchRun.items.map((item) => item.taskRunAttemptId).filter(Boolean),
          resumableAttemptId: dependentTaskAttempt.id,
          checkpointEventId: batchRun.checkpointEventId ?? undefined,
          taskIdentifier: dependentTaskAttempt.taskRun.taskIdentifier,
          projectId: environment.projectId,
          environmentId: environment.id,
          environmentType: environment.type,
        });

        return "COMPLETED";
      } else {
        logger.debug("ResumeBatchRunService: without checkpoint was already completed", {
          batchRunId: batchRun.id,
          dependentTaskAttempt: dependentTaskAttempt,
          checkpointEventId: batchRun.checkpointEventId,
          hasCheckpointEvent: !!batchRun.checkpointEventId,
        });

        return "ALREADY_COMPLETED";
      }
    }
  }

  async #setBatchToCompletedOnce(batchRunId: string) {
    const result = await this._prisma.batchTaskRun.updateMany({
      where: {
        id: batchRunId,
        status: {
          not: "COMPLETED", // Ensure the status is not already "COMPLETED"
        },
      },
      data: {
        status: "COMPLETED",
      },
    });

    // Check if any records were updated
    if (result.count > 0) {
      // The status was changed, so we return true
      return true;
    } else {
      return false;
    }
  }

  static async enqueue(batchRunId: string, tx: PrismaClientOrTransaction, runAt?: Date) {
    return await workerQueue.enqueue(
      "v3.resumeBatchRun",
      {
        batchRunId,
      },
      {
        tx,
        runAt,
        jobKey: `resumeBatchRun-${batchRunId}`,
      }
    );
  }
}
