import { sanitizeError, TaskRunFailedExecutionResult } from "@trigger.dev/core/v3";
import { logger } from "~/services/logger.server";
import { createExceptionPropertiesFromError, eventRepository } from "./eventRepository.server";
import { BaseService } from "./services/baseService.server";
import { FinalizeTaskRunService } from "./services/finalizeTaskRun.server";
import { FAILABLE_RUN_STATUSES } from "./taskStatus";

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

    if (!FAILABLE_RUN_STATUSES.includes(taskRun.status)) {
      logger.error("[FailedTaskRunService] Task run is not in a failable state", {
        taskRun,
        completion,
      });

      return;
    }

    // No more retries, we need to fail the task run
    logger.debug("[FailedTaskRunService] Failing task run", { taskRun, completion });

    const finalizeService = new FinalizeTaskRunService();
    await finalizeService.call({
      id: taskRun.id,
      status: "SYSTEM_FAILURE",
      completedAt: new Date(),
    });

    // Get the final attempt and add the error to it, if it's not already set
    const finalAttempt = await this._prisma.taskRunAttempt.findFirst({
      where: {
        taskRunId: taskRun.id,
      },
      orderBy: { id: "desc" },
    });

    if (finalAttempt && !finalAttempt.error) {
      // Haven't set the status because the attempt might still be running
      await this._prisma.taskRunAttempt.update({
        where: { id: finalAttempt.id },
        data: {
          error: sanitizeError(completion.error),
        },
      });
    }

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
  }
}
