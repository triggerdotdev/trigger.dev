import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { marqs } from "~/v3/marqs/index.server";
import { eventRepository } from "../eventRepository.server";
import { BaseService } from "./baseService.server";

import { PrismaClientOrTransaction, prisma } from "~/db.server";
import { isCancellableRunStatus } from "../taskStatus";
import { ResumeTaskRunDependenciesService } from "./resumeTaskRunDependencies.server";

export class CancelAttemptService extends BaseService {
  public async call(
    attemptId: string,
    taskRunId: string,
    cancelledAt: Date,
    reason: string,
    env?: AuthenticatedEnvironment
  ) {
    let environment: AuthenticatedEnvironment | undefined = env;

    if (!environment) {
      environment = await getAuthenticatedEnvironmentFromAttempt(attemptId);

      if (!environment) {
        return;
      }
    }

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

      if (taskRunAttempt.status === "CANCELED") {
        logger.warn("Task run attempt is already cancelled", {
          attemptId,
        });

        return;
      }

      /*
      "INTERRUPTED" (or leave it as is)
      
      Steps:
      1. marqs ack
      2. Updates the run *attempt* to canceled AND potentially the run to INTERRUPTED
      3. Cancels all incomplete OTEL events
      4. Enqueues resuming task run dependencies

      Inputs: 
      - taskRun: id, status, friendlyId
      - taskRunAttempt: friendlyId
      - cancelledAt
      - reason
      - Prisma client/transaction
      */

      await marqs?.acknowledgeMessage(taskRunId);

      await this._prisma.taskRunAttempt.update({
        where: {
          friendlyId: attemptId,
        },
        data: {
          status: "CANCELED",
          completedAt: cancelledAt,
          taskRun: {
            update: {
              data: {
                status: isCancellableRunStatus(taskRunAttempt.taskRun.status)
                  ? "INTERRUPTED"
                  : undefined,
                completedAt: isCancellableRunStatus(taskRunAttempt.taskRun.status)
                  ? cancelledAt
                  : undefined,
              },
            },
          },
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

      if (environment?.type !== "DEVELOPMENT") {
        await ResumeTaskRunDependenciesService.enqueue(taskRunAttempt.id, this._prisma);
      }
    });
  }
}

async function getAuthenticatedEnvironmentFromAttempt(
  friendlyId: string,
  prismaClient?: PrismaClientOrTransaction
) {
  const taskRunAttempt = await (prismaClient ?? prisma).taskRunAttempt.findUnique({
    where: {
      friendlyId,
    },
    include: {
      runtimeEnvironment: {
        include: {
          organization: true,
          project: true,
        },
      },
    },
  });

  if (!taskRunAttempt) {
    return;
  }

  return taskRunAttempt?.runtimeEnvironment;
}
