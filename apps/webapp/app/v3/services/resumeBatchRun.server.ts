import type { PrismaClientOrTransaction } from "~/db.server";
import { commonWorker } from "../commonWorker.server";
import { marqs } from "~/v3/marqs/index.server";
import { BaseService } from "./baseService.server";
import { logger } from "~/services/logger.server";
import type { BatchTaskRun, Prisma } from "@trigger.dev/database";
import { findEnvironmentById } from "~/models/runtimeEnvironment.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { workerQueue } from "~/services/worker.server";
import { isV3Disabled } from "../engineDeprecation.server";

const finishedBatchRunStatuses = ["COMPLETED", "FAILED", "CANCELED"];

const BATCH_RUN_INCLUDE = {
  items: {
    select: {
      status: true,
      taskRunAttemptId: true,
    },
  },
} satisfies Prisma.BatchTaskRunInclude;

type RetrieveBatchRunResult = Prisma.BatchTaskRunGetPayload<{
  include: typeof BATCH_RUN_INCLUDE;
}>;

export class ResumeBatchRunService extends BaseService {
  public async call(batchRunId: string) {
    const batchRun = await this.runStore.findBatchTaskRunById(batchRunId, {
      include: BATCH_RUN_INCLUDE,
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

    // BatchTaskRun -> RuntimeEnvironment FK is dropped; resolve the env from the scalar id.
    const environment = await findEnvironmentById(batchRun.runtimeEnvironmentId);
    if (!environment) {
      logger.error("ResumeBatchRunService: Environment not found", {
        batchRunId,
        runtimeEnvironmentId: batchRun.runtimeEnvironmentId,
      });

      return "ERROR";
    }

    // v3 (engine V1) shutdown: don't resume batches for abandoned V1 projects. v4 is unaffected.
    // The BatchTaskRun -> RuntimeEnvironment relation is dropped, so read the engine from the
    // resolved environment's project rather than the unloaded batchRun.runtimeEnvironment relation.
    if (isV3Disabled() && environment.project.engine === "V1") {
      logger.debug("[ResumeBatchRunService] Skipping resume for shut-down v3 batch", {
        batchRunId,
      });
      return "ERROR";
    }

    if (batchRun.batchVersion === "v3") {
      return await this.#handleV3BatchRun(batchRun, environment);
    } else {
      return await this.#handleLegacyBatchRun(batchRun, environment);
    }
  }

  async #handleV3BatchRun(batchRun: RetrieveBatchRunResult, environment: AuthenticatedEnvironment) {
    // V3 batch runs should already be complete by the time this is called
    if (batchRun.status !== "COMPLETED") {
      logger.debug("ResumeBatchRunService: Batch run is already completed", {
        batchRunId: batchRun.id,
        batchRun: {
          id: batchRun.id,
          status: batchRun.status,
        },
      });

      return "ERROR";
    }

    // Even though we are in v3, we still need to check if the batch run has a dependent attempt
    if (!batchRun.dependentTaskAttemptId) {
      logger.debug("ResumeBatchRunService: Batch run doesn't have a dependent attempt", {
        batchRunId: batchRun.id,
      });

      return "ERROR";
    }

    return await this.#handleDependentTaskAttempt(
      batchRun,
      batchRun.dependentTaskAttemptId,
      environment
    );
  }

