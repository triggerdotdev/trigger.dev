import { CoordinatorToPlatformMessages } from "@trigger.dev/core/v3";
import type { InferSocketMessageSchema } from "@trigger.dev/core/v3/zodSocket";
import type { Checkpoint, CheckpointRestoreEvent } from "@trigger.dev/database";
import { logger } from "~/services/logger.server";
import { marqs } from "~/v3/marqs/index.server";
import { generateFriendlyId } from "../friendlyIdentifiers";
import {
  isFinalAttemptStatus,
  isFinalRunStatus,
  isFreezableAttemptStatus,
  isFreezableRunStatus,
} from "../taskStatus";
import { BaseService } from "./baseService.server";
import { CreateCheckpointRestoreEventService } from "./createCheckpointRestoreEvent.server";
import { ResumeBatchRunService } from "./resumeBatchRun.server";
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
    // await new Promise((resolve) => setTimeout(resolve, 60_000));

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

    switch (reason.type) {
      case "WAIT_FOR_DURATION": {
        checkpointEvent = await eventService.checkpoint({
          checkpointId: checkpoint.id,
        });

        if (checkpointEvent) {
          await marqs?.replaceMessage(
            attempt.taskRunId,
            {
              type: "RESUME_AFTER_DURATION",
              resumableAttemptId: attempt.id,
              checkpointEventId: checkpointEvent.id,
            },
            reason.now + reason.ms
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
      case "WAIT_FOR_TASK": {
        checkpointEvent = await eventService.checkpoint({
          checkpointId: checkpoint.id,
          dependencyFriendlyRunId: reason.friendlyId,
        });

        if (checkpointEvent) {
          //heartbeats will start again when the run resumes
          logger.log("CreateCheckpointService: Canceling heartbeat", {
            attemptId: attempt.id,
            taskRunId: attempt.taskRunId,
            type: "WAIT_FOR_TASK",
          });
          await marqs?.cancelHeartbeat(attempt.taskRunId);

          const dependency = await this._prisma.taskRunDependency.findFirst({
            select: {
              id: true,
              taskRunId: true,
            },
            where: {
              taskRun: {
                friendlyId: reason.friendlyId,
              },
            },
          });

          logger.log("CreateCheckpointService: Created checkpoint WAIT_FOR_TASK", {
            checkpointId: checkpoint.id,
            runFriendlyId: reason.friendlyId,
            dependencyId: dependency?.id,
          });

          if (!dependency) {
            logger.error("CreateCheckpointService: Dependency not found", {
              friendlyId: reason.friendlyId,
            });

            return {
              success: true,
              checkpoint,
              event: checkpointEvent,
              keepRunAlive: false,
            };
          }

          const childRun = await this._prisma.taskRun.findFirst({
            select: {
              id: true,
              status: true,
            },
            where: {
              id: dependency.taskRunId,
            },
          });

          if (!childRun) {
            logger.error("CreateCheckpointService: Dependency child run not found", {
              taskRunId: dependency.taskRunId,
              runFriendlyId: reason.friendlyId,
              dependencyId: dependency.id,
            });

            return {
              success: true,
              checkpoint,
              event: checkpointEvent,
              keepRunAlive: false,
            };
          }

          const isFinished = isFinalRunStatus(childRun.status);
          if (!isFinished) {
            logger.debug("CreateCheckpointService: Dependency child run not finished", {
              taskRunId: dependency.taskRunId,
              runFriendlyId: reason.friendlyId,
              dependencyId: dependency.id,
              childRunStatus: childRun.status,
              childRunId: childRun.id,
            });

            return {
              success: true,
              checkpoint,
              event: checkpointEvent,
              keepRunAlive: false,
            };
          }

          const lastAttempt = await this._prisma.taskRunAttempt.findFirst({
            select: {
              id: true,
              status: true,
            },
            where: {
              taskRunId: dependency.taskRunId,
            },
            orderBy: {
              createdAt: "desc",
            },
          });

          if (!lastAttempt) {
            logger.debug("CreateCheckpointService: Dependency child attempt not found", {
              taskRunId: dependency.taskRunId,
              runFriendlyId: reason.friendlyId,
              dependencyId: dependency?.id,
            });
            return {
              success: true,
              checkpoint,
              event: checkpointEvent,
              keepRunAlive: false,
            };
          }

          if (!isFinalAttemptStatus(lastAttempt.status)) {
            logger.debug("CreateCheckpointService: Dependency child attempt not final", {
              taskRunId: dependency.taskRunId,
              runFriendlyId: reason.friendlyId,
              dependencyId: dependency.id,
              lastAttemptId: lastAttempt.id,
              lastAttemptStatus: lastAttempt.status,
            });

            return {
              success: true,
              checkpoint,
              event: checkpointEvent,
              keepRunAlive: false,
            };
          }

          //resume the dependent task
          await ResumeTaskDependencyService.enqueue(dependency.id, lastAttempt.id, this._prisma);

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
          //heartbeats will start again when the run resumes
          logger.log("CreateCheckpointService: Canceling heartbeat", {
            attemptId: attempt.id,
            taskRunId: attempt.taskRunId,
            type: "WAIT_FOR_BATCH",
          });
          await marqs?.cancelHeartbeat(attempt.taskRunId);

          const batchRun = await this._prisma.batchTaskRun.findFirst({
            select: {
              id: true,
            },
            where: {
              friendlyId: reason.batchFriendlyId,
            },
          });

          if (!batchRun) {
            logger.error("CreateCheckpointService: Batch not found", {
              friendlyId: reason.batchFriendlyId,
            });

            return {
              success: true,
              checkpoint,
              event: checkpointEvent,
              keepRunAlive: false,
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

    return {
      success: true,
      checkpoint,
      event: checkpointEvent,
      keepRunAlive: false,
    };
  }
}
