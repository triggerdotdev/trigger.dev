import { CoordinatorToPlatformMessages } from "@trigger.dev/core/v3";
import type { InferSocketMessageSchema } from "@trigger.dev/core/v3/zodSocket";
import type { Checkpoint, CheckpointRestoreEvent } from "@trigger.dev/database";
import { logger } from "~/services/logger.server";
import { marqs } from "~/v3/marqs/index.server";
import { generateFriendlyId } from "../friendlyIdentifiers";
import { isFreezableAttemptStatus, isFreezableRunStatus } from "../taskStatus";
import { BaseService } from "./baseService.server";
import { CreateCheckpointRestoreEventService } from "./createCheckpointRestoreEvent.server";
import { ResumeBatchRunService } from "./resumeBatchRun.server";
import { ResumeDependentParentsService } from "./resumeDependentParents.server";

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
        taskRun: {
          include: {
            childRuns: {
              orderBy: {
                createdAt: "asc",
              },
              take: 1,
            },
          },
        },
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
      logger.error("Attempt not found", params);

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
        params,
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
        params,
      });

      return {
        success: false,
      };
    }

    const { reason } = params;

    switch (reason.type) {
      case "WAIT_FOR_TASK": {
        const lastChildRun = attempt.taskRun.childRuns[0];

        if (!lastChildRun) {
          logger.warn("CreateCheckpointService: No child runs, creating checkpoint regardless", {
            attemptId: attempt.id,
            runId: attempt.taskRunId,
            params,
          });

          break;
        }

        if (lastChildRun.friendlyId !== reason.friendlyId) {
          logger.error("CreateCheckpointService: Checkpoint not for most recent child run", {
            attemptId: attempt.id,
            runId: attempt.taskRunId,
            params,
          });

          return {
            success: false,
            keepRunAlive: true,
          };
        }

        break;
      }
      case "WAIT_FOR_BATCH": {
        break;
      }
      default: {
        break;
      }
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
            reason,
            params,
          });
          await marqs?.cancelHeartbeat(attempt.taskRunId);

          const childRun = await this._prisma.taskRun.findFirst({
            where: {
              friendlyId: reason.friendlyId,
            },
          });

          if (!childRun) {
            logger.error("CreateCheckpointService: WAIT_FOR_TASK child run not found", {
              friendlyId: reason.friendlyId,
              params,
            });

            return {
              success: true,
              checkpoint,
              event: checkpointEvent,
              keepRunAlive: false,
            };
          }

          const resumeService = new ResumeDependentParentsService(this._prisma);
          const result = await resumeService.call({ id: childRun.id });

          if (result.success) {
            logger.log("CreateCheckpointService: Resumed dependent parents", {
              result,
              childRun,
              attempt,
              checkpointEvent,
              params,
            });
          } else {
            logger.error("CreateCheckpointService: Failed to resume dependent parents", {
              result,
              childRun,
              attempt,
              checkpointEvent,
              params,
            });
          }

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
            params,
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
              params,
            });

            return {
              success: true,
              checkpoint,
              event: checkpointEvent,
              keepRunAlive: false,
            };
          }

          //if there's a message in the queue, we make sure the checkpoint event is on it
          await marqs?.replaceMessage(
            attempt.taskRun.id,
            {
              checkpointEventId: checkpointEvent.id,
            },
            undefined,
            true
          );

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
        params,
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
