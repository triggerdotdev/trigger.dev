import { $transaction, type PrismaClient, type PrismaClientOrTransaction, prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { ResumeTaskService } from "~/services/tasks/resumeTask.server";
import { workerQueue } from "~/services/worker.server";

export class CallbackRunTaskService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string, taskBody: any, callbackUrl: string): Promise<void> {
    const task = await findTask(prisma, id);

    if (!task) {
      return;
    }

    if (task.status !== "WAITING") {
      return;
    }

    if (!task.callbackUrl) {
      throw new Error("Task doesn't have a callback URL");
    }

    if (new URL(task.callbackUrl).pathname !== new URL(callbackUrl).pathname) {
      logger.debug("Callback URLs don't match", { taskId: id, callbackUrl });

      throw new Error("Callback URLs don't match");
    }

    logger.debug("CallbackRunTaskService.call()", { task });

    await this.#resumeTask(task, taskBody);
  }

  async #resumeTask(task: NonNullable<FoundTask>, output: any) {
    await $transaction(this.#prismaClient, async (tx) => {
      await tx.taskAttempt.updateMany({
        where: {
          taskId: task.id,
          status: "PENDING",
        },
        data: {
          status: "COMPLETED",
        },
      });

      await tx.task.update({
        where: { id: task.id },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
          output: output ? output : undefined,
        },
      });

      await workerQueue.dequeue(`process-callback:${task.id}`, { tx });

      await this.#resumeRunExecution(task, tx);
    });
  }

  async #resumeRunExecution(task: NonNullable<FoundTask>, prisma: PrismaClientOrTransaction) {
    await ResumeTaskService.enqueue(task.id, undefined, prisma);
  }
}

type FoundTask = Awaited<ReturnType<typeof findTask>>;

async function findTask(prisma: PrismaClientOrTransaction, id: string) {
  return prisma.task.findUnique({
    where: { id },
    include: {
      run: {
        include: {
          environment: true,
          queue: true,
        },
      },
    },
  });
}
