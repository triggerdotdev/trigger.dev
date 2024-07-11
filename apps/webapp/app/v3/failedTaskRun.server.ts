import { TaskRunFailedExecutionResult } from "@trigger.dev/core/v3";
import { logger } from "~/services/logger.server";
import { marqs } from "~/v3/marqs/index.server";

import { TaskRunStatus } from "@trigger.dev/database";
import { createExceptionPropertiesFromError, eventRepository } from "./eventRepository.server";
import { BaseService } from "./services/baseService.server";

const FAILABLE_TASK_RUN_STATUSES: TaskRunStatus[] = ["EXECUTING", "PENDING", "WAITING_FOR_DEPLOY"];

export class FailedTaskRunService extends BaseService {
  public async call(anyRunId: string, completion: TaskRunFailedExecutionResult) {
    const isFriendlyId = anyRunId.startsWith("run_");

    const taskRun = await this._prisma.taskRun.findUnique({
      where: {
        friendlyId: isFriendlyId ? anyRunId : undefined,
        id: !isFriendlyId ? anyRunId : undefined,
      },
    });

    if (!taskRun) {
      logger.error("[FailedTaskRunService] Task run not found", {
        anyRunId,
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

    await marqs?.acknowledgeMessage(taskRun.id);

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
