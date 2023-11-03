import { PrismaClient, PrismaClientOrTransaction, prisma } from "~/db.server";
import { workerQueue } from "../worker.server";
import { enqueueRunExecutionV3 } from "~/models/jobRunExecution.server";
import { RuntimeEnvironmentType } from "@trigger.dev/database";
import { logger } from "../logger.server";

type FoundTask = Awaited<ReturnType<typeof findTask>>;

export class ResumeTaskService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string) {
    const task = await findTask(this.#prismaClient, id);

    if (!task) {
      return;
    }

    if (task.status === "COMPLETED" || task.status === "ERRORED") {
      return await this.#resumeRunExecution(task);
    }

    const updatedTask = await this.#prismaClient.task.update({
      where: {
        id: task.id,
      },
      data: {
        status: task.noop ? "COMPLETED" : "RUNNING",
        completedAt: task.noop ? new Date() : undefined,
      },
      include: {
        attempts: true,
        run: {
          include: {
            environment: true,
          },
        },
        parent: true,
      },
    });

    // This will retry the task if it's not a noop, or just resume
    // the run execution if it is a noop.
    return await this.#resumeRunExecution(updatedTask);
  }

  async #resumeRunExecution(task: NonNullable<FoundTask>) {
    logger.debug("ResumeTaskService.call resuming run execution", {
      parent: task.parent,
      taskId: task.id,
    });

    if (task.parent && task.parent.childExecutionMode === "PARALLEL") {
      const children = await this.#prismaClient.task.findMany({
        where: {
          parentId: task.parent.id,
        },
        select: {
          id: true,
          status: true,
        },
      });

      const allChildrenCompleted = children.every(
        (child) =>
          child.status === "COMPLETED" || child.status === "ERRORED" || child.status === "CANCELED"
      );

      logger.debug("ResumeTaskService.call parent executing children in parallel", {
        parentId: task.parent.id,
        allChildrenCompleted,
        children,
      });

      if (!allChildrenCompleted) {
        return;
      }
    }

    await enqueueRunExecutionV3(task.run, this.#prismaClient, {
      skipRetrying: task.run.environment.type === RuntimeEnvironmentType.DEVELOPMENT,
    });
  }

  public static async enqueue(id: string, runAt?: Date, tx?: PrismaClientOrTransaction) {
    return await workerQueue.enqueue("resumeTask", { id }, { tx, jobKey: `resume:${id}`, runAt });
  }
}

async function findTask(prisma: PrismaClient, id: string) {
  return prisma.task.findUnique({
    where: { id },
    include: {
      attempts: true,
      run: {
        include: {
          environment: true,
        },
      },
      parent: true,
    },
  });
}
