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
        dependentTaskAttempt: {
          include: {
            runtimeEnvironment: {
              include: {
                project: true,
                organization: true,
              },
            },
            taskRun: true,
          },
        },
        items: true,
      },
    });

    if (!batchRun || !batchRun.dependentTaskAttempt) {
      logger.error(
        "ResumeBatchRunService: Batch run doesn't exist or doesn't have a dependent attempt",
        {
          batchRun,
        }
      );
      return;
    }

    if (batchRun.status === "COMPLETED") {
      logger.debug("ResumeBatchRunService: Batch run is already completed", {
        batchRun: batchRun,
      });
      return;
    }

    if (batchRun.items.some((item) => !finishedBatchRunStatuses.includes(item.status))) {
      logger.debug("ResumeBatchRunService: All items aren't yet completed", {
        batchRun: batchRun,
      });
      return;
    }

    // This batch has a dependent attempt and just finalized, we should resume that attempt
    const environment = batchRun.dependentTaskAttempt.runtimeEnvironment;

    // If we are in development, we don't need to resume the dependent task (that will happen automatically)
    if (environment.type === "DEVELOPMENT") {
      // We need to update the batchRun status so we don't resume it again
      await this._prisma.batchTaskRun.update({
        where: {
          id: batchRun.id,
        },
        data: {
          status: "COMPLETED",
        },
      });
      return;
    }

    const dependentRun = batchRun.dependentTaskAttempt.taskRun;

    if (batchRun.dependentTaskAttempt.status === "PAUSED" && batchRun.checkpointEventId) {
      logger.debug("ResumeBatchRunService: Attempt is paused and has a checkpoint event", {
        batchRunId: batchRun.id,
        dependentTaskAttempt: batchRun.dependentTaskAttempt,
        checkpointEventId: batchRun.checkpointEventId,
      });

      // We need to update the batchRun status so we don't resume it again
      const wasUpdated = await this.#setBatchToCompletedOnce(batchRun.id);
      if (wasUpdated) {
        logger.debug("ResumeBatchRunService: Resuming dependent run with checkpoint", {
          batchRunId: batchRun.id,
          dependentTaskAttemptId: batchRun.dependentTaskAttempt.id,
        });
        await marqs?.enqueueMessage(
          environment,
          dependentRun.queue,
          dependentRun.id,
          {
            type: "RESUME",
            completedAttemptIds: [],
            resumableAttemptId: batchRun.dependentTaskAttempt.id,
            checkpointEventId: batchRun.checkpointEventId,
            taskIdentifier: batchRun.dependentTaskAttempt.taskRun.taskIdentifier,
            projectId: batchRun.dependentTaskAttempt.runtimeEnvironment.projectId,
            environmentId: batchRun.dependentTaskAttempt.runtimeEnvironment.id,
            environmentType: batchRun.dependentTaskAttempt.runtimeEnvironment.type,
          },
          dependentRun.concurrencyKey ?? undefined
        );
      } else {
        logger.debug("ResumeBatchRunService: with checkpoint was already completed", {
          batchRunId: batchRun.id,
          dependentTaskAttempt: batchRun.dependentTaskAttempt,
          checkpointEventId: batchRun.checkpointEventId,
          hasCheckpointEvent: !!batchRun.checkpointEventId,
        });
      }
    } else {
      logger.debug("ResumeBatchRunService: attempt is not paused or there's no checkpoint event", {
        batchRunId: batchRun.id,
        dependentTaskAttempt: batchRun.dependentTaskAttempt,
        checkpointEventId: batchRun.checkpointEventId,
        hasCheckpointEvent: !!batchRun.checkpointEventId,
      });

      if (batchRun.dependentTaskAttempt.status === "PAUSED" && !batchRun.checkpointEventId) {
        // In case of race conditions the status can be PAUSED without a checkpoint event
        // When the checkpoint is created, it will continue the run
        logger.error("ResumeBatchRunService: attempt is paused but there's no checkpoint event", {
          batchRunId: batchRun.id,
          dependentTaskAttemptId: batchRun.dependentTaskAttempt.id,
        });
        return;
      }

      // We need to update the batchRun status so we don't resume it again
      const wasUpdated = await this.#setBatchToCompletedOnce(batchRun.id);
      if (wasUpdated) {
        logger.debug("ResumeBatchRunService: Resuming dependent run without checkpoint", {
          batchRunId: batchRun.id,
          dependentTaskAttemptId: batchRun.dependentTaskAttempt.id,
        });
        await marqs?.replaceMessage(dependentRun.id, {
          type: "RESUME",
          completedAttemptIds: batchRun.items.map((item) => item.taskRunAttemptId).filter(Boolean),
          resumableAttemptId: batchRun.dependentTaskAttempt.id,
          checkpointEventId: batchRun.checkpointEventId ?? undefined,
          taskIdentifier: batchRun.dependentTaskAttempt.taskRun.taskIdentifier,
          projectId: batchRun.dependentTaskAttempt.runtimeEnvironment.projectId,
          environmentId: batchRun.dependentTaskAttempt.runtimeEnvironment.id,
          environmentType: batchRun.dependentTaskAttempt.runtimeEnvironment.type,
        });
      } else {
        logger.debug("ResumeBatchRunService: without checkpoint was already completed", {
          batchRunId: batchRun.id,
          dependentTaskAttempt: batchRun.dependentTaskAttempt,
          checkpointEventId: batchRun.checkpointEventId,
          hasCheckpointEvent: !!batchRun.checkpointEventId,
        });
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
