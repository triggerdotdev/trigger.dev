import {
  ExceptionEventProperties,
  TaskRunError,
  TaskRunFailedExecutionResult,
} from "@trigger.dev/core/v3";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { marqs } from "~/v3/marqs/index.server";

import { eventRepository } from "./eventRepository.server";
import { BaseService } from "./services/baseService.server";
import { TaskRunStatus } from "@trigger.dev/database";

const FAILABLE_TASK_RUN_STATUSES: TaskRunStatus[] = ["EXECUTING", "PENDING", "WAITING_FOR_DEPLOY"];

export class FailedTaskRunService extends BaseService {
  public async call({
    runFriendlyId,
    completion,
    env,
  }: {
    runFriendlyId: string;
    completion: TaskRunFailedExecutionResult;
    env: AuthenticatedEnvironment;
  }) {
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

function createExceptionPropertiesFromError(error: TaskRunError): ExceptionEventProperties {
  switch (error.type) {
    case "BUILT_IN_ERROR": {
      return {
        type: error.name,
        message: error.message,
        stacktrace: error.stackTrace,
      };
    }
    case "CUSTOM_ERROR": {
      return {
        type: "Error",
        message: error.raw,
      };
    }
    case "INTERNAL_ERROR": {
      return {
        type: "Internal error",
        message: [error.code, error.message].filter(Boolean).join(": "),
      };
    }
    case "STRING_ERROR": {
      return {
        type: "Error",
        message: error.raw,
      };
    }
  }
}
