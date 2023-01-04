import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { internalPubSub } from "../messageBroker.server";

export class InterruptWorkflowRun {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async call(id: string) {
    const workflowRun = await this.#prismaClient.workflowRun.findUnique({
      where: { id },
      include: {
        event: true,
        environment: true,
      },
    });

    if (!workflowRun) {
      throw new Error("Workflow run not found");
    }

    if (workflowRun.status !== "RUNNING") {
      return true;
    }

    await this.#prismaClient.workflowRun.update({
      where: { id: workflowRun.id },
      data: {
        status: "INTERRUPTED",
      },
    });

    return await internalPubSub.publish(
      "TRIGGER_WORKFLOW_RUN",
      {
        id: workflowRun.id,
      },
      {},
      { deliverAfter: 5 * 1000 }
    );
  }
}
