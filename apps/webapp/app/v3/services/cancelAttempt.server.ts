import { $transaction, type PrismaClientOrTransaction, prisma } from "~/db.server";
import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { eventRepository } from "../eventRepository.server";
import { isCancellableRunStatus } from "../taskStatus";
import { BaseService } from "./baseService.server";
import { FinalizeTaskRunService } from "./finalizeTaskRun.server";
import { getTaskEventStoreTableForRun } from "../taskEventStore.server";

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

      const taskRunAttempt = await this._prisma.taskRunAttempt.findFirst({
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

      await $transaction(this._prisma, "cancel attempt", async (tx) => {
        await tx.taskRunAttempt.update({
          where: {
            friendlyId: attemptId,
          },
          data: {
            status: "CANCELED",
            completedAt: cancelledAt,
          },
        });

        const isCancellable = isCancellableRunStatus(taskRunAttempt.taskRun.status);

        const finalizeService = new FinalizeTaskRunService(tx);
        await finalizeService.call({
          id: taskRunId,
          status: isCancellable ? "INTERRUPTED" : undefined,
          completedAt: isCancellable ? cancelledAt : undefined,
          attemptStatus: isCancellable ? "CANCELED" : undefined,
          error: isCancellable ? { type: "STRING_ERROR", raw: reason } : undefined,
        });
      });

      const inProgressEvents = await eventRepository.queryIncompleteEvents(
        getTaskEventStoreTableForRun(taskRunAttempt.taskRun),
        {
          runId: taskRunAttempt.taskRun.friendlyId,
        },
        taskRunAttempt.taskRun.createdAt,
        taskRunAttempt.taskRun.completedAt ?? undefined
      );

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

async function getAuthenticatedEnvironmentFromAttempt(
  friendlyId: string,
  prismaClient?: PrismaClientOrTransaction
) {
  const taskRunAttempt = await (prismaClient ?? prisma).taskRunAttempt.findFirst({
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
