import { logger } from "~/services/logger.server";
import { marqs } from "~/v3/marqs/index.server";

import assertNever from "assert-never";
import { FailedTaskRunService } from "./failedTaskRun.server";
import { BaseService } from "./services/baseService.server";
import { PrismaClientOrTransaction } from "~/db.server";
import { workerQueue } from "~/services/worker.server";

export class RequeueTaskRunService extends BaseService {
  public async call(runId: string) {
    const taskRun = await this._prisma.taskRun.findUnique({
      where: { id: runId },
    });

    if (!taskRun) {
      logger.error("[RequeueTaskRunService] Task run not found", {
        runId,
      });

      return;
    }

    switch (taskRun.status) {
      case "PENDING": {
        logger.debug("[RequeueTaskRunService] Requeueing task run", { taskRun });

        await marqs?.nackMessage(taskRun.id);

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
            code: "TASK_RUN_HEARTBEAT_TIMEOUT",
            message: "Did not receive a heartbeat from the worker in time",
          },
        });

        break;
      }
      case "DELAYED":
      case "WAITING_FOR_DEPLOY": {
        logger.debug("[RequeueTaskRunService] Removing task run from queue", { taskRun });

        await marqs?.acknowledgeMessage(taskRun.id);

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

        await marqs?.acknowledgeMessage(taskRun.id);

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
