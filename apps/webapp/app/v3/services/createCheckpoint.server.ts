import type { CoordinatorToPlatformMessages, ManualCheckpointMetadata } from "@trigger.dev/core/v3";
import type { InferSocketMessageSchema } from "@trigger.dev/core/v3/zodSocket";
import type { Checkpoint, CheckpointRestoreEvent } from "@trigger.dev/database";
import { runOpsLegacyPrisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { marqs } from "~/v3/marqs/index.server";
import { isFreezableAttemptStatus, isFreezableRunStatus } from "../taskStatus";
import { BaseService } from "./baseService.server";
import { CreateCheckpointRestoreEventService } from "./createCheckpointRestoreEvent.server";
import { ResumeBatchRunService } from "./resumeBatchRun.server";
import { ResumeDependentParentsService } from "./resumeDependentParents.server";
import { CheckpointId } from "@trigger.dev/core/v3/isomorphic";

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

    // The attempt + its run live on the run-graph DB (routed by the store); the attempt's
    // backgroundWorker/deployment are control-plane rows, so they are resolved separately below
    // rather than joined across the seam. Read the primary for read-your-writes.
    const attempt = await this.runStore.findTaskRunAttempt(
      {
        where: {
          friendlyId: params.attemptFriendlyId,
        },
        include: {
          taskRun: true,
        },
      },
      this._prisma
    );

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

    // backgroundWorker + deployment are control-plane rows; resolve them off the seam.
    const backgroundWorker = await this._prisma.backgroundWorker.findFirst({
      where: {
        id: attempt.backgroundWorkerId,
      },
      select: {
        id: true,
        deployment: {
          select: {
            imageReference: true,
          },
        },
      },
    });

    const imageRef = backgroundWorker?.deployment?.imageReference;

    if (!imageRef) {
      logger.error("Missing deployment or image ref", {
        attemptId: attempt.id,
        workerId: backgroundWorker?.id,
        params,
      });

      return {
        success: false,
      };
    }

    const { reason } = params;

    // Check if we should accept this checkpoint
    switch (reason.type) {
      case "MANUAL": {
        // Always accept manual checkpoints
        break;
      }
      case "WAIT_FOR_DURATION": {
        // Always accept duration checkpoints
        break;
      }
      case "WAIT_FOR_TASK": {
        // Routed by friendlyId; read the primary for read-your-writes so a just-resumed
        // dependency isn't seen as still pending due to replica lag.
        const childRun = await this.runStore.findRun(
          {
            friendlyId: reason.friendlyId,
          },
          {
            select: {
              dependency: {
                select: {
                  resumedAt: true,
                },
              },
            },
          },
          this._prisma
        );

        if (!childRun) {
          logger.error("CreateCheckpointService: Pre-check - WAIT_FOR_TASK child run not found", {
            friendlyId: reason.friendlyId,
            params,
          });

          return {
            success: false,
            keepRunAlive: false,
          };
        }

        if (childRun.dependency?.resumedAt) {
          logger.info("CreateCheckpointService: Child run already resumed", {
            childRun,
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
        // Routed by friendlyId so a run-ops id (NEW-resident) batch is found on the owning DB;
        // env-scoped to the dependent attempt's run (a batch shares its dependent's env). Read the
        // primary: a batch that just resumed the parent may lag the replica, and a stale resumedAt
        // (null) would checkpoint (suspend) an already-resumed run -> it stalls until a sweep.
        const batchRun = await this.runStore.findBatchTaskRunByFriendlyId(
          reason.batchFriendlyId,
          attempt.taskRun.runtimeEnvironmentId,
          undefined,
          this._prisma
        );

        if (!batchRun) {
          logger.error("CreateCheckpointService: Pre-check - Batch not found", {
            batchFriendlyId: reason.batchFriendlyId,
            params,
          });

          return {
            success: false,
            keepRunAlive: false,
          };
        }

        if (batchRun.resumedAt) {
          logger.info("CreateCheckpointService: Batch already resumed", {
            batchRun,
            params,
          });

          return {
            success: false,
            keepRunAlive: true,
          };
        }

        break;
      }
      default: {
        break;
      }
    }

    //sleep to test slow checkpoints
    // Sleep a random value between 4 and 30 seconds
    // await new Promise((resolve) => {
    //   const waitSeconds = Math.floor(Math.random() * 26) + 4;
    //   logger.log(`Sleep for ${waitSeconds} seconds`);
    //   setTimeout(resolve, waitSeconds * 1000);
    // });

    let metadata: string;

    if (params.reason.type === "MANUAL") {
      metadata = JSON.stringify({
        ...params.reason,
        attemptId: attempt.id,
        previousAttemptStatus: attempt.status,
        previousRunStatus: attempt.taskRun.status,
      } satisfies ManualCheckpointMetadata);
    } else {
      metadata = JSON.stringify(params.reason);
    }

    // Checkpoint is a V1-only run-graph model (never minted for run-ops/NEW runs), so the
    // owning run is always a cuid/legacy run — write it directly on the legacy client.
    const checkpoint = await runOpsLegacyPrisma.checkpoint.create({
      data: {
        ...CheckpointId.generate(),
        runtimeEnvironmentId: attempt.taskRun.runtimeEnvironmentId,
        projectId: attempt.taskRun.projectId,
        attemptId: attempt.id,
        attemptNumber: attempt.number,
        runId: attempt.taskRunId,
        location: params.location,
        type: params.docker ? "DOCKER" : "KUBERNETES",
        reason: params.reason.type,
        metadata,
        imageRef,
      },
    });

    const eventService = new CreateCheckpointRestoreEventService(this._prisma);

    // TaskRunAttempt is V1-only; the attempt and its nested run are co-resident cuid/legacy
    // rows, so this write (and the nested taskRun update) land together on the legacy client.
    await runOpsLegacyPrisma.taskRunAttempt.update({
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
      case "MANUAL":
      case "WAIT_FOR_DURATION": {
        let restoreAtUnixTimeMs: number;

        if (reason.type === "MANUAL") {
          // Restore immediately if not specified, useful for live migration
          restoreAtUnixTimeMs = reason.restoreAtUnixTimeMs ?? Date.now();
        } else {
          restoreAtUnixTimeMs = reason.now + reason.ms;
        }

        checkpointEvent = await eventService.checkpoint({
          checkpointId: checkpoint.id,
        });

        if (checkpointEvent) {
          await marqs.requeueMessage(
            attempt.taskRunId,
            {
              type: "RESUME_AFTER_DURATION",
              resumableAttemptId: attempt.id,
              checkpointEventId: checkpointEvent.id,
            },
            restoreAtUnixTimeMs,
            "resume"
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

          // Routed by friendlyId; read the primary for read-your-writes.
          const childRun = await this.runStore.findRun(
            {
              friendlyId: reason.friendlyId,
            },
            this._prisma
          );

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

          // Routed by friendlyId; read the primary (this._prisma) so a just-resumed batch that still
          // lags the replica doesn't leave a stale resumedAt and suspend an already-resumed run.
          const batchRun = await this.runStore.findBatchTaskRunByFriendlyId(
            reason.batchFriendlyId,
            attempt.taskRun.runtimeEnvironmentId,
            undefined,
            this._prisma
          );

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
          await marqs.replaceMessage(attempt.taskRun.id, {
            checkpointEventId: checkpointEvent.id,
          });

          await ResumeBatchRunService.enqueue(batchRun.id, batchRun.batchVersion === "v3");

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
      await marqs?.acknowledgeMessage(
        attempt.taskRunId,
        "No checkpoint event in CreateCheckpointService"
      );

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
