import { type JobRun } from "@trigger.dev/database";
import { type PrismaClient, prisma } from "~/db.server";
import { workerQueue } from "../worker.server";

export class DeliverRunSubscriptionsService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string) {
    const run = await this.#prismaClient.jobRun.findUnique({
      where: {
        id,
      },
    });

    if (!run) {
      return;
    }

    const subscriptions = await this.#findSubscriptions(run);

    for (const subscription of subscriptions) {
      await workerQueue.enqueue("deliverRunSubscription", {
        id: subscription.id,
      });
    }
  }

  async #findSubscriptions(run: JobRun) {
    const subscriptions = await this.#prismaClient.jobRunSubscription.findMany({
      where: {
        runId: run.id,
        deliveredAt: null,
        status: "ACTIVE",
        event: run.status === "SUCCESS" ? "SUCCESS" : "FAILURE",
      },
    });

    return subscriptions;
  }
}
