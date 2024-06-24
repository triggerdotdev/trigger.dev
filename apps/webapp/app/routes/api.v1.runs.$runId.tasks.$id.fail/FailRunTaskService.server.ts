import { FailTaskBodyInput, ServerTask } from "@trigger.dev/core";
import { PrismaClient } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { taskWithAttemptsToServerTask } from "~/models/task.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { formatError } from "~/utils/formatErrors.server";

export class FailRunTaskService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    environment: AuthenticatedEnvironment,
    runId: string,
    id: string,
    taskBody: FailTaskBodyInput
  ): Promise<ServerTask | undefined> {
    // Using a transaction, we'll first check to see if the task already exists and return if if it does
    // If it doesn't exist, we'll create it and return it
    const task = await this.#prismaClient.$transaction(async (tx) => {
      const existingTask = await tx.task.findUnique({
        where: {
          id,
        },
        include: {
          run: true,
          attempts: {
            where: {
              status: "PENDING",
            },
            orderBy: {
              number: "desc",
            },
            take: 1,
          },
        },
      });

      if (!existingTask) {
        return;
      }

      if (existingTask.runId !== runId) {
        return;
      }

      if (existingTask.run.environmentId !== environment.id) {
        return;
      }

      if (
        existingTask.status === "COMPLETED" ||
        existingTask.status === "ERRORED" ||
        existingTask.status === "CANCELED"
      ) {
        return existingTask;
      }

      if (existingTask.attempts.length === 1) {
        await tx.taskAttempt.update({
          where: {
            id: existingTask.attempts[0].id,
          },
          data: {
            status: "ERRORED",
            error: formatError(taskBody.error),
          },
        });
      }

      return await tx.task.update({
        where: {
          id,
        },
        data: {
          status: "ERRORED",
          output: taskBody.error ?? undefined,
          completedAt: new Date(),
        },
        include: {
          attempts: true,
          run: true,
        },
      });
    });

    return task ? taskWithAttemptsToServerTask(task) : undefined;
  }
}
