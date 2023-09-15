import { BackgroundFunctionTaskParamsSchema } from "@trigger.dev/core";
import { PrismaClient, RuntimeEnvironmentType, Task } from "@trigger.dev/database";
import { $transaction, prisma } from "~/db.server";
import { enqueueRunExecutionV2 } from "~/models/jobRunExecution.server";
import { KitchenSinkTask } from "~/models/task.server";
import { workerQueue } from "../worker.server";

export class InitializeBackgroundFunctionTaskService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(task: KitchenSinkTask) {
    const params = BackgroundFunctionTaskParamsSchema.safeParse(task.params);
    // We need to create a new background task operation

    if (!params.success) {
      await this.#resumeTaskWithError(task, params.error.message);
      return;
    }

    const backgroundFunction = await this.#prismaClient.backgroundFunction.findUnique({
      where: {
        projectId_slug: {
          projectId: task.run.projectId,
          slug: params.data.id,
        },
      },
      include: {
        versions: {
          where: {
            version: params.data.version,
          },
        },
      },
    });

    if (!backgroundFunction) {
      await this.#resumeTaskWithError(task, `Background function ${params.data.id} not found`);
      return;
    }

    const version = backgroundFunction.versions[0];

    if (!version) {
      await this.#resumeTaskWithError(
        task,
        `Background task ${params.data.id} version ${params.data.version} not found`
      );
      return;
    }

    await $transaction(this.#prismaClient, async (tx) => {
      const functionTask = await tx.backgroundFunctionTask.create({
        data: {
          backgroundFunctionId: backgroundFunction.id,
          backgroundFunctionVersionId: version.id,
          taskId: task.id,
          payload: params.data.payload,
        },
      });

      await workerQueue.enqueue(
        "executeBackgroundFunctionTask",
        {
          id: functionTask.id,
        },
        { tx }
      );

      return functionTask;
    });
  }

  async #resumeTaskWithError(task: KitchenSinkTask, message: string) {
    await $transaction(this.#prismaClient, async (tx) => {
      await tx.task.update({
        where: { id: task.id },
        data: {
          status: "ERRORED",
          completedAt: new Date(),
          output: { message },
        },
      });

      await tx.taskAttempt.updateMany({
        where: {
          taskId: task.id,
          status: "PENDING",
        },
        data: {
          status: "ERRORED",
          error: message,
        },
      });

      await enqueueRunExecutionV2(task.run, prisma, {
        skipRetrying: task.run.environment.type === RuntimeEnvironmentType.DEVELOPMENT,
      });
    });
  }
}
