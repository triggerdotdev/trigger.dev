import { TaskRunFailedExecutionResult } from "@trigger.dev/core/v3";
import { logger } from "~/services/logger.server";
import { marqsv3 } from "~/v3/marqs/v3.server";

import { TaskRunStatus } from "@trigger.dev/database";
import { createExceptionPropertiesFromError, eventRepository } from "./eventRepository.server";
import { BaseService } from "./services/baseService.server";

const FAILABLE_TASK_RUN_STATUSES: TaskRunStatus[] = ["EXECUTING", "PENDING", "WAITING_FOR_DEPLOY"];

export class FailedTaskRunService extends BaseService {
  public async call(runFriendlyId: string, completion: TaskRunFailedExecutionResult) {
    const taskRun = await this._prisma.taskRun.findUnique({
      where: { friendlyId: runFriendlyId },
    });

    if (!taskRun) {
      logger.error("[FailedTaskRunService] Task run not found", {
        runFriendlyId,
        completion,
      });

      return;
    }

    if (!FAILABLE_TASK_RUN_STATUSES.includes(taskRun.status)) {
      logger.error("[FailedTaskRunService] Task run is not in a failable state", {
        taskRun,
        completion,
      });

      return;
    }

    // No more retries, we need to fail the task run
    logger.debug("[FailedTaskRunService] Failing task run", { taskRun, completion });

    await marqsv3?.acknowledgeMessage(taskRun.id);

    // Now we need to "complete" the task run event/span
    await eventRepository.completeEvent(taskRun.spanId, {
      endTime: new Date(),
      attributes: {
        isError: true,
      },
      events: [
        {
          name: "exception",
          time: new Date(),
          properties: {
            exception: createExceptionPropertiesFromError(completion.error),
          },
        },
      ],
    });

    await this._prisma.taskRun.update({
      where: {
        id: taskRun.id,
      },
      data: {
        status: "SYSTEM_FAILURE",
      },
    });
  }
}
