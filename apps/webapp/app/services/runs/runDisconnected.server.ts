import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { createStepOnce } from "~/models/workflowRunStep.server";
import { internalPubSub } from "../messageBroker.server";

export class WorkflowRunDisconnected {
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

    const lastStep = await this.#prismaClient.workflowRunStep.findFirst({
      where: {
        runId: workflowRun.id,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    await createStepOnce(
      workflowRun.id,
      `${lastStep ? lastStep.id : ""}-interruption`,
      {
        type: "INTERRUPTION",
        status: "RUNNING",
        input: {},
        context: {},
        startedAt: new Date(),
      }
    );

    // Create an INTERRUPTION step
    return await internalPubSub.publish(
      "TRIGGER_WORKFLOW_RUN",
      {
        id: workflowRun.id,
      },
      {},
      { deliverAfter: 1 * 1000 }
    );
  }
}
