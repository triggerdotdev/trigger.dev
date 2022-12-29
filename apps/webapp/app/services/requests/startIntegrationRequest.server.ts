import type { IntegrationRequest, WorkflowRunStep } from ".prisma/client";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { requestPubSub } from "../messageBroker.server";

export class StartIntegrationRequest {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async call(request: IntegrationRequest, step: WorkflowRunStep) {
    await this.#prismaClient.integrationRequest.update({
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

    requestPubSub.publish("PERFORM_INTEGRATION_REQUEST", {
      id: request.id,
    });
  }
}
