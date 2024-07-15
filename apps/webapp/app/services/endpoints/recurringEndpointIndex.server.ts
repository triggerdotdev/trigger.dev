import { type PrismaClient, prisma } from "~/db.server";
import { logger } from "../logger.server";
import { workerQueue } from "../worker.server";
import { RuntimeEnvironmentType } from "@trigger.dev/database";

export class RecurringEndpointIndexService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(ts: Date) {
    // Find all production endpoints that haven't been indexed in the last 10 minutes
    const currentTimestamp = ts.getTime();

    const endpoints = await this.#prismaClient.endpoint.findMany({
      where: {
        url: {
          not: null,
        },
        environment: {
          type: {
            in: [RuntimeEnvironmentType.PRODUCTION, RuntimeEnvironmentType.STAGING],
          },
        },
        indexings: {
          none: {
            createdAt: {
              gt: new Date(currentTimestamp - 60 * 60 * 1000),
            },
          },
        },
      },
    });

    logger.debug("Found endpoints that haven't been indexed in the last 10 minutes", {
      count: endpoints.length,
    });
    // Enqueue each endpoint for indexing
    for (const endpoint of endpoints) {
      const index = await this.#prismaClient.endpointIndex.create({
        data: {
          endpointId: endpoint.id,
          status: "PENDING",
          source: "INTERNAL",
        },
      });

      await workerQueue.enqueue("performEndpointIndexing", {
        id: index.id,
      });
    }
  }
}
