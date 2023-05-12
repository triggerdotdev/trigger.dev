import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { ClientApi } from "../clientApi.server";
import { workerQueue } from "../worker.server";

export class EndpointRegisteredService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string) {
    const endpoint = await this.#prismaClient.endpoint.findUniqueOrThrow({
      where: {
        id,
      },
      include: {
        environment: true,
      },
    });

    // Make a request to the endpoint to fetch a list of jobs
    const client = new ClientApi(endpoint.environment.apiKey, endpoint.url);

    const { jobs, dynamicTriggers } = await client.getEndpointData();

    for (const job of jobs) {
      await workerQueue.enqueue("registerJob", {
        job,
        endpointId: endpoint.id,
      });
    }
  }
}
