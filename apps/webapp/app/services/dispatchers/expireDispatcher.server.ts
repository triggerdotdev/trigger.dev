import { type PrismaClient, type PrismaClientOrTransaction, prisma } from "~/db.server";
import { workerQueue } from "../worker.server";

export class ExpireDispatcherService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string) {
    await this.#prismaClient.eventDispatcher.delete({
      where: {
        id,
      },
    });
  }

  static async dequeue(id: string, tx?: PrismaClientOrTransaction) {
    await workerQueue.dequeue(`expire:${id}`, { tx });
  }

  static async enqueue(id: string, timeoutInSeconds: number, tx?: PrismaClientOrTransaction) {
    await workerQueue.enqueue(
      "expireDispatcher",
      {
        id,
      },
      {
        tx,
        runAt: new Date(Date.now() + 1000 * timeoutInSeconds),
        jobKey: `expire:${id}`,
      }
    );
  }
}
