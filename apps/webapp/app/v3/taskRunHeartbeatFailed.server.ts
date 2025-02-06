import { logger } from "~/services/logger.server";
import { marqs } from "~/v3/marqs/index.server";

import assertNever from "assert-never";
import { FailedTaskRunService } from "./failedTaskRun.server";
import { BaseService } from "./services/baseService.server";
import { PrismaClientOrTransaction } from "~/db.server";
import { workerQueue } from "~/services/worker.server";
import { socketIo } from "./handleSocketIo.server";
import { TaskRunErrorCodes } from "@trigger.dev/core/v3";

export class TaskRunHeartbeatFailedService extends BaseService {
  public async call(runId: string) {
    const taskRun = await this._prisma.taskRun.findFirst({
      where: {
        id: runId,
      },
      select: {
        id: true,
        friendlyId: true,
        status: true,
        lockedAt: true,
        runtimeEnvironment: {
          select: {
            type: true,
          },
        },
        lockedToVersion: {
          select: {
            supportsLazyAttempts: true,
          },
        },
      },
    });

    if (!taskRun) {
      logger.error("[RequeueTaskRunService] Task run not found", {
        runId,
      });

      return;
    }

    switch (taskRun.status) {
      case "PENDING": {
        if (taskRun.lockedAt) {
          logger.debug(
            "[RequeueTaskRunService] Failing task run because the heartbeat failed and it's PENDING but locked",
            { taskRun }
          );

          const service = new FailedTaskRunService();

          await service.call(taskRun.friendlyId, {
            ok: false,
            id: taskRun.friendlyId,
            retry: undefined,
            error: {
              type: "INTERNAL_ERROR",
              code: TaskRunErrorCodes.TASK_RUN_HEARTBEAT_TIMEOUT,
              message: "Did not receive a heartbeat from the worker in time",
            },
          });
        } else {
          logger.debug("[RequeueTaskRunService] Nacking task run", { taskRun });

          await marqs?.nackMessage(taskRun.id);
        }

        break;
      }
      case "EXECUTING":
      case "RETRYING_AFTER_FAILURE": {
        logger.debug("[RequeueTaskRunService] Failing task run", { taskRun });

        const service = new FailedTaskRunService();

        await service.call(taskRun.friendlyId, {
          ok: false,
          id: taskRun.friendlyId,
          retry: undefined,
          error: {
            type: "INTERNAL_ERROR",
            code: TaskRunErrorCodes.TASK_RUN_HEARTBEAT_TIMEOUT,
            message: "Did not receive a heartbeat from the worker in time",
          },
        });

        break;
      }
      case "DELAYED":
      case "WAITING_FOR_DEPLOY": {
        logger.debug("[RequeueTaskRunService] Removing task run from queue", { taskRun });

        await marqs?.acknowledgeMessage(
          taskRun.id,
          "Run is either DELAYED or WAITING_FOR_DEPLOY so we cannot requeue it in RequeueTaskRunService"
        );

        break;
      }
      case "WAITING_TO_RESUME":
      case "PAUSED": {
        logger.debug("[RequeueTaskRunService] Requeueing task run", { taskRun });

        await marqs?.nackMessage(taskRun.id);

        break;
      }
      case "SYSTEM_FAILURE":
      case "INTERRUPTED":
      case "CRASHED":
      case "COMPLETED_WITH_ERRORS":
      case "COMPLETED_SUCCESSFULLY":
      case "EXPIRED":
      case "TIMED_OUT":
      case "CANCELED": {
        logger.debug("[RequeueTaskRunService] Task run is completed", { taskRun });

        await marqs?.acknowledgeMessage(
          taskRun.id,
          "Task run is already completed in RequeueTaskRunService"
        );

        try {
          if (taskRun.runtimeEnvironment.type === "DEVELOPMENT") {
            return;
          }

          // Signal to exit any leftover containers
          socketIo.coordinatorNamespace.emit("REQUEST_RUN_CANCELLATION", {
            version: "v1",
            runId: taskRun.id,
            // Give the run a few seconds to exit to complete any flushing etc
            delayInMs: taskRun.lockedToVersion?.supportsLazyAttempts ? 5_000 : undefined,
          });
        } catch (error) {
          logger.error("[RequeueTaskRunService] Error signaling run cancellation", {
            runId: taskRun.id,
            error: error instanceof Error ? error.message : error,
          });
        }

        break;
      }
      default: {
        assertNever(taskRun.status);
      }
    }
  }

  public static async enqueue(runId: string, runAt?: Date, tx?: PrismaClientOrTransaction) {
    return await workerQueue.enqueue(
      "v3.requeueTaskRun",
      { runId },
      { runAt, jobKey: `requeueTaskRun:${runId}` }
    );
  }

  public static async dequeue(runId: string, tx?: PrismaClientOrTransaction) {
    return await workerQueue.dequeue(`requeueTaskRun:${runId}`, { tx });
  }
}