  async #handleLegacyBatchRun(
    batchRun: RetrieveBatchRunResult,
    environment: AuthenticatedEnvironment
  ) {
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
    if (environment.type === "DEVELOPMENT" || !batchRun.dependentTaskAttemptId) {
      // We need to update the batchRun status so we don't resume it again
      await this.runStore.updateBatchTaskRun({
        where: {
          id: batchRun.id,
        },
        data: {
          status: "COMPLETED",
        },
        select: { id: true },
      });

      return "COMPLETED";
    }

    return await this.#handleDependentTaskAttempt(
      batchRun,
      batchRun.dependentTaskAttemptId,
      environment
    );
  }

  async #handleDependentTaskAttempt(
    batchRun: RetrieveBatchRunResult,
    dependentTaskAttemptId: string,
    environment: AuthenticatedEnvironment
  ) {
    const dependentTaskAttempt = await this._prisma.taskRunAttempt.findFirst({
      where: {
        id: dependentTaskAttemptId,
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
            createdAt: true,
            queueTimestamp: true,
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
    const dependentRun = dependentTaskAttempt.taskRun;

    if (dependentTaskAttempt.status === "PAUSED" && batchRun.checkpointEventId) {
      logger.debug("ResumeBatchRunService: Attempt is paused and has a checkpoint event", {
        batchRunId: batchRun.id,
        dependentTaskAttempt: dependentTaskAttempt,
        checkpointEventId: batchRun.checkpointEventId,
      });

      // We need to update the batchRun status so we don't resume it again
      const wasUpdated = await this.#setBatchToResumedOnce(batchRun);

      if (wasUpdated) {
        logger.debug("ResumeBatchRunService: Resuming dependent run with checkpoint", {
          batchRunId: batchRun.id,
          dependentTaskAttemptId: dependentTaskAttempt.id,
        });

        await marqs.enqueueMessage(
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
          dependentRun.concurrencyKey ?? undefined,
          dependentRun.queueTimestamp ?? dependentRun.createdAt,
          undefined,
          "resume"
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
      const wasUpdated = await this.#setBatchToResumedOnce(batchRun);

      if (wasUpdated) {
        logger.debug("ResumeBatchRunService: Resuming dependent run without checkpoint", {
          batchRunId: batchRun.id,
          dependentTaskAttempt: dependentTaskAttempt,
          checkpointEventId: batchRun.checkpointEventId,
          hasCheckpointEvent: !!batchRun.checkpointEventId,
        });

        await marqs.requeueMessage(
          dependentRun.id,
          {
            type: "RESUME",
            completedAttemptIds: batchRun.items
              .map((item) => item.taskRunAttemptId)
              .filter(Boolean),
            resumableAttemptId: dependentTaskAttempt.id,
            checkpointEventId: batchRun.checkpointEventId ?? undefined,
            taskIdentifier: dependentTaskAttempt.taskRun.taskIdentifier,
            projectId: environment.projectId,
            environmentId: environment.id,
            environmentType: environment.type,
          },
          (
            dependentTaskAttempt.taskRun.queueTimestamp ?? dependentTaskAttempt.taskRun.createdAt
          ).getTime(),
          "resume"
        );

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

  async #setBatchToResumedOnce(batchRun: BatchTaskRun) {
    // v3 batches don't use the status for deciding whether a batch has been resumed
    if (batchRun.batchVersion === "v3") {
      const result = await this.runStore.updateManyBatchTaskRun({
        where: {
          id: batchRun.id,
          resumedAt: null,
        },
        data: {
          resumedAt: new Date(),
        },
      });

      if (result.count > 0) {
        return true;
      } else {
        return false;
      }
    }

    const result = await this.runStore.updateManyBatchTaskRun({
      where: {
        id: batchRun.id,
        status: {
          not: "COMPLETED", // Ensure the status is not already "COMPLETED"
        },
      },
      data: {
        status: "COMPLETED",
      },
    });

    if (result.count > 0) {
      return true;
    } else {
      return false;
    }
  }

  static async enqueue(
    batchRunId: string,
    skipJobKey: boolean,
    tx?: PrismaClientOrTransaction,
    runAt?: Date
  ) {
    if (tx) {
      logger.debug("ResumeBatchRunService: Enqueuing resume batch run using workerQueue", {
        batchRunId,
        skipJobKey,
        runAt,
      });

      return await workerQueue.enqueue(
        "v3.resumeBatchRun",
        {
          batchRunId,
        },
        {
          jobKey: skipJobKey ? undefined : `resumeBatchRun-${batchRunId}`,
          runAt,
          tx,
        }
      );
    } else {
      logger.debug("ResumeBatchRunService: Enqueuing resume batch run using commonWorker", {
        batchRunId,
        skipJobKey,
        runAt,
      });

      return await commonWorker.enqueue({
        id: skipJobKey ? undefined : `resumeBatchRun-${batchRunId}`,
        job: "v3.resumeBatchRun",
        payload: {
          batchRunId,
        },
        availableAt: runAt,
      });
    }
  }
}
