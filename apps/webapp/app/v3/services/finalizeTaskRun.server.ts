import { FlushedRunMetadata, sanitizeError, TaskRunError } from "@trigger.dev/core/v3";
import { type Prisma, type TaskRun } from "@trigger.dev/database";
import { findQueueInEnvironment } from "~/models/taskQueue.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { updateMetadataService } from "~/services/metadata/updateMetadata.server";
import { emitRunFailed, emitRunSucceeded } from "~/services/runsDashboardInstance.server";
import { marqs } from "~/v3/marqs/index.server";
import { generateFriendlyId } from "../friendlyIdentifiers";
import { socketIo } from "../handleSocketIo.server";
import {
  FINAL_ATTEMPT_STATUSES,
  isFailedRunStatus,
  isFatalRunStatus,
  type FINAL_RUN_STATUSES,
} from "../taskStatus";
import { PerformTaskRunAlertsService } from "./alerts/performTaskRunAlerts.server";
import { BaseService } from "./baseService.server";
import { completeBatchTaskRunItemV3 } from "./batchTriggerV3.server";
import { ExpireEnqueuedRunService } from "./expireEnqueuedRun.server";
import { ResumeBatchRunService } from "./resumeBatchRun.server";
import { ResumeDependentParentsService } from "./resumeDependentParents.server";

type BaseInput = {
  id: string;
  status?: FINAL_RUN_STATUSES;
  expiredAt?: Date;
  completedAt?: Date;
  attemptStatus?: FINAL_ATTEMPT_STATUSES;
  error?: TaskRunError;
  metadata?: FlushedRunMetadata;
  env?: AuthenticatedEnvironment;
};

type InputWithInclude<T extends Prisma.TaskRunInclude> = BaseInput & {
  include: T;
};

type InputWithoutInclude = BaseInput & {
  include?: undefined;
};

type Output<T extends Prisma.TaskRunInclude | undefined> = T extends Prisma.TaskRunInclude
  ? Prisma.TaskRunGetPayload<{ include: T }>
  : TaskRun;

export class FinalizeTaskRunService extends BaseService {
  public async call<T extends Prisma.TaskRunInclude | undefined>({
    id,
    status,
    expiredAt,
    completedAt,
    include,
    attemptStatus,
    error,
    metadata,
    env,
  }: T extends Prisma.TaskRunInclude ? InputWithInclude<T> : InputWithoutInclude): Promise<
    Output<T>
  > {
    logger.debug("Finalizing run marqs ack", {
      id,
      status,
      expiredAt,
      completedAt,
    });
    await marqs?.acknowledgeMessage(id, "FinalTaskRunService call");

    logger.debug("Finalizing run updating run status", {
      id,
      status,
      expiredAt,
      completedAt,
    });

    if (metadata) {
      try {
        await updateMetadataService.call(id, metadata, env);
      } catch (e) {
        logger.error("[FinalizeTaskRunService] Failed to update metadata", {
          taskRun: id,
          error:
            e instanceof Error
              ? {
                  name: e.name,
                  message: e.message,
                  stack: e.stack,
                }
              : e,
        });
      }
    }

    // I moved the error update here for two reasons:
    // - A single update is more efficient than two
    // - If the status updates to a final status, realtime will receive that status and then shut down the stream
    //   before the error is updated, which would cause the error to be lost
    const taskRunError = error ? sanitizeError(error) : undefined;

    const run = await this._prisma.taskRun.update({
      where: { id },
      data: { status, expiredAt, completedAt, error: taskRunError },
      ...(include ? { include } : {}),
    });

    if (run.organizationId) {
      if (status === "COMPLETED_SUCCESSFULLY") {
        emitRunSucceeded({
          time: new Date(),
          run: {
            id: run.id,
            status: run.status,
            spanId: run.spanId,
            output: run.output ?? undefined,
            outputType: run.outputType,
            taskEventStore: run.taskEventStore,
            createdAt: run.createdAt,
            completedAt: run.completedAt,
            updatedAt: run.updatedAt,
            attemptNumber: run.attemptNumber ?? 1,
            usageDurationMs: run.usageDurationMs,
            costInCents: run.costInCents,
          },
          organization: {
            id: run.organizationId,
          },
          project: {
            id: run.projectId,
          },
          environment: {
            id: run.runtimeEnvironmentId,
          },
        });
      } else if (taskRunError) {
        emitRunFailed({
          time: new Date(),
          run: {
            id: run.id,
            status: run.status,
            spanId: run.spanId,
            error: taskRunError,
            taskEventStore: run.taskEventStore,
            createdAt: run.createdAt,
            completedAt: run.completedAt,
            updatedAt: run.updatedAt,
            attemptNumber: run.attemptNumber ?? 1,
            usageDurationMs: run.usageDurationMs,
            costInCents: run.costInCents,
          },
          organization: {
            id: run.organizationId,
          },
          project: {
            id: run.projectId,
          },
          environment: {
            id: run.runtimeEnvironmentId,
          },
        });
      }
    }

    if (run.ttl) {
      await ExpireEnqueuedRunService.ack(run.id);
    }

    if (attemptStatus || error) {
      await this.finalizeAttempt({ attemptStatus, error, run });
    }

    try {
      await this.#finalizeBatch(run);
    } catch (finalizeBatchError) {
      logger.error("FinalizeTaskRunService: Failed to finalize batch", {
        runId: run.id,
        error: finalizeBatchError,
      });
    }

    //resume any dependencies
    const resumeService = new ResumeDependentParentsService(this._prisma);
    const result = await resumeService.call({ id: run.id });

    if (result.success) {
      logger.log("FinalizeTaskRunService: Resumed dependent parents", { result, run: run.id });
    } else {
      logger.error("FinalizeTaskRunService: Failed to resume dependent parents", {
        result,
        run: run.id,
      });
    }

    //enqueue alert
    if (isFailedRunStatus(run.status)) {
      await PerformTaskRunAlertsService.enqueue(run.id);
    }

    if (isFatalRunStatus(run.status)) {
      logger.error("FinalizeTaskRunService: Fatal status", { runId: run.id, status: run.status });

      const extendedRun = await this._prisma.taskRun.findFirst({
        where: { id: run.id },
        select: {
          id: true,
          lockedToVersion: {
            select: {
              supportsLazyAttempts: true,
            },
          },
          runtimeEnvironment: {
            select: {
              type: true,
            },
          },
        },
      });

      if (extendedRun && extendedRun.runtimeEnvironment.type !== "DEVELOPMENT") {
        logger.error("FinalizeTaskRunService: Fatal status, requesting worker exit", {
          runId: run.id,
          status: run.status,
        });

        // Signal to exit any leftover containers
        socketIo.coordinatorNamespace.emit("REQUEST_RUN_CANCELLATION", {
          version: "v1",
          runId: run.id,
          // Give the run a few seconds to exit to complete any flushing etc
          delayInMs: extendedRun.lockedToVersion?.supportsLazyAttempts ? 5_000 : undefined,
        });
      }
    }

    return run as Output<T>;
  }

