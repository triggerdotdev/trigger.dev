import type {
  ExternalService,
  IntegrationRequest,
  WorkflowRun,
  WorkflowRunStep,
} from ".prisma/client";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";

export class WaitForConnection {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async call(
    request: IntegrationRequest,
    service: ExternalService,
    step: WorkflowRunStep,
    run: WorkflowRun
  ) {
    await this.#prismaClient.integrationRequest.update({
      where: {
        id: request.id,
      },
      data: {
        status: "WAITING_FOR_CONNECTION",
      },
    });

    // TODO: Send user an email with a link to connect their account
  }
}
