import { $transaction, type PrismaClient, type PrismaClientOrTransaction, prisma } from "~/db.server";
import { logger } from "../logger.server";
import { ResumeTaskService } from "./resumeTask.server";

type FoundTask = Awaited<ReturnType<typeof findTask>>;

export class ProcessCallbackTimeoutService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string) {
    const task = await findTask(this.#prismaClient, id);

    if (!task) {
      return;
    }

    if (task.status !== "WAITING" || !task.callbackUrl) {
      return;
    }

    logger.debug("ProcessCallbackTimeoutService.call", { task });

    return await this.#failTask(task, "Remote callback timeout - no requests received");
  }

  async #failTask(task: NonNullable<FoundTask>, error: string) {
    await $transaction(this.#prismaClient, async (tx) => {
      await tx.taskAttempt.updateMany({
        where: {
          taskId: task.id,
          status: "PENDING",
        },
        data: {
          status: "ERRORED",
          error,
        },
      });

      await tx.task.update({
        where: { id: task.id },
        data: {
          status: "ERRORED",
          completedAt: new Date(),
          output: error,
        },
      });

      await this.#resumeRunExecution(task, tx);
    });
  }

  async #resumeRunExecution(task: NonNullable<FoundTask>, prisma: PrismaClientOrTransaction) {
    await ResumeTaskService.enqueue(task.id, undefined, prisma);
  }
}

async function findTask(prisma: PrismaClient, id: string) {
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
