import { CoordinatorToPlatformMessages } from "@trigger.dev/core/v3";
import type { InferSocketMessageSchema } from "@trigger.dev/core/v3/zodSocket";
import type { Checkpoint, CheckpointRestoreEvent } from "@trigger.dev/database";
import { logger } from "~/services/logger.server";
import { generateFriendlyId } from "../friendlyIdentifiers";
import { marqs } from "~/v3/marqs/index.server";
import { CreateCheckpointRestoreEventService } from "./createCheckpointRestoreEvent.server";
import { BaseService } from "./baseService.server";
import { isFinalRunStatus, isFreezableAttemptStatus, isFreezableRunStatus } from "../taskStatus";
import { ResumeBatchRunService } from "./resumeBatchRun.server";
import { ResumeTaskRunDependenciesService } from "./resumeTaskRunDependencies.server";
import { ResumeTaskDependencyService } from "./resumeTaskDependency.server";

export class CreateCheckpointService extends BaseService {
  public async call(
    params: Omit<
      InferSocketMessageSchema<typeof CoordinatorToPlatformMessages, "CHECKPOINT_CREATED">,
      "version"
    >
  ): Promise<
    | {
        success: true;
        checkpoint: Checkpoint;
        event: CheckpointRestoreEvent;
        keepRunAlive: boolean;
      }
    | {
        success: false;
        keepRunAlive?: boolean;
      }
  > {
    logger.debug(`Creating checkpoint`, params);

    const attempt = await this._prisma.taskRunAttempt.findUnique({
      where: {
        friendlyId: params.attemptFriendlyId,
      },
      include: {
        taskRun: true,
        backgroundWorker: {
          select: {
            id: true,
            deployment: {
              select: {
                imageReference: true,
              },
            },
          },
        },
      },
    });

    if (!attempt) {
      logger.error("Attempt not found", { attemptFriendlyId: params.attemptFriendlyId });

      return {
        success: false,
      };
    }

    if (
      !isFreezableAttemptStatus(attempt.status) ||
      !isFreezableRunStatus(attempt.taskRun.status)
    ) {
      logger.error("Unfreezable state", {
        attempt: {
          id: attempt.id,
          status: attempt.status,
        },
        run: {
          id: attempt.taskRunId,
          status: attempt.taskRun.status,
        },
      });

      return {
        success: false,
        keepRunAlive: true,
      };
    }

    const imageRef = attempt.backgroundWorker.deployment?.imageReference;

    if (!imageRef) {
      logger.error("Missing deployment or image ref", {
        attemptId: attempt.id,
        workerId: attempt.backgroundWorker.id,
      });

      return {
        success: false,
      };
    }

    //sleep to test slow checkpoints
    await new Promise((resolve) => setTimeout(resolve, 10_000));

    const checkpoint = await this._prisma.checkpoint.create({
      data: {
        friendlyId: generateFriendlyId("checkpoint"),
        runtimeEnvironmentId: attempt.taskRun.runtimeEnvironmentId,
        projectId: attempt.taskRun.projectId,
        attemptId: attempt.id,
        attemptNumber: attempt.number,
        runId: attempt.taskRunId,
        location: params.location,
        type: params.docker ? "DOCKER" : "KUBERNETES",
        reason: params.reason.type,
        metadata: JSON.stringify(params.reason),
        imageRef,
      },
    });

    const eventService = new CreateCheckpointRestoreEventService(this._prisma);

    await this._prisma.taskRunAttempt.update({
      where: {
        id: attempt.id,
      },
      data: {
        status: params.reason.type === "RETRYING_AFTER_FAILURE" ? undefined : "PAUSED",
        taskRun: {
          update: {
            status: "WAITING_TO_RESUME",
          },
        },
      },
    });

    const { reason } = params;

    let checkpointEvent: CheckpointRestoreEvent | undefined;
    let keepRunAlive = false;

    switch (reason.type) {
      case "WAIT_FOR_DURATION": {
        checkpointEvent = await eventService.checkpoint({
          checkpointId: checkpoint.id,
        });

        break;
      }
      case "WAIT_FOR_TASK": {
        checkpointEvent = await eventService.checkpoint({
          checkpointId: checkpoint.id,
          dependencyFriendlyRunId: reason.friendlyId,
        });

        if (checkpointEvent) {
          const dependency = await this._prisma.taskRunDependency.findFirst({
            select: {
              id: true,
              dependentAttempt: {
                select: {
                  id: true,
                },
              },
            },
            where: {
              taskRun: {
                friendlyId: reason.friendlyId,
              },
            },
          });

          logger.log("Created checkpoint WAIT_FOR_TASK", {
            checkpointId: checkpoint.id,
            runFriendlyId: reason.friendlyId,
            dependencyId: dependency?.id,
            dependentAttemptId: dependency?.dependentAttempt?.id,
          });

          if (!dependency) {
            logger.error("Dependency not found", { friendlyId: reason.friendlyId });
            await marqs?.acknowledgeMessage(attempt.taskRunId);

            return {
              success: false,
            };
          }

          if (!dependency.dependentAttempt) {
            logger.error("Dependent attempt not found", { dependencyId: dependency.id });
            await marqs?.acknowledgeMessage(attempt.taskRunId);

            return {
              success: false,
            };
          }

          await ResumeTaskDependencyService.enqueue(
            dependency.id,
            dependency.dependentAttempt.id,
            this._prisma
          );

          return {
            success: true,
            checkpoint,
            event: checkpointEvent,
            keepRunAlive: false,
          };
        }

        break;
      }
      case "WAIT_FOR_BATCH": {
        checkpointEvent = await eventService.checkpoint({
          checkpointId: checkpoint.id,
          batchDependencyFriendlyId: reason.batchFriendlyId,
        });

        if (checkpointEvent) {
          const batchRun = await this._prisma.batchTaskRun.findFirst({
            select: {
              id: true,
            },
            where: {
              friendlyId: reason.batchFriendlyId,
            },
          });

          if (!batchRun) {
            logger.error("Batch not found", { friendlyId: reason.batchFriendlyId });
            await marqs?.acknowledgeMessage(attempt.taskRunId);

            return {
              success: false,
            };
          }

          await ResumeBatchRunService.enqueue(batchRun.id, this._prisma);

          return {
            success: true,
            checkpoint,
            event: checkpointEvent,
            keepRunAlive: false,
          };
        }

        break;
      }
      case "RETRYING_AFTER_FAILURE": {
        checkpointEvent = await eventService.checkpoint({
          checkpointId: checkpoint.id,
        });

        // ACK is already handled by attempt completion
        break;
      }
      default: {
        break;
      }
    }

    if (!checkpointEvent) {
      logger.error("No checkpoint event", {
        attemptId: attempt.id,
        checkpointId: checkpoint.id,
      });
      await marqs?.acknowledgeMessage(attempt.taskRunId);

      return {
        success: false,
      };
    }

    if (reason.type === "WAIT_FOR_DURATION") {
      await marqs?.replaceMessage(
        attempt.taskRunId,
        {
          type: "RESUME_AFTER_DURATION",
          resumableAttemptId: attempt.id,
          checkpointEventId: checkpointEvent.id,
        },
        reason.now + reason.ms
      );
    }

    return {
      success: true,
      checkpoint,
      event: checkpointEvent,
      keepRunAlive,
    };
  }

  async #isBatchCompleted(friendlyId: string): Promise<boolean> {
    const batch = await this._prisma.batchTaskRun.findUnique({
      where: {
        friendlyId,
      },
    });

    if (!batch) {
      logger.error("Batch not found", { friendlyId });
      return false;
    }

    return batch.status === "COMPLETED";
  }

  async #isRunCompleted(friendlyId: string): Promise<boolean> {
    const run = await this._prisma.taskRun.findUnique({
      where: {
        friendlyId,
      },
    });

    if (!run) {
      logger.error("Run not found", { friendlyId });
      return false;
    }

    return isFinalRunStatus(run.status);
  }
}
