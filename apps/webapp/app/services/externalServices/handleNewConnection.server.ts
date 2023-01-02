import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { StartIntegrationRequest } from "../requests/startIntegrationRequest.server";

export class HandleNewServiceConnection {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async call(id: string) {
    const externalService = await this.#prismaClient.externalService.findUnique(
      {
        where: {
          id,
        },
      }
    );

    if (!externalService) {
      return;
    }

    if (!externalService.connectionId) {
      return;
    }

    await this.#prismaClient.externalService.update({
      where: {
        id,
      },
      data: {
        status: "READY",
      },
    });

    const integrationRequests =
      await this.#prismaClient.integrationRequest.findMany({
        where: {
          externalServiceId: id,
          status: "WAITING_FOR_CONNECTION",
        },
        include: {
          step: true,
        },
      });

    for (const integrationRequest of integrationRequests) {
      await this.#startIntegrationRequest.call(
        integrationRequest,
        integrationRequest.step
      );
    }
  }

  get #startIntegrationRequest() {
    return new StartIntegrationRequest(this.#prismaClient);
  }
}
