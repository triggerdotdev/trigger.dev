import type { WorkflowRunStep } from ".prisma/client";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import type { FetchRequest } from "~/models/fetchRequest.server";
import { requestTaskQueue } from "../messageBroker.server";

export class StartFetchRequest {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async call(request: FetchRequest, step: WorkflowRunStep) {
    await this.#prismaClient.fetchRequest.update({
      where: {
        id: request.id,
      },
      data: {
        status: "FETCHING",
      },
    });

    await this.#prismaClient.workflowRunStep.update({
      where: {
        id: step.id,
      },
      data: {
        status: "RUNNING",
        startedAt: new Date(),
      },
    });

    requestTaskQueue.publish("PERFORM_FETCH_REQUEST", {
      id: request.id,
    });
  }
}