  async #finalizeBatch(run: TaskRun) {
    if (!run.batchId) {
      return;
    }

    logger.debug("FinalizeTaskRunService: Finalizing batch", { runId: run.id });

    const environment = await this._prisma.runtimeEnvironment.findFirst({
      where: {
        id: run.runtimeEnvironmentId,
      },
    });

    if (!environment) {
      return;
    }

    const batchItems = await this._prisma.batchTaskRunItem.findMany({
      where: {
        taskRunId: run.id,
      },
      include: {
        batchTaskRun: {
          select: {
            id: true,
            dependentTaskAttemptId: true,
            batchVersion: true,
          },
        },
      },
    });

    if (batchItems.length === 0) {
      return;
    }

    if (batchItems.length > 10) {
      logger.error("FinalizeTaskRunService: More than 10 batch items", {
        runId: run.id,
        batchItems: batchItems.length,
      });

      return;
    }

    for (const item of batchItems) {
      // Don't do anything if this is a batchTriggerAndWait in a deployed task
      // As that is being handled in resumeDependentParents and resumeTaskRunDependencies
      if (environment.type !== "DEVELOPMENT" && item.batchTaskRun.dependentTaskAttemptId) {
        continue;
      }

      if (item.batchTaskRun.batchVersion === "v3") {
        await completeBatchTaskRunItemV3(item.id, item.batchTaskRunId, this._prisma);
      } else {
        // THIS IS DEPRECATED and only happens with batchVersion != v3
        // Update the item to complete
        await this._prisma.batchTaskRunItem.update({
          where: {
            id: item.id,
          },
          data: {
            status: "COMPLETED",
          },
        });

        // This won't resume because this batch does not have a dependent task attempt ID
        // or is in development, but this service will mark the batch as completed
        await ResumeBatchRunService.enqueue(item.batchTaskRunId, false, this._prisma);
      }
    }
  }

  async finalizeAttempt({
    attemptStatus,
    error,
    run,
  }: {
    attemptStatus?: FINAL_ATTEMPT_STATUSES;
    error?: TaskRunError;
    run: TaskRun;
  }) {
    if (!attemptStatus && !error) {
      logger.error("FinalizeTaskRunService: No attemptStatus or error provided", { runId: run.id });
      return;
    }

    const latestAttempt = await this._prisma.taskRunAttempt.findFirst({
      where: { taskRunId: run.id },
      orderBy: { id: "desc" },
      take: 1,
    });

    if (latestAttempt) {
      logger.debug("Finalizing run attempt", {
        id: latestAttempt.id,
        status: attemptStatus,
        error,
      });

      await this._prisma.taskRunAttempt.update({
        where: { id: latestAttempt.id },
        data: { status: attemptStatus, error: error ? sanitizeError(error) : undefined },
      });

      return;
    }

    // There's no attempt, so create one

    logger.debug("Finalizing run no attempt found", {
      runId: run.id,
      attemptStatus,
      error,
    });

    if (!run.lockedById) {
      logger.error(
        "FinalizeTaskRunService: No lockedById, so can't get the BackgroundWorkerTask. Not creating an attempt.",
        { runId: run.id }
      );
      return;
    }

    const workerTask = await this._prisma.backgroundWorkerTask.findFirst({
      select: {
        id: true,
        workerId: true,
        runtimeEnvironmentId: true,
        queueConfig: true,
      },
      where: {
        id: run.lockedById,
      },
    });

    if (!workerTask) {
      logger.error("FinalizeTaskRunService: No worker task found", { runId: run.id });
      return;
    }

    const queue = await findQueueInEnvironment(
      run.queue,
      workerTask.runtimeEnvironmentId,
      workerTask.id,
      workerTask
    );

    if (!queue) {
      logger.error("FinalizeTaskRunService: No queue found", { runId: run.id });
      return;
    }

    await this._prisma.taskRunAttempt.create({
      data: {
        number: 1,
        friendlyId: generateFriendlyId("attempt"),
        taskRunId: run.id,
        backgroundWorkerId: workerTask?.workerId,
        backgroundWorkerTaskId: workerTask?.id,
        queueId: queue.id,
        runtimeEnvironmentId: workerTask.runtimeEnvironmentId,
        status: attemptStatus,
        error: error ? sanitizeError(error) : undefined,
      },
    });
  }
}
