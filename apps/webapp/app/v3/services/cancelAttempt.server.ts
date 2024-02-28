import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { eventRepository } from "../eventRepository.server";
import { marqs } from "../marqs.server";
import { BaseService } from "./baseService.server";
import { logger } from "~/services/logger.server";

export class CancelAttemptService extends BaseService {
  public async call(
    attemptId: string,
    taskRunId: string,
    cancelledAt: Date,
    reason: string,
    environment: AuthenticatedEnvironment
  ) {
    return await this.traceWithEnv("call()", environment, async (span) => {
      span.setAttribute("taskRunId", taskRunId);
      span.setAttribute("attemptId", attemptId);

      const taskRunAttempt = await this._prisma.taskRunAttempt.findUnique({
        where: {
          friendlyId: attemptId,
        },
        include: {
          taskRun: true,
        },
      });

      if (!taskRunAttempt) {
        return;
      }

      await marqs?.acknowledgeMessage(taskRunId);

      await this._prisma.taskRunAttempt.update({
        where: {
          friendlyId: attemptId,
        },
        data: {
          status: "CANCELED",
        },
      });

      const inProgressEvents = await eventRepository.queryIncompleteEvents({
        runId: taskRunAttempt.taskRun.friendlyId,
      });

      logger.debug("Cancelling in-progress events", {
        inProgressEvents: inProgressEvents.map((event) => event.id),
      });

      await Promise.all(
        inProgressEvents.map((event) => {
          return eventRepository.cancelEvent(event, cancelledAt, reason);
        })
      );
    });
  }
}
