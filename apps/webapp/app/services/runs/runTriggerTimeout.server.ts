import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";

export class WorkflowRunTriggerTimeout {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async call(data: { id: string; ttl: number; elapsedSeconds: number }) {
    const workflowRun = await this.#prismaClient.workflowRun.findUnique({
      where: { id: data.id },
      include: {
        event: true,
        environment: true,
      },
    });

    if (!workflowRun) {
      throw new Error("Workflow run not found");
    }

    if (workflowRun.status !== "PENDING") {
      return;
    }

    await this.#prismaClient.workflowRun.update({
      where: { id: data.id },
      data: {
        status: "TIMED_OUT",
        timedOutAt: new Date(),
        timedOutReason: `Trigger timed out after ${data.elapsedSeconds}s because it exceeded the TTL of ${data.ttl}s`,
      },
    });
  }
}
