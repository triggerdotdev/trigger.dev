import type { CompleteTaskBodyOutput, ServerTask } from "@trigger.dev/core";
import { PrismaClientOrTransaction, prisma } from "~/db.server";
import { taskWithAttemptsToServerTask } from "~/models/task.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";

export class CompleteRunTaskService {
  #prismaClient: PrismaClientOrTransaction;

  constructor(prismaClient: PrismaClientOrTransaction = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    environment: AuthenticatedEnvironment,
    runId: string,
    id: string,
    taskBody: CompleteTaskBodyOutput
  ): Promise<ServerTask | undefined> {
    const existingTask = await this.#prismaClient.task.findUnique({
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
      logger.debug("Task already completed", {
        existingTask,
      });

      return taskWithAttemptsToServerTask(existingTask);
    }

    if (existingTask.attempts.length === 1) {
      await this.#prismaClient.taskAttempt.update({
        where: {
          id: existingTask.attempts[0].id,
        },
        data: {
          status: "COMPLETED",
        },
      });
    }

    const updatedTask = await this.#prismaClient.task.update({
      where: {
        id,
      },
      data: {
        status: "COMPLETED",
        output: taskBody.output as any,
        outputIsUndefined: typeof taskBody.output === "undefined",
        completedAt: new Date(),
        outputProperties: taskBody.properties,
      },
      include: {
        attempts: true,
        run: true,
      },
    });

    return taskWithAttemptsToServerTask(updatedTask);
  }
}
